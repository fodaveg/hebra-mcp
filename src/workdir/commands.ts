/**
 * Las órdenes de los ficheros de trabajo (SPEC.md §13): `checkout`, `apply`, `undo`,
 * `status` y `diff`. Cada una devuelve su código de salida y escribe por `io.out`; no
 * llaman a `process.exit` ni leen `process.argv` (eso es `./cli.ts`), para poder
 * probarlas en el mismo proceso.
 *
 * `status`, `diff` y `apply --simular` no abren la biblioteca: comparan cada fichero con
 * su base. `checkout`, `apply` y `undo` la abren como el dispositivo local emparejado
 * (`./library.ts`), con una ronda de sync antes de sacar y después de devolver o deshacer.
 *
 * Códigos de salida: 0 todo limpio; 1 algo no entró limpio (copia de conflicto, rechazada,
 * no disponible, bloqueada, base dañada, en conflicto de antes, demasiado grande) o la
 * ronda de sync trajo otra versión de una nota devuelta; 2 error de uso o de la carpeta.
 */
import { randomBytes } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { deriveNote, type NoteRow } from '../hebra';
import { PrivacyFilter } from '../privacy/filter';
import { isBusyOtherInstance, StoreError } from '../store/errors';
import { REPLACE_BODY_MAX_LENGTH, type ReplaceBodyResult } from '../store/body-writes';
import { LOCKED_BODY_PREFIX } from '../store/writes';
import type { RoundWait } from '../server/write-context';
import type { WriterRole } from '../sync/library-instance';
import { compactDiff, diffStat, unifiedDiff } from './diff';
import {
  findWorkdir,
  safeRuta,
  sha256Hex,
  Workdir,
  WorkdirError,
  type ApplyOutcomeName,
  type CheckoutFile,
  type JournalEntry,
  type NoteMeta,
  type UndoOutcomeName
} from './layout';
import type { WorkdirLibrary } from './library';
import { assignNotePath, pathKey, toPosixRelative } from './names';

export interface CommandIo {
  cwd: string;
  out(line: string): void;
  now?: () => Date;
}

/** Abre la biblioteca (`openWorkdirLibrary` en producción; los tests inyectan la suya). */
export type OpenLibrary = () => Promise<WorkdirLibrary>;

/** Un error de uso: se dice y se sale con 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Rutas impresas por `checkout` antes de dar solo el patrón. */
const MAX_LISTED_PATHS = 60;
/** Rutas por lista en `status` sin `--rutas`. */
const STATUS_LIST = 5;
/** Tope del diff compacto de `apply`: líneas por nota y caracteres en total. */
const COMPACT_LINES_PER_NOTE = 6;
const COMPACT_TOTAL_CHARS = 3_000;
/** Una sacada más antigua que esto se avisa en `status`. */
const STALE_CHECKOUT_MS = 24 * 60 * 60 * 1000;
/** Páginas de 200 como mucho al recorrer la biblioteca (unas 2 M de notas). */
const PAGE_SIZE = 200;
const MAX_PAGES = 10_000;

function nowOf(io: CommandIo): Date {
  return io.now ? io.now() : new Date();
}

/** Una ruta para imprimir: relativa al directorio actual, para pasarla tal cual a `cat` o
 *  `sed`, salvo que haya que subir (`../`): entonces, la absoluta. */
function display(io: CommandIo, absolute: string): string {
  const rel = relative(io.cwd, absolute);
  if (rel === '') return '.';
  return rel.startsWith('..') || isAbsolute(rel) ? absolute : rel;
}

function shown(io: CommandIo, workdir: Workdir, ruta: string): string {
  // Una ruta tocada a mano en los metadatos no se resuelve (quedaría fuera de la carpeta).
  if (safeRuta(ruta) === null) return `(ruta no válida en los metadatos: ${JSON.stringify(ruta)})`;
  return display(io, workdir.notePath(ruta));
}

/** Lo que pasó con la ronda: lo que responde el escritor, o por qué no respondió. */
export type RoundOutcome = RoundWait | { kind: 'old_writer' } | { kind: 'unreachable' };

/** La ronda, sin que un escritor que no responde tumbe la orden: lo escrito ya está en la
 *  SQLite y lo subirá la ronda de quien la tenga abierta. */
async function syncRoundQuietly(lib: WorkdirLibrary): Promise<RoundOutcome> {
  try {
    return await lib.syncRound();
  } catch (error) {
    return errorCode(error) === 'invalid_request' ? { kind: 'old_writer' } : { kind: 'unreachable' };
  }
}

/**
 * La ronda en una frase. Lo dice la ronda del escritor (que puede ser otro proceso), no los
 * secretos de este. `role` es el de este proceso al terminar: si era el escritor, al salir
 * no queda nadie que siga la ronda, y lo pendiente sube la próxima vez que algo abra la
 * biblioteca.
 */
