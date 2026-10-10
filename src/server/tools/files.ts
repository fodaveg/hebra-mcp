/**
 * Ficheros sueltos (D10, decisión de David del 9 oct 2026: «adelante con las tres»):
 * `hebra_list_files`, `hebra_trash_file` y `hebra_restore_file`. Un fichero suelto es un
 * recurso de la tabla `files` de Hebra (un `.base`, un PDF que no cuelga de una nota),
 * con carpeta propia. NO es un adjunto: esos van por `./attachments.ts`. Aquí no se lee
 * su contenido (eso es `./read-file.ts`, D15) ni se crea, renombra, mueve o purga
 * ninguno: no hay herramienta para eso. Reemplazar el texto de uno es
 * `./replace-file-text.ts` (D15).
 *
 * Privacidad (`FileFilter`, `src/privacy/file-filter.ts`; SPEC.md §6.3), la misma regla
 * para los vivos y para los de la papelera: oculto si su carpeta es privada (también si
 * ya se borró) o si lo enlaza una nota oculta. En tres sitios, como la papelera de notas
 * (`./organize.ts`):
 * 1. Aquí, antes de escribir, con el filtro de esta llamada. Se construye SIEMPRE, con
 *    las mismas consultas haya o no acierto, y `not_found` es el mismo para un fichero
 *    oculto, uno inexistente, una lápida, el id de una nota o un SHA-256.
 * 2. En el escritor, dentro del turno en que escribe y con esta misma configuración
 *    (`NoteWriter.organizeFileLocal`).
 * 3. Sobre el resultado de restaurar: la ruta que se devuelve sale de un filtro
 *    recalculado DESPUÉS de escribir. Si para entonces el fichero no fuera visible, se
 *    responde `not_found` en vez de enseñar una ruta privada.
 *
 * La lista no deja adivinar cuántos ficheros ocultos hay: no hay recuento, la página se
 * rellena solo con visibles y `nextCursor` solo es distinto de `null` si detrás queda al
 * menos otro VISIBLE. La salida nunca lleva el SHA-256 de los bytes ni la carpeta
 * guardada: solo la carpeta donde el fichero está o quedaría al restaurarlo.
 *
 * Logs (§6.4): `file.organize` con el id (opaco), la acción y el estado de sync, en cuanto
 * el escritor responde (también si la herramienta acaba después en error). Nunca el
 * nombre.
 */
import { logEvent } from '../../log/logger';
import { FileFilter, type VisibleFile } from '../../privacy/file-filter';
import { PrivacyFilter } from '../../privacy/filter';
import type { OrganizeFileAction } from '../../store/writes';
import type { ToolContext } from '../context';
import { ToolError } from '../errors';
import { LIMITS, effectiveLimit, sliceAfterKey, unwrapCursor, wrapCursor } from '../pagination';
import { syncOf, type FileOutcome, type SyncFields } from '../write-context';
import { mapWriteError } from './write-errors';

export interface ListedFile {
  id: string;
  name: string;
  /** Donde está o, en la papelera, donde volverá al restaurarlo (vacío = la raíz). */
  folderPath: string;
  mimeType: string | null;
  byteLength: number | null;
  updatedAt: string;
  /** `null` en los vivos. */
  trashedAt: string | null;
}

/** Longitud máxima del filtro `name` de `hebra_list_files` (SPEC.md §5). */
export const FILE_NAME_FILTER_MAX_LENGTH = 255;

/**
 * Cuántos caracteres del nombre entran en la clave de orden de los vivos. El cursor lleva
 * esa clave y un cursor no pasa de 2 048 caracteres (`pagination.ts`): el motor no pone
 * tope al nombre de un fichero, y con el nombre entero uno muy largo daría un
 * `nextCursor` que la página siguiente rechazaría. Dos ficheros que coinciden en estos
 * 200 caracteres se ordenan por id.
 */
const FILE_SORT_NAME_CHARS = 200;

/** Nombre para comparar sin distinguir mayúsculas ni la forma de una tilde (NFC). */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Clave de orden de un fichero, que es también lo que lleva el cursor:
 * - vivos (`n`): los primeros caracteres del nombre en minúsculas y el id, ascendentes;
 * - papelera (`t`): la fecha en que entró y el id, los dos descendentes (la más reciente
 *   primero; `folderTrash` de Hebra manda varios con la MISMA fecha, y entre ellos manda
 *   el id).
 * El primer elemento distingue las dos listas, para que un cursor de una no valga en la
 * otra.
 */
