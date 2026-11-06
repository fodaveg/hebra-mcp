/**
 * `hebra_grep` (D13, SPEC.md §5): un literal o una expresión regular, línea a línea, sobre
 * el cuerpo de las notas VISIBLES, con el número de línea, la línea, su contexto y el
 * apartado más interno (`heading`, como `hebra_search` con D11).
 *
 * Qué notas se miran, antes de leer ningún cuerpo: las vivas (ni papelera ni lápida),
 * visibles para el filtro de privados (§6.3), sin bloquear (el cuerpo de una bloqueada va
 * cifrado: no se busca) y, si se piden, de la carpeta (con `subfolders`, su subárbol) y con
 * la etiqueta. Solo de esas se lee el cuerpo, así que una nota oculta no cuenta en nada:
 * ni en los resultados, ni en el tiempo que se gasta, ni en dónde se corta, ni en si hay
 * `nextCursor`. La respuesta no lleva ningún recuento.
 *
 * Privados por tramos (`privacyLoad: 'lazy'`, A4 del plan de memoria, 6 nov 2026): el filtro
 * no trae la biblioteca entera. Las notas se juzgan en orden de id, por tramos que se cargan
 * con `ctx.privacy.ensure` (`PendingNotes`), y solo hasta donde llegue la página: el resultado,
 * los cortes y el cursor son los mismos que juzgándolas todas antes de empezar. Lo ya decidido
 * se suelta del índice (`forget`, M1 de la revisión de seguridad, 6 nov 2026): las de un tramo que
 * no se miran, al juzgarlo, y las de un lote, al recorrerlo. Con un patrón raro la llamada
 * recorre la biblioteca entera en TIEMPO, pero su índice no pasa de un tramo (`GREP_WINDOW_MAX`)
 * más un lote. Las filas de las notas vivas (id, título y `rowid`) se leen por páginas
 * (`NoteRowsById`, M2 del plan de memoria, 6 nov 2026; antes, todas de una vez, unos 4,8 MiB a
 * 30 000 notas) y la cola tira lo ya recorrido: nada de lo que guarda la llamada crece con la
 * biblioteca.
 *
 * Orden y cursor: por id de nota y número de línea, estable aunque las notas cambien. El
 * cursor (`g1`) es la posición por la que seguir: `[id, línea]` (la línea de esa nota por
 * la que empezar; 0, la nota ya está entera). No exige que esa nota siga existiendo o
 * siendo visible: se sigue por las de id mayor. Lleva siempre el id de una nota visible
 * que ya se miró. Una nota editada entre dos páginas puede repetir o saltarse líneas.
 *
 * Topes (`capabilities.limits.grep`): `limit` coincidencias por página (se mira una más
 * para no dar un `nextCursor` sin nada detrás), un plazo de tiempo para recorrer y un
 * tamaño de respuesta. Si se agota el plazo o el tamaño, sale lo que haya, `cutoff`
 * (`time` o `size`) y un `nextCursor` que sigue justo donde se quedó. El plazo cuenta
 * desde el primer cuerpo leído: lo de antes (qué notas mirar y el índice) no depende de
 * cuánto texto tengan las ocultas. Juzgar un tramo nuevo a mitad del recorrido (y leer del
 * almacén las páginas de filas que pide, ocultas incluidas) tampoco cuenta: el plazo se corre
 * lo que tarde.
 *
 * Prefiltro: con un literal (o el trozo que toda coincidencia de la expresión contiene,
 * `requiredLiteral`) de al menos tres caracteres, el índice de subcadena de Hebra
 * (`notes_trigram`) da un superconjunto de las notas que pueden casar
 * (`trigramMatch`, `grepSubstringCandidates`), y solo se leen esas. El índice no guarda el
 * texto de los comentarios de Obsidian `%%…%%` (TRA-18) ni el de los destinos de enlaces:
 * esas notas se miran aparte (`grepSubstringCandidates`). Se comprueba SIEMPRE
 * sobre el cuerpo: el índice no guarda texto. Sin índice completo (el relleno de
 * `fillSubstringIndex` no ha terminado, o es un lector sobre una base sin él), o con un
 * patrón con el que el índice se podría dejar notas, se recorren todas.
 *
 * Expresiones regulares: en un hilo que se mata al agotarse el plazo
 * (`../../store/regex-worker.ts`); si no termina ni una nota en todo el plazo,
 * `pattern_too_slow`. Un literal se recorre en el hilo principal: es lineal.
 */
