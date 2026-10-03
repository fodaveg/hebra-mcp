/**
 * Las escrituras de hebra-mcp (D2, SPEC.md §5 «Detalle de las escrituras», ampliada el
 * 28 sep 2026 con la edición), sobre el almacén. NO son las herramientas MCP: aquí no
 * hay esquema de salida ni límites de longitud de la herramienta. Nada de borrar.
 *
 * - `createNote`: `noteCreate(folderId)` + `noteSave` con los derivados de
 *   `deriveNote(body)`, en UN turno de la cola del almacén (`writeExclusive`): una ronda
 *   de sync no puede colarse entre los dos pasos y subir la nota vacía.
 * - `appendToNote`: `noteRead` → `body + "\n\n" + text` → `noteSave` con
 *   `expectedLocalSeq` y `baseBodySha256` de lo leído. Si el almacén responde
 *   `redirected` (la nota cambió o es una lápida), el texto quedó en una copia de
 *   conflicto visible: `conflict_copy` con su id. Si el choque llega después, con la
 *   ronda (otro dispositivo editó la misma nota), lo resuelve la tabla de §7 del almacén
 *   con otra copia, y el motor lo avisa con `sync.conflict_copy` (`SyncRunner`).
 * - `editNote`: sustituciones puntuales (`./edits.ts`) sobre la versión que el agente
 *   leyó (`./revision.ts`), con el filtro de privados construido DENTRO del turno y la
 *   idempotencia de `./operations.ts`. Ver su comentario.
 * - `organize`: mover, favorita, archivar y, desde el 30 sep 2026, mandar a la papelera
 *   y sacar de ella (`noteTrash`/`noteRestore`, reversibles). Nunca purga ni vacía la
 *   papelera.
 * - `restoreVersion` (30 sep 2026): restaurar una «versión anterior» es una edición
 *   nueva, con la revisión, la idempotencia y la copia de conflicto de `editNote`.
 * - `createFolder`/`renameFolder` (D9, 3 oct 2026): `folderCreate`/`folderRename` del
 *   motor, con el plan de `./folders.ts` rehecho dentro del turno.
 * - `addAttachment` (D9): `blobPut` del motor y la referencia `![[sha256:H|nombre]]` al
 *   final del cuerpo, como `appendToNote`, con la idempotencia de `editNote`.
 *
 * Después de cada escritura, `onWritten` (la instancia lo conecta a
 * `SyncRunner.requestRound`, SPEC.md §8: «una ronda justo después de cada escritura»).
 */
import { createHash } from 'node:crypto';
import {
  deriveNote,
  LibraryError,
  ROOT_FOLDER_ID,
  type FoldersList,
  type NoteRow,
  type NoteSaveInput,
  type NoteSaveResult,
  type SqliteLibraryEngine
} from '../hebra';
import type { PrivacyConfig } from '../privacy/config';
import { PrivacyFilter } from '../privacy/filter';
import { TrashFilter } from '../privacy/trash-filter';
import {
  ATTACHMENT_BASE64_MAX_CHARS,
  ATTACHMENT_MAX_BYTES,
  attachmentMarkdown,
  detectAttachmentType,
  validAttachmentName
} from './attachment-content';
import { applyEdits, type TextEdit } from './edits';
import { writeRejected } from './errors';
import { planCreateFolder, planRenameFolder } from './folders';
import type { OperationStore } from './operations';
import { decodeRevision, encodeRevision } from './revision';
import type { NoteAttachmentRow, NoteVersion, NoteVisibilityEntry, TrashIndex } from './types';

/** Tipos de carpeta y de blob del motor (`library/types.ts`): `node.ts` no los
 *  reexporta, así que salen de la firma de `SqliteLibraryEngine`. */
export type FolderRow = Awaited<ReturnType<SqliteLibraryEngine['folderCreate']>>;
export type BlobPutOptions = NonNullable<Parameters<SqliteLibraryEngine['blobPut']>[1]>;
export type BlobPutResult = Awaited<ReturnType<SqliteLibraryEngine['blobPut']>>;

/** Acceso directo del motor dentro de un turno de la cola (`NodeLibraryPort`). */
export interface NoteWriteStore {
  noteCreate(folderId?: string | null): Promise<NoteRow>;
  noteRead(id: string): Promise<NoteRow | null>;
  noteSave(input: NoteSaveInput): Promise<NoteSaveResult>;
  /** Carpetas (D9, 3 oct 2026): crear y renombrar, solo desde `NoteWriter` y con el plan
   *  de `./folders.ts` rehecho en el turno. Mover y borrar carpetas (`folderMove`,
   *  `folderTrash`) NO están, ni aquí ni en ningún sitio de hebra-mcp
   *  (`test/store/surface.node.test.ts`). */
  folderCreate(parentId: string, name: string): Promise<FolderRow>;
  folderRename(id: string, name: string): Promise<FolderRow>;
  /** Guardar los bytes de un adjunto que se añade (D9): el `blobPut` del motor (fichero y
   *  fila de `blobs`). Solo lo llama `NoteWriter.addAttachment`, en el mismo turno en que
   *  la nota pasa a referenciarlo. */
  blobPut(bytes: Uint8Array, options: BlobPutOptions): Promise<BlobPutResult>;
  /** Organización de notas (D2 ampliada): los métodos del mismo nombre de
   *  `SqliteLibraryEngine`. */
  noteMove(id: string, folderId: string): Promise<NoteRow>;
  noteSetFavorite(id: string, favorite: boolean): Promise<NoteRow>;
  noteArchive(id: string): Promise<NoteRow>;
  noteUnarchive(id: string): Promise<NoteRow>;
  /** Papelera (ampliación de D2, 30 sep 2026): mandar y sacar, las dos reversibles e
   *  idempotentes en el motor. Purgar y vaciar la papelera NO están, ni aquí ni en
   *  ningún sitio de hebra-mcp (`test/store/surface.node.test.ts`). */
  noteTrash(id: string): Promise<NoteRow>;
  noteRestore(id: string): Promise<NoteRow>;
  /** «Versiones anteriores»: leer una, y la instantánea forzada del cuerpo actual que
   *  Hebra pide antes de restaurar (`noteVersionSnapshot`, no toca la fila de la nota). */
  noteVersionRead(versionId: number): NoteVersion | null;
  noteVersionSnapshot(noteId: string): Promise<void>;
  /** `meta.library_id` del almacén (para la revisión). */
  libraryId(): string;
  /** Lo que lee el filtro de privados, en este mismo turno. */
  foldersList(): FoldersList;
  notesVisibilityIndex(): NoteVisibilityEntry[];
  /** Lo que lee el filtro de la papelera (`src/privacy/trash-filter.ts`). */
  trashIndex(): TrashIndex;
  /** Adjuntos de una nota (`note_blob_refs`), para `fetchAttachment`. */
  noteAttachments(noteId: string): NoteAttachmentRow[];
  /** Registro de idempotencia de `editNote`. */
  operations: OperationStore;
}

