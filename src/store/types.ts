/**
 * Puerto propio de hebra-mcp sobre el almacén de Hebra: solo lo que D2 permite en v1
 * (leer, buscar, crear una nota y añadir texto al final; `noteSave` cubre las dos
 * escrituras porque `hebra_append_to_note` construye `body + "\n\n" + text` en la capa
 * de herramientas y llama a lo mismo que crear, SPEC.md §5). A propósito NO es
 * `LibraryStorePort` (`library/types` de Hebra): ese interfaz obliga a implementar
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
} from '../hebra';

/** Una fila de `notesVisibilityIndex()`: lo mínimo para decidir si una nota está
 *  oculta (carpeta EFECTIVA y etiquetas canónicas, con sus ancestros) y para enseñar su
 *  ruta y sus etiquetas. Tipo nuestro, no de Hebra: nada de esto sale ya montado de
 *  `HebraLibraryPort`. */
export interface NoteVisibilityEntry {
  id: string;
  folderId: string;
  tags: string[];
}

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
  /** Carpeta EFECTIVA y etiquetas canónicas (con ancestros, como las guarda
   *  `note_tags`) de cada nota VIVA (ni papelera ni lápida). Para el filtro de
   *  privados (`src/privacy/`): antes se componía con `notesPage`/`noteRead` por nota
   *  (O(notas) + O(etiquetas) consultas); esto es UNA sola consulta SQL, pensada para
   *  recalcularse en cada llamada de herramienta sin caché (el sync cambia el almacén
   *  mientras el proceso vive). */
  notesVisibilityIndex(): Promise<NoteVisibilityEntry[]>;
  /** Cierra la conexión SQLite subyacente. */
  close(): void;
}