import { canonicalTag } from '../../hebra';
import {
  clipAround,
  clipContext,
  compileGrepPattern,
  GREP_CONTEXT_MAX_LINES,
  lineStarts,
  lineText,
  scanBody,
  trigramMatch,
  type GrepPattern
} from '../../store/grep';
import type { GrepBodiesSession, GrepNoteRow } from '../../store/grep-sql';
import { NoteRowsById } from '../../store/grep-notes';
import {
  RegexScanWorker,
  type OnNote,
  type ScanNote,
  type ScanOutcome
} from '../../store/regex-worker';
import { headingAtLine, parseHeadings, type HeadingInfo } from '../../store/sections';
import { usageOf, type ToolContext } from '../context';
import { ToolError } from '../errors';
import { LIMITS, effectiveLimit, unwrapCursor, wrapCursor } from '../pagination';

/** Plazo para recorrer los cuerpos, en milisegundos. */
export const GREP_TIME_BUDGET_MS = 2_000;
/** Tope de la respuesta: la suma del JSON de las coincidencias, en unidades UTF-16. La
 *  primera coincidencia sale siempre, aunque lo pase. */
export const GREP_RESPONSE_MAX_CHARS = 100_000;
/** Notas por lote de lectura: un turno de la cola por lote. */
const GREP_BATCH_NOTES = 64;
/** Tope del id de nota de un cursor. */
const CURSOR_ID_MAX_LENGTH = 200;

export interface GrepMatch {
  id: string;
  title: string;
  isConflictCopy: boolean;
  /** Línea (1-based) de la nota: la misma numeración que `hebra_read_note` con `lines` y
   *  que `line` de `hebra_note_outline`. */
  line: number;
  /** Columna (1-based, en unidades UTF-16) de la primera coincidencia en la línea. */
  column: number;
  /** La línea; si es más larga que el tope, un trozo alrededor de la coincidencia. */
  text: string;
  /** Solo si `text` es un trozo: la columna donde empieza y la longitud de la línea. */
  textStart?: number;
  lineChars?: number;
  /** Solo con `contextLines`: las líneas de antes y de después (cortadas al tope con `…`). */
  before?: string[];
  after?: string[];
  /** El apartado más interno que contiene la línea (D11), tal como está en la nota: sirve
   *  como `heading` de `hebra_read_note`. `null` antes del primer encabezado. */
  heading: string | null;
  /** Cuál de los encabezados con ese título es (1-based, `occurrence` de `parseHeadings`):
   *  el `headingOccurrence` de `hebra_read_note`, que con un título repetido hace falta.
   *  `null` si `heading` lo es. */
  headingOccurrence: number | null;
}

export interface GrepOutput {
  matches: GrepMatch[];
  nextCursor: string | null;
  /** Por qué paró antes de recorrerlo todo sin llenar la página: `time` (plazo) o `size`
   *  (tamaño de la respuesta). `null` si no. Con él, siempre hay `nextCursor`. */
  cutoff: 'time' | 'size' | null;
  /** Solo si esta página se SALTÓ una nota: la expresión regular se interrumpió en ella
   *  dos veces seguidas sin terminarla (por el plazo o por un fallo del hilo), desde la línea
   *  `fromLine`. De esa nota, desde esa línea, no se sabe si casa. */
  skipped?: { id: string; fromLine: number };
}

export interface GrepInput {
  pattern: string;
  regex?: boolean;
  caseSensitive?: boolean;
  folder?: string;
  subfolders?: boolean;
  tag?: string;
  contextLines?: number;
  limit?: number;
  cursor?: string;
}