/** Lo que `NoteWriter` necesita del almacén: un turno exclusivo de la cola. Rechaza con
 *  `busy_other_instance` si esta instancia no es el escritor único. */
export interface NoteWriteTarget {
  writeExclusive<T>(operation: (store: NoteWriteStore) => Promise<T>): Promise<T>;
}

export interface CreateNoteInput {
  /** Markdown; el primer H1 es el título, como en Hebra. */
  body: string;
  /** Carpeta existente; `null`/ausente = la raíz. */
  folderId?: string | null;
  /** Igual que `EditNoteInput.privacy`: la configuración de quien pide, aplicada dentro
   *  del turno de la escritura. */
  privacy: PrivacyConfig;
}

export interface CreateNoteResult {
  id: string;
  title: string;
  folderId: string;
}

export interface AppendToNoteInput {
  id: string;
  text: string;
  /** Igual que `EditNoteInput.privacy`. */
  privacy: PrivacyConfig;
}

export type AppendToNoteResult =
  | { id: string; outcome: 'saved' }
  | { id: string; outcome: 'conflict_copy'; copyId: string };

/** Separador entre el cuerpo existente y lo añadido (SPEC.md §5). */
export const APPEND_SEPARATOR = '\n\n';

/** Límite del cuerpo de `hebra_create_note` (SPEC.md §5), en unidades UTF-16
 *  (`string.length`). Lo comprueban la herramienta y, otra vez, el socket del escritor
 *  (`src/ipc/writer-socket.ts`), que no se fía de lo que le llega. */
export const CREATE_BODY_MAX_LENGTH = 100_000;

/** Límite del texto de `hebra_append_to_note` (SPEC.md §5), igual que el de arriba. */
export const APPEND_TEXT_MAX_LENGTH = 20_000;

/**
 * Tope, en bytes, de una petición de escritura: una línea de `writer.sock`
 * (`MAX_MESSAGE_BYTES`, `src/ipc/writer-socket.ts`) y el cuerpo de `POST /mcp`
 * (`MAX_MCP_BODY_BYTES`, `src/http/app.ts`). Lo mayor entre:
 * - el cuerpo de `hebra_create_note` con el peor escape JSON (un carácter de control sale
 *   como `\uXXXX`, 6 bytes por unidad UTF-16; las sustituciones de `editNote` suman como
 *   mucho lo mismo), y
 * - el base64 de un adjunto de 5 MiB (`hebra_add_attachment`, D9), que JSON no escapa;
 * más un margen de 512 KiB (`WRITE_MESSAGE_MARGIN_BYTES`) para el sobre (ids, nombre,
 * `operationId`), la configuración de privados y los saltos de línea de un base64
 * partido como lo parte un `base64` de terminal: cada 76 caracteres, 91 981 líneas en el
 * peor caso, que en JSON son `\n` (2 bytes, 183 962) o `\r\n` (4 bytes, 367 924).
 * Desde D9 manda el adjunto: 6 990 508 + 524 288 = 7 514 796 bytes (antes, 665 536 con
 * un margen de 64 KiB, que no dejaba pasar ese base64 partido).
 */
export const WRITE_MESSAGE_MARGIN_BYTES = 512 * 1024;
export const MAX_WRITE_MESSAGE_BYTES =
  Math.max(CREATE_BODY_MAX_LENGTH * 6, ATTACHMENT_BASE64_MAX_CHARS) + WRITE_MESSAGE_MARGIN_BYTES;

export interface EditNoteInput {
  id: string;
  /** Sustituciones puntuales sobre el cuerpo LEÍDO (`./edits.ts`). */
  edits: TextEdit[];
  /** La `revision` que devolvió `hebra_read_note` (`./revision.ts`). */
  expectedRevision: string;
  /** Idempotencia (`./operations.ts`): el mismo id con la misma petición no se repite. */
  operationId: string;
  /**
   * Configuración de privados de QUIEN pide la edición: la herramienta que la recibe o,
   * por `writer.sock`, la del lector (el escritor no la conoce ni la supone igual). Se
   * evalúa dentro del turno de la escritura. Obligatoria en el tipo (revisión del 28 sep
   * 2026): sin un valor por defecto, una llamada nueva que se olvide de pasarla no compila
   * en vez de escribir sin filtro. Quien de verdad no tenga privados pasa una
   * configuración vacía, explícita.
   */
  privacy: PrivacyConfig;
}

/** Resultado del guardado LOCAL de una edición (el estado de sync lo añade quien espera
 *  la ronda, `src/server/write-context.ts`). `replayed`: devuelto del registro de
 *  idempotencia, sin volver a escribir. */
export type EditNoteSaved =
  | { id: string; outcome: 'saved'; revision: string; replayed?: true }
  | { id: string; outcome: 'conflict_copy'; copyId: string; replayed?: true };

/**
 * Organización de notas (D2 ampliada, 28 sep 2026): mover una nota a una carpeta que ya
 * existe, favorita, archivar y desarchivar. Todo por id; la raíz es `ROOT_FOLDER_ID`
 * (`"root"`, la que lista `hebra_list_folders` con ruta vacía). Desde el 30 sep 2026
 * (ampliación de D2), también mandar una nota a la papelera (`trashNote`) y sacarla
 * (`restoreNote`): cada una se deshace con la otra, desde Hebra o desde el MCP. Sin
 * nada irreversible: ni purga ni vaciar la papelera.
 *
 * Crear y renombrar CARPETAS (D9, 3 oct 2026) no son acciones de nota: van por
 * `createFolderLocal`/`renameFolderLocal`. Mover y borrar carpetas siguen fuera del MCP.
 */
export type OrganizeAction =
  | { action: 'moveNote'; id: string; folderId: string }
  | { action: 'setFavorite'; id: string; favorite: boolean }
  | { action: 'setArchived'; id: string; archived: boolean }
  | { action: 'trashNote'; id: string }
  | { action: 'restoreNote'; id: string };

