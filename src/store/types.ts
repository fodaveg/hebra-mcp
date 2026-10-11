/**
 * Puerto propio de hebra-mcp sobre el almacén de Hebra: las lecturas de las herramientas
 * y las dos mutaciones de nota más sencillas (`noteCreate`/`noteSave`). La edición, la
 * organización (D2 ampliada, 28 sep 2026) y la papelera y las versiones (ampliación del
 * 30 sep 2026) NO están aquí: van por un turno exclusivo de la cola (`writeExclusive`,
 * `./writes.ts`), con el filtro de privados dentro del turno. Aquí solo están sus
 * LECTURAS (`trashIndex`, `noteVersionsList`, `noteVersionRead`). Lo mismo los ficheros
 * sueltos (D10, 9 oct 2026): aquí solo se LEEN (`filesIndex`), y mandarlos a la papelera
 * o sacarlos va por el turno exclusivo. A propósito NO es `LibraryStorePort`
 * (`library/types` de Hebra): ese interfaz obliga a implementar
 * `tagRename`/`notePurge`/`trashEmpty` y todos los `file*` (purgar, crear, renombrar,
 * mover, reemplazar), que hebra-mcp nunca expone (`test/store/surface.node.test.ts`).
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
import type { GrepBodiesResult, GrepBodiesSession, GrepNoteRow } from './grep-sql';
import type { PrivacyConfig } from '../privacy/config';

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
  /** Bloqueada (`notes.locked`): no deriva etiquetas, así que el filtro no puede saber si
   *  llevaba una privada (A1 del audit de privacidad, 10 oct 2026). Ausente = no. */
  locked?: boolean;
  /** Solo si la carpeta GUARDADA de la nota no está viva (una lápida, o una fila que aún no
   *  llegó por sync) y por eso `folderId` es la raíz: la guardada, para subir por las
   *  lápidas como en la papelera (A2 del mismo audit). */
  storedFolderId?: string;
  /** Con `storedFolderId`: las filas de carpeta desde la guardada hacia arriba hasta la
   *  primera viva (sin ella), tal como están. Se corta donde falta una fila o hay un ciclo:
   *  la subida no resuelve y la nota queda oculta. */
  folderTrail?: FolderRowFact[];
  /** `notes.local_seq` de la fila con la que se decidió (sube con cada guardado, también de
   *  sync): el sello de la puerta final (`src/server/privacy-gate.ts`). Ausente en filas
   *  construidas a mano (tests). */
  localSeq?: number;
}

/** El sello de una nota (viva o de la papelera) en el instante de la puerta final. */
export interface NoteStamp {
  localSeq: number;
  trashed: boolean;
}

/** Opciones de `HebraLibraryPort.search` que no son del motor. */
export interface PortSearchOptions {
  /**
   * `true`: la búsqueda entera del motor, que también encuentra una nota por el nombre o el
   * texto extraído de un fichero que incrusta (dibujo, PDF, adjunto). Solo vale cuando la
   * configuración de privados de la llamada no tiene ni carpetas ni etiquetas privadas
   * (`hasPrivates`, SPEC.md §6.3, M6): con alguna, esos ficheros pueden ser privados aunque
   * la nota se vea. Por defecto, `false`: solo título y cuerpo (`safeTextSearch`).
   */
  embedded?: boolean;
}

/** Lo que pide la puerta final (`src/server/privacy-gate.ts`): el sello de esas notas y,
 *  solo si la respuesta usó algo de eso, la papelera, los ficheros sueltos y quién enlaza
 *  esos bytes. */
export interface PrivacyRecheckRequest {
  notes: readonly string[];
  trash: boolean;
  files: boolean;
  blobs: readonly string[];
  /** Ids del registro que pueden ser planes; se resuelven junto al filtro final. */
  operationTargets?: readonly string[];
  /** Lo que la puerta comprueba fuera del almacén DENTRO de la misma transacción, síncrono
   *  (que `config.json` siga siendo el de la configuración instalada): su resultado sale en
   *  `PrivacyRecheckSnapshot.check`. Así, después de la transacción no queda ninguna espera. */
  check?: () => boolean;
}

