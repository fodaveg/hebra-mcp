/**
 * Socket del escritor (SPEC.md §8): cómo una instancia lectora de hebra-mcp le pide al
 * escritor único que escriba por ella.
 *
 * Claude Code lanza un proceso `serve` por sesión. Solo el que tiene `writer.lock`
 * (`src/lock/writer-lock.ts`) abre la SQLite en lectura-escritura y sincroniza; los demás
 * la leen en solo lectura. Para que cualquier sesión pueda crear o ampliar notas, el
 * escritor escucha en un socket Unix `writer.sock` del directorio de datos y los lectores
 * le reenvían ahí las escrituras (`src/server/forward.ts`).
 *
 * Protocolo: JSON por líneas (`\n`), una petición y una respuesta por línea, emparejadas
 * por `id` de petición. Cada petición lleva `op` y `params`. Todas las escrituras llevan
 * `privacy`, la configuración de privados del LECTOR, que el escritor aplica dentro del
 * turno de la escritura (D2 ampliada, 28 sep 2026); sin ella, `invalid_request`:
 * - `createNote` `{body, folderId, privacy}` → `{id, title, folderId}`.
 * - `appendToNote` `{id, text, privacy}` → `{id, outcome, copyId?}`, ya con la ronda de
 *   sync esperada en el escritor (como `hebra_append_to_note` con `awaitRound`).
 * - `status` `{}` → el estado de sync del escritor, sin `writer` ni `linked`.
 * - `editNote` `{id, edits, expectedRevision, operationId, privacy}` → el resultado
 *   completo de `hebra_edit_note` (`EditNoteOutcome`), con la ronda ya esperada en el
 *   escritor.
 * - `organize` `{action, …, privacy}` → `OrganizeOutcome` (mover nota, favorita,
 *   archivar y, desde el 30 sep 2026, `trashNote`/`restoreNote`), igual: ronda esperada
 *   y privacidad del lector. Sin acciones de carpetas (opción A de David, 28 sep 2026)
 *   ni de purga: una acción desconocida es `invalid_request`.
 * - `restoreVersion` `{id, versionId, expectedRevision, operationId, privacy}` → lo
 *   mismo que `editNote` (`EditNoteOutcome`), restaurando una versión anterior.
 * - `fetchAttachment` `{noteId, sha256, privacy}` → `{available}`: el escritor baja al
 *   disco compartido los bytes de un adjunto de una nota visible (adjuntos en solo
 *   lectura, 30 sep 2026). La respuesta NUNCA lleva los bytes: el lector los lee del
 *   disco, con su filtro.
 * - `createFolder` `{parentId, name, privacy}` y `renameFolder` `{id, name, privacy}` (D9,
 *   3 oct 2026) → `FolderOutcome` (`{id, changed, sync, syncError?}`), con la ronda ya
 *   esperada. Sin acciones de mover ni borrar carpetas.
 * - `addAttachment` `{id, name, dataBase64, mimeType, operationId, privacy}` (D9) →
 *   `AddAttachmentOutcome`, con la ronda ya esperada. Los bytes van en base64 del lector
 *   al escritor, nunca de vuelta, y el escritor los decodifica con la misma regla
 *   estricta que la herramienta.
 * Respuesta: `{id, ok: true, result}` o `{id, ok: false, error, edit?}` con un código
 * cerrado (`WriterSocketErrorCode`) y, en los rechazos de una sustitución, su índice.
 * Nunca viaja el mensaje de una excepción.
 *
 * Seguridad:
 * - El directorio de datos ya es 0700; el socket queda además en 0600 (umask acotado a
 *   `listen` y `chmod` después, por si el umask no se puede tocar en este hilo).
 * - Solo lo abre quien tiene el bloqueo: cualquier `writer.sock` que haya al arrancar es
 *   de un escritor muerto y se sustituye (`bind` en una ruta temporal y `rename`).
 * - Al cerrar se borra solo si sigue siendo el suyo (mismo inodo), para no llevarse el
 *   de un escritor nuevo que ya tomó el relevo. Por eso el `bind` no se hace sobre
 *   `writer.sock`: libuv borra al cerrar la ruta del `bind` sin mirar de quién es
 *   (medido: sin el `rename`, el test del socket ajeno lo pierde).
 * - Límite por mensaje (`MAX_MESSAGE_BYTES`): el cuerpo máximo de §5 escapado en JSON en
 *   el peor caso, más un margen. Lo que lo pase se rechaza y se cierra la conexión, sin
 *   leer más. El escritor vuelve a comprobar los límites de §5 aunque el lector ya lo
 *   hiciera: no se fía de lo que le llega.
 *
 * Logs (§6.4): eventos cerrados (`writer.socket`, `writer.socket.request`) con la
 * operación y códigos. Ni cuerpos, ni textos, ni ids de nota.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { LibraryError } from '../hebra';
import { logEvent } from '../log/logger';
import type { PrivacyConfig } from '../privacy/config';
import type {
  AddAttachmentOutcome,
  EditNoteOutcome,
  FolderOutcome,
  OrganizeOutcome
} from '../server/write-context';
import { decodeAttachmentBase64 } from '../store/attachment-content';
import { editsWithinLimits, type TextEdit } from '../store/edits';
import {
  busyOtherInstance,
  isBusyOtherInstance,
  isWriteRejectionCode,
  StoreError,
  WRITE_REJECTION_CODES,
  writeRejected,
  type WriteRejectionCode
} from '../store/errors';
import { OPERATION_ID_MAX_LENGTH } from '../store/operations';
import { REVISION_MAX_LENGTH } from '../store/revision';
import {
  APPEND_TEXT_MAX_LENGTH,
  CREATE_BODY_MAX_LENGTH,
  MAX_WRITE_MESSAGE_BYTES,
  type AddAttachmentInput,
  type AppendToNoteInput,
  type AppendToNoteResult,
  type CreateFolderInput,
  type CreateNoteInput,
  type CreateNoteResult,
  type EditNoteInput,
  type FetchAttachmentInput,
  type OrganizeInput,
  type RenameFolderInput,
  type RestoreVersionInput
} from '../store/writes';

export const WRITER_SOCKET_FILE = 'writer.sock';

/**
 * Tamaño máximo de una línea del protocolo, en bytes (`MAX_WRITE_MESSAGE_BYTES`, ver su
 * cálculo): lo mayor entre el cuerpo de `createNote` con el peor escape JSON (`\uXXXX`, 6
 * bytes por unidad UTF-16; las sustituciones de `editNote` suman como mucho lo mismo) y
 * el base64 de un adjunto de 5 MiB de `addAttachment` (D9), más el margen del sobre y de
 * la configuración de privados del lector.
 */