type FileSortKey = readonly ['n', string, string] | readonly ['t', number, string];

function sortKeyOf(file: VisibleFile): FileSortKey {
  return file.trashedAt === null
    ? ['n', nameKey(file.name).slice(0, FILE_SORT_NAME_CHARS), file.id]
    : ['t', file.trashedAt, file.id];
}

/** Por unidades de código, no por `localeCompare`: el mismo orden en cualquier máquina. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSortKeys(left: FileSortKey, right: FileSortKey): number {
  if (left[0] === 'n' && right[0] === 'n') {
    return compareText(left[1], right[1]) || compareText(left[2], right[2]);
  }
  if (left[0] === 't' && right[0] === 't') {
    // Los dos términos en descendente, como el motor (`ORDER BY trashed_at DESC, id DESC`
    // de `filesTrashPage`) y como `hebra_list_trash`.
    return right[1] - left[1] || compareText(right[2], left[2]);
  }
  // Nunca se mezclan: una lista es de vivos o de la papelera.
  return compareText(left[0], right[0]);
}

/** La clave que lleva un cursor de `hebra_list_files`; ilegible, de otra herramienta o de
 *  la otra lista (vivos frente a papelera): `invalid_input`. */
function cursorKeyOf(cursor: string, trashed: boolean): FileSortKey {
  let value: unknown;
  try {
    value = JSON.parse(unwrapCursor('fl1', cursor));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError('invalid_input');
  }
  if (!Array.isArray(value) || value.length !== 3 || typeof value[2] !== 'string') {
    throw new ToolError('invalid_input');
  }
  const [kind, sort, id] = value as [unknown, unknown, string];
  if (!trashed && kind === 'n' && typeof sort === 'string') return ['n', sort, id];
  if (trashed && kind === 't' && typeof sort === 'number' && Number.isFinite(sort)) {
    return ['t', sort, id];
  }
  throw new ToolError('invalid_input');
}

/**
 * `hebra_list_files`: los ficheros sueltos visibles. Sin `trashed`, los vivos, por nombre
 * (en minúsculas) y después por id; con `trashed: true`, los de la papelera, el último en
 * entrar primero, con la carpeta a la que volverían. `folder` (ruta, con `subfolders`
 * para su subárbol) y `name` (subcadena, sin distinguir mayúsculas) filtran; una carpeta
 * privada o inexistente da lista vacía en los dos casos, como en `hebra_list_notes`.
 *
 * La lista sale entera del índice del almacén (`filesIndex`), se filtra y se ordena en
 * memoria, y se pagina con un cursor POSICIONAL por clave de orden (`sliceAfterKey`): la
 * página siguiente empieza en el primero que va después del último devuelto, siga ese en
 * la lista o no. Listar, mandar a la papelera el último de la página y pedir la siguiente
 * es el uso previsto.
 */
export async function runListFiles(
  ctx: ToolContext,
  input: {
    folder?: string;
    subfolders?: boolean;
    name?: string;
    trashed?: boolean;
    limit?: number;
    cursor?: string;
  }
): Promise<{ files: ListedFile[]; nextCursor: string | null }> {
  const limit = effectiveLimit(input.limit, LIMITS.listFiles);
  const trashed = input.trashed === true;
  if (
    input.name !== undefined &&
    (input.name.length === 0 || input.name.length > FILE_NAME_FILTER_MAX_LENGTH)
  ) {
    throw new ToolError('invalid_input');
  }
  const after = input.cursor === undefined ? null : cursorKeyOf(input.cursor, trashed);
  const needle = input.name === undefined ? undefined : nameKey(input.name);

  let folderIds: ReadonlySet<string> | undefined;
  if (input.folder !== undefined) {
    const resolved = ctx.privacy.folderIdForPath(input.folder);
    if (!resolved || ctx.privacy.isFolderHidden(resolved)) return { files: [], nextCursor: null };
    folderIds = new Set(input.subfolders ? ctx.privacy.folderSubtree(resolved) : [resolved]);
  }

  const filter = await FileFilter.build(ctx.port, ctx.privacy, ctx.privacyConfig);
  const listed = filter
    .visibleFiles()
    .filter(
      (file) =>
        (file.trashedAt !== null) === trashed &&
        (folderIds === undefined || folderIds.has(file.folderId)) &&
        (needle === undefined || nameKey(file.name).includes(needle))
    )
    .map((file) => ({ file, key: sortKeyOf(file) }))
    .sort((left, right) => compareSortKeys(left.key, right.key));

  const page = sliceAfterKey(listed, {
    limit,
    after,
    keyOf: (entry) => entry.key,
    compare: compareSortKeys
  });
  return {
    files: page.items.map(({ file }) => ({
      id: file.id,
      name: file.name,
      folderPath: ctx.privacy.folderPath(file.folderId),
      mimeType: file.mime,
      byteLength: file.byteLength,
      updatedAt: new Date(file.updatedAt).toISOString(),
      trashedAt: file.trashedAt === null ? null : new Date(file.trashedAt).toISOString()
    })),
    nextCursor: page.lastKey === null ? null : wrapCursor('fl1', JSON.stringify(page.lastKey))
  };
}

