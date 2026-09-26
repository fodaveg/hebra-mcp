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
 * por `id` de petición. Cada petición lleva `op` y `params`:
 * - `createNote` `{body, folderId}` → `{id, title, folderId}`.
 * - `appendToNote` `{id, text}` → `{id, outcome, copyId?}`, ya con la ronda de sync
 *   esperada en el escritor (como `hebra_append_to_note` con `awaitRound`).
 * - `status` `{}` → el estado de sync del escritor, sin `writer` ni `linked`.
 * Respuesta: `{id, ok: true, result}` o `{id, ok: false, error}` con un código cerrado
 * (`WriterSocketErrorCode`). Nunca viaja el mensaje de una excepción.
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
import { busyOtherInstance, isBusyOtherInstance } from '../store/errors';
import {
  APPEND_TEXT_MAX_LENGTH,
  CREATE_BODY_MAX_LENGTH,
  type AppendToNoteInput,
  type AppendToNoteResult,
  type CreateNoteInput,
  type CreateNoteResult
} from '../store/writes';

export const WRITER_SOCKET_FILE = 'writer.sock';

/**
 * Tamaño máximo de una línea del protocolo, en bytes. `JSON.stringify` escapa un
 * carácter de control como `\uXXXX` (6 bytes por unidad UTF-16), que es el peor caso
 * (un carácter no ASCII ocupa como mucho 3 bytes de UTF-8 por unidad). El margen cubre
 * el sobre (`id`, `op`, `folderId`…).
 */
export const MAX_MESSAGE_BYTES = CREATE_BODY_MAX_LENGTH * 6 + 64 * 1024;

/** Una respuesta nunca lleva cuerpos: basta con mucho menos. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Longitud máxima de un id de nota o de carpeta (son UUID; el margen es de sobra). */
const MAX_ID_LENGTH = 200;

export type WriterSocketOp = 'createNote' | 'appendToNote' | 'status';

/** Códigos de error del protocolo: cerrados, sin texto libre. */
export type WriterSocketErrorCode =
  | 'busy_other_instance'
  | 'note_not_found'
  | 'folder_not_found'
  | 'invalid_request'
  | 'message_too_large'
  | 'internal';

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
  status(): Promise<WriterSyncStatus>;
}

interface RequestEnvelope {
  id: number | string;
  op: WriterSocketOp;
  params: Record<string, unknown>;
}

type ResponseEnvelope =
  | { id: number | string | null; ok: true; result: unknown }
  | { id: number | string | null; ok: false; error: WriterSocketErrorCode };

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
  if (op !== 'createNote' && op !== 'appendToNote' && op !== 'status') throw new InvalidRequest();
  if (params !== undefined && !isPlainObject(params)) throw new InvalidRequest();
  return { id, op, params: params ?? {} };
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function createInputOf(params: Record<string, unknown>): CreateNoteInput {
  const { body, folderId } = params;
  if (typeof body !== 'string' || body.length > CREATE_BODY_MAX_LENGTH) throw new InvalidRequest();
  if (folderId !== null && folderId !== undefined && !isId(folderId)) throw new InvalidRequest();
  return { body, folderId: folderId ?? null };
}

function appendInputOf(params: Record<string, unknown>): AppendToNoteInput {
  const { id, text } = params;
  if (!isId(id) || typeof text !== 'string' || text.length > APPEND_TEXT_MAX_LENGTH) {
    throw new InvalidRequest();
  }
  return { id, text };
}

/** Código cerrado de un fallo del escritor; nunca el mensaje. */
function errorCodeOf(error: unknown): WriterSocketErrorCode {
  if (error instanceof InvalidRequest) return 'invalid_request';
  if (isBusyOtherInstance(error)) return 'busy_other_instance';
  if (error instanceof LibraryError && REMOTE_LIBRARY_CODES.has(error.code)) {
    return error.code as WriterSocketErrorCode;
  }
  return 'internal';
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
        case 'status':
          result = await handlers.status();
          break;
      }
      response = { id: envelope.id, ok: true, result };
      logEvent({ event: 'writer.socket.request', op: envelope.op, outcome: 'ok' });
    } catch (error) {
      const code = errorCodeOf(error);
      response = { id: envelope.id, ok: false, error: code };
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
function remoteError(code: WriterSocketErrorCode): Error {
  if (code === 'busy_other_instance') return busyOtherInstance();
  if (REMOTE_LIBRARY_CODES.has(code)) return new LibraryError(code);
  return new WriterRemoteError(code);
}

const KNOWN_ERROR_CODES = new Set<WriterSocketErrorCode>([
  'busy_other_instance',
  'note_not_found',
  'folder_not_found',
  'invalid_request',
  'message_too_large',
  'internal'
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
      finish({ error: remoteError(KNOWN_ERROR_CODES.has(code) ? code : 'internal') });
    });
  });
}
