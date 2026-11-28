/**
 * Mandar una carpeta a la papelera y sacarla (D29, 28 nov 2026; SPEC.md §3, §5 y §6.3), en un
 * turno exclusivo del escritor, como `./note-state.ts`, con el filtro de privados de quien pide
 * construido DENTRO del turno. Las dos acciones son las del motor de Hebra, las mismas que usa la
 * app (`folderTrash`, `folderRestore`), también en un espacio compartido:
 *
 * - `trashFolder`: la carpeta, sus subcarpetas y lo que tienen vivo (notas y ficheros sueltos)
 *   van a la papelera con UNA marca de tiempo. Es lo que hace «Enviar a la papelera…» de la app
 *   («Carpeta, subcarpetas, notas y archivos en la papelera»): una carpeta con contenido se manda
 *   con él, también lo que el MCP no ve, que sigue oculto en la papelera (lo juzga el filtro de la
 *   papelera, `../privacy/trash-filter.ts`). Nada de lo que la carpeta tiene dentro decide la
 *   respuesta, como al mover una carpeta a un ID (`./jd-move.ts`).
 * - `restoreFolder`: saca la carpeta, sus subcarpetas del mismo borrado y lo que entró con ellas
 *   (lo que ya estaba en la papelera antes se queda), y las antecesoras que también estuvieran en
 *   la papelera. Lo que vuelve oculto, vuelve oculto.
 *
 * Nada de esto purga: `folderPurge`, `folderUndoTrash` y `folderTrashEmpty` siguen fuera de
 * hebra-mcp (`test/store/surface.node.test.ts`).
 *
 * Privacidad, en este orden (el de `./folders.ts`, D9):
 * 1. La raíz no se manda a la papelera ni se saca: `invalid_input` (`root_folder_immutable`).
 * 2. Visibilidad: una carpeta viva oculta, una de la papelera que el filtro de la papelera no
 *    deja ver (`restoreFolderOf`, la regla de `hebra_list_trash` con `kind: "folders"`), una lápida
 *    o un id que no existe: `not_found`, todo igual.
 * 3. DESDE LA CONFIGURACIÓN, antes del motor, la regla de `hebra_rename_folder` y de mover a un
 *    ID: una carpeta en una ruta privada configurada o con una ruta privada configurada por debajo
 *    de la suya (`isPrivatePathPrefix`) responde `folder_unavailable`. Mandarla a la papelera se
 *    llevaría la carpeta privada, y la configuración dejaría de resolver (`privacy_config_unresolved`
 *    para toda herramienta, R5); sacarla la devolvería. Lo único que delata es la configuración (la
 *    fuga aceptada en D9).
 * 4. Ya en el estado pedido (viva y visible al sacarla, o ya en la papelera y visible al mandarla):
 *    sin escribir (`changed: false`). El motor marcaría filas sucias otra vez.
 *
 * La carpeta de la papelera se juzga con su ruta original: los nombres de las antecesoras que
 * también están en la papelera hasta la primera viva (su ruta de ahora), en minúsculas y sin
 * espacios en los extremos, como compara `privateFolders`.
 *
 * Op propia de `writer.sock` (`organizeFolder`): un escritor anterior la rechaza sin escribir
 * (`writer_outdated` en el lector).
 */
import { LibraryError, ROOT_FOLDER_ID } from '../hebra';
import type { PrivacyConfig } from '../privacy/config';
import type { PrivacyFilter } from '../privacy/filter';
import { TrashFilter } from '../privacy/trash-filter';
import { writeRejected } from './errors';
import type { FolderTrashEntry } from './state-reads';
import { privacyInTurnFor, type FolderSaved, type LocalWrite, type NoteWriteTarget } from './writes';

export type FolderTrashActionName = 'trashFolder' | 'restoreFolder';

/** Una acción sobre una carpeta, con la configuración de quien pide. */
export interface FolderTrashInput {
  action: FolderTrashActionName;
  id: string;
  privacy: PrivacyConfig;
}

export type FolderTrashRejectionCode = 'invalid_input' | 'not_found' | 'folder_unavailable';

/** Lo que haría la acción, decidido sin escribir. */
export type FolderTrashPlan =
  | { kind: 'reject'; code: FolderTrashRejectionCode }
  /** Ya está como se pide: nada que escribir. */
  | { kind: 'unchanged' }
  | { kind: 'write' };

/** Lo que el plan necesita saber de la papelera: las carpetas que están en ella y el filtro de la
 *  papelera de esta misma lectura. */
