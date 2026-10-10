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
 * cuánto texto tengan las ocultas.
 *
 * Prefiltro: con un literal (o el trozo que toda coincidencia de la expresión contiene,
 * `requiredLiteral`) de al menos tres caracteres, el índice de subcadena de Hebra
 * (`notes_trigram`) da un superconjunto de las notas que pueden casar
 * (`trigramMatch`, `grepSubstringCandidates`), y solo se leen esas. Se comprueba SIEMPRE
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
import {
  RegexScanWorker,
  RegexWorkerFailed,
  type OnNote,
  type ScanNote,
  type ScanOutcome
} from '../../store/regex-worker';
import { headingAtLine, parseHeadings, type HeadingInfo } from '../../store/sections';
import type { ToolContext } from '../context';
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
}

/** Una nota que hay que recorrer, en orden, con la línea por la que empezar. */
interface Pending extends GrepNoteRow {
  fromLine: number;
}

function parseCursor(cursor: string): { id: string; line: number } {
  let payload: unknown;
  try {
    payload = JSON.parse(unwrapCursor('g1', cursor));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError('invalid_input');
  }
  if (
    !Array.isArray(payload) ||
    payload.length !== 2 ||
    typeof payload[0] !== 'string' ||
    payload[0].length === 0 ||
    payload[0].length > CURSOR_ID_MAX_LENGTH ||
    !Number.isSafeInteger(payload[1]) ||
    (payload[1] as number) < 0
  ) {
    throw new ToolError('invalid_input');
  }
  return { id: payload[0], line: payload[1] as number };
}

function cursorAt(id: string, line: number): string {
  return wrapCursor('g1', JSON.stringify([id, line]));
}

/** Comparación por unidades de código: el orden de los ids, el mismo en todas las páginas. */
function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

  // Qué notas se miran, sin leer ningún cuerpo, en orden de id y desde el cursor.
  let pending: Pending[] = [];
  for (const row of await ctx.port.grepNotes()) {
    if (row.locked) continue;
    const meta = ctx.privacy.visibleMeta(row.id);
    if (!meta) continue;
    if (inFolder && !inFolder(meta.folderId)) continue;
    if (tag !== undefined && !ctx.privacy.hasTag(row.id, tag)) continue;
    if (start) {
      const order = byId(row.id, start.id);
      if (order < 0 || (order === 0 && start.line === 0)) continue;
      pending.push({ ...row, fromLine: order === 0 ? start.line : 1 });
    } else {
      pending.push({ ...row, fromLine: 1 });
    }
  }
  pending.sort((left, right) => byId(left.id, right.id));

  const match = trigramMatch(pattern.required, input.caseSensitive === true);
  if (match !== null && pending.length > 0) {
    const candidates = await ctx.port.grepCandidates(
      match,
      pending.map((note) => note.rowid)
    );
    if (candidates) pending = pending.filter((note) => candidates.has(note.rowid));
  }

  const matches: GrepMatch[] = [];
  let responseChars = 0;
  let progressed = false;
  let session: GrepBodiesSession | null = null;
  let stop: { cursor: string | null; cutoff: GrepOutput['cutoff'] } | null = null;
  // Con expresión regular, primero un hueco para su hilo (`REGEX_WORKERS_MAX` en todo el
  // proceso): la espera no cuenta para el plazo, que empieza con el hilo ya arrancado.
  const worker = pattern.literal ? null : await RegexScanWorker.start(pattern.re);
  const deadline = Date.now() + (options.timeBudgetMs ?? GREP_TIME_BUDGET_MS);
  try {
    for (let first = 0; first < pending.length && !stop; first += GREP_BATCH_NOTES) {
      const batch = pending.slice(first, first + GREP_BATCH_NOTES);
      if (progressed && Date.now() >= deadline) {
        stop = { cursor: cursorAt(batch[0]!.id, batch[0]!.fromLine), cutoff: 'time' };
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
      // Una que ya no está viva, se bloqueó o pasó a ser oculta desde `grepNotes` (el filtro
      // se rehace en el turno de la lectura) se salta.
      const notes = batch.filter((note) => bodies.has(note.rowid));
      const scanNotes: ScanNote[] = notes.map((note) => ({
        body: bodies.get(note.rowid)!,
        fromLine: note.fromLine
      }));

      const onNote: OnNote = (index, result) => {
        progressed = true;
        const note = notes[index]!;
        const body = scanNotes[index]!.body;
        let starts: number[] | null = null;
        let headings: HeadingInfo[] | null = null;
        for (let hit = 0; hit < result.hits.length; hit += 2) {
          const line = result.hits[hit]!;
          const column = result.hits[hit + 1]!;
          const last = matches[matches.length - 1];
          if (matches.length >= limit) {
            // La de más: hay algo detrás de la página.
            stop = { cursor: cursorAt(last!.id, last!.line + 1), cutoff: null };
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
            stop = { cursor: cursorAt(last!.id, last!.line + 1), cutoff: 'size' };
            return false;
          }
          responseChars += size;
          matches.push(found);
        }
        return true;
      };

      const maxHits = limit + 1 - matches.length;
      let outcome: ScanOutcome;
      try {
        outcome = worker
          ? await worker.scan(scanNotes, maxHits, deadline, () => progressed, onNote)
          : scanLiteral(pattern, scanNotes, maxHits, deadline, () => progressed, onNote);
      } catch (error) {
        if (error instanceof RegexWorkerFailed) throw new ToolError('pattern_too_slow');
        throw error;
      }
      if (outcome.status === 'time') {
        // `next` es la primera nota del lote sin recorrer; si el lote se acabó justo, la
        // siguiente a él.
        const next = notes[outcome.next] ?? pending[first + GREP_BATCH_NOTES];
        stop = next ? { cursor: cursorAt(next.id, next.fromLine), cutoff: 'time' } : null;
        break;
      }
    }
  } finally {
    await worker?.close();
  }
  return { matches, nextCursor: stop?.cursor ?? null, cutoff: stop?.cutoff ?? null };
}