export const MAX_MESSAGE_BYTES = MAX_WRITE_MESSAGE_BYTES;

/** Longitud máxima, sin recortar, del nombre de una carpeta o de un adjunto que llega por
 *  el socket. El escritor lo valida después con la regla de cada uno (255 tras recortar);
 *  esto solo corta lo desmedido antes de mirarlo. */
const MAX_NAME_INPUT_LENGTH = 1024;

/** Longitud máxima del `mimeType` declarado de un adjunto. */
const MAX_MIME_LENGTH = 255;

/** Una respuesta nunca lleva cuerpos: basta con mucho menos. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Longitud máxima de un id de nota o de carpeta (son UUID; el margen es de sobra). */
const MAX_ID_LENGTH = 200;

export type WriterSocketOp =
  | 'createNote'
  | 'appendToNote'
  | 'editNote'
  | 'organize'
  | 'restoreVersion'
  | 'fetchAttachment'
  | 'createFolder'
  | 'renameFolder'
  | 'addAttachment'
  | 'status';

const OPS: ReadonlySet<string> = new Set<WriterSocketOp>([
  'createNote',
  'appendToNote',
  'editNote',
  'organize',
  'restoreVersion',
  'fetchAttachment',
  'createFolder',
  'renameFolder',
  'addAttachment',
  'status'
]);

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Códigos de error del protocolo: cerrados, sin texto libre. Los de
 *  `WriteRejectionCode` son los rechazos de la edición y la organización
 *  (`src/store/errors.ts`), que viajan tal cual. */
export type WriterSocketErrorCode =
  | 'busy_other_instance'
  | 'note_not_found'
  | 'folder_not_found'
  | 'invalid_request'
  | 'message_too_large'
  | 'internal'
  | WriteRejectionCode;