export interface FolderTrashView {
  trashed: readonly FolderTrashEntry[];
  trash: Pick<TrashFilter, 'restoreFolderOf'>;
}

/** El segmento de ruta de un nombre, como `folderPathSegments` del filtro. */
function segmentOf(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * La ruta original de una carpeta de la papelera, en segmentos: los nombres de ella y de sus
 * antecesoras de la papelera, debajo de la primera viva (su ruta de ahora). `null` si la subida no
 * llega a una carpeta viva ni a la raíz (una antecesora purgada, un ciclo): no se puede saber.
 */
export function trashedFolderSegments(
  live: Pick<PrivacyFilter, 'folderExists' | 'folderSegments'>,
  trashed: readonly FolderTrashEntry[],
  id: string
): string[] | null {
  const byId = new Map(trashed.map((entry) => [entry.id, entry] as const));
  const names: string[] = [];
  const seen = new Set<string>();
  for (let current: string | null = id; ; ) {
    if (current === null || current === ROOT_FOLDER_ID) return names;
    if (live.folderExists(current)) return [...live.folderSegments(current), ...names];
    const entry = byId.get(current);
    if (!entry || seen.has(current)) return null;
    seen.add(current);
    names.unshift(segmentOf(entry.name));
    current = entry.parentId;
  }
}

/** La regla de la configuración (paso 3 de la cabecera) sobre una ruta. */
function configRejects(live: PrivacyFilter, segments: readonly string[]): boolean {
  return live.isPrivateFolderPath(segments) || live.isPrivatePathPrefix(segments);
}

/** Decide la acción sobre `id` con el filtro de carpetas vivas y la papelera de la misma lectura. */
export function planFolderTrash(
  live: PrivacyFilter,
  view: FolderTrashView,
  action: FolderTrashActionName,
  id: string
): FolderTrashPlan {
  if (id === ROOT_FOLDER_ID) return { kind: 'reject', code: 'invalid_input' };
  const reject = (code: FolderTrashRejectionCode): FolderTrashPlan => ({ kind: 'reject', code });
  if (live.folderExists(id)) {
    if (live.isFolderHidden(id)) return reject('not_found');
    if (configRejects(live, live.folderSegments(id))) return reject('folder_unavailable');
    return action === 'trashFolder' ? { kind: 'write' } : { kind: 'unchanged' };
  }
  if (!view.trashed.some((entry) => entry.id === id)) return reject('not_found');
  if (view.trash.restoreFolderOf(id) === undefined) return reject('not_found');
  const segments = trashedFolderSegments(live, view.trashed, id);
  if (segments === null) return reject('not_found');
  if (configRejects(live, segments)) return reject('folder_unavailable');
  return action === 'restoreFolder' ? { kind: 'write' } : { kind: 'unchanged' };
}

/** Un `folder_not_found` del motor (la carpeta cambió entre medias) es `not_found`; la raíz,
 *  `invalid_input`. */
function rejection(error: unknown): unknown {
  if (error instanceof LibraryError) {
    if (error.code === 'folder_not_found') return writeRejected('not_found');
    if (error.code === 'root_folder_immutable') return writeRejected('invalid_input');
  }
  return error;
}

/** Aplica la acción (ver la cabecera). `onWritten` pide la ronda de después. */
export async function writeFolderTrash(
  target: NoteWriteTarget,
  input: FolderTrashInput,
  onWritten: () => void
): Promise<LocalWrite<FolderSaved>> {
  const outcome = await target.writeExclusive(async (store): Promise<LocalWrite<FolderSaved>> => {
    // Solo carpetas: el filtro no carga ninguna nota (la papelera la juzga su propio filtro).
    const live = privacyInTurnFor(store, input.privacy, []);
    const view: FolderTrashView = {
      trashed: store.foldersTrash(),
      trash: TrashFilter.fromSnapshot(live, store.trashIndex(), input.privacy)
    };
    const plan = planFolderTrash(live, view, input.action, input.id);
    if (plan.kind === 'reject') throw writeRejected(plan.code);
    if (plan.kind === 'unchanged') return { result: { id: input.id, changed: false }, wrote: false };
    try {
      if (input.action === 'trashFolder') await store.folderTrash(input.id);
      else await store.folderRestore(input.id);
    } catch (error) {
      throw rejection(error);
    }
    return { result: { id: input.id, changed: true }, wrote: true };
  });
  if (outcome.wrote) {
    try {
      onWritten();
    } catch {
      // Ya está en disco; la ronda periódica lo subirá.
    }
  }
  return outcome;
}