/** Lo que lee la puerta final (`src/server/privacy-gate.ts`), todo en UNA transacción de
 *  lectura: el árbol de carpetas y el índice de visibilidad, como `PrivacyFilter.build`, la
 *  memoria de las carpetas privadas (A3), el sello de las notas pedidas (vivas o de la
 *  papelera) y, si se piden, la papelera, los ficheros sueltos y las notas que enlazan cada
 *  SHA-256 (en el orden de `blobs`). */
export interface PrivacyRecheckSnapshot {
  folders: FoldersList;
  notes: NoteVisibilityEntry[];
  remembered: RememberedPrivateFolder[];
  /** La época de privacidad del almacén en esta misma transacción (`privacyEpoch`). */
  epoch: string;
  /** El resultado de `PrivacyRecheckRequest.check`, dentro de la transacción (`true` sin él). */
  check: boolean;
  stamps: Map<string, NoteStamp>;
  trash?: TrashIndex;
  files?: FilesIndex;
  blobRefs?: BlobNoteRef[][];
  /** Planes existentes del registro, o ausencia. Leídos dentro de la misma transacción. */
  operationPlans?: Map<string, { privacySha256: string; noteIds: string[] }>;
}

/** Una carpeta a la que resolvió una ruta privada configurada (A3 del audit de privacidad,
 *  10 oct 2026): la ruta (`privacyPathKey`, minúsculas y NFC) y el id. hebra-mcp las recuerda
 *  para seguir ocultando una carpeta privada que se movió y cuya ruta ocupa otra. */
