/**
 * Puerto propio de hebra-mcp sobre el almacén de Hebra: las lecturas de las herramientas
 * y las dos mutaciones de nota más sencillas (`noteCreate`/`noteSave`). La edición, la
 * organización (D2 ampliada, 28 sep 2026) y la papelera y las versiones (ampliación del
 * 30 sep 2026) NO están aquí: van por un turno exclusivo de la cola (`writeExclusive`,
 * `./writes.ts`), con el filtro de privados dentro del turno. Aquí solo están sus
 * LECTURAS (`trashIndex`, `noteVersionsList`, `noteVersionRead`). A propósito NO es
 * `LibraryStorePort` (`library/types` de Hebra): ese interfaz obliga a implementar
 * `tagRename`/`notePurge`/`trashEmpty`/`file*`, que hebra-mcp nunca expone
 * (`test/store/surface.node.test.ts`).
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
  SqliteLibraryEngine,
  TagsList,
  TitleCandidates
} from '../hebra';

/** `NoteVersionsList`/`NoteVersion` de Hebra (`library/types.ts`): `node.ts` no los
 *  reexporta, así que salen de la firma del motor en vez de importarlos por `$lib`. */
export type NoteVersionsList = ReturnType<SqliteLibraryEngine['noteVersionsList']>;
export type NoteVersion = NonNullable<ReturnType<SqliteLibraryEngine['noteVersionRead']>>;
export type NoteVersionSummary = NoteVersionsList['items'][number];

/** Una fila de `notesVisibilityIndex()`: lo mínimo para decidir si una nota está
 *  oculta (carpeta EFECTIVA y etiquetas canónicas, con sus ancestros) y para enseñar su
 *  ruta y sus etiquetas. Tipo nuestro, no de Hebra: nada de esto sale ya montado de
 *  `HebraLibraryPort`. */
export interface NoteVisibilityEntry {
  id: string;
  folderId: string;
  tags: string[];
}

/** Una nota de la papelera tal como la necesita el filtro de privados de la papelera
 *  (`src/privacy/trash-filter.ts`). `folderId` es la carpeta GUARDADA en la nota
 *  (`notes.folder_id`, `root` si no tiene), NO la efectiva: si esa carpeta ya es una
 *  lápida (se borró la carpeta y sus notas fueron a la papelera), el filtro sube por sus
 *  filas para saber si era privada. */
export interface TrashedNoteEntry {
  id: string;
  folderId: string;
  /** Etiquetas canónicas CON ancestros, como las guarda `note_tags` (siguen ahí en la
   *  papelera: `noteTrash` solo marca `trashed_at`). */
  tags: string[];
  /** Epoch ms, la clave del cursor de `notesPage({kind: 'trash'})`. */
  trashedAt: number;
}

/** Una fila de `folders`, VIVA O LÁPIDA, con su padre GUARDADO (no el efectivo). */
export interface FolderRowFact {
  id: string;
  parentId: string | null;
  name: string | null;
  deleted: boolean;
}

/** Lo que el filtro de la papelera lee del almacén, de una vez. */
export interface TrashIndex {
  notes: TrashedNoteEntry[];
  folders: FolderRowFact[];
}

/** Un adjunto de una nota (`note_blob_refs`, lo que Hebra escribe como
 *  `![[sha256:H|nombre]]`), con lo que el almacén sepa de sus bytes SIN leerlos
 *  (`blobs`): tamaño y tipo si hay fila (un recurso recibido por sync la trae aunque sus
 *  bytes no estén; un blob bajado de Blob V2 no trae tipo), y si los bytes están aquí. */
export interface NoteAttachmentRow {
  sha256: string;
  ordinal: number;
  byteLength: number | null;
  mime: string | null;
  present: boolean;
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
    filters?: SearchFilters | null,
    scope?: NotesScope | null
  ): Promise<SearchPage>;
  notesByTitlePrefix(prefix: string, limit?: number): Promise<TitleCandidates>;
  /** Carpeta EFECTIVA y etiquetas canónicas (con ancestros, como las guarda
   *  `note_tags`) de cada nota VIVA (ni papelera ni lápida). Para el filtro de
   *  privados (`src/privacy/`): antes se componía con `notesPage`/`noteRead` por nota
   *  (O(notas) + O(etiquetas) consultas); esto es UNA sola consulta SQL, pensada para
   *  recalcularse en cada llamada de herramienta sin caché (el sync cambia el almacén
   *  mientras el proceso vive). */
  notesVisibilityIndex(): Promise<NoteVisibilityEntry[]>;
  /** Notas de la papelera (sin lápidas) y TODAS las filas de carpeta, lápidas incluidas,
   *  en un solo turno de la cola: para `hebra_list_trash` y `hebra_restore_note`
   *  (ampliación de D2 del 30 sep 2026). */
  trashIndex(): Promise<TrashIndex>;
  /** «Versiones anteriores» LOCALES de una nota (`noteVersionsList` del motor), de la
   *  más reciente a la más antigua, sin cuerpo. Sin filtro: lo aplica la herramienta. */
  noteVersionsList(noteId: string): Promise<NoteVersionsList>;
  /** Una versión con su cuerpo, o `null` si ya no existe (caducada o purgada). */
  noteVersionRead(versionId: number): Promise<NoteVersion | null>;
  /** Adjuntos de una nota, en el orden del cuerpo (ampliación de D2 del 30 sep 2026,
   *  adjuntos en solo lectura). Sin filtro: lo aplica la herramienta. */
  noteAttachments(noteId: string): Promise<NoteAttachmentRow[]>;
  /** Bytes de un adjunto si ESTE dispositivo los tiene (`blobRead` del motor, que
   *  verifica el SHA-256); `null` si no. Nunca los baja del relé: eso lo hace el escritor
   *  (`NoteWriter.fetchAttachment`). Aquí no hay ninguna escritura de adjuntos. */
  blobRead(sha256: string): Promise<Uint8Array | null>;
  /** Cierra la conexión SQLite subyacente. */
  close(): void;
}
