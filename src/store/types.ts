/**
 * Puerto propio de hebra-mcp sobre el almacén de Hebra: solo lo que D2 permite en v1
 * (leer, buscar, crear una nota y añadir texto al final; `noteSave` cubre las dos
 * escrituras porque `hebra_append_to_note` construye `body + "\n\n" + text` en la capa
 * de herramientas y llama a lo mismo que crear, SPEC.md §5). A propósito NO es
 * `LibraryStorePort` (`$lib/library/types`): ese interfaz obliga a implementar
 * `tagRename`/`tagsReindex`/`noteMove`/`noteTrash`/`folder*`/`file*`, que v1 nunca
 * expone (SPEC.md §5: «el servidor ni siquiera las importa»). Cualquier método de aquí
 * es uno que SÍ hace falta detrás de una herramienta MCP futura (L1/L3).
 */
import type {
  FoldersList,
  LibraryOpenInfo,
  LinkResolution,
  NoteRow,
  NoteSaveInput,
  NoteSaveResult,
  NotesPage,
  NotesScope,
  SearchFilters,
  SearchPage,
  TagsList,
  TitleCandidates
} from '$lib/library/types';

export interface HebraLibraryPort {
  libraryOpen(): Promise<LibraryOpenInfo>;
  noteCreate(folderId?: string | null): Promise<NoteRow>;
  noteRead(id: string): Promise<NoteRow | null>;
  noteSave(input: NoteSaveInput): Promise<NoteSaveResult>;
  notesPage(cursor: string | null, limit: number, scope?: NotesScope): Promise<NotesPage>;
  foldersList(): Promise<FoldersList>;
  tagsList(): Promise<TagsList>;
  /** `ref` es lo que iría entre `[[` y `]]` (sin alias): `id:…`, `Título`, `ruta/Título`. */
  resolveLink(ref: string): Promise<LinkResolution>;
  backlinks(id: string, cursor?: string | null, limit?: number): Promise<NotesPage>;
  search(
    q: string,
    cursor: string | null,
    limit?: number,
    filters?: SearchFilters | null
  ): Promise<SearchPage>;
  notesByTitlePrefix(prefix: string, limit?: number): Promise<TitleCandidates>;
  /** Cierra la conexión SQLite subyacente. */
  close(): void;
}