export interface RememberedPrivateFolder {
  pathKey: string;
  folderId: string;
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
  /** Bloqueada (`notes.locked`), como en `NoteVisibilityEntry`. Ausente = no. */
  locked?: boolean;
  /** `notes.local_seq`, el sello de la puerta final, como en `NoteVisibilityEntry`. */
  localSeq?: number;
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

/**
 * Un fichero suelto de la biblioteca (D10, 9 oct 2026): una fila de `files` que no es
 * lápida, viva o en la papelera. `folderId` es la carpeta GUARDADA (`files.folder_id`),
 * no la efectiva: el filtro (`src/privacy/file-filter.ts`) sube por las filas de carpeta
 * si ya es una lápida, como con las notas de la papelera. El cruce con las notas que lo
 * enlazan ya viene hecho en `FilesIndex.refs`.
 */
export interface FileEntry {
  id: string;
  folderId: string;
  name: string;
  /** SHA-256 de sus bytes (`files.sha256`, en minúsculas). Solo lo enseñan la lectura y
   *  el reemplazo de UN fichero visible (D15), nunca `hebra_list_files`: lo necesitan
   *  para leer los bytes y para la base comprobada del reemplazo, del MISMO turno que el
   *  filtro. */
  sha256: string;
  /** Tamaño y tipo de su fila de `blobs`; `null` si no hay fila. */
  byteLength: number | null;
  mime: string | null;
  /** Epoch ms (`files.updated_at`; si falta, `created_at`). */
  updatedAt: number;
  /** Epoch ms, o `null` si está vivo. */
  trashedAt: number | null;
  /** `files.local_seq`, el sello de la puerta final (`src/server/privacy-gate.ts`). Ausente
   *  en filas construidas a mano (tests). */
  localSeq?: number;
}

/** Una nota que enlaza un fichero suelto: por su nombre o por el SHA-256 de sus bytes en
 *  `links` de Hebra, o por ese SHA-256 en `note_blob_refs` (lo único que queda de los
 *  adjuntos de una nota bloqueada). La nota no es lápida; puede estar viva o en la
 *  papelera. */
export interface FileNoteRef {
  fileId: string;
  noteId: string;
  noteTrashed: boolean;
}

/** Una nota (no lápida, viva o de la papelera) que enlaza unos bytes por su SHA-256: un
 *  enlace `blob` de `links` o una fila de `note_blob_refs`. Para saber, antes de
 *  reemplazar un fichero suelto (D15), si el contenido nuevo lo dejaría oculto por la
 *  regla (b) de D10. */
export interface BlobNoteRef {
  noteId: string;
  noteTrashed: boolean;
}

/** Lo que el filtro de los ficheros sueltos lee del almacén, de una vez y en un solo
 *  turno de la cola: los ficheros, las notas que los enlazan y lo que necesita el filtro
 *  de la papelera para juzgar esas notas y las carpetas ya borradas. */
export interface FilesIndex {
  files: FileEntry[];
  refs: FileNoteRef[];
  trash: TrashIndex;
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
  /** `meta.library_id` (para la revisión de `hebra_read_note`): no cambia mientras la
   *  conexión vive, así que el puerto lo guarda tras la primera lectura. */
  libraryId(): Promise<string>;
  noteCreate(folderId?: string | null): Promise<NoteRow>;
  noteRead(id: string): Promise<NoteRow | null>;
  noteSave(input: NoteSaveInput): Promise<NoteSaveResult>;
  notesPage(cursor: string | null, limit: number, scope?: NotesScope): Promise<NotesPage>;
  foldersList(): Promise<FoldersList>;
  tagsList(): Promise<TagsList>;
  /** `ref` es lo que iría entre `[[` y `]]` (sin alias): `id:…`, `Título`, `ruta/Título`. */
  resolveLink(ref: string): Promise<LinkResolution>;
  /** `resolveLink` de varias refs en UN turno de la cola, en el mismo orden. */
  resolveLinks(refs: readonly string[]): Promise<LinkResolution[]>;
  backlinks(id: string, cursor?: string | null, limit?: number): Promise<NotesPage>;
  /** Sin `options.embedded`, solo título y cuerpo (el valor seguro, §6.3 M6). */
  search(
    q: string,
    cursor: string | null,
    limit?: number,
    filters?: SearchFilters | null,
    scope?: NotesScope | null,
    options?: PortSearchOptions
  ): Promise<SearchPage>;
  notesByTitlePrefix(prefix: string, limit?: number): Promise<TitleCandidates>;
  /** TODAS las notas vivas con ese título normalizado exacto, por id (sin el corte de 50
   *  de `notesByTitlePrefix`). */
  notesByExactTitle(title: string): Promise<TitleCandidates>;
  /** Carpeta EFECTIVA y etiquetas canónicas (con ancestros, como las guarda
   *  `note_tags`) de cada nota VIVA (ni papelera ni lápida). Para el filtro de
   *  privados (`src/privacy/`): antes se componía con `notesPage`/`noteRead` por nota
   *  (O(notas) + O(etiquetas) consultas); esto es UNA sola consulta SQL, pensada para
   *  recalcularse en cada llamada de herramienta sin caché (el sync cambia el almacén
   *  mientras el proceso vive). */
  notesVisibilityIndex(): Promise<NoteVisibilityEntry[]>;
  /** Lo que lee la puerta final antes de responder (`PrivacyRecheckSnapshot`): en UN turno
   *  de la cola y en una transacción de lectura, para que el filtro, la memoria de las
   *  carpetas privadas y los sellos sean del mismo instante del almacén. */
  privacyRecheck(request: PrivacyRecheckRequest): Promise<PrivacyRecheckSnapshot>;
  /** La ÉPOCA de privacidad del almacén (`privacyEpochOf` de `./privacy-sql.ts`): una huella
   *  que cambia con cualquier cambio de notas, carpetas, ficheros sueltos o de la memoria de
   *  carpetas privadas. La toma cada llamada al empezar, ANTES de construir su filtro, y la
   *  puerta final la compara con la de su transacción. */
  privacyEpoch(): Promise<string>;
  /** Notas de la papelera (sin lápidas) y TODAS las filas de carpeta, lápidas incluidas,
   *  en un solo turno de la cola: para `hebra_list_trash` y `hebra_restore_note`
   *  (ampliación de D2 del 30 sep 2026). */
  trashIndex(): Promise<TrashIndex>;
  /** Ficheros sueltos (vivos y de la papelera, sin lápidas), las notas que los enlazan y
   *  el índice de la papelera, en un solo turno de la cola: para `hebra_list_files`,
   *  `hebra_trash_file` y `hebra_restore_file` (D10). Sin filtro: lo aplica
   *  `FileFilter`. */
  filesIndex(): Promise<FilesIndex>;
  /** Por cada SHA-256 (en minúsculas), las notas (no lápidas, vivas o de la papelera) que
   *  enlazan esos bytes: `links` de tipo `blob` o `note_blob_refs` (`./file-sql.ts`). En UN
   *  turno de la cola y en el mismo orden. Para no servir como adjunto los bytes de lo
   *  oculto (M6 del audit de privacidad). Sin filtro: lo aplica quien llama. */
  notesLinkingBlobs(sha256s: readonly string[]): Promise<BlobNoteRef[][]>;
  /** Las carpetas a las que resolvió alguna vez una ruta privada (A3): las de la tabla
   *  propia `hebra_mcp_private_folders` y las que este proceso anotó sin poder escribirla
   *  (un lector). Sin filtrar por la configuración: lo hace `privacyWithMemory`. */
  rememberedPrivateFolders(): Promise<RememberedPrivateFolder[]>;
  /** Anota `fresh` y olvida las de las rutas que ya no están en `configured` (claves
   *  `privacyPathKey`). En memoria siempre; en la tabla, solo el escritor. */
  rememberPrivateFolders(
    fresh: readonly RememberedPrivateFolder[],
    configured: readonly string[]
  ): Promise<void>;
  /** «Versiones anteriores» LOCALES de una nota (`noteVersionsList` del motor), de la
   *  más reciente a la más antigua, sin cuerpo. Sin filtro: lo aplica la herramienta. */
  noteVersionsList(noteId: string): Promise<NoteVersionsList>;
  /** Una versión con su cuerpo, o `null` si ya no existe (caducada o purgada). */
  noteVersionRead(versionId: number): Promise<NoteVersion | null>;
  /** `noteVersionRead` de varias versiones en UN turno de la cola, en el orden pedido. */
  noteVersionsRead(versionIds: readonly number[]): Promise<Array<NoteVersion | null>>;
  /** Si cada versión es de una nota BLOQUEADA, sin leer el cuerpo entero (solo su
   *  prefijo); `null` si ya no existe. En UN turno de la cola. */
  noteVersionsLocked(versionIds: readonly number[]): Promise<Array<boolean | null>>;
  /** Adjuntos de una nota, en el orden del cuerpo (ampliación de D2 del 30 sep 2026,
   *  adjuntos en solo lectura). Sin filtro: lo aplica la herramienta. */
  noteAttachments(noteId: string): Promise<NoteAttachmentRow[]>;
  /** Bytes de un adjunto si ESTE dispositivo los tiene (`blobRead` del motor, que
   *  verifica el SHA-256); `null` si no. Nunca los baja del relé: eso lo hace el escritor
   *  (`NoteWriter.fetchAttachment`). Aquí no hay ninguna escritura de adjuntos. */
  blobRead(sha256: string): Promise<Uint8Array | null>;
  /** Estado de sync de lo que escriben las herramientas de carpetas y de adjuntos (D9):
   *  si una carpeta viva sigue sucia, y si un blob ya subió; `null` si no existe. Solo
   *  leen. */
  folderDirty(id: string): Promise<boolean | null>;
  blobUploaded(sha256: string): Promise<boolean | null>;
  /** Lo mismo para un fichero suelto (D10): si su fila sigue sucia; `null` si no existe o
   *  es una lápida. Solo lee. No se llama `fileDirty` para que ningún método del puerto
   *  case con los `file*` del motor (`test/store/surface.node.test.ts`). */
  looseFileDirty(id: string): Promise<boolean | null>;
  /** `hebra_grep` (D13): las notas vivas sin su cuerpo (id, título, si está bloqueada y
   *  su `rowid`), en un turno de la cola. Sin filtro: lo aplica la herramienta. */
  grepNotes(): Promise<GrepNoteRow[]>;
  /** `hebra_grep` (D13): de `rowids`, las que pueden casar según el índice de subcadena
   *  (`grepSubstringCandidates` de `./grep-sql.ts`), o `null` si el índice no está
   *  completo. Solo lee el cuerpo de las de `rowids`. */
  grepCandidates(match: string, rowids: readonly number[]): Promise<Set<number> | null>;
  /** `hebra_grep` (D13): el cuerpo de las de `rowids` que siguen vivas, sin bloquear y
   *  visibles con el filtro de `privacy` rehecho en ese mismo turno (`grepVisibleBodies`).
   *  `session` es la que devolvió el lote anterior de la misma llamada, o `null`. */
  grepBodies(
    rowids: readonly number[],
    privacy: PrivacyConfig,
    session: GrepBodiesSession | null
  ): Promise<GrepBodiesResult>;
  /** Cierra la conexión SQLite subyacente. */
  close(): void;
}