/**
 * Paso 1 de la cabecera, la escritura y su log. El filtro se construye siempre, sin
 * atajos: un id de un fichero visible, uno oculto y uno que no existe hacen las mismas
 * consultas, y los dos últimos salen por la misma línea.
 *
 * `file.organize` se emite AQUÍ, en cuanto el escritor responde, y no al final de la
 * herramienta: al restaurar todavía queda recalcular el filtro, que puede acabar en error
 * (`privacy_config_unresolved` o `not_found`) con el fichero ya restaurado. Lo escrito
 * queda registrado aunque la respuesta sea un error.
 */
async function organizeFile(ctx: ToolContext, action: OrganizeFileAction): Promise<FileOutcome> {
  const filter = await FileFilter.build(ctx.port, ctx.privacy, ctx.privacyConfig);
  if (!filter.isVisible(action.id)) throw new ToolError('not_found');
  if (!ctx.write) throw new ToolError('invalid_input');
  let outcome: FileOutcome;
  try {
    outcome = await ctx.write.organizeFile({ ...action, privacy: ctx.privacyConfig });
  } catch (error) {
    throw mapWriteError(error);
  }
  logEvent({ event: 'file.organize', id: outcome.id, action: action.action, sync: outcome.sync });
  return outcome;
}

export type FileTrashOutput = { id: string; trashed: true } & SyncFields;

/** `hebra_trash_file`: manda un fichero suelto visible a la papelera (reversible con
 *  `hebra_restore_file` o desde Hebra). Idempotente: uno que ya está en la papelera y es
 *  visible se queda como está, sin escribir. La salida no lleva ruta ni nombre. */
export async function runTrashFile(
  ctx: ToolContext,
  input: { id: string }
): Promise<FileTrashOutput> {
  const outcome = await organizeFile(ctx, { action: 'trashFile', id: input.id });
  return { id: outcome.id, trashed: true, ...syncOf(outcome) };
}

export type FileRestoreOutput = { id: string; folderPath: string } & SyncFields;

/** `hebra_restore_file`: saca un fichero suelto de la papelera, a su carpeta si sigue
 *  viva o a la raíz (como Hebra). Idempotente: uno vivo y visible se queda como está. La
 *  ruta de la salida sale de los filtros de DESPUÉS de escribir (paso 3 de la cabecera);
 *  si para entonces la configuración de privados no se pudiera aplicar, cerrado ante la
 *  duda: `privacy_config_unresolved` en vez de una ruta sin filtrar, y `not_found` si el
 *  fichero pasó a oculto. En los dos casos la escritura ya está hecha y registrada
 *  (`file.organize`, en `organizeFile`); la respuesta no da ruta. */
export async function runRestoreFile(
  ctx: ToolContext,
  input: { id: string }
): Promise<FileRestoreOutput> {
  const outcome = await organizeFile(ctx, { action: 'restoreFile', id: input.id });
  const after = await PrivacyFilter.build(ctx.port, ctx.privacyConfig);
  if (after.unresolved) throw new ToolError('privacy_config_unresolved');
  const meta = (await FileFilter.build(ctx.port, after, ctx.privacyConfig)).visibleMeta(outcome.id);
  if (!meta) throw new ToolError('not_found');
  return { id: outcome.id, folderPath: after.folderPath(meta.folderId), ...syncOf(outcome) };
}
