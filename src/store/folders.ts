/**
 * Crear y renombrar carpetas (D9, decisión de David del 3 oct 2026, que sustituye en esto
 * la opción A del 28 sep 2026): QUÉ se haría, decidido sobre un `PrivacyFilter` ya
 * construido, sin escribir nada. Lo usan dos capas con la misma lógica:
 * - la herramienta (`src/server/tools/folders.ts`), para rechazar antes de molestar al
 *   escritor, con el filtro de su llamada;
 * - el escritor único (`./writes.ts`, `NoteWriter.createFolder`/`renameFolder`), dentro
 *   del turno de la cola en que escribe, con el filtro de ESE turno y la configuración de
 *   quien pide.
 *
 * Por qué la opción A dejó las carpetas fuera: `folder_name_taken` del motor delataba una
 * hermana privada, y renombrar una carpeta con una privada dentro respondía distinto que
 * sin ella. Aquí eso se cierra así, en este orden:
 * 1. Nombre (`validFolderName`): `invalid_input`.
 * 2. Carpeta de partida visible (el padre al crear; la carpeta al renombrar): si no,
 *    `not_found`, igual que una inexistente.
 * 3. DESDE LA CONFIGURACIÓN, antes de mirar el motor (`isPrivateFolderPath`): una ruta
 *    resultante privada o debajo de una privada, `folder_unavailable`. Al renombrar,
 *    también una carpeta con una privada debajo, o una descendiente que quedaría en una
 *    ruta privada. La respuesta no depende de que la carpeta privada exista.
 * 4. Hermanas homónimas (`folderNameKey`, la comparación del motor): una VISIBLE es la
 *    misma carpeta al crear (idempotente) o `folder_name_taken` al renombrar; si solo hay
 *    ocultas, `folder_unavailable`. El escritor además traduce un `folder_name_taken` del
 *    motor que se escape de aquí a `folder_unavailable` (cerrado ante la duda).
 * `privacy_config_unresolved` va ANTES que todo esto (lo comprueban `runTool` y
 * `privacyInTurn`): al revés, una configuración rota delataría qué rutas tiene.
 */
import { ROOT_FOLDER_ID } from '../hebra';
import type { PrivacyFilter } from '../privacy/filter';

/** Longitud máxima del nombre de una carpeta tras recortar. Hebra no fija ninguna; esta
 *  es la del nombre de un fichero en casi cualquier sistema (Obsidian, de donde se
 *  replican las carpetas, las tiene en disco). */
export const FOLDER_NAME_MAX_LENGTH = 255;

/** Controles (saltos de línea incluidos), la barra y los caracteres de formato invisibles
 *  de Unicode (categoría Cf: U+200B, U+202E…), con los que dos nombres que se ven iguales
 *  serían distintos, o uno se leería al revés. */
const FOLDER_NAME_FORBIDDEN = /[\u0000-\u001f\u007f/]|\p{Cf}/u;

/** U+2028 y U+2029 (separadores de línea de Unicode), fuera de la expresión regular para
 *  que ningún editor los convierta en el carácter literal, que la rompería. */
const LINE_SEPARATORS = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];

/** El nombre recortado si vale: no vacío, sin `/` (`validName` del motor), sin caracteres
 *  de control, de formato (Cf) ni separadores de línea y de a lo sumo
 *  `FOLDER_NAME_MAX_LENGTH`. Si no, `null`. */
export function validFolderName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0 || name.length > FOLDER_NAME_MAX_LENGTH) return null;
  if (FOLDER_NAME_FORBIDDEN.test(name)) return null;
  return LINE_SEPARATORS.some((separator) => name.includes(separator)) ? null : name;
}

/** Cómo compara el motor dos nombres de carpetas hermanas (`folderNameKey` de
 *  `sqlite-engine.ts`, que no se exporta): NFC, sin espacios en los extremos y en
 *  minúsculas. */