/** Para los tests: otro plazo. */
export interface GrepOptions {
  timeBudgetMs?: number;
  /** Para los tests: otras filas por página del almacén (`GREP_NOTES_PAGE`). */
  notesPage?: number;
}

/** Una nota que hay que recorrer, en orden, con la línea por la que empezar. */
interface Pending extends GrepNoteRow {
  fromLine: number;
}

function parseCursor(cursor: string): { id: string; line: number; failedOnce: boolean } {
  let payload: unknown;
  try {
    payload = JSON.parse(unwrapCursor('g1', cursor));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError('invalid_input');
  }
  if (
    !Array.isArray(payload) ||
    (payload.length !== 2 && !(payload.length === 3 && payload[2] === 1)) ||
    typeof payload[0] !== 'string' ||
    payload[0].length === 0 ||
    payload[0].length > CURSOR_ID_MAX_LENGTH ||
    !Number.isSafeInteger(payload[1]) ||
    (payload[1] as number) < 0
  ) {
    throw new ToolError('invalid_input');
  }
  return { id: payload[0], line: payload[1] as number, failedOnce: payload.length === 3 };
}

/** El cursor `[id, línea]`; con `failedOnce`, `[id, línea, 1]`: la expresión regular ya se
 *  interrumpió una vez en esa nota (punto por el que seguir), y si vuelve a interrumpirse
 *  en ella sin avanzar nada, se salta (`skipped`). */
function cursorAt(id: string, line: number, failedOnce = false): string {
  return wrapCursor('g1', JSON.stringify(failedOnce ? [id, line, 1] : [id, line]));
}

/** Primer tramo de notas que se juzgan (`PendingNotes`): dos lotes de lectura. */
const GREP_WINDOW_FIRST = GREP_BATCH_NOTES * 2;
/** Tope del tramo: cada uno dobla al anterior hasta aquí. Medido a 30 000 notas con un patrón que
 *  no está en ninguna (heap vivo máximo de la llamada, M2 del plan de memoria, 6 nov 2026): con
 *  8 192 y las filas de toda la biblioteca, 13,5 MiB; con las filas por páginas, 9,2 MiB con
 *  8 192 y 2,4 MiB con 2 048, dentro de los 8 MiB que aparta cada llamada
 *  (`REQUEST_RESERVE_BYTES`), y el tiempo, igual (unos 0,5 s). */
export const GREP_WINDOW_MAX = 2_048;

/**
 * Las notas que se miran, en orden de id, juzgadas por TRAMOS (`privacyLoad: 'lazy'`, A4 del
 * plan de memoria, 6 nov 2026): el filtro de privados no trae la biblioteca entera, y cada
 * tramo de `rows` (vivas, sin bloquear y desde el cursor, en orden: `NoteRowsById`, que las lee
 * del almacén por páginas, M2) se carga con
 * `ctx.privacy.ensure` antes de juzgarlo, y lo que de él no se va a mirar se suelta en cuanto se
 * juzga (`forget`, M1 de la revisión de seguridad): con un patrón raro se recorren todos los
 * tramos, y el índice de la llamada no puede acabar con la biblioteca entera dentro. De cada
 * tramo quedan las visibles que pasan
 * `accept` (carpeta y etiqueta) y, con prefiltro, las que el índice de subcadena da como
 * candidatas: `grepCandidates` sigue recibiendo solo notas VISIBLES (lee el cuerpo de algunas,
 * así que una oculta no puede entrar ahí, cabecera). Las que se miran son la misma lista que
 * se calculaba de una vez, pero solo hasta donde se pida con `fillTo`: una página que se llena
 * pronto no juzga el resto de la biblioteca. Se numeran desde 0 en el orden de la llamada
 * (`length`, `slice`), y las ya recorridas se tiran (`drop`): lo guardado a la vez es un tramo y
 * un lote, no la biblioteca. Los tramos doblan (de `GREP_WINDOW_FIRST` a `GREP_WINDOW_MAX`)
 * para que un patrón raro no pida el prefiltro cientos de veces.
 */