export function describeRound(round: RoundOutcome, role: WriterRole): string {
  switch (round.kind) {
    case 'no_sync':
      return 'sin emparejar, sin sync';
    case 'old_writer':
      return 'el escritor (otro proceso de hebra-mcp) es de una versión anterior y no atiende la petición de ronda; lo escrito lo subirá su ronda periódica';
    case 'unreachable':
      return 'el escritor (otro proceso de hebra-mcp) no respondió; lo escrito está en la biblioteca y lo subirá su ronda';
    case 'timeout':
      return role === 'this'
        ? 'la ronda no terminó a tiempo; lo pendiente sube la próxima vez que un proceso de hebra-mcp abra la biblioteca'
        : 'la ronda no terminó a tiempo; la sigue el escritor (otro proceso de hebra-mcp)';
    case 'done':
      return round.result === 'ok' ? 'ok' : `ronda con resultado ${round.result}`;
  }
}

/**
 * ¿Puede salir esta nota a disco, decidido con la fila RECIÉN leída y un filtro hecho
 * DESPUÉS de leerla (D3)? Una ronda de sync a mitad del `checkout` puede haberla vuelto
 * privada: por su carpeta (la efectiva de la fila, en el árbol de `filter`), por una
 * etiqueta de su cuerpo (con `deriveNote`, sus ancestros incluidos) o por lo que ya diga el
 * índice. También fuera: papelera, archivada, copia de conflicto y bloqueada.
 */
function canLeave(row: NoteRow | null, filter: PrivacyFilter): boolean {
  if (!row || row.trashedAt !== null || row.archivedAt !== null || row.conflictOf !== null) return false;
  if (row.body.startsWith(LOCKED_BODY_PREFIX)) return false;
  if (filter.isHiddenNote(row.id) || filter.isFolderHidden(row.effectiveFolderId)) return false;
  return !filter.hidesAnyTag((deriveNote(row.body).tags ?? []).map(({ tag }) => tag));
}

/** La más antigua de unas fechas ISO (o `fallback` si no hay ninguna). */
function oldest(dates: Array<string | undefined>, fallback: string): string {
  let result: string | null = null;
  for (const date of dates) {
    if (date !== undefined && (result === null || Date.parse(date) < Date.parse(result))) result = date;
  }
  return result ?? fallback;
}

/** Nombres (tal como están guardados) de las carpetas de Hebra hasta `folderId`. */
function folderNames(filter: PrivacyFilter, folderId: string): string[] {
  const names: string[] = [];
  let current: string | null = folderId;
  for (let depth = 0; current !== null && depth < 256; depth += 1) {
    const parent = filter.folderParent(current);
    if (parent === null) break;
    names.unshift(filter.folderName(current) ?? '');
    current = parent;
  }
  return names;
}

