/**
 * Filtro de privados (SPEC.md §6.3, D3): un único `isHidden`, usado por TODAS las
 * herramientas antes de devolver nada. Cerrado ante la duda: si una carpeta configurada
 * no existe hoy, `unresolved` queda `true` y el servidor responde `privacy_config_unresolved`
 * a toda herramienta (R5).
 */
import { ROOT_FOLDER_ID } from '$lib/library/folder-tree';
import type { HebraLibraryPort } from '../store/types';
import type { PrivacyConfig } from './config';
import { FolderIndex } from './folder-index';
import { LibraryIndex } from './library-index';

export class PrivacyFilter {
  readonly unresolved: boolean;
  private readonly hiddenFolderIds: Set<string>;
  private readonly privateTags: Set<string>;

  private constructor(
    private readonly folders: FolderIndex,
    private readonly library: LibraryIndex,
    config: PrivacyConfig
  ) {
    this.privateTags = new Set(config.privateTags);
    let unresolved = false;
    const hidden = new Set<string>();
    for (const segments of config.privateFolders) {
      const folderId = folders.idForPath(segments);
      if (!folderId || folderId === ROOT_FOLDER_ID) {
        unresolved = true;
        continue;
      }
      for (const id of folders.subtree(folderId)) hidden.add(id);
    }
    this.unresolved = unresolved;
    this.hiddenFolderIds = hidden;
  }

  static async build(port: HebraLibraryPort, config: PrivacyConfig): Promise<PrivacyFilter> {
    const [folders, library] = await Promise.all([
      FolderIndex.build(port),
      LibraryIndex.build(port)
    ]);
    return new PrivacyFilter(folders, library, config);
  }

  /** `true` si la nota no debe salir por NINGUNA herramienta: en una carpeta privada (o
   *  subcarpeta), con una etiqueta privada (o descendiente), o desconocida para el
   *  índice (cerrado ante la duda). */
  isHiddenNote(id: string): boolean {
    const entry = this.library.get(id);
    if (!entry) return true;
    if (this.hiddenFolderIds.has(entry.folderId)) return true;
    for (const tag of entry.tags) {
      if (this.privateTags.has(tag)) return true;
    }
    return false;
  }

  isFolderHidden(folderId: string): boolean {
    return this.hiddenFolderIds.has(folderId);
  }

  isTagHidden(tag: string): boolean {
    return this.privateTags.has(tag);
  }

  folderPath(folderId: string): string {
    return this.folders.path(folderId);
  }

  folderExists(folderId: string): boolean {
    return this.folders.has(folderId);
  }

  /** Id de la carpeta que corresponde a una ruta escrita por la persona (`folder?` de
   *  `hebra_search`/`hebra_list_notes`, SPEC.md §5), o `undefined` si no existe. */
  folderIdForPath(path: string): string | undefined {
    const segments = path
      .split('/')
      .map((segment) => segment.trim().toLowerCase())
      .filter((segment) => segment.length > 0);
    if (segments.length === 0) return ROOT_FOLDER_ID;
    return this.folders.idForPath(segments);
  }

  /** Etiquetas HOJA de una nota (sin los ancestros que `note_tags` guarda de más), para
   *  enseñar en `hebra_search`/`hebra_list_notes`/`hebra_read_note`. */
  visibleTagsOf(id: string): string[] {
    const entry = this.library.get(id);
    if (!entry) return [];
    const tags = [...entry.tags];
    return tags.filter((tag) => !tags.some((other) => other !== tag && other.startsWith(`${tag}/`)));
  }

  /** Si una nota VISIBLE lleva `tag` (canónica), con sus ancestros (igual que
   *  `note_tags`): para combinar el filtro `folder?`+`tag?` de `hebra_list_notes`
   *  cuando el ámbito nativo del almacén ya usó el otro. */
  hasTag(id: string, tag: string): boolean {
    if (this.isHiddenNote(id)) return false;
    return this.library.get(id)?.tags.has(tag) ?? false;
  }

  /** Carpeta y etiquetas hoja de una nota VISIBLE, para las salidas de `hebra_search`,
   *  `hebra_list_notes` y `hebra_read_note`. `undefined` si la nota está oculta o no
   *  existe: quien llama debe tratarlo como si la nota no estuviera. */
  visibleMeta(id: string): { folderId: string; tags: string[] } | undefined {
    if (this.isHiddenNote(id)) return undefined;
    const entry = this.library.get(id)!;
    return { folderId: entry.folderId, tags: this.visibleTagsOf(id) };
  }

  /** Notas visibles con su carpeta y etiquetas, para recalcular recuentos (SPEC.md §6.3:
   *  «Recuentos de `hebra_list_tags` y `hebra_list_folders`… las etiquetas privadas o
   *  solo presentes en notas ocultas tampoco» — y por la aceptación #5, una nota oculta
   *  por ETIQUETA tampoco cuenta en el recuento de una CARPETA visible). */
  visibleNotes(): Map<string, { folderId: string; tags: readonly string[] }> {
    const result = new Map<string, { folderId: string; tags: readonly string[] }>();
    for (const [id, entry] of this.library.entries()) {
      if (this.isHiddenNote(id)) continue;
      result.set(id, { folderId: entry.folderId, tags: [...entry.tags] });
    }
    return result;
  }
}