export type OrganizeActionName = OrganizeAction['action'];

/** Igual que `EditNoteInput.privacy`: la configuración de quien pide. */
export type OrganizeInput = OrganizeAction & { privacy: PrivacyConfig };

/** Lo que queda tras organizar una nota: carpeta efectiva, favorita, archivada y si está
 *  en la papelera. La ruta para enseñar la calcula la herramienta con SU filtro. */
export interface OrganizeSaved {
  id: string;
  folderId: string;
  favorite: boolean;
  archived: boolean;
  trashed: boolean;
}

/**
 * Traer al disco los bytes de un adjunto (adjuntos en solo lectura, ampliación de D2 del
 * 30 sep 2026). No devuelve los bytes: los lee quien pide, del almacén compartido, con
 * su propio filtro. Lo hace el escritor porque bajar un blob escribe (`blobPut` del
 * motor guarda los bytes y su fila): un lector se lo pide por `writer.sock`.
 */
export interface FetchAttachmentInput {
  /** La nota VISIBLE que lo adjunta. */
  noteId: string;
  /** SHA-256 en hexadecimal, uno de los `note_blob_refs` de esa nota. */
  sha256: string;
  /** Igual que `EditNoteInput.privacy`. */
  privacy: PrivacyConfig;
}

export interface RestoreVersionInput {
  id: string;
  /** Id de la versión (`hebra_list_versions`). Tiene que ser de ESTA nota. */
  versionId: number;
  /** Igual que en `EditNoteInput`: la `revision` que el agente leyó. */
  expectedRevision: string;
  /** Igual que en `EditNoteInput`: idempotencia, en el mismo registro. */
  operationId: string;
  /** Igual que `EditNoteInput.privacy`. */
  privacy: PrivacyConfig;
}

/** Crear una carpeta (D9): dentro de `parentId` (`ROOT_FOLDER_ID` es la raíz). */
export interface CreateFolderInput {
  parentId: string;
  /** Sin recortar: el plan (`./folders.ts`) lo valida y lo recorta. */
  name: string;
  /** Igual que `EditNoteInput.privacy`. */
  privacy: PrivacyConfig;
}

/** Renombrar una carpeta (D9). */
export interface RenameFolderInput {
  id: string;
  name: string;
  /** Igual que `EditNoteInput.privacy`. */
  privacy: PrivacyConfig;
}

/** La carpeta creada (o la visible que ya estaba) o renombrada, y si se escribió algo.
 *  La ruta para enseñar la calcula la herramienta con SU filtro. */
export interface FolderSaved {
  id: string;
  changed: boolean;
}

/** Añadir un adjunto a una nota (D9). */
export interface AddAttachmentInput {
  id: string;
  /** Sin recortar: se valida con `validAttachmentName`. */
  name: string;
  bytes: Uint8Array;
  /** El que declara el agente: solo decide entre los tipos de texto (`detectAttachmentType`). */
  mimeType: string | null;
  /** Igual que en `EditNoteInput`: idempotencia, en el mismo registro. */
  operationId: string;
  /** Igual que `EditNoteInput.privacy`. */
  privacy: PrivacyConfig;
}

/** El guardado de la nota (como el de una edición: `revision` o copia de conflicto, y
 *  `replayed`) y el adjunto añadido: su SHA-256 y la referencia que quedó en el cuerpo. */
export interface AddAttachmentSaved {
  note: EditNoteSaved;
  attachmentId: string;
  markdown: string;
}

/**
 * Resultado de una escritura que dice si de verdad escribió (`wrote`). Sin escritura (una
 * edición sin cambios, un reintento con el mismo `operationId`, una organización que ya
 * estaba en el estado pedido) no se pide ronda de sync ni se espera: no hay nada nuevo que
 * subir (`src/server/write-context.ts`).
 */
export interface LocalWrite<T> {
  result: T;
  wrote: boolean;
}

/** Los errores del motor de Hebra que la organización de notas puede dar. */
function organizeRejection(error: unknown): unknown {
  if (!(error instanceof LibraryError)) return error;
  if (error.code === 'note_not_found' || error.code === 'folder_not_found') {
    return writeRejected('not_found');
  }
  return error;
}

function noteSaved(row: NoteRow): OrganizeSaved {
  return {
    id: row.id,
    folderId: row.effectiveFolderId,
    favorite: row.favorite,
    archived: row.archivedAt !== null,
    trashed: row.trashedAt !== null
  };
}

/** Prefijo de un cuerpo bloqueado (`LOCKED_MARK` de `sqlite-engine.ts`, Paridad Bear L
 *  §17). Una nota cuyo cuerpo empieza así no se edita, y una edición no puede producirlo. */
export const LOCKED_BODY_PREFIX = 'hebra-locked:';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function bytesSha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Los errores del motor de Hebra que crear o renombrar una carpeta pueden dar. Un
 *  `folder_name_taken` que se escape del plan (`./folders.ts` ya mira las hermanas)
 *  sería una carpeta que este filtro no ve: `folder_unavailable`, nunca el del motor. */
function folderRejection(error: unknown): unknown {
  if (!(error instanceof LibraryError)) return error;
  switch (error.code) {
    case 'folder_name_taken':
      return writeRejected('folder_unavailable');
    case 'folder_not_found':
      return writeRejected('not_found');
    case 'invalid_name':
    case 'root_folder_immutable':
      return writeRejected('invalid_input');
    default:
      return error;
  }
}

/** Cierres de bloque de código que se prueban, en este orden, cuando el cuerpo termina
 *  dentro de un bloque sin cerrar (``` o ~~~, de 3 a 5 marcas). */
const FENCE_CLOSERS = ['```', '~~~', '````', '~~~~', '`````', '~~~~~'] as const;

/**
 * El cuerpo con la referencia de un adjunto al final (`cuerpo + "\n\n" + markdown`, como
 * `appendToNote`) y sus derivados, comprobando con `deriveNote` (el mismo análisis que
 * guarda `note_blob_refs`) que la referencia CUENTA como adjunto. Si el cuerpo termina
 * dentro de un bloque de código sin cerrar, el texto añadido sería código y no adjunto:
 * se cierra el bloque antes (`\n` + la marca que lo cierre) y se vuelve a comprobar. Si
 * ninguna marca vale, `null`. (Si la nota ya referenciaba ese mismo blob en otro sitio,
 * cuenta igual: lo que importa es que el blob quede referenciado y suba.)
 */