class PendingNotes {
  /** Las que se miran desde la número `base`, en orden de id (crece con `fillTo`). */
  private items: Pending[] = [];
  private base = 0;
  /** `rows` ya no tiene más. */
  private done = false;
  private window = GREP_WINDOW_FIRST;

  constructor(
    private readonly ctx: ToolContext,
    private readonly rows: { take(max: number): Promise<Pending[]> },
    private readonly match: string | null,
    private readonly accept: (row: Pending) => boolean
  ) {}

  /** Cuántas se miran hasta ahora, contando las ya tiradas. */
  get length(): number {
    return this.base + this.items.length;
  }

  /** Las que se miran de la número `from` a la `to` (sin ella). */
  slice(from: number, to: number): Pending[] {
    return this.items.slice(from - this.base, to - this.base);
  }

  /** Tira las anteriores a la número `before` (ya recorridas). */
  drop(before: number): void {
    const count = before - this.base;
    if (count <= 0) return;
    this.items.splice(0, count);
    this.base = before;
  }

  /** ¿Hay que juzgar algún tramo más para tener `count` notas? */
  needs(count: number): boolean {
    return this.length < count && !this.done;
  }

  /** Juzga tramos hasta tener `count` notas o acabar `rows`. */
  async fillTo(count: number): Promise<void> {
    while (this.needs(count)) {
      const slice = await this.rows.take(this.window);
      if (slice.length < this.window) this.done = true;
      if (slice.length === 0) break;
      this.window = Math.min(this.window * 2, GREP_WINDOW_MAX);
      await this.ctx.privacy.ensure(slice.map((row) => row.id));
      let accepted = slice.filter(this.accept);
      if (this.match !== null && accepted.length > 0) {
        const candidates = await this.ctx.port.grepCandidates(
          this.match,
          accepted.map((note) => note.rowid)
        );
        if (candidates) accepted = accepted.filter((note) => candidates.has(note.rowid));
      }
      // M1: las del tramo que no se van a mirar ya están decididas y nadie vuelve a preguntar
      // por ellas: se sueltan del índice. Las que quedan en `items` siguen cargadas hasta
      // recorrerlas (`release`), porque la puerta final toma su sello al declararlas.
      const kept = new Set(accepted);
      this.ctx.privacy.forget(slice.filter((row) => !kept.has(row)).map((row) => row.id));
      this.items.push(...accepted);
    }
  }

  /** Suelta del índice notas de `items` ya recorridas (M1): ver `runGrep`. */
  release(ids: Iterable<string>): void {
    this.ctx.privacy.forget(ids);
  }
}

/** Recorre un lote de notas con un literal en el hilo principal (es lineal): entre nota y
 *  nota mira el plazo, si ya se avanzó algo en esta llamada. */
function scanLiteral(
  pattern: GrepPattern,
  notes: readonly ScanNote[],
  maxHits: number,
  deadline: number,
  mayCut: () => boolean,
  onNote: OnNote
): ScanOutcome {
  for (let index = 0; index < notes.length; index += 1) {
    if (mayCut() && Date.now() >= deadline) return { status: 'time', next: index };
    const note = notes[index]!;
    if (!onNote(index, scanBody(note.body, pattern.re, note.fromLine, maxHits, true))) {
      return { status: 'stopped' };
    }
  }
  return { status: 'done' };
}

