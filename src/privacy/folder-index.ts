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

/**
 * Clave de una ruta para compararla con `privateFolders`: los segmentos de
 * `folderPathSegments` (minúsculas, sin espacios en los extremos) además en NFC, para que
 * «Café» escrito con la tilde compuesta o descompuesta sea la misma ruta, como para el
 * motor (`folderNameKey` de Hebra compara en NFC). Más estricto que la ruta que se
 * enseña: solo sirve para decidir qué es privado.
 */
export function privacyPathKey(segments: readonly string[]): string {
  return segments.map((segment) => segment.normalize('NFC')).join('/');
}

export class FolderIndex {
  private readonly parents = new Map<string, EffectiveParent>();
  private readonly names = new Map<string, string>();
  /** Ruta (`privacyPathKey`) → TODAS las carpetas vivas con esa ruta, ordenadas por id.
   *  Más de una cuando el sync trae hermanas homónimas (dos dispositivos crean la misma
   *  carpeta a la vez: el motor las admite, `ensureFolderNameFree` solo mira lo local);
   *  con una sola por ruta, la última tapaba a las demás y una homónima de una carpeta
   *  privada quedaba visible. Misma semántica que `resolveFolderPath` de Hebra, que
   *  `node.ts` no reexporta. */
  private readonly idsByPath = new Map<string, string[]>();

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
      const key = privacyPathKey(folderPathSegments(folder.id, index.parents, index.names));
      const ids = index.idsByPath.get(key);
      if (ids) ids.push(folder.id);
      else index.idsByPath.set(key, [folder.id]);
    }
    for (const ids of index.idsByPath.values()) ids.sort();
    return index;
  }

  /** `folderPath` para enseñar (SPEC.md §5): vacío para la raíz. */
  path(folderId: string): string {
    return this.segments(folderId).join('/');
  }

  /** Los segmentos de la ruta (minúsculas, sin espacios en los extremos, sin la raíz):
   *  la forma en que se comparan con `privateFolders`. */
  segments(folderId: string): string[] {
    return folderPathSegments(folderId, this.parents, this.names);
  }

  /** Padre EFECTIVO de una carpeta viva (`null` para la raíz o una que no existe). */
  parentOf(folderId: string): string | null {
    return this.parents.get(folderId)?.parentId ?? null;
  }

  /** Hijas vivas (por padre efectivo) de `parentId`, con su nombre tal como está
   *  guardado, ordenadas por id: para el choque de nombres de crear y renombrar (D9). */
  children(parentId: string): Array<{ id: string; name: string }> {
    const out: Array<{ id: string; name: string }> = [];
    for (const [id, parent] of this.parents) {
      if (id === ROOT_FOLDER_ID || parent.parentId !== parentId) continue;
      out.push({ id, name: this.names.get(id) ?? '' });
    }
    return out.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  /** Nombre guardado de una carpeta viva (`undefined` si no existe). */
  name(folderId: string): string | undefined {
    return this.names.get(folderId);
  }

  /** TODAS las carpetas con esa ruta (ya en minúsculas), por id; vacío si no existe hoy
   *  (renombrada o borrada: R5 / `privacy_config_unresolved`). */
  idsForPath(pathSegments: readonly string[]): readonly string[] {
    return this.idsByPath.get(privacyPathKey(pathSegments)) ?? [];
  }

  /** La primera (por id) de las carpetas con esa ruta, para los filtros `folder?` de las
   *  herramientas; `undefined` si no hay ninguna. */
  idForPath(pathSegments: readonly string[]): string | undefined {
    return this.idsForPath(pathSegments)[0];
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