async function collectPages(
  next: (cursor: string | null) => Promise<{ items: Array<{ id: string }>; nextCursor: string | null }>
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await next(cursor);
    for (const item of result.items) ids.push(item.id);
    if (!result.nextCursor || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  return ids;
}

// ---- checkout ----------------------------------------------------------------------

export interface CheckoutArgs {
  dir?: string;
  all: boolean;
  consultas: string[];
  titulos: string[];
  carpetas: string[];
  forzar: boolean;
}

export async function checkoutCommand(io: CommandIo, open: OpenLibrary, args: CheckoutArgs): Promise<number> {
  if (!args.all && args.consultas.length === 0 && args.titulos.length === 0 && args.carpetas.length === 0) {
    throw new UsageError('checkout: di qué sacar (--all, --consulta, --titulo o --carpeta)');
  }
  let workdir: Workdir;
  if (args.dir !== undefined) workdir = new Workdir(resolve(io.cwd, args.dir));
  else {
    try {
      workdir = findWorkdir(io.cwd, undefined);
    } catch {
      throw new UsageError('checkout: falta --dir <carpeta de trabajo>');
    }
  }
  const release = workdir.acquireLock();
  try {
    return await checkoutLocked(io, open, args, workdir);
  } finally {
    release();
  }
}

async function checkoutLocked(io: CommandIo, open: OpenLibrary, args: CheckoutArgs, workdir: Workdir): Promise<number> {
  const lib = await open();
  try {
    const round = await syncRoundQuietly(lib);
    const filter = await PrivacyFilter.build(lib.port, lib.privacyConfig);
    if (filter.unresolved) {
      throw new WorkdirError(
        'la configuración de privados no se puede aplicar (una carpeta privada configurada no existe): no se saca nada'
      );
    }
    const libraryId = await lib.port.libraryId();
    const existing = workdir.exists() ? workdir.readCheckout() : null;
    if (existing && existing.biblioteca !== libraryId) {
      throw new WorkdirError('esa carpeta de trabajo es de otra biblioteca');
    }

    // Carpetas pedidas: visibles y existentes, con sus subcarpetas.
    let allowed: Set<string> | null = null;
    const folderIds: string[] = [];
    for (const path of args.carpetas) {
      const id = filter.folderIdForPath(path);
      if (id === undefined || filter.isFolderHidden(id)) {
        throw new WorkdirError(`no existe la carpeta «${path}»`);
      }
      folderIds.push(id);
      allowed ??= new Set();
      for (const sub of filter.folderSubtree(id)) allowed.add(sub);
    }

    const candidates: string[] = [];
    const titleOf = new Map<string, string>();
    if (args.all) {
      candidates.push(...(await collectPages((cursor) => lib.port.notesPage(cursor, PAGE_SIZE, { kind: 'all' }))));
    }
    for (const query of args.consultas) {
      candidates.push(...(await collectPages((cursor) => lib.port.search(query, cursor, PAGE_SIZE, null, null))));
    }
    for (const title of args.titulos) {
      for (const item of (await lib.port.notesByExactTitle(title)).items) {
        candidates.push(item.id);
        if (!titleOf.has(item.id)) titleOf.set(item.id, title);
      }
    }
    if (!args.all && args.consultas.length === 0 && args.titulos.length === 0) {
      for (const folderId of folderIds) {
        candidates.push(
          ...(await collectPages((cursor) =>
            lib.port.notesPage(cursor, PAGE_SIZE, { kind: 'folder', folderId, subfolders: true })
          ))
        );
      }
    }

    // Se leen las candidatas; qué sale se decide DESPUÉS, con un filtro rehecho tras leer
    // (una ronda de sync a mitad pudo volver privada alguna: `canLeave`).
    const read: NoteRow[] = [];
    const seen = new Set<string>();
    for (const id of candidates) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = await lib.port.noteRead(id);
      if (row) read.push(row);
    }
    // Y las sacadas antes que esta vez no se piden: por si ya no pueden estar en disco.
    const previous = new Map<string, NoteRow | null>();
    for (const entry of existing?.notas ?? []) {
      if (!seen.has(entry.id)) previous.set(entry.id, await lib.port.noteRead(entry.id));
    }
    const fresh = await PrivacyFilter.build(lib.port, lib.privacyConfig);
    if (fresh.unresolved) {
      throw new WorkdirError(
        'la configuración de privados no se puede aplicar (una carpeta privada configurada no existe): no se saca nada'
      );
    }

    // Notas que salen: vivas, visibles, sin bloquear, no copias de conflicto ni archivadas.
    const rows: NoteRow[] = [];
    const leftOut = new Set<string>();
    const foundTitles = new Set<string>();
    let shaMismatch = 0;
    for (const row of read) {
      if (!canLeave(row, fresh)) {
        leftOut.add(row.id);
        continue;
      }
      if (allowed && !allowed.has(row.effectiveFolderId)) continue;
      if (sha256Hex(row.body) !== row.bodySha256) {
        shaMismatch += 1;
        continue;
      }
      const title = titleOf.get(row.id);
      if (title !== undefined) foundTitles.add(title);
      rows.push(row);
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const at = nowOf(io).toISOString();
    const entries = new Map<string, string>();
    for (const entry of existing?.notas ?? []) entries.set(entry.id, entry.ruta);

    // Lo sacado antes que ya no puede estar en disco (privado ahora, en la papelera,
    // bloqueado o borrado): sin editar, se retira; editado, se avisa sin nombrarlo.
    let retired = 0;
    let keptEdited = 0;
    const readIds = new Set(read.map((row) => row.id));
    for (const [id, ruta] of entries) {
      const gone = previous.has(id)
        ? !canLeave(previous.get(id) ?? null, fresh)
        : leftOut.has(id) || !readIds.has(id);
      if (!gone) continue;
      const meta = workdir.readMeta(id);
      const file = meta && safeRuta(meta.ruta) !== null ? workdir.readNoteFile(meta.ruta) : null;
      const base = meta ? workdir.readBase(meta) : null;
      if (file !== null && file !== base) {
        keptEdited += 1;
        continue;
      }
      workdir.removeNote(id, meta?.ruta ?? ruta);
      entries.delete(id);
      retired += 1;
    }

    // Rutas: las ya sacadas conservan la suya; las nuevas, sin chocar (NFC y minúsculas).
    const used = new Set([...entries.values()].map(pathKey));
    const taken: string[] = [];
    const notOverwritten: string[] = [];
    for (const row of rows) {
      const known = entries.get(row.id);
      const ruta =
        known !== undefined && safeRuta(known) !== null
          ? known
          : assignNotePath(used, folderNames(fresh, row.effectiveFolderId), row.title, row.id);
      const meta = workdir.readMeta(row.id);
      if (!args.forzar) {
        const metaRuta = meta && safeRuta(meta.ruta) !== null ? meta.ruta : null;
        const file = workdir.readNoteFile(metaRuta ?? ruta);
        const base = meta ? workdir.readBase(meta) : null;
        // Una edición que ya quedó en una copia de conflicto está a salvo en Hebra: volver a
        // sacar la nota la refresca. Cualquier otra edición sin devolver no se pisa, y un
        // fichero que no es de esta carpeta (sin metadatos) tampoco.
        const savedInCopy =
          file !== null && meta?.conflicto?.tipo === 'copia' && sha256Hex(file) === meta.conflicto.sha;
        const foreign = meta === null && file !== null && file !== row.body;
        if (foreign || (meta !== null && file !== null && (base === null || file !== base) && !savedInCopy)) {
          notOverwritten.push(metaRuta ?? ruta);
          continue;
        }
      }
      entries.set(row.id, ruta);
      const next: NoteMeta = { id: row.id, ruta, rev: row.localSeq, sha: row.bodySha256, sacadaEn: at };
      workdir.setBase(next, row.body);
      workdir.writeNoteFile(ruta, row.body);
      taken.push(ruta);
    }
    const notas = [...entries].map(([id, ruta]) => ({ id, ruta })).sort((a, b) => (a.ruta < b.ruta ? -1 : 1));
    const file: CheckoutFile = {
      version: 1,
      biblioteca: libraryId,
      // La base más antigua de las sacadas, no la de hoy: una sacada parcial no rejuvenece
      // el aviso de 24 h de las demás.
      sacadaEn: oldest(
        notas.map(({ id }) => workdir.readMeta(id)?.sacadaEn ?? existing?.sacadaEn),
        at
      ),
      notas
    };
    workdir.writeCheckout(file);

    const where = display(io, workdir.root);
    io.out(`Sacadas ${taken.length} notas en ${where} (sync: ${describeRound(round, lib.role)}).`);
    if (taken.length <= MAX_LISTED_PATHS) {
      for (const ruta of taken.sort()) io.out(`  ${shown(io, workdir, ruta)}`);
    } else {
      io.out(`  ${where}/**/*.md (los nombres llevan el principio del id de la nota entre paréntesis)`);
    }
    if (notOverwritten.length > 0) {
      io.out(`Editadas sin devolver, no se han pisado (devuélvelas o usa --forzar): ${notOverwritten.length}`);
      for (const ruta of notOverwritten.slice(0, MAX_LISTED_PATHS)) io.out(`  ${shown(io, workdir, ruta)}`);
    }
    for (const title of args.titulos) {
      if (!foundTitles.has(title)) io.out(`Sin nota con el título «${title}».`);
    }
    if (shaMismatch > 0) io.out(`${shaMismatch} notas no se han sacado: su SHA no casa con el del almacén.`);
    // Sin nombrarlas: alguna puede haberse vuelto privada.
    if (retired > 0) {
      io.out(
        retired === 1
          ? 'Retirada 1 nota sacada antes que ya no se puede sacar (privada, en la papelera, bloqueada o borrada).'
          : `Retiradas ${retired} notas sacadas antes que ya no se pueden sacar (privadas, en la papelera, bloqueadas o borradas).`
      );
    }
    if (keptEdited > 0) {
      io.out(
        keptEdited === 1
          ? '1 nota sacada antes ya no se puede sacar y tiene una edición sin devolver: su fichero no se ha tocado, y apply no la devolverá.'
          : `${keptEdited} notas sacadas antes ya no se pueden sacar y tienen ediciones sin devolver: sus ficheros no se han tocado, y apply no las devolverá.`
      );
    }
    io.out(`Edita los .md y devuelve con: hebra-mcp apply --dir ${where}   (para ver antes el diff: --simular)`);
    return 0;
  } finally {
    await lib.close();
  }
}

// ---- lo que hay en la carpeta -------------------------------------------------------

type ScanState = 'sin_cambios' | 'editada' | 'falta' | 'base_danada';

interface ScanEntry {
  id: string;
  ruta: string;
  state: ScanState;
  meta: NoteMeta | null;
  base: string | null;
  edited: string | null;
}

interface Scan {
  checkout: CheckoutFile;
  entries: ScanEntry[];
  untracked: string[];
}

function scan(workdir: Workdir): Scan {
  const checkout = workdir.readCheckout();
  const entries: ScanEntry[] = [];
  const tracked = new Set<string>();
  for (const { id, ruta } of checkout.notas) {
    tracked.add(workdir.keyOf(ruta));
    const meta = workdir.readMeta(id);
    // Una ruta tocada a mano (absoluta, con `..`, dentro de `.hebra-d`…) en cualquiera de
    // los dos JSON es una base dañada: ni se lee ni se devuelve (`safeRuta`).
    const valid = safeRuta(ruta) !== null && (meta === null || safeRuta(meta.ruta) !== null);
    const base = meta && valid ? workdir.readBase(meta) : null;
    const edited = valid ? workdir.readNoteFile(meta?.ruta ?? ruta) : null;
    let state: ScanState;
    if (!meta || base === null) state = 'base_danada';
    else if (edited === null) state = 'falta';
    else state = edited === base ? 'sin_cambios' : 'editada';
    entries.push({ id, ruta: meta?.ruta ?? ruta, state, meta, base, edited });
  }
  const untracked = workdir.listMarkdown().filter((ruta) => !tracked.has(workdir.keyOf(ruta)));
  return { checkout, entries, untracked };
}

// ---- status ------------------------------------------------------------------------

export interface StatusArgs {
  dir?: string;
  rutas: boolean;
}

export function statusCommand(io: CommandIo, args: StatusArgs): number {
  const workdir = findWorkdir(io.cwd, args.dir);
  const { checkout, entries, untracked } = scan(workdir);
  const pending = entries.filter((entry) => entry.state === 'editada' && !entry.meta?.conflicto);
  const conflicted = entries.filter((entry) => entry.meta?.conflicto);
  const missing = entries.filter((entry) => entry.state === 'falta');
  const damaged = entries.filter((entry) => entry.state === 'base_danada');
  const lists: Array<[string, string[]]> = [
    ['editadas sin devolver', pending.map((entry) => entry.ruta)],
    ['en conflicto (no se devuelven hasta otro checkout)', conflicted.map((entry) => entry.ruta)],
    ['faltan (renombradas o borradas: no se devuelven)', missing.map((entry) => entry.ruta)],
    ['sin seguimiento (D no crea notas desde ficheros)', untracked],
    ['base dañada (vuelve a sacarlas con checkout --forzar)', damaged.map((entry) => entry.ruta)]
  ];
  // La base más antigua, nota a nota: una sacada parcial reciente no esconde las viejas.
  const since = oldest(
    entries.map((entry) => entry.meta?.sacadaEn ?? checkout.sacadaEn),
    checkout.sacadaEn
  );
  io.out(`${display(io, workdir.root)}: ${entries.length} notas sacadas; la base más antigua es del ${since}.`);
  const age = nowOf(io).getTime() - Date.parse(since);
  if (age > STALE_CHECKOUT_MS) {
    io.out('Aviso: la sacada tiene más de 24 h; lo que devuelvas puede chocar con lo editado en Hebra.');
  }
  for (const [label, rutas] of lists) {
    if (rutas.length === 0) continue;
    io.out(`${rutas.length} ${label}:`);
    for (const ruta of args.rutas ? rutas : rutas.slice(0, STATUS_LIST)) io.out(`  ${shown(io, workdir, ruta)}`);
    if (!args.rutas && rutas.length > STATUS_LIST) io.out(`  (… ${rutas.length - STATUS_LIST} más; --rutas para todas)`);
  }
  if (lists.every(([, rutas]) => rutas.length === 0)) io.out('Nada editado.');
  return 0;
}

// ---- diff --------------------------------------------------------------------------

export interface DiffArgs {
  dir?: string;
  stat: boolean;
  files: string[];
}

export function diffCommand(io: CommandIo, args: DiffArgs): number {
  const workdir = findWorkdir(io.cwd, args.dir);
  const { entries } = scan(workdir);
  let selected = entries.filter((entry) => entry.state === 'editada');
  if (args.files.length > 0) {
    const wanted = new Set(
      args.files.map((file) => workdir.keyOf(toPosixRelative(relative(workdir.root, resolve(io.cwd, file))).normalize('NFC')))
    );
    selected = selected.filter((entry) => wanted.has(workdir.keyOf(entry.ruta)));
  }
  for (const entry of selected) {
    if (args.stat) {
      const { added, removed } = diffStat(entry.base!, entry.edited!);
      io.out(`${shown(io, workdir, entry.ruta)}  +${added} -${removed}`);
    } else {
      io.out(unifiedDiff(entry.base!, entry.edited!, entry.ruta).trimEnd());
    }
  }
  if (selected.length === 0) io.out('Sin cambios.');
  return 0;
}

// ---- apply -------------------------------------------------------------------------

export interface ApplyArgs {
  dir?: string;
  conflicto: 'copia' | 'rechazar';
  simular: boolean;
}

/** Solo para tests (SPEC.md §13.8): nunca llegan de la línea de órdenes. */
export interface ApplyTestHooks {
  /** Tras escribir la nota `index` y ANTES de poner al día sus metadatos (el hueco del
   *  `kill -9` «dentro de una nota»). */
  afterWrite?: (index: number, id: string) => Promise<void>;
}

const OUTCOME_LABEL: Record<ApplyOutcomeName, string> = {
  aplicada: 'aplicada',
  ya_estaba: 'ya estaba (la dejó un apply cortado)',
  copia_de_conflicto: 'copia de conflicto: la nota cambió en Hebra; tu versión está en la copia',
  rechazada_por_conflicto: 'rechazada: la nota cambió en Hebra (no se escribió nada)',
  no_disponible: 'no disponible (borrada, en la papelera u oculta): no se escribió nada',
  bloqueada: 'bloqueada: no se escribió nada'
};

const NOT_CLEAN: ReadonlySet<ApplyOutcomeName> = new Set([
  'copia_de_conflicto',
  'rechazada_por_conflicto',
  'no_disponible',
  'bloqueada'
]);

function outcomeName(result: ReplaceBodyResult): ApplyOutcomeName {
  switch (result.outcome) {
    case 'applied':
      return 'aplicada';
    case 'already':
      return 'ya_estaba';
    case 'conflict_copy':
      return 'copia_de_conflicto';
    case 'conflict_rejected':
      return 'rechazada_por_conflicto';
    case 'unavailable':
      return 'no_disponible';
    case 'locked':
      return 'bloqueada';
  }
}

function newLoteId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/** Bloque compacto de una nota para la salida, respetando el tope total. */
class CompactBudget {
  private used = 0;
  private omitted = 0;
  constructor(private readonly io: CommandIo) {}

  print(header: string, lines: string[]): void {
    const block = [header, ...lines.map((line) => `    ${line}`)];
    const size = block.join('\n').length;
    if (this.used + size > COMPACT_TOTAL_CHARS) {
      this.omitted += 1;
      return;
    }
    this.used += size;
    for (const line of block) this.io.out(line);
  }

  finish(where: string): void {
    if (this.omitted > 0) this.io.out(`  (… ${this.omitted} notas más; el diff entero está en ${where})`);
  }
}

function errorCode(error: unknown): string {
  if (isBusyOtherInstance(error)) return 'busy_other_instance';
  if (error instanceof StoreError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.message : 'unknown';
}

function writeFailure(code: string): string {
  if (code === 'busy_other_instance') return 'el escritor (otro proceso de hebra-mcp) no respondió';
  if (code === 'invalid_request') {
    return 'el escritor (otro proceso de hebra-mcp) no entiende esta orden: es de una versión anterior; ciérralo o actualízalo';
  }
  if (code === 'privacy_config_unresolved') return 'la configuración de privados no se puede aplicar';
  return `el escritor falló (${code})`;
}

export async function applyCommand(
  io: CommandIo,
  open: OpenLibrary,
  args: ApplyArgs,
  hooks: ApplyTestHooks = {}
): Promise<number> {
  const workdir = findWorkdir(io.cwd, args.dir);
  // `--simular` no escribe nada en la carpeta: no necesita el cerrojo.
  const release = args.simular ? () => undefined : workdir.acquireLock();
  try {
    return await applyLocked(io, open, args, hooks, workdir);
  } finally {
    release();
  }
}

async function applyLocked(
  io: CommandIo,
  open: OpenLibrary,
  args: ApplyArgs,
  hooks: ApplyTestHooks,
  workdir: Workdir
): Promise<number> {
  const { checkout, entries, untracked } = scan(workdir);
  const candidates = entries
    .filter((entry) => entry.state === 'editada' && !entry.meta?.conflicto)
    .sort((a, b) => (a.ruta < b.ruta ? -1 : a.ruta > b.ruta ? 1 : 0));
  const damaged = entries.filter((entry) => entry.state === 'base_danada');
  const stillConflicted = entries.filter((entry) => entry.state === 'editada' && entry.meta?.conflicto);
  const tooLarge = candidates.filter((entry) => entry.edited!.length > REPLACE_BODY_MAX_LENGTH);
  const toApply = candidates.filter((entry) => entry.edited!.length <= REPLACE_BODY_MAX_LENGTH);
  let unclean = damaged.length > 0 || stillConflicted.length > 0 || tooLarge.length > 0;

  const reportSide = (): void => {
    for (const entry of damaged) io.out(`  ${shown(io, workdir, entry.ruta)}  base dañada: no se devuelve (checkout --forzar)`);
    for (const entry of stillConflicted) {
      io.out(`  ${shown(io, workdir, entry.ruta)}  en conflicto de antes: no se devuelve hasta otro checkout`);
    }
    for (const entry of tooLarge) io.out(`  ${shown(io, workdir, entry.ruta)}  demasiado grande para devolverla`);
    const missing = entries.filter((entry) => entry.state === 'falta');
    if (missing.length > 0) io.out(`  ${missing.length} faltan (renombradas o borradas): no se devuelven`);
    if (untracked.length > 0) io.out(`  ${untracked.length} sin seguimiento: D no crea notas desde ficheros`);
  };

  if (args.simular) {
    io.out(`Simulación: se devolverían ${toApply.length} notas. No se ha escrito nada.`);
    const budget = new CompactBudget(io);
    for (const entry of toApply) {
      const { added, removed } = diffStat(entry.base!, entry.edited!);
      budget.print(
        `  ${shown(io, workdir, entry.ruta)}  +${added} -${removed}`,
        compactDiff(entry.base!, entry.edited!, COMPACT_LINES_PER_NOTE)
      );
    }
    budget.finish('hebra-mcp diff');
    reportSide();
    return unclean ? 1 : 0;
  }

  if (toApply.length === 0) {
    io.out('Nada que devolver.');
    reportSide();
    return unclean ? 1 : 0;
  }

  const lib = await open();
  const lote = newLoteId(nowOf(io));
  const counts = new Map<ApplyOutcomeName, number>();
  const written: Array<{ entry: ScanEntry; name: ApplyOutcomeName; sha: string; copyId?: string }> = [];
  let failure: string | null = null;
  try {
    const libraryId = await lib.port.libraryId();
    if (libraryId !== checkout.biblioteca) {
      throw new WorkdirError('esta carpeta de trabajo es de otra biblioteca: no se devuelve nada');
    }
    const at = (): string => nowOf(io).toISOString();
    workdir.appendJournal(lote, { paso: 'lote', lote, conflicto: args.conflicto, en: at() });
    for (const [index, entry] of toApply.entries()) {
      const meta = entry.meta!;
      const edited = entry.edited!;
      const editedSha = sha256Hex(edited);
      workdir.appendJournal(lote, {
        paso: 'intento',
        id: entry.id,
        ruta: entry.ruta,
        shaBase: meta.sha,
        shaEditado: editedSha,
        en: at()
      });
      workdir.writeLoteBase(lote, entry.id, entry.base!);
      let result: ReplaceBodyResult;
      try {
        result = await lib.replaceBody({
          id: entry.id,
          body: edited,
          baseBodySha256: meta.sha,
          onConflict: args.conflicto === 'copia' ? 'copy' : 'reject'
        });
      } catch (error) {
        failure = writeFailure(errorCode(error));
        break;
      }
      await hooks.afterWrite?.(index, entry.id);
      const name = outcomeName(result);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (result.outcome === 'applied' || result.outcome === 'already') {
        workdir.setBase(
          { id: entry.id, ruta: entry.ruta, rev: result.localSeq, sha: result.bodySha256, sacadaEn: at() },
          edited
        );
      } else if (result.outcome === 'conflict_copy') {
        workdir.writeMeta({ ...meta, conflicto: { tipo: 'copia', lote, copyId: result.copyId, sha: editedSha } });
      } else if (result.outcome === 'conflict_rejected') {
        workdir.writeMeta({ ...meta, conflicto: { tipo: 'rechazada', lote, sha: editedSha } });
      }
      const done: JournalEntry =
        result.outcome === 'conflict_copy'
          ? { paso: 'hecho', id: entry.id, resultado: name, copyId: result.copyId, en: at() }
          : { paso: 'hecho', id: entry.id, resultado: name, en: at() };
      workdir.appendJournal(lote, done);
      if (name === 'aplicada' || name === 'ya_estaba' || name === 'copia_de_conflicto') {
        workdir.appendLoteDiff(lote, unifiedDiff(entry.base!, edited, entry.ruta));
      }
      written.push({
        entry,
        name,
        sha: editedSha,
        ...(result.outcome === 'conflict_copy' ? { copyId: result.copyId } : {})
      });
      if (NOT_CLEAN.has(name)) unclean = true;
    }

    const round = await syncRoundQuietly(lib);
    // La ronda pudo traer otra versión de una nota recién devuelta (alguien la editó en
    // otro dispositivo a la vez): el motor la resuelve con una copia de conflicto en Hebra.
    const changedBySync: string[] = [];
    for (const item of written) {
      if (item.name !== 'aplicada' && item.name !== 'ya_estaba') continue;
      const row = await lib.port.noteRead(item.entry.id);
      if (!row || row.bodySha256 !== item.sha) changedBySync.push(item.entry.ruta);
    }
    if (changedBySync.length > 0) unclean = true;

    const summary = [...counts].map(([name, count]) => `${count} ${name.replace(/_/gu, ' ')}`).join(', ');
    io.out(`Lote ${lote}: ${summary || 'nada escrito'} (sync: ${describeRound(round, lib.role)}).`);
    const budget = new CompactBudget(io);
    for (const item of written) {
      const { added, removed } = diffStat(item.entry.base!, item.entry.edited!);
      const label = OUTCOME_LABEL[item.name];
      const copy = item.copyId ? ` (${item.copyId.slice(0, 8)})` : '';
      const header = `  ${shown(io, workdir, item.entry.ruta)}  ${label}${copy}  +${added} -${removed}`;
      if (item.name === 'aplicada' || item.name === 'copia_de_conflicto') {
        budget.print(header, compactDiff(item.entry.base!, item.entry.edited!, COMPACT_LINES_PER_NOTE));
      } else {
        io.out(header);
      }
    }
    budget.finish(`${display(io, workdir.loteDir(lote))}/cambios.diff`);
    for (const ruta of changedBySync) {
      io.out(`  ${shown(io, workdir, ruta)}  la ronda de sync trajo otra versión: revisa las copias de conflicto en Hebra`);
    }
    reportSide();
    if (failure) {
      io.out(`Cortado: ${failure}. Lo hecho consta en el diario; repite apply para completar lo pendiente.`);
      unclean = true;
    }
    io.out(`Deshacer el lote: hebra-mcp undo --lote ${lote}`);
    return unclean ? 1 : 0;
  } finally {
    workdir.removeLoteIfEmpty(lote);
    await lib.close();
  }
}

// ---- undo --------------------------------------------------------------------------

export interface UndoArgs {
  dir?: string;
  lote: string;
}

interface UndoItem {
  id: string;
  ruta: string;
  shaEditado: string;
  resultado: ApplyOutcomeName | null;
  copyId?: string;
  /** Cuándo se intentó (epoch ms): una copia anterior no la pudo dejar este lote. */
  intentoEn: number;
}

/** Copias de conflicto que OTROS lotes anotaron como suyas, por nota: un lote cortado no
 *  las toca aunque tengan el mismo cuerpo. */
function copiesOfOtherLotes(workdir: Workdir, lote: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const other of workdir.lotes()) {
    if (other === lote) continue;
    for (const entry of workdir.readJournal(other)) {
      if (entry.paso === 'hecho' && entry.copyId) out.set(entry.id, [...(out.get(entry.id) ?? []), entry.copyId]);
    }
  }
  return out;
}

const UNDO_LABEL: Record<UndoOutcomeName, string> = {
  restaurada: 'restaurada',
  ya_estaba: 'ya estaba como antes del lote',
  cambiada_despues: 'cambió después del lote: no se toca',
  no_disponible: 'no disponible: no se toca',
  bloqueada: 'bloqueada: no se toca',
  copia_a_la_papelera: 'su copia de conflicto, a la papelera',
  copia_cambiada: 'su copia de conflicto cambió después: no se toca'
};

export async function undoCommand(io: CommandIo, open: OpenLibrary, args: UndoArgs): Promise<number> {
  const workdir = findWorkdir(io.cwd, args.dir);
  if (!workdir.hasLote(args.lote)) throw new WorkdirError(`no existe el lote ${args.lote}`);
  const release = workdir.acquireLock();
  try {
    return await undoLocked(io, open, args, workdir);
  } finally {
    release();
  }
}

async function undoLocked(io: CommandIo, open: OpenLibrary, args: UndoArgs, workdir: Workdir): Promise<number> {
  const checkout = workdir.readCheckout();
  const items = new Map<string, UndoItem>();
  const otherCopies = copiesOfOtherLotes(workdir, args.lote);
  for (const entry of workdir.readJournal(args.lote)) {
    if (entry.paso === 'intento') {
      const intentoEn = Date.parse(entry.en);
      items.set(entry.id, {
        id: entry.id,
        ruta: entry.ruta,
        shaEditado: entry.shaEditado,
        resultado: null,
        intentoEn: Number.isFinite(intentoEn) ? intentoEn : 0
      });
    } else if (entry.paso === 'hecho') {
      const item = items.get(entry.id);
      if (item) {
        item.resultado = entry.resultado;
        if (entry.copyId) item.copyId = entry.copyId;
      }
    }
  }
  const lib = await open();
  let unclean = false;
  const results: Array<{ ruta: string; name: UndoOutcomeName }> = [];
  try {
    if ((await lib.port.libraryId()) !== checkout.biblioteca) {
      throw new WorkdirError('esta carpeta de trabajo es de otra biblioteca: no se deshace nada');
    }
    const at = (): string => nowOf(io).toISOString();
    const record = (item: UndoItem, name: UndoOutcomeName): void => {
      workdir.appendJournal(args.lote, { paso: 'deshacer', id: item.id, resultado: name, en: at() });
      results.push({ ruta: item.ruta, name });
      if (name === 'cambiada_despues' || name === 'no_disponible' || name === 'bloqueada' || name === 'copia_cambiada') {
        unclean = true;
      }
    };
    for (const item of items.values()) {
      const { resultado } = item;
      if (resultado === 'rechazada_por_conflicto' || resultado === 'no_disponible' || resultado === 'bloqueada') {
        continue; // Ese lote no escribió nada en esta nota.
      }
      if (resultado === 'copia_de_conflicto') {
        // La copia que anotó el lote va a la papelera si sigue igual.
        const trashed = await lib.trashConflictCopies({
          originalId: item.id,
          bodySha256: item.shaEditado,
          ...(item.copyId ? { copyId: item.copyId } : {})
        });
        if (trashed.trashed > 0) record(item, 'copia_a_la_papelera');
        else if (trashed.changed > 0) record(item, 'copia_cambiada');
        continue;
      }
      const base = workdir.readLoteBase(args.lote, item.id);
      if (base === null) {
        record(item, 'no_disponible');
        continue;
      }
      // Lo que diga la biblioteca decide, no las copias: si el original es el editado, lo
      // escribió este lote y se restaura (`reject`: si cambió después, no se toca).
      const result = await lib.replaceBody({
        id: item.id,
        body: base,
        baseBodySha256: item.shaEditado,
        onConflict: 'reject'
      });
      let name: UndoOutcomeName;
      switch (result.outcome) {
        case 'applied':
          name = 'restaurada';
          break;
        case 'already':
          name = 'ya_estaba';
          break;
        case 'conflict_rejected':
        case 'conflict_copy':
          name = 'cambiada_despues';
          break;
        case 'unavailable':
          name = 'no_disponible';
          break;
        case 'locked':
          name = 'bloqueada';
          break;
      }
      if (resultado === null && result.outcome !== 'applied') {
        // Lote cortado tras «intento» y sin «hecho»: el original no es el editado, así que
        // si el lote escribió algo fue una copia de conflicto. Solo una de ESTE lote: con su
        // cuerpo, creada después del intento y que ningún otro lote anotó como suya.
        const trashed = await lib.trashConflictCopies({
          originalId: item.id,
          bodySha256: item.shaEditado,
          notBefore: item.intentoEn,
          exclude: otherCopies.get(item.id) ?? []
        });
        if (trashed.trashed > 0) {
          record(item, 'copia_a_la_papelera');
          continue;
        }
        // Nada que deshacer: el lote no llegó a escribir en esta nota.
        if (name === 'ya_estaba') continue;
      }
      record(item, name);
      if (result.outcome === 'applied') {
        // La carpeta de trabajo vuelve a la base si seguía como la dejó el lote; si el
        // fichero ya tenía otra edición, no se pisa y queda marcada para no devolverla.
        const meta = workdir.readMeta(item.id);
        if (meta && meta.sha === item.shaEditado && safeRuta(meta.ruta) !== null) {
          const file = workdir.readNoteFile(meta.ruta);
          const restored: NoteMeta = {
            id: meta.id,
            ruta: meta.ruta,
            rev: result.localSeq,
            sha: result.bodySha256,
            sacadaEn: at()
          };
          if (file !== null && sha256Hex(file) === item.shaEditado) {
            workdir.setBase(restored, base);
            workdir.writeNoteFile(meta.ruta, base);
          } else {
            workdir.setBase({ ...restored, conflicto: { tipo: 'deshecha', lote: args.lote } }, base);
          }
        }
      }
    }
    const round = await syncRoundQuietly(lib);
    io.out(`Deshecho el lote ${args.lote} (sync: ${describeRound(round, lib.role)}).`);
    for (const { ruta, name } of results) io.out(`  ${shown(io, workdir, ruta)}  ${UNDO_LABEL[name]}`);
    if (results.length === 0) io.out('  Nada que deshacer.');
    return unclean ? 1 : 0;
  } finally {
    await lib.close();
  }
}