export async function runGrep(
  ctx: ToolContext,
  input: GrepInput,
  options: GrepOptions = {}
): Promise<GrepOutput> {
  if (typeof input.pattern !== 'string') throw new ToolError('invalid_input');
  const pattern = compileGrepPattern(input.pattern, {
    regex: input.regex === true,
    caseSensitive: input.caseSensitive === true
  });
  if (!pattern) throw new ToolError('invalid_input');
  const contextLines = input.contextLines ?? 0;
  if (
    !Number.isSafeInteger(contextLines) ||
    contextLines < 0 ||
    contextLines > GREP_CONTEXT_MAX_LINES
  ) {
    throw new ToolError('invalid_input');
  }
  const limit = effectiveLimit(input.limit, LIMITS.grep);
  const start = input.cursor === undefined ? null : parseCursor(input.cursor);
  const empty: GrepOutput = { matches: [], nextCursor: null, cutoff: null };

  // Filtros, como `hebra_search`: una etiqueta o una carpeta privadas o inexistentes dan
  // lista vacía, sin mirar nada.
  let tag: string | undefined;
  if (input.tag !== undefined) {
    const canonical = canonicalTag(input.tag)?.tag;
    if (!canonical || ctx.privacy.isTagHidden(canonical)) return empty;
    tag = canonical;
  }
  let inFolder: ((folderId: string) => boolean) | undefined;
  if (input.folder !== undefined) {
    const resolved = ctx.privacy.folderIdForPath(input.folder);
    if (!resolved || ctx.privacy.isFolderHidden(resolved)) return empty;
    if (input.subfolders) {
      const subtree = new Set(ctx.privacy.folderSubtree(resolved));
      inFolder = (folderId) => subtree.has(folderId);
    } else {
      inFolder = (folderId) => folderId === resolved;
    }
  }

  // Qué notas se miran, sin leer ningún cuerpo, en orden de id y desde el cursor, leídas del
  // almacén por páginas (`NoteRowsById`, M2). Lo que no depende de la privacidad (bloqueada,
  // cursor) se aplica al leerlas; la visibilidad, la carpeta, la etiqueta y el prefiltro, por
  // tramos (`PendingNotes`).
  const source = new NoteRowsById(
    ctx.port,
    start ? { id: start.id, inclusive: start.line > 0 } : null,
    options.notesPage
  );
  const rows = {
    /** Las `max` siguientes sin bloquear (menos solo al acabar), con la línea por la que empezar. */
    async take(max: number): Promise<Pending[]> {
      const out: Pending[] = [];
      while (out.length < max) {
        const page = await source.take(max - out.length);
        if (page.length === 0) break;
        for (const row of page) {
          if (!row.locked) out.push({ ...row, fromLine: start && row.id === start.id ? start.line : 1 });
        }
      }
      return out;
    }
  };
  const queue = new PendingNotes(ctx, rows, trigramMatch(pattern.required, input.caseSensitive === true), (row) => {
    const meta = ctx.privacy.visibleMeta(row.id);
    if (!meta) return false;
    if (inFolder && !inFolder(meta.folderId)) return false;
    return tag === undefined || ctx.privacy.hasTag(row.id, tag);
  });
  // Lo que decide el primer lote y si hay otro detrás, antes del plazo (como antes de A4).
  await queue.fillTo(GREP_BATCH_NOTES + 1);

  const matches: GrepMatch[] = [];
  let responseChars = 0;
  let progressed = false;
  let session: GrepBodiesSession | null = null;
  let skipped: GrepOutput['skipped'];
  let stop: { cursor: string | null; cutoff: GrepOutput['cutoff'] } | null = null;
  /** La última nota recorrida (leída y visible en el turno de su lote). Un corte por tiempo
   *  ENTRE lotes sigue detrás de ella (`[id, 0]`: esa nota ya no se vuelve a mirar), nunca
   *  en una nota que no se ha leído. */
  let lastScanned: string | null = null;
  // Lo que sale de una nota (una coincidencia, el id de un cursor o de `skipped`) lo vuelve a
  // juzgar la puerta final (`../privacy-gate.ts`) con el filtro de ahora y el sello de la
  // fila con la que se decidió que se veía: una que pasó a oculta mientras se leía o se
  // recorría su lote hace repetir la llamada (2.ª revisión de Codex).
  const used = usageOf(ctx);
  const usedCursor = (id: string, line: number, failedOnce = false): string => {
    used.note(id);
    return cursorAt(id, line, failedOnce);
  };
  const afterLastScanned = (): string | null => (lastScanned === null ? null : usedCursor(lastScanned, 0));
  // Con expresión regular, primero un hueco para su hilo (`REGEX_WORKERS_MAX` en todo el
  // proceso): la espera no cuenta para el plazo, que empieza con el hilo ya arrancado.
  const worker = pattern.literal ? null : await RegexScanWorker.start(pattern.re, ctx.port);
  let deadline = Date.now() + (options.timeBudgetMs ?? GREP_TIME_BUDGET_MS);
  /** M1: notas ya recorridas que aún se guardan en el índice porque un corte posterior todavía
   *  puede declararlas (`usedCursor`): la última recorrida y la de la última coincidencia. */
  let held: string[] = [];
  try {
    for (let first = 0; !stop; first += GREP_BATCH_NOTES) {
      // Este lote entero y una más (`queue.length > first + GREP_BATCH_NOTES` dice si hay
      // otro lote detrás). Juzgar un tramo nuevo (con las páginas de filas que lea, M2) no
      // cuenta para el plazo, como no contaba juzgarlas todas antes de empezar: el plazo se corre
      // lo que tarde. Sin tramo que juzgar, ni se mira el reloj.
      const wanted = first + GREP_BATCH_NOTES + 1;
      if (queue.needs(wanted)) {
        const fillStart = Date.now();
        await queue.fillTo(wanted);
        deadline += Date.now() - fillStart;
      }
      if (first >= queue.length) break;
      const batch = queue.slice(first, first + GREP_BATCH_NOTES);
      if (progressed && Date.now() >= deadline) {
        // Detrás de la última recorrida, no en la primera del lote que no se ha leído: esa
        // pudo pasar a oculta desde que se leyó su fila, y su id no puede salir (C6 de la revisión
        // de Codex). `progressed` asegura que hay una.
        stop = { cursor: afterLastScanned(), cutoff: 'time' };
        break;
      }
      const read = await ctx.port.grepBodies(
        batch.map((note) => note.rowid),
        ctx.privacyConfig,
        session
      );
      if (read.unresolved) throw new ToolError('privacy_config_unresolved');
      session = read.session;
      const bodies = read.bodies;
      // Una que ya no está viva, se bloqueó o pasó a ser oculta desde que se leyó su fila (el
      // filtro se rehace en el turno de la lectura) se salta.
      const notes = batch.filter((note) => bodies.has(note.rowid));
      const scanNotes: ScanNote[] = notes.map((note) => ({
        body: bodies.get(note.rowid)!,
        fromLine: note.fromLine
      }));

      const onNote: OnNote = (index, result) => {
        progressed = true;
        const note = notes[index]!;
        lastScanned = note.id;
        const body = scanNotes[index]!.body;
        let starts: number[] | null = null;
        let headings: HeadingInfo[] | null = null;
        for (let hit = 0; hit < result.hits.length; hit += 2) {
          const line = result.hits[hit]!;
          const column = result.hits[hit + 1]!;
          const last = matches[matches.length - 1];
          if (matches.length >= limit) {
            // La de más: hay algo detrás de la página. Su nota decide que HAYA cursor: la
            // puerta final la juzga también (R3-4 de la 3.ª revisión de Codex).
            used.note(note.id);
            stop = { cursor: usedCursor(last!.id, last!.line + 1), cutoff: null };
            return false;
          }
          starts ??= lineStarts(body);
          headings ??= parseHeadings(body);
          const full = lineText(body, starts, line - 1);
          const clipped = clipAround(full, column);
          const section = headingAtLine(headings, line);
          const found: GrepMatch = {
            id: note.id,
            title: note.title,
            isConflictCopy: note.conflict,
            line,
            column,
            text: clipped.text,
            heading: section?.heading ?? null,
            headingOccurrence: section?.occurrence ?? null
          };
          if (clipped.text.length < full.length) {
            found.textStart = clipped.start;
            found.lineChars = full.length;
          }
          if (contextLines > 0) {
            const before: string[] = [];
            for (let other = Math.max(1, line - contextLines); other < line; other += 1) {
              before.push(clipContext(lineText(body, starts, other - 1)));
            }
            const after: string[] = [];
            const lastLine = Math.min(starts.length, line + contextLines);
            for (let other = line + 1; other <= lastLine; other += 1) {
              after.push(clipContext(lineText(body, starts, other - 1)));
            }
            found.before = before;
            found.after = after;
          }
          const size = JSON.stringify(found).length;
          if (matches.length > 0 && responseChars + size > GREP_RESPONSE_MAX_CHARS) {
            stop = { cursor: usedCursor(last!.id, last!.line + 1), cutoff: 'size' };
            return false;
          }
          responseChars += size;
          used.note(note.id);
          matches.push(found);
        }
        return true;
      };

      const maxHits = limit + 1 - matches.length;
      const outcome: ScanOutcome = worker
        ? await worker.scan(scanNotes, maxHits, deadline, onNote)
        : scanLiteral(pattern, scanNotes, maxHits, deadline, () => progressed, onNote);
      if (outcome.status === 'time') {
        // `next` es la primera nota del lote sin recorrer (leída en el turno de este lote,
        // visible); si el lote se acabó justo, detrás de la última recorrida: la del lote
        // siguiente no se ha leído y pudo pasar a oculta (C6 de la revisión de Codex).
        const next = notes[outcome.next];
        stop = next
          ? { cursor: usedCursor(next.id, next.fromLine), cutoff: 'time' }
          : queue.length > first + GREP_BATCH_NOTES
            ? { cursor: afterLastScanned(), cutoff: 'time' }
            : null;
        break;
      }
      if (outcome.status === 'interrupted') {
        const stuck = notes[outcome.next];
        if (!stuck) {
          // Todas las del lote terminadas y el plazo llegó antes del aviso de fin: se sigue
          // detrás de la última recorrida, como un corte entre notas (C6, arriba).
          stop =
            queue.length > first + GREP_BATCH_NOTES ? { cursor: afterLastScanned(), cutoff: 'time' } : null;
          break;
        }
        if (progressed) {
          // Lo encontrado vale; se sigue EN la nota interrumpida, marcada como ya fallida.
          stop = { cursor: usedCursor(stuck.id, stuck.fromLine, true), cutoff: 'time' };
          break;
        }
        if (start?.failedOnce && start.id === stuck.id) {
          // Segunda vez seguida en la misma nota sin avanzar: se salta y se dice.
          skipped = { id: stuck.id, fromLine: stuck.fromLine };
          stop = { cursor: usedCursor(stuck.id, 0), cutoff: 'time' };
          break;
        }
        // Ni una nota en todo el plazo: la expresión es demasiado cara. El cursor permite
        // reintentar esa nota una vez más y, si vuelve a fallar, saltarla.
        throw new ToolError('pattern_too_slow', {
          nextCursor: usedCursor(stuck.id, stuck.fromLine, true)
        });
      }
      // M1: el lote está recorrido y lo que salió ya está declarado a la puerta final (con su
      // sello), así que sus notas se sueltan del índice. Menos las dos que un corte de una
      // vuelta posterior aún puede declarar: `lastScanned` (`afterLastScanned`) y la de la última
      // coincidencia (`last` del corte por la de más o por tamaño). Así lo cargado lo acota el
      // tramo (y el lote), no la biblioteca: un patrón raro recorre todos los tramos.
      if (!stop) {
        const keep = new Set<string>();
        if (lastScanned !== null) keep.add(lastScanned);
        const lastMatch = matches[matches.length - 1];
        if (lastMatch) keep.add(lastMatch.id);
        queue.release([...held, ...batch.map((note) => note.id)].filter((id) => !keep.has(id)));
        held = [...keep];
        // M2: y se tiran de la cola, que así guarda un tramo y un lote, no lo ya recorrido.
        queue.drop(first + GREP_BATCH_NOTES);
      }
    }
  } finally {
    await worker?.close();
  }
  const output: GrepOutput = {
    matches,
    nextCursor: stop?.cursor ?? null,
    cutoff: stop?.cutoff ?? null
  };
  if (skipped) output.skipped = skipped;
  return output;
}
