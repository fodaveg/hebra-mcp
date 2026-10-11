/**
 * Subir por las lápidas de carpeta (SPEC.md §6.3): dónde queda, para el filtro de privados,
 * algo cuya carpeta GUARDADA ya no está viva. `folderTrash` de Hebra deja la carpeta como
 * lápida (con su nombre y su padre) y no toca el `folder_id` de lo que había dentro; el motor
 * lo enseña en la raíz (la carpeta efectiva de una lápida). Lo usan:
 * - `TrashFilter` (`./trash-filter.ts`), para las notas de la papelera (30 sep 2026);
 * - `FileFilter` (`./file-filter.ts`), por medio de `TrashFilter`, para los ficheros (D10);
 * - `PrivacyFilter` (`./filter.ts`), para las notas VIVAS que Hebra sacó de la papelera con
 *   su carpeta ya borrada (A2 del audit de privacidad, 10 oct 2026), y para las que esperan
 *   una carpeta que aún no llegó por sync.
 *
 * La regla: se sube por las filas de carpeta hasta una viva o la raíz.
 * - Si esa carpeta viva es privada, oculto.
 * - Si alguna ruta intermedia (la de la carpeta viva más los nombres de las lápidas, en
 *   minúsculas) es una ruta privada configurada, oculto: una carpeta privada borrada y vuelta
 *   a crear con el mismo nombre no destapa lo de la vieja.
 * - Si alguna lápida es una carpeta a la que resolvió una ruta privada (A3: la memoria de
 *   `./folder-memory.ts`), oculto: una carpeta privada movida y después borrada tampoco.
 * - Cerrado ante la duda: una fila que falta, un nombre vacío o un ciclo, oculto.
 */
import { ROOT_FOLDER_ID } from '../hebra';
import type { FolderRowFact } from '../store/types';
import { privacyPathKey } from './folder-index';

/** Lo que la subida necesita saber de las carpetas vivas (lo da `PrivacyFilter`). */
export interface LiveFolders {
  folderExists(folderId: string): boolean;
  isFolderHidden(folderId: string): boolean;
  folderPath(folderId: string): string;
  /** ¿Es una carpeta (viva o lápida) a la que resolvió alguna ruta privada? */
  isPrivateFolderId(folderId: string): boolean;
}

/**
 * La carpeta viva y visible (o la raíz) donde queda algo guardado en `folderId`, o
 * `undefined` si queda oculto o no se puede saber. `rows` son filas de carpeta, lápidas
 * incluidas (de las vivas no hace falta ninguna); `privatePaths`, las rutas configuradas
 * como `privacyPathKey`.
 */
export function climbFolder(
  folderId: string,
  rows: ReadonlyMap<string, FolderRowFact>,
  live: LiveFolders,
  privatePaths: ReadonlySet<string>
): string | undefined {
  if (folderId === ROOT_FOLDER_ID) return ROOT_FOLDER_ID;
  if (live.folderExists(folderId)) {
    return live.isFolderHidden(folderId) ? undefined : folderId;
  }
  // Carpeta borrada (o que no ha llegado): subir por las lápidas hasta una viva o la raíz.
  const tombstoneNames: string[] = [];
  const seen = new Set<string>();
  let current: string = folderId;
  let anchorPath: string[];
  for (;;) {
    if (current === ROOT_FOLDER_ID) {
      anchorPath = [];
      break;
    }
    if (live.folderExists(current)) {
      if (live.isFolderHidden(current)) return undefined;
      const path = live.folderPath(current);
      anchorPath = path.length === 0 ? [] : path.split('/');
      break;
    }
    const row = rows.get(current);
    const name = row?.name?.trim().toLowerCase();
    if (!row || !name || seen.has(current) || live.isPrivateFolderId(current)) return undefined;
    seen.add(current);
    tombstoneNames.unshift(name);
    current = row.parentId ?? ROOT_FOLDER_ID;
  }
  const full = [...anchorPath, ...tombstoneNames];
  for (let length = 1; length <= full.length; length += 1) {
    if (privatePaths.has(privacyPathKey(full.slice(0, length)))) return undefined;
  }
  return ROOT_FOLDER_ID;
}