export function folderNameKey(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/** El segmento de ruta de un nombre, como lo calcula `folderPathSegments` (y por tanto
 *  como se compara con `privateFolders`): sin espacios en los extremos y en minúsculas. */
function pathSegment(name: string): string {
  return name.trim().toLowerCase();
}

export type FolderRejectionCode =
  | 'invalid_input'
  | 'not_found'
  | 'folder_unavailable'
  | 'folder_name_taken';

export type CreateFolderPlan =
  | { kind: 'reject'; code: FolderRejectionCode }
  /** Ya hay una hermana VISIBLE con ese nombre: es esa (idempotente). */
  | { kind: 'existing'; id: string }
  | { kind: 'create'; parentId: string; name: string };

export type RenameFolderPlan =
  | { kind: 'reject'; code: FolderRejectionCode }
  /** Ya se llama exactamente así: nada que escribir. */
  | { kind: 'unchanged' }
  | { kind: 'rename'; id: string; name: string };

const reject = (code: FolderRejectionCode): { kind: 'reject'; code: FolderRejectionCode } => ({
  kind: 'reject',
  code
});

function isVisibleFolder(filter: PrivacyFilter, id: string): boolean {
  return filter.folderExists(id) && !filter.isFolderHidden(id);
}

/** Crear `rawName` dentro de `parentId` (`ROOT_FOLDER_ID` es la raíz). */
export function planCreateFolder(
  filter: PrivacyFilter,
  parentId: string,
  rawName: string
): CreateFolderPlan {
  const name = validFolderName(rawName);
  if (name === null) return reject('invalid_input');
  if (!isVisibleFolder(filter, parentId)) return reject('not_found');
  if (filter.isPrivateFolderPath([...filter.folderSegments(parentId), pathSegment(name)])) {
    return reject('folder_unavailable');
  }
  const key = folderNameKey(name);
  const homonyms = filter.folderChildren(parentId).filter((child) => folderNameKey(child.name) === key);
  const visible = homonyms.find((child) => !child.hidden);
  if (visible) return { kind: 'existing', id: visible.id };
  if (homonyms.length > 0) return reject('folder_unavailable');
  return { kind: 'create', parentId, name };
}

/** Renombrar la carpeta `folderId` a `rawName`. La raíz no se renombra (`invalid_input`,
 *  `root_folder_immutable` del motor). */
export function planRenameFolder(
  filter: PrivacyFilter,
  folderId: string,
  rawName: string
): RenameFolderPlan {
  const name = validFolderName(rawName);
  if (name === null || folderId === ROOT_FOLDER_ID) return reject('invalid_input');
  if (!isVisibleFolder(filter, folderId)) return reject('not_found');
  // Su propia ruta, desde la configuración y sin fiarse del índice de carpetas ocultas:
  // una carpeta en una ruta privada (o debajo) no se renombra aunque el índice no la
  // hubiera marcado (p. ej. una homónima que no resolvió). Con el índice bien, una así ya
  // es oculta y sale arriba como `not_found`, igual que una inexistente.
  if (filter.isPrivateFolderPath(filter.folderSegments(folderId))) return reject('folder_unavailable');
  if (filter.hasHiddenFolderBelow(folderId)) return reject('folder_unavailable');
  const parentId = filter.folderParent(folderId) ?? ROOT_FOLDER_ID;
  const renamed = [...filter.folderSegments(parentId), pathSegment(name)];
  if (filter.isPrivateFolderPath(renamed)) return reject('folder_unavailable');
  if (filter.folderName(folderId) === name) return { kind: 'unchanged' };
  const key = folderNameKey(name);
  const homonyms = filter
    .folderChildren(parentId)
    .filter((child) => child.id !== folderId && folderNameKey(child.name) === key);
  if (homonyms.some((child) => !child.hidden)) return reject('folder_name_taken');
  if (homonyms.length > 0) return reject('folder_unavailable');
  // Una descendiente (todas visibles: si no, ya habría salido arriba) en su ruta nueva.
  const depth = filter.folderSegments(folderId).length;
  for (const id of filter.folderSubtree(folderId)) {
    if (id === folderId) continue;
    const below = filter.folderSegments(id).slice(depth);
    if (filter.isPrivateFolderPath([...renamed, ...below])) return reject('folder_unavailable');
  }
  return { kind: 'rename', id: folderId, name };
}