function bodyReferencing(
  body: string,
  markdown: string,
  sha256: string
): { body: string; derived: ReturnType<typeof deriveNote> } | null {
  for (const closer of ['', ...FENCE_CLOSERS]) {
    const candidate = closer
      ? `${body}\n${closer}${APPEND_SEPARATOR}${markdown}`
      : `${body}${APPEND_SEPARATOR}${markdown}`;
    const derived = deriveNote(candidate);
    if ((derived.blobRefs ?? []).includes(sha256)) return { body: candidate, derived };
  }
  return null;
}

/** Igual que `editFingerprint` (comparten registro): la operación va en la huella, así
 *  que un `operationId` de una edición no vale para añadir un adjunto. Los bytes, por su
 *  SHA-256. */
function addAttachmentFingerprint(
  input: AddAttachmentInput,
  sha256: string,
  name: string,
  mimeType: string
): string {
  return sha256Hex(JSON.stringify(['addAttachment', input.id, sha256, name, mimeType]));
}

/** Huella de la petición: el mismo `operationId` con otra petición es un error. */
function editFingerprint(input: EditNoteInput): string {
  return sha256Hex(
    JSON.stringify([
      'editNote',
      input.id,
      input.expectedRevision,
      input.edits.map((edit) => [edit.find, edit.replace])
    ])
  );
}

/** Igual que `editFingerprint`: comparten registro, así que la operación va en la huella
 *  y un `operationId` de una edición no vale para restaurar (`operation_id_reused`). */
function restoreVersionFingerprint(input: RestoreVersionInput): string {
  return sha256Hex(
    JSON.stringify(['restoreVersion', input.id, input.expectedRevision, input.versionId])
  );
}

function isEditNoteSaved(value: unknown): value is EditNoteSaved {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string') return false;
  if (record.outcome === 'saved') return typeof record.revision === 'string';
  return record.outcome === 'conflict_copy' && typeof record.copyId === 'string';
}

/**
 * El filtro de privados sobre el almacén TAL COMO ESTÁ en este turno de la cola (ni el
 * sync ni otra escritura pueden cambiarlo hasta que el turno acabe). Cerrado ante la
 * duda: una configuración que no se puede aplicar rechaza sin escribir.
 */
function privacyInTurn(store: NoteWriteStore, config: PrivacyConfig): PrivacyFilter {
  const filter = PrivacyFilter.fromSnapshot(store.foldersList(), store.notesVisibilityIndex(), config);
  if (filter.unresolved) throw writeRejected('privacy_config_unresolved');
  return filter;
}

/**
 * `NoteSaveInput` completo para `body`: TODOS los derivados de `deriveNote` y la base.
 * Se pasan todos, no una lista a mano: el almacén de Hebra reemplaza cada conjunto
 * derivado en cada guardado (`replaceNoteTasks` borra e inserta `tasks ?? []`), así que
 * uno que falte aquí vacía su índice (bug medido el 28 sep 2026 con `tasks`,
 * `hasOpenTasks` y `titleSort`; `test/store/writes-derived.node.test.ts`). `locked` viaja
 * también, aunque `noteSave` lo recalcula del cuerpo y no se fía de él.
 *
 * `base`: la versión sobre la que se escribe. Por defecto, la de `note` (lo recién
 * leído); `editNote` pasa la de la revisión que trae el agente.
 *
 * `derived`: lo que ya devolvió `deriveNote(body)`, si quien llama lo analizó antes (para
 * mirar sus etiquetas) y no quiere pagar el análisis dos veces. Tiene que ser el resultado
 * COMPLETO de `deriveNote` sobre ESTE `body`, no una selección de campos.
 */
export function saveInputFor(
  note: NoteRow,
  body: string,
  base: { localSeq: number; bodySha256: string } = note,
  derived: ReturnType<typeof deriveNote> = deriveNote(body)
): NoteSaveInput {
  return {
    ...derived,
    id: note.id,
    body,
    expectedLocalSeq: base.localSeq,
    baseBodySha256: base.bodySha256
  };
}

export interface NoteWriterOptions {
  /** Tras cada escritura confirmada. Un fallo aquí no deshace ni oculta la escritura. */
  onWritten?: () => void;
}

export class NoteWriter {
  constructor(
    private readonly target: NoteWriteTarget,
    private readonly options: NoteWriterOptions = {}
  ) {}

  private written(): void {
    try {
      this.options.onWritten?.();
    } catch {
      // La escritura ya está en disco; la ronda periódica la subirá.
    }
  }

  /**
   * Crea una nota. Dentro del turno, con la configuración de privados de quien pide: la
   * carpeta tiene que existir y ser visible, y el cuerpo no puede llevar una etiqueta
   * privada (decisión 4 de David, 28 sep 2026: el MCP no le pone una etiqueta privada a
   * ninguna nota). Si no, `not_found` sin crear nada.
   */
  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    const result = await this.target.writeExclusive(async (store) => {
      // Antes de `noteCreate`, que confirma su propia transacción: si `noteSave` fallara
      // después (`invalid_locked_body`), quedaría una nota vacía huérfana; y con una
      // cabecera v1 válida, una nota «bloqueada» con lo que el agente escribió. El MCP
      // nunca crea notas bloqueadas.
      if (input.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('invalid_input');
      const filter = privacyInTurn(store, input.privacy);
      const folderId = input.folderId ?? ROOT_FOLDER_ID;
      if (!filter.folderExists(folderId) || filter.isFolderHidden(folderId)) {
        throw writeRejected('not_found');
      }
      const derived = deriveNote(input.body);
      if (filter.hidesAnyTag((derived.tags ?? []).map(({ tag }) => tag))) {
        throw writeRejected('not_found');
      }
      const note = await store.noteCreate(folderId);
      const saved = await store.noteSave(saveInputFor(note, input.body, note, derived));
      // Recién creada, nadie más la conoce: `redirected` aquí sería un fallo del motor,
      // no un conflicto. Se devuelve igual el id donde quedó el texto.
      const id = saved.outcome === 'saved' ? note.id : saved.redirectedTo;
      const row = await store.noteRead(id);
      return { id, title: row?.title ?? '', folderId: row?.folderId ?? note.folderId };
    });
    this.written();
    return result;
  }