const REMOTE_LIBRARY_CODES = new Set(['note_not_found', 'folder_not_found']);

/** Estado de sync del escritor para `hebra_status` de un lector (SPEC.md §5). */
export interface WriterSyncStatus {
  lastSyncAt: string | null;
  lastSyncOutcome: string | null;
  pendingUpload: number;
  errorsByCode: Record<string, number>;
  revoked: boolean;
}

/** Lo que el escritor hace con cada operación (lo monta `src/server/forward.ts`). */
export interface WriterSocketHandlers {
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>;
  /** Escribe y espera la ronda de sync (con su copia de conflicto, si la hubo). */
  appendToNote(input: AppendToNoteInput): Promise<AppendToNoteResult>;
  /** Edita, espera la ronda y devuelve el estado de sync (`hebra_edit_note`). */
  editNote(input: EditNoteInput): Promise<EditNoteOutcome>;
  /** Organiza, espera la ronda y devuelve el estado de sync. */
  organize(input: OrganizeInput): Promise<OrganizeOutcome>;
  /** Restaura una versión, espera la ronda y devuelve el estado de sync. */
  restoreVersion(input: RestoreVersionInput): Promise<EditNoteOutcome>;
  /** Trae al disco los bytes de un adjunto; nunca los devuelve. */
  fetchAttachment(input: FetchAttachmentInput): Promise<{ available: boolean }>;
  /** Crea o renombra una carpeta (D9), espera la ronda y devuelve el estado de sync. */
  createFolder(input: CreateFolderInput): Promise<FolderOutcome>;
  renameFolder(input: RenameFolderInput): Promise<FolderOutcome>;
  /** Añade un adjunto (D9), espera la ronda y devuelve el estado de sync. */
  addAttachment(input: AddAttachmentInput): Promise<AddAttachmentOutcome>;
  status(): Promise<WriterSyncStatus>;
}

interface RequestEnvelope {
  id: number | string;
  op: WriterSocketOp;
  params: Record<string, unknown>;
}

type ResponseEnvelope =
  | { id: number | string | null; ok: true; result: unknown }
  | { id: number | string | null; ok: false; error: WriterSocketErrorCode; edit?: number };

