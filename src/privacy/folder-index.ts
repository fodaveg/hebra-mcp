/**
 * Índice de carpetas construido UNA vez sobre `foldersList()` (el puerto ya da el padre
 * EFECTIVO y su estado, SPEC.md §5/§6.3): rutas para enseñar (`folderPath`) y, para el
 * filtro de privados, qué carpeta corresponde a una ruta configurada y todo su subárbol.
 * Reutiliza `folderPathSegments`/`folderSubtree` de Hebra (`../hebra`, reexportado de
 * `library/folder-tree`, puro, sin CodeMirror): mismo algoritmo que la interfaz de
 * Hebra, sin reimplementarlo.
 */
import {
  folderPathSegments,
  folderSubtree,
  ROOT_FOLDER_ID,
  type EffectiveParent,
  type FoldersList
} from '../hebra';
import type { HebraLibraryPort } from '../store/types';

export class FolderIndex {
  private readonly parents = new Map<string, EffectiveParent>();
  private readonly names = new Map<string, string>();
  /** Ruta (minúsculas, sin la raíz) → id de carpeta, para resolver `privateFolders`. */
  private readonly idByPath = new Map<string, string>();

  private constructor() {}

  static async build(port: Pick<HebraLibraryPort, 'foldersList'>): Promise<FolderIndex> {
    return FolderIndex.fromList(await port.foldersList());
  }

  /** Sobre una lista ya leída: la usa el filtro que se construye DENTRO de un turno de
   *  escritura (`src/store/writes.ts`), y la simulación de un cambio de carpetas antes de
   *  hacerlo (`../privacy/filter.ts`, `withFolders`). */
  static fromList({ folders }: FoldersList): FolderIndex {
    const index = new FolderIndex();
    for (const folder of folders) {
      index.parents.set(folder.id, { parentId: folder.parentId, state: folder.parentState });
      index.names.set(folder.id, folder.name);
    }
    for (const folder of folders) {
      if (folder.id === ROOT_FOLDER_ID) continue;
      const segments = folderPathSegments(folder.id, index.parents, index.names);
      index.idByPath.set(segments.join('/'), folder.id);
    }
    return index;
  }

  /** `folderPath` para enseñar (SPEC.md §5): vacío para la raíz. */
  path(folderId: string): string {
    return folderPathSegments(folderId, this.parents, this.names).join('/');
  }

  /** Id de la carpeta configurada por su ruta (ya en minúsculas), o `undefined` si no
   *  existe hoy (renombrada o borrada: R5 / `privacy_config_unresolved`). */
  idForPath(pathSegments: readonly string[]): string | undefined {
    return this.idByPath.get(pathSegments.join('/'));
  }

  /** Ella y todas sus carpetas descendientes (SPEC.md §6.3: «carpeta privada o
   *  cualquier subcarpeta»). */
  subtree(folderId: string): string[] {
    return folderSubtree(folderId, this.parents);
  }

  has(folderId: string): boolean {
    return this.parents.has(folderId);
  }
}