  /**
   * Añade `text` al final de la nota `id`. `note_not_found` (`LibraryError` de Hebra) si
   * no existe o está en la papelera: las herramientas nunca devuelven notas de la
   * papelera (SPEC.md §5), así que tampoco se escribe en ellas. Dentro del turno, con la
   * configuración de privados de quien pide: una nota oculta, o un texto que la dejaría
   * con una etiqueta privada (decisión 4), es `not_found` sin escribir; una nota
   * bloqueada, `note_locked`.
   */
  async appendToNote(input: AppendToNoteInput): Promise<AppendToNoteResult> {
    const result = await this.target.writeExclusive(async (store) => {
      const filter = privacyInTurn(store, input.privacy);
      const note = await store.noteRead(input.id);
      if (!note || note.trashedAt !== null) throw new LibraryError('note_not_found');
      if (filter.isHiddenNote(note.id)) throw writeRejected('not_found');
      if (note.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('note_locked');
      const saveInput = saveInputFor(note, `${note.body}${APPEND_SEPARATOR}${input.text}`);
      if (filter.hidesAnyTag((saveInput.tags ?? []).map(({ tag }) => tag))) {
        throw writeRejected('not_found');
      }
      const saved = await store.noteSave(saveInput);
      return saved.outcome === 'saved'
        ? ({ id: input.id, outcome: 'saved' } as const)
        : ({ id: input.id, outcome: 'conflict_copy', copyId: saved.redirectedTo } as const);
    });
    this.written();
    return result;
  }

  /**
   * Sustituciones puntuales sobre la versión que el agente leyó (D2 ampliada, 28 sep
   * 2026). Todo en UN turno de la cola del almacén, así que ni una ronda de sync ni otra
   * escritura se cuelan entre la comprobación y el guardado:
   * 1. Registro de idempotencia: el mismo `operationId` ya terminado devuelve lo que
   *    devolvió (`replayed`); con otra petición, `operation_id_reused`; a medias
   *    (`started`), el SHA-256 del cuerpo dice si llegó a guardarse.
   * 2. Filtro de privados del que pide, sobre el almacén de ESTE turno: una nota oculta,
   *    en la papelera o inexistente es `not_found`, las tres igual.
   * 3. Nota bloqueada: `note_locked`.
   * 4. Revisión: tiene que ser de esta nota (si no, `invalid_input`) y de esta biblioteca
   *    con el MISMO cuerpo que hay ahora (si no, `revision_conflict`). La base del guardado
   *    es la de la revisión, no la de la nota actual.
   * 5. Sustituciones (`applyEdits`): cualquier fallo rechaza sin escribir.
   * 6. Resultado: si dejaría la nota con una etiqueta privada, `not_found` sin escribir
   *    (decisión 4 de David).
   * 7. `begin` → `noteSave` → `finish` (`./operations.ts`).
   * Un conflicto con otro dispositivo llega DESPUÉS, en la ronda: lo resuelve el motor
   * con una copia visible, y quien espera la ronda lo anota con `recordEditConflict`.
   */
  async editNote(input: EditNoteInput): Promise<EditNoteSaved> {
    return (await this.editNoteLocal(input)).result;
  }

  /** `editNote` diciendo si escribió (`LocalWrite`): lo usa `WriteContext` para no
   *  esperar una ronda cuando no hubo nada que subir. */
  async editNoteLocal(input: EditNoteInput): Promise<LocalWrite<EditNoteSaved>> {
    const { result, wrote } = await this.target.writeExclusive(async (store) => {
      const now = Date.now();
      const log = store.operations;
      log.purgeExpired(now);
      const fingerprint = editFingerprint(input);
      const previous = log.lookup(input.operationId);
      if (previous && previous.fingerprint !== fingerprint) {
        throw writeRejected('operation_id_reused');
      }
      const filter = privacyInTurn(store, input.privacy);
      const note = await store.noteRead(input.id);
      if (!note || note.trashedAt !== null || filter.isHiddenNote(note.id)) {
        throw writeRejected('not_found');
      }
      const libraryId = store.libraryId();
      const revisionOf = (row: { localSeq: number; bodySha256: string }): string =>
        encodeRevision({
          libraryId,
          noteId: input.id,
          localSeq: row.localSeq,
          bodySha256: row.bodySha256
        });

      if (previous?.state === 'done' && isEditNoteSaved(previous.result)) {
        return { result: { ...previous.result, replayed: true as const }, wrote: false };
      }
      if (previous?.state === 'started' && note.bodySha256 === previous.targetBodySha256) {
        // Murió entre el guardado y `finish`: se guardó. Se completa el registro.
        const saved: EditNoteSaved = { id: input.id, outcome: 'saved', revision: revisionOf(note) };
        log.finish(input.operationId, saved);
        return { result: { ...saved, replayed: true as const }, wrote: false };
      }

      if (note.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('note_locked');
      const revision = decodeRevision(input.expectedRevision);
      if (!revision || revision.noteId !== input.id) throw writeRejected('invalid_input');
      if (revision.libraryId !== libraryId || revision.bodySha256 !== note.bodySha256) {
        throw writeRejected('revision_conflict');
      }
      const applied = applyEdits(note.body, input.edits);
      if (!applied.ok) throw writeRejected(applied.code, applied.editIndex);
      if (applied.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('invalid_input');
      if (applied.body === note.body) {
        // Nada que guardar: ni sube `local_seq` ni hay ronda que pedir.
        const unchanged: EditNoteSaved = { id: input.id, outcome: 'saved', revision: revisionOf(note) };
        return { result: unchanged, wrote: false };
      }

      const saveInput = saveInputFor(note, applied.body, revision);
      if (filter.hidesAnyTag((saveInput.tags ?? []).map(({ tag }) => tag))) {
        throw writeRejected('not_found');
      }
      log.begin({
        operationId: input.operationId,
        fingerprint,
        noteId: input.id,
        targetBodySha256: sha256Hex(applied.body),
        now
      });
      const saved = await store.noteSave(saveInput);
      const outcome: EditNoteSaved =
        saved.outcome === 'saved'
          ? { id: input.id, outcome: 'saved', revision: revisionOf(saved) }
          : { id: input.id, outcome: 'conflict_copy', copyId: saved.redirectedTo };
      log.finish(input.operationId, outcome);
      return { result: outcome, wrote: true };
    });
    if (wrote) this.written();
    return { result, wrote };
  }

  /**
   * Restaurar una «versión anterior» (ampliación de D2, 30 sep 2026): una edición NUEVA
   * que deja el cuerpo de la versión, como «Restaurar» en Hebra (`restoreVersion` de
   * `LibraryEditor.svelte`: instantánea YA del cuerpo actual y guardado normal). Mismo
   * turno y mismos pasos que `editNote`, con la versión en lugar de las sustituciones:
   * 1. Idempotencia, en el mismo registro (huella propia, `restoreVersionFingerprint`).
   * 2. Nota visible para quien pide (oculta, en la papelera o inexistente: `not_found`).
   * 3. Nota bloqueada: `note_locked`.
   * 4. Revisión: igual que `editNote` (`invalid_input` / `revision_conflict`).
   * 5. La versión tiene que existir y ser de ESTA nota; si su cuerpo lleva una etiqueta
   *    privada (o descendiente), tampoco vale: `not_found` en los tres casos, igual que
   *    una versión que no existe (regla 4 de D2: nunca llevar una nota a una etiqueta
   *    privada por ninguna vía, y sin delatar que la versión era privada).
   * 6. Instantánea forzada del cuerpo actual (`noteVersionSnapshot`), para que lo que
   *    había se pueda recuperar, y `noteSave` con la base de la revisión: si otro
   *    dispositivo la cambió a la vez, copia de conflicto visible, como `editNote`.
   */
  async restoreVersion(input: RestoreVersionInput): Promise<EditNoteSaved> {
    return (await this.restoreVersionLocal(input)).result;
  }

  /** `restoreVersion` diciendo si escribió (`LocalWrite`), como `editNoteLocal`. */
  async restoreVersionLocal(input: RestoreVersionInput): Promise<LocalWrite<EditNoteSaved>> {
    const { result, wrote } = await this.target.writeExclusive(async (store) => {
      const now = Date.now();
      const log = store.operations;
      log.purgeExpired(now);
      const fingerprint = restoreVersionFingerprint(input);
      const previous = log.lookup(input.operationId);
      if (previous && previous.fingerprint !== fingerprint) {
        throw writeRejected('operation_id_reused');
      }
      const filter = privacyInTurn(store, input.privacy);
      const note = await store.noteRead(input.id);
      if (!note || note.trashedAt !== null || filter.isHiddenNote(note.id)) {
        throw writeRejected('not_found');
      }
      const libraryId = store.libraryId();
      const revisionOf = (row: { localSeq: number; bodySha256: string }): string =>
        encodeRevision({
          libraryId,
          noteId: input.id,
          localSeq: row.localSeq,
          bodySha256: row.bodySha256
        });

      if (previous?.state === 'done' && isEditNoteSaved(previous.result)) {
        return { result: { ...previous.result, replayed: true as const }, wrote: false };
      }
      if (previous?.state === 'started' && note.bodySha256 === previous.targetBodySha256) {
        const saved: EditNoteSaved = { id: input.id, outcome: 'saved', revision: revisionOf(note) };
        log.finish(input.operationId, saved);
        return { result: { ...saved, replayed: true as const }, wrote: false };
      }

      if (note.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('note_locked');
      const revision = decodeRevision(input.expectedRevision);
      if (!revision || revision.noteId !== input.id) throw writeRejected('invalid_input');
      if (revision.libraryId !== libraryId || revision.bodySha256 !== note.bodySha256) {
        throw writeRejected('revision_conflict');
      }
      const version = store.noteVersionRead(input.versionId);
      if (!version || version.noteId !== input.id) throw writeRejected('not_found');
      if (version.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('invalid_input');
      const saveInput = saveInputFor(note, version.body, revision);
      if (filter.hidesAnyTag((saveInput.tags ?? []).map(({ tag }) => tag))) {
        throw writeRejected('not_found');
      }
      if (version.body === note.body) {
        const unchanged: EditNoteSaved = { id: input.id, outcome: 'saved', revision: revisionOf(note) };
        return { result: unchanged, wrote: false };
      }

      log.begin({
        operationId: input.operationId,
        fingerprint,
        noteId: input.id,
        targetBodySha256: sha256Hex(version.body),
        now
      });
      await store.noteVersionSnapshot(input.id);
      const saved = await store.noteSave(saveInput);
      const outcome: EditNoteSaved =
        saved.outcome === 'saved'
          ? { id: input.id, outcome: 'saved', revision: revisionOf(saved) }
          : { id: input.id, outcome: 'conflict_copy', copyId: saved.redirectedTo };
      log.finish(input.operationId, outcome);
      return { result: outcome, wrote: true };
    });
    if (wrote) this.written();
    return { result, wrote };
  }

  /**
   * Organización de notas (D2 ampliada, 28 sep 2026), en UN turno de la cola del
   * almacén, con el filtro de privados de quien pide construido sobre el almacén de ESTE
   * turno:
   * - La nota tiene que ser visible: oculta, en la papelera o inexistente es
   *   `not_found`, las tres igual.
   * - La carpeta de destino de `moveNote` también: una carpeta privada responde
   *   `not_found`, igual que una que no existe (decisión 4 de David: sin revelar que el
   *   destino es privado).
   * Favorita y archivar son idempotentes (fijan un estado). Una nota bloqueada se puede
   * organizar: nada de esto toca su cuerpo.
   *
   * Papelera (ampliación de D2, 30 sep 2026), también idempotentes:
   * - `trashNote`: una nota visible va a la papelera; una que ya está en la papelera y
   *   el filtro de la papelera deja ver (`TrashFilter`) se queda como está.
   * - `restoreNote`: una nota de la papelera visible para el filtro de la papelera sale
   *   de ella; una nota viva y visible se queda como está. El filtro de la papelera ya
   *   comprueba el DESTINO (su carpeta si sigue viva, si no la raíz): nunca deja la nota
   *   en una carpeta privada ni con una etiqueta privada.
   * Lo demás (oculta, inexistente, lápida), `not_found`, sin distinguir.
   */
  async organize(input: OrganizeInput): Promise<OrganizeSaved> {
    return (await this.organizeLocal(input)).result;
  }

  /**
   * `organize` diciendo si escribió (`LocalWrite`). Una nota que ya está en el estado
   * pedido (favorita ya puesta, ya archivada, ya en esa carpeta, ya en la papelera, ya
   * fuera de ella) se devuelve tal cual: sin llamar al motor (que subiría `local_seq` y
   * la dejaría sucia sin nada nuevo que subir) y sin ronda de sync. La visibilidad y el
   * destino se comprueban igual antes, así que un `not_found` no cambia.
   */
  async organizeLocal(input: OrganizeInput): Promise<LocalWrite<OrganizeSaved>> {
    const outcome = await this.target.writeExclusive(async (store): Promise<LocalWrite<OrganizeSaved>> => {
      const filter = privacyInTurn(store, input.privacy);

      const requireVisibleFolder = (id: string): void => {
        if (!filter.folderExists(id) || filter.isFolderHidden(id)) throw writeRejected('not_found');
      };
      const requireVisibleNote = async (id: string): Promise<NoteRow> => {
        const row = await store.noteRead(id);
        if (!row || row.trashedAt !== null || filter.isHiddenNote(id)) {
          throw writeRejected('not_found');
        }
        return row;
      };
      const unchanged = (row: NoteRow): LocalWrite<OrganizeSaved> => ({
        result: noteSaved(row),
        wrote: false
      });
      const written = (row: NoteRow): LocalWrite<OrganizeSaved> => ({
        result: noteSaved(row),
        wrote: true
      });
      /** La nota, viva y visible, o en la papelera y visible para el filtro de la
       *  papelera; si no, `not_found`. */
      const visibleLiveOrTrashed = async (id: string): Promise<NoteRow> => {
        const row = await store.noteRead(id);
        if (!row) throw writeRejected('not_found');
        const visible =
          row.trashedAt === null
            ? !filter.isHiddenNote(id)
            : TrashFilter.fromSnapshot(filter, store.trashIndex(), input.privacy).isVisible(id);
        if (!visible) throw writeRejected('not_found');
        return row;
      };

      try {
        switch (input.action) {
          case 'moveNote': {
            const row = await requireVisibleNote(input.id);
            requireVisibleFolder(input.folderId);
            if (row.folderId === input.folderId) return unchanged(row);
            return written(await store.noteMove(input.id, input.folderId));
          }
          case 'setFavorite': {
            const row = await requireVisibleNote(input.id);
            if (row.favorite === input.favorite) return unchanged(row);
            return written(await store.noteSetFavorite(input.id, input.favorite));
          }
          case 'setArchived': {
            const row = await requireVisibleNote(input.id);
            if ((row.archivedAt !== null) === input.archived) return unchanged(row);
            return written(
              input.archived ? await store.noteArchive(input.id) : await store.noteUnarchive(input.id)
            );
          }
          case 'trashNote': {
            const row = await visibleLiveOrTrashed(input.id);
            return row.trashedAt === null ? written(await store.noteTrash(input.id)) : unchanged(row);
          }
          case 'restoreNote': {
            const row = await visibleLiveOrTrashed(input.id);
            return row.trashedAt === null ? unchanged(row) : written(await store.noteRestore(input.id));
          }
        }
      } catch (error) {
        throw organizeRejection(error);
      }
    });
    if (outcome.wrote) this.written();
    return outcome;
  }

  /**
   * Crea una carpeta (D9, 3 oct 2026). En UN turno de la cola, con el filtro de privados
   * de quien pide sobre el almacén de ESTE turno, rehace el plan de `./folders.ts`
   * (nombre, padre visible, ruta privada desde la configuración, hermanas homónimas):
   * una hermana VISIBLE con ese nombre se devuelve tal cual (`changed: false`, sin ronda),
   * y cualquier rechazo sale sin escribir. Solo entonces `folderCreate` del motor.
   */
  async createFolderLocal(input: CreateFolderInput): Promise<LocalWrite<FolderSaved>> {
    const outcome = await this.target.writeExclusive(async (store): Promise<LocalWrite<FolderSaved>> => {
      const plan = planCreateFolder(privacyInTurn(store, input.privacy), input.parentId, input.name);
      switch (plan.kind) {
        case 'reject':
          throw writeRejected(plan.code);
        case 'existing':
          return { result: { id: plan.id, changed: false }, wrote: false };
        case 'create':
          try {
            const row = await store.folderCreate(plan.parentId, plan.name);
            return { result: { id: row.id, changed: true }, wrote: true };
          } catch (error) {
            throw folderRejection(error);
          }
      }
    });
    if (outcome.wrote) this.written();
    return outcome;
  }

  /**
   * Renombra una carpeta (D9), igual que `createFolderLocal`: plan rehecho en el turno
   * (carpeta visible, ninguna privada debajo, ruta nueva no privada, hermanas) y después
   * `folderRename`. El nombre que ya tiene no escribe (`changed: false`).
   */
  async renameFolderLocal(input: RenameFolderInput): Promise<LocalWrite<FolderSaved>> {
    const outcome = await this.target.writeExclusive(async (store): Promise<LocalWrite<FolderSaved>> => {
      const plan = planRenameFolder(privacyInTurn(store, input.privacy), input.id, input.name);
      switch (plan.kind) {
        case 'reject':
          throw writeRejected(plan.code);
        case 'unchanged':
          return { result: { id: input.id, changed: false }, wrote: false };
        case 'rename':
          try {
            await store.folderRename(plan.id, plan.name);
            return { result: { id: plan.id, changed: true }, wrote: true };
          } catch (error) {
            throw folderRejection(error);
          }
      }
    });
    if (outcome.wrote) this.written();
    return outcome;
  }

  /**
   * Añade un adjunto al final de una nota (D9, 3 oct 2026). Antes del turno, lo que no
   * depende del almacén, otra vez aunque la herramienta ya lo mirara (puede llegar de un
   * lector por `writer.sock`): nombre (`invalid_input`), tamaño
   * (`attachment_too_large`) y tipo por el contenido (`attachment_type_not_allowed`), con
   * la misma detección que la lectura. Después, en UN turno de la cola, los pasos de
   * `editNote` con la base de `appendToNote`:
   * 1. Registro de idempotencia (huella propia: un `operationId` de otra operación da
   *    `operation_id_reused`); ya terminado, se devuelve con `replayed`; a medias, el
   *    SHA-256 del cuerpo dice si se guardó.
   * 2. Nota visible para quien pide, viva (`not_found`) y no bloqueada (`note_locked`).
   * 3. `blobPut` de los bytes con el tipo DETECTADO (no el declarado) y, en el mismo
   *    turno, `noteSave` de `cuerpo + "\n\n" + ![[sha256:H|nombre]]` con la base recién
   *    leída. El blob va antes que la nota: una nota nunca referencia un blob que no está;
   *    si el proceso muere entre los dos, queda un blob local sin referencia, que el sync
   *    no sube (solo sube los referenciados) y el reintento reutiliza.
   * Un `redirected` deja la referencia en una copia de conflicto visible (`conflict_copy`).
   * Un choque con otro dispositivo llega en la ronda, y lo anota quien la espera con
   * `recordEditConflict`, como en una edición.
   */
  async addAttachmentLocal(input: AddAttachmentInput): Promise<LocalWrite<AddAttachmentSaved>> {
    const name = validAttachmentName(input.name);
    if (name === null || input.bytes.length === 0) throw writeRejected('invalid_input');
    if (input.bytes.length > ATTACHMENT_MAX_BYTES) throw writeRejected('attachment_too_large');
    const detected = detectAttachmentType(input.bytes, input.mimeType, name);
    if (!detected.allowed) throw writeRejected('attachment_type_not_allowed');
    const attachmentId = bytesSha256Hex(input.bytes);
    const markdown = attachmentMarkdown(attachmentId, name);
    const fingerprint = addAttachmentFingerprint(input, attachmentId, name, detected.mimeType);
    const added = (note: EditNoteSaved): AddAttachmentSaved => ({ note, attachmentId, markdown });

    const { result, wrote } = await this.target.writeExclusive(async (store) => {
      const now = Date.now();
      const log = store.operations;
      log.purgeExpired(now);
      const previous = log.lookup(input.operationId);
      if (previous && previous.fingerprint !== fingerprint) {
        throw writeRejected('operation_id_reused');
      }
      const filter = privacyInTurn(store, input.privacy);
      const note = await store.noteRead(input.id);
      if (!note || note.trashedAt !== null || filter.isHiddenNote(note.id)) {
        throw writeRejected('not_found');
      }
      const libraryId = store.libraryId();
      const revisionOf = (row: { localSeq: number; bodySha256: string }): string =>
        encodeRevision({
          libraryId,
          noteId: input.id,
          localSeq: row.localSeq,
          bodySha256: row.bodySha256
        });

      if (previous?.state === 'done' && isEditNoteSaved(previous.result)) {
        return { result: added({ ...previous.result, replayed: true as const }), wrote: false };
      }
      if (
        previous?.state === 'started' &&
        (note.bodySha256 === previous.targetBodySha256 || note.body.includes(markdown))
      ) {
        // Murió entre el guardado y `finish`: se guardó (y el blob, antes). Se completa.
        // No basta el SHA-256 del cuerpo: si después otra escritura (o el sync) cambió la
        // nota, la referencia sigue ahí y volver a añadirla la duplicaría. (Si el guardado
        // acabó en una copia de conflicto, en `started` no consta cuál: esa vía, la de un
        // `redirected` dentro del turno, solo se da con una lápida.)
        const saved: EditNoteSaved = { id: input.id, outcome: 'saved', revision: revisionOf(note) };
        log.finish(input.operationId, saved);
        return { result: added({ ...saved, replayed: true as const }), wrote: false };
      }

      if (note.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('note_locked');
      const withAttachment = bodyReferencing(note.body, markdown, attachmentId);
      // Ni cerrando un bloque de código la referencia cuenta como adjunto (otra construcción
      // sin cerrar se la traga): no se guarda un blob que ninguna nota referenciaría.
      if (!withAttachment) throw writeRejected('invalid_input');
      const { body, derived } = withAttachment;
      const saveInput = saveInputFor(note, body, note, derived);
      if (filter.hidesAnyTag((saveInput.tags ?? []).map(({ tag }) => tag))) {
        throw writeRejected('not_found');
      }
      log.begin({
        operationId: input.operationId,
        fingerprint,
        noteId: input.id,
        targetBodySha256: sha256Hex(body),
        now
      });
      await store.blobPut(input.bytes, { mime: detected.mimeType, expectedSha256: attachmentId });
      const saved = await store.noteSave(saveInput);
      const outcome: EditNoteSaved =
        saved.outcome === 'saved'
          ? { id: input.id, outcome: 'saved', revision: revisionOf(saved) }
          : { id: input.id, outcome: 'conflict_copy', copyId: saved.redirectedTo };
      log.finish(input.operationId, outcome);
      return { result: added(outcome), wrote: true };
    });
    if (wrote) this.written();
    return { result, wrote };
  }

  /**
   * Trae al disco los bytes de un adjunto, sin devolverlos (`FetchAttachmentInput`).
   * Primero, en UN turno de la cola y con la configuración de privados de quien pide:
   * la nota tiene que ser visible (oculta, en la papelera o inexistente: `not_found`), no
   * estar bloqueada (`note_locked`: sus adjuntos van cifrados con ella) y adjuntar ESE
   * SHA-256 (si no, `not_found`). Después, fuera del turno (la descarga pasa por la misma
   * cola cuando guarda), `download`: `readBlob` del motor de sync, que baja el objeto de
   * Blob V2, lo descifra, verifica el hash y lo guarda en su almacén de adjuntos, la
   * única caché que hay. Devuelve si los bytes quedaron aquí. Nunca escribe en la nota
   * ni crea, cambia o borra adjuntos.
   */
  async fetchAttachment(
    input: FetchAttachmentInput,
    download: ((sha256: string) => Promise<boolean>) | null
  ): Promise<boolean> {
    const sha256 = input.sha256.toLowerCase();
    const present = await this.target.writeExclusive(async (store) => {
      const filter = privacyInTurn(store, input.privacy);
      const note = await store.noteRead(input.noteId);
      if (!note || note.trashedAt !== null || filter.isHiddenNote(note.id)) {
        throw writeRejected('not_found');
      }
      if (note.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('note_locked');
      const row = store.noteAttachments(note.id).find((entry) => entry.sha256 === sha256);
      if (!row) throw writeRejected('not_found');
      return row.present;
    });
    // `readBlob` mira primero lo local (y verifica el hash): se le pide aunque la fila
    // diga que está, por si el fichero se quedó a medias.
    return download ? download(sha256) : present;
  }

  /**
   * La ronda de después de una edición produjo una copia de conflicto para esa nota (otro
   * dispositivo la cambió a la vez): se anota en el registro de idempotencia, para que un
   * reintento con el mismo `operationId` devuelva `conflict_copy` y no un `saved` con una
   * revisión que ya no casa. Si el registro no existe o no terminó, no hace nada.
   */
  async recordEditConflict(operationId: string, id: string, copyId: string): Promise<void> {
    await this.target.writeExclusive(async (store) => {
      const record = store.operations.lookup(operationId);
      if (record?.state !== 'done' || record.noteId !== id) return;
      const conflict: EditNoteSaved = { id, outcome: 'conflict_copy', copyId };
      store.operations.finish(operationId, conflict);
    });
  }
}