class InvalidRequest extends Error {
  constructor() {
    super('invalid_request');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEnvelope(line: string): RequestEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new InvalidRequest();
  }
  if (!isPlainObject(value)) throw new InvalidRequest();
  const { id, op, params } = value;
  if (typeof id !== 'number' && typeof id !== 'string') throw new InvalidRequest();
  if (typeof op !== 'string' || !OPS.has(op)) throw new InvalidRequest();
  if (params !== undefined && !isPlainObject(params)) throw new InvalidRequest();
  return { id, op: op as WriterSocketOp, params: params ?? {} };
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function createInputOf(params: Record<string, unknown>): CreateNoteInput {
  const { body, folderId } = params;
  if (typeof body !== 'string' || body.length > CREATE_BODY_MAX_LENGTH) throw new InvalidRequest();
  if (folderId !== null && folderId !== undefined && !isId(folderId)) throw new InvalidRequest();
  return { body, folderId: folderId ?? null, privacy: privacyOf(params.privacy) };
}

function appendInputOf(params: Record<string, unknown>): AppendToNoteInput {
  const { id, text } = params;
  if (!isId(id) || typeof text !== 'string' || text.length > APPEND_TEXT_MAX_LENGTH) {
    throw new InvalidRequest();
  }
  return { id, text, privacy: privacyOf(params.privacy) };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** La configuración de privados del lector: obligatoria en las operaciones que la llevan
 *  (sin ella el escritor no sabría qué ocultar, y no supone la suya). */
function privacyOf(value: unknown): PrivacyConfig {
  if (!isPlainObject(value)) throw new InvalidRequest();
  const { privateFolders, privateTags } = value;
  if (!Array.isArray(privateFolders) || !privateFolders.every(isStringArray)) {
    throw new InvalidRequest();
  }
  if (!isStringArray(privateTags)) throw new InvalidRequest();
  return { privateFolders, privateTags };
}

/** `operationId` y `expectedRevision` de `editNote` y `restoreVersion`. */
function revisionFieldsOf(params: Record<string, unknown>): {
  expectedRevision: string;
  operationId: string;
} {
  const { expectedRevision, operationId } = params;
  if (
    typeof operationId !== 'string' ||
    operationId.length === 0 ||
    operationId.length > OPERATION_ID_MAX_LENGTH
  ) {
    throw new InvalidRequest();
  }
  if (typeof expectedRevision !== 'string' || expectedRevision.length > REVISION_MAX_LENGTH) {
    throw new InvalidRequest();
  }
  return { expectedRevision, operationId };
}

function fetchAttachmentInputOf(params: Record<string, unknown>): FetchAttachmentInput {
  const { noteId, sha256 } = params;
  if (!isId(noteId) || typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    throw new InvalidRequest();
  }
  return { noteId, sha256, privacy: privacyOf(params.privacy) };
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_NAME_INPUT_LENGTH;
}

function createFolderInputOf(params: Record<string, unknown>): CreateFolderInput {
  const { parentId, name } = params;
  if (!isId(parentId) || !isName(name)) throw new InvalidRequest();
  return { parentId, name, privacy: privacyOf(params.privacy) };
}

function renameFolderInputOf(params: Record<string, unknown>): RenameFolderInput {
  const { id, name } = params;
  if (!isId(id) || !isName(name)) throw new InvalidRequest();
  return { id, name, privacy: privacyOf(params.privacy) };
}

/** `addAttachment` (D9): el base64 se decodifica aquí con la regla estricta de la
 *  herramienta (`decodeAttachmentBase64`); uno mal formado es `invalid_request`, y uno
 *  de más de 5 MiB, `attachment_too_large` (el rechazo de siempre del escritor). Nombre,
 *  tipo y tamaño los vuelve a comprobar `NoteWriter.addAttachment`. */
function addAttachmentInputOf(params: Record<string, unknown>): AddAttachmentInput {
  const { id, name, dataBase64, mimeType, operationId } = params;
  if (!isId(id) || !isName(name) || typeof dataBase64 !== 'string') throw new InvalidRequest();
  if (
    mimeType !== null &&
    mimeType !== undefined &&
    (typeof mimeType !== 'string' || mimeType.length > MAX_MIME_LENGTH)
  ) {
    throw new InvalidRequest();
  }
  if (
    typeof operationId !== 'string' ||
    operationId.length === 0 ||
    operationId.length > OPERATION_ID_MAX_LENGTH
  ) {
    throw new InvalidRequest();
  }
  const privacy = privacyOf(params.privacy);
  const decoded = decodeAttachmentBase64(dataBase64);
  if (!decoded.ok) {
    if (decoded.code === 'attachment_too_large') throw writeRejected('attachment_too_large');
    throw new InvalidRequest();
  }
  return { id, name, bytes: decoded.bytes, mimeType: mimeType ?? null, operationId, privacy };
}

function restoreVersionInputOf(params: Record<string, unknown>): RestoreVersionInput {
  const { id, versionId } = params;
  if (!isId(id)) throw new InvalidRequest();
  if (typeof versionId !== 'number' || !Number.isSafeInteger(versionId) || versionId < 1) {
    throw new InvalidRequest();
  }
  return { id, versionId, ...revisionFieldsOf(params), privacy: privacyOf(params.privacy) };
}

function editInputOf(params: Record<string, unknown>): EditNoteInput {
  const { id, edits, privacy } = params;
  if (!isId(id)) throw new InvalidRequest();
  const { expectedRevision, operationId } = revisionFieldsOf(params);
  if (!Array.isArray(edits)) throw new InvalidRequest();
  const parsed: TextEdit[] = edits.map((edit: unknown) => {
    if (!isPlainObject(edit) || typeof edit.find !== 'string' || typeof edit.replace !== 'string') {
      throw new InvalidRequest();
    }
    return { find: edit.find, replace: edit.replace };
  });
  if (!editsWithinLimits(parsed)) throw new InvalidRequest();
  return { id, edits: parsed, expectedRevision, operationId, privacy: privacyOf(privacy) };
}

function organizeInputOf(params: Record<string, unknown>): OrganizeInput {
  const privacy = privacyOf(params.privacy);
  const { id } = params;
  switch (params.action) {
    case 'moveNote':
      if (!isId(id) || !isId(params.folderId)) throw new InvalidRequest();
      return { action: 'moveNote', id, folderId: params.folderId, privacy };
    case 'setFavorite':
      if (!isId(id) || typeof params.favorite !== 'boolean') throw new InvalidRequest();
      return { action: 'setFavorite', id, favorite: params.favorite, privacy };
    case 'setArchived':
      if (!isId(id) || typeof params.archived !== 'boolean') throw new InvalidRequest();
      return { action: 'setArchived', id, archived: params.archived, privacy };
    case 'trashNote':
    case 'restoreNote':
      if (!isId(id)) throw new InvalidRequest();
      return { action: params.action, id, privacy };
    default:
      throw new InvalidRequest();
  }
}

/** Código cerrado de un fallo del escritor; nunca el mensaje. */
function errorCodeOf(error: unknown): WriterSocketErrorCode {
  if (error instanceof InvalidRequest) return 'invalid_request';
  if (isBusyOtherInstance(error)) return 'busy_other_instance';
  if (error instanceof StoreError && isWriteRejectionCode(error.code)) return error.code;
  if (error instanceof LibraryError && REMOTE_LIBRARY_CODES.has(error.code)) {
    return error.code as WriterSocketErrorCode;
  }
  return 'internal';
}

/** Índice de la sustitución que falló, si el rechazo lo trae. */
function editIndexOf(error: unknown): number | undefined {
  return error instanceof StoreError ? error.editIndex : undefined;
}

function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

function inodeOf(path: string): number | null {
  try {
    return statSync(path).ino;
  } catch {
    return null;
  }
}

export interface WriterSocketServerOptions {
  /** Ruta del socket (`<dataDir>/writer.sock`). */
  path: string;
  handlers: WriterSocketHandlers;
  /** Tope por línea (tests). Por defecto, `MAX_MESSAGE_BYTES`. */
  maxMessageBytes?: number;
}

/**
 * El lado del escritor. Se crea con `WriterSocketServer.listen` SOLO teniendo el
 * bloqueo; `close` lo cierra y borra el fichero si sigue siendo el suyo.
 */
export class WriterSocketServer {
  private readonly connections = new Set<Socket>();
  private readonly server: Server;
  private inode: number | null = null;
  private closed = false;
  private readonly onExit = (): void => this.unlinkIfOurs();

  private constructor(
    readonly path: string,
    handlers: WriterSocketHandlers,
    maxBytes: number
  ) {
    this.server = createServer((socket) => this.accept(socket, handlers, maxBytes));
  }

  static async listen(options: WriterSocketServerOptions): Promise<WriterSocketServer> {
    const { path } = options;
    const holder = new WriterSocketServer(
      path,
      options.handlers,
      options.maxMessageBytes ?? MAX_MESSAGE_BYTES
    );
    const { server } = holder;
    // `bind` en una ruta temporal y `rename` a `writer.sock`, por dos motivos:
    // - libuv borra al cerrar el servidor la ruta en la que hizo `bind`, sin mirar de
    //   quién es. Si fuera `writer.sock`, un escritor que suelta el papel se llevaría el
    //   socket del escritor nuevo. Así borra la temporal, que ya no existe, y
    //   `writer.sock` solo lo borra `unlinkIfOurs` (mismo inodo).
    // - `rename` sustituye de forma atómica el `writer.sock` de un escritor muerto
    //   (SIGKILL, sin limpieza): quien llama tiene el bloqueo, así que ese fichero no es
    //   de nadie vivo. Y el socket ya está en 0600 antes de aparecer con su nombre.
    const bindPath = join(dirname(path), `.ws-${randomBytes(4).toString('hex')}`);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // El `bind` de un socket Unix ocurre dentro de `listen`, de forma síncrona: el
      // umask solo afecta a esta llamada. En un worker thread `process.umask` lanza;
      // entonces queda el `chmod` de después (y el 0700 del directorio).
      let previous: number | null = null;
      try {
        previous = process.umask(0o177);
      } catch {
        previous = null;
      }
      try {
        server.listen(bindPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      } finally {
        if (previous !== null) process.umask(previous);
      }
    });
    try {
      chmodSync(bindPath, 0o600);
      renameSync(bindPath, path);
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
    // Un servidor escuchando no mantiene vivo el proceso: lo mantiene el transporte MCP.
    // Sin esto, un escritor cuya sesión cerró stdin seguiría vivo con el bloqueo.
    server.unref();
    holder.inode = inodeOf(path);
    process.once('exit', holder.onExit);
    logEvent({ event: 'writer.socket', result: 'listening' });
    return holder;
  }

  private accept(socket: Socket, handlers: WriterSocketHandlers, maxBytes: number): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.connections.add(socket);
    socket.once('close', () => this.connections.delete(socket));
    socket.on('error', () => undefined);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const reject = (error: WriterSocketErrorCode): void => {
      logEvent({ event: 'writer.socket.request', outcome: 'rejected', code: error });
      socket.end(`${JSON.stringify({ id: null, ok: false, error } satisfies ResponseEnvelope)}\n`);
    };
    socket.on('data', (chunk: Buffer) => {
      let start = 0;
      for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, start)) {
        const part = chunk.subarray(start, index);
        if (pendingBytes + part.length > maxBytes) {
          reject('message_too_large');
          socket.removeAllListeners('data');
          return;
        }
        const line = Buffer.concat([...pending, part]).toString('utf8');
        pending = [];
        pendingBytes = 0;
        start = index + 1;
        let envelope: RequestEnvelope;
        try {
          envelope = parseEnvelope(line);
        } catch {
          reject('invalid_request');
          socket.removeAllListeners('data');
          return;
        }
        void this.dispatch(socket, envelope, handlers);
      }
      const rest = chunk.subarray(start);
      if (pendingBytes + rest.length > maxBytes) {
        reject('message_too_large');
        socket.removeAllListeners('data');
        return;
      }
      if (rest.length > 0) {
        pending.push(rest);
        pendingBytes += rest.length;
      }
    });
  }

  private async dispatch(
    socket: Socket,
    envelope: RequestEnvelope,
    handlers: WriterSocketHandlers
  ): Promise<void> {
    let response: ResponseEnvelope;
    try {
      let result: unknown;
      switch (envelope.op) {
        case 'createNote':
          result = await handlers.createNote(createInputOf(envelope.params));
          break;
        case 'appendToNote':
          result = await handlers.appendToNote(appendInputOf(envelope.params));
          break;
        case 'editNote':
          result = await handlers.editNote(editInputOf(envelope.params));
          break;
        case 'organize':
          result = await handlers.organize(organizeInputOf(envelope.params));
          break;
        case 'restoreVersion':
          result = await handlers.restoreVersion(restoreVersionInputOf(envelope.params));
          break;
        case 'fetchAttachment':
          result = await handlers.fetchAttachment(fetchAttachmentInputOf(envelope.params));
          break;
        case 'createFolder':
          result = await handlers.createFolder(createFolderInputOf(envelope.params));
          break;
        case 'renameFolder':
          result = await handlers.renameFolder(renameFolderInputOf(envelope.params));
          break;
        case 'addAttachment':
          result = await handlers.addAttachment(addAttachmentInputOf(envelope.params));
          break;
        case 'status':
          result = await handlers.status();
          break;
      }
      response = { id: envelope.id, ok: true, result };
      logEvent({ event: 'writer.socket.request', op: envelope.op, outcome: 'ok' });
    } catch (error) {
      const code = errorCodeOf(error);
      const edit = editIndexOf(error);
      response =
        edit === undefined
          ? { id: envelope.id, ok: false, error: code }
          : { id: envelope.id, ok: false, error: code, edit };
      logEvent({ event: 'writer.socket.request', op: envelope.op, outcome: 'error', code });
    }
    if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(response)}\n`);
  }

  /** Deja de aceptar, corta las conexiones abiertas y borra el socket si es el suyo. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    process.removeListener('exit', this.onExit);
    for (const socket of this.connections) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.unlinkIfOurs();
    logEvent({ event: 'writer.socket', result: 'closed' });
  }

  /** Síncrono: vale dentro de un manejador de `exit`. */
  private unlinkIfOurs(): void {
    if (this.inode === null || inodeOf(this.path) !== this.inode) return;
    try {
      unlinkSync(this.path);
    } catch {
      // Ya no estaba.
    }
  }
}

/** Por qué no se pudo hablar con el escritor. */
export type WriterUnavailableReason =
  /** No hay `writer.sock`: no hay escritor, o murió y aún no se recuperó el huérfano. */
  | 'no_socket'
  /** Hay fichero pero nadie escucha (escritor muerto con SIGKILL) u otro fallo al conectar. */
  | 'refused'
  /** Conectó pero no respondió a tiempo. */
  | 'timeout'
  /** La conexión se cerró tras enviar la petición y sin respuesta: puede que el escritor
   *  la ejecutara antes de morir. */
  | 'closed'
  /** Respondió algo que no es el protocolo. */
  | 'protocol';

export class WriterUnavailableError extends Error {
  constructor(readonly reason: WriterUnavailableReason) {
    super(`writer_unavailable:${reason}`);
    this.name = 'WriterUnavailableError';
  }
}

export function isWriterUnavailable(error: unknown): error is WriterUnavailableError {
  return error instanceof WriterUnavailableError;
}

/** El escritor respondió con un error que no tiene traducción propia aquí. */
export class WriterRemoteError extends Error {
  constructor(readonly code: WriterSocketErrorCode) {
    super(code);
    this.name = 'WriterRemoteError';
  }
}

/** Traduce el código remoto al mismo error que habría lanzado una escritura local, para
 *  que `mapWriteError` (`src/server/tools/write-errors.ts`) no distinga el camino. */
function remoteError(code: WriterSocketErrorCode, edit?: number): Error {
  if (code === 'busy_other_instance') return busyOtherInstance();
  if (REMOTE_LIBRARY_CODES.has(code)) return new LibraryError(code);
  if (isWriteRejectionCode(code)) return new StoreError(code, edit);
  return new WriterRemoteError(code);
}

const KNOWN_ERROR_CODES = new Set<WriterSocketErrorCode>([
  'busy_other_instance',
  'note_not_found',
  'folder_not_found',
  'invalid_request',
  'message_too_large',
  'internal',
  ...WRITE_REJECTION_CODES
]);

let nextRequestId = 1;

/**
 * El lado del lector: una conexión por petición. Resuelve con `result`; rechaza con
 * `WriterUnavailableError` si no se pudo hablar con el escritor, o con el error
 * traducido de `remoteError` si el escritor respondió que no.
 */
export function requestWriter(
  path: string,
  op: WriterSocketOp,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<unknown> {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let buffered = '';
    const socket = createConnection(path);
    const finish = (outcome: { value: unknown } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if ('error' in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const timer = setTimeout(() => finish({ error: new WriterUnavailableError('timeout') }), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      sent = true;
      socket.write(`${JSON.stringify({ id, op, params })}\n`);
    });
    socket.on('error', (error) => {
      if (sent) {
        finish({ error: new WriterUnavailableError('closed') });
        return;
      }
      const reason = errnoOf(error) === 'ENOENT' ? 'no_socket' : 'refused';
      finish({ error: new WriterUnavailableError(reason) });
    });
    socket.once('close', () => {
      finish({ error: new WriterUnavailableError(sent ? 'closed' : 'refused') });
    });
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline === -1) {
        if (buffered.length > MAX_RESPONSE_BYTES) {
          finish({ error: new WriterUnavailableError('protocol') });
        }
        return;
      }
      let response: unknown;
      try {
        response = JSON.parse(buffered.slice(0, newline));
      } catch {
        finish({ error: new WriterUnavailableError('protocol') });
        return;
      }
      // `id: null` = el escritor rechazó la línea entera (demasiado grande o ilegible)
      // antes de poder leer su `id`: es una respuesta, no un escritor caído.
      if (!isPlainObject(response) || (response.id !== id && response.id !== null)) {
        finish({ error: new WriterUnavailableError('protocol') });
        return;
      }
      if (response.ok === true && response.id === id) {
        finish({ value: response.result });
        return;
      }
      const code = response.error as WriterSocketErrorCode;
      const edit =
        typeof response.edit === 'number' && Number.isSafeInteger(response.edit) && response.edit >= 0
          ? response.edit
          : undefined;
      finish({ error: remoteError(KNOWN_ERROR_CODES.has(code) ? code : 'internal', edit) });
    });
  });
}
