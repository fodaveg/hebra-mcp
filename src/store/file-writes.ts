/**
 * Leer y reemplazar el contenido de un FICHERO SUELTO (D15, decidido por David el 10 oct
 * 2026, tarea F2 de Lumbre; amplía D10; SPEC.md §5 y §6.3), en turnos exclusivos del
 * escritor, como `./writes.ts`.
 *
 * - `fetchFileBytes`: trae al disco compartido los bytes de un fichero visible que este
 *   dispositivo aún no tiene (los baja el escritor con `readBlob` del motor de sync, como
 *   un adjunto). No los devuelve: los lee la herramienta con su filtro.
 * - `replaceFileText`: sustituye el contenido ENTERO de un fichero de texto visible por un
 *   texto nuevo, con la base comprobada (`expectedSha256`). Un fichero suelto no tiene
 *   revisiones, copias de conflicto ni versiones en Hebra: la base es el SHA-256 de los
 *   bytes que el agente leyó, y el motor la vuelve a comprobar en la transacción del
 *   reemplazo (`fileReplace(id, sha, expected)`, `file_stale`), que es la misma vía con la
 *   que el editor de Bases de Hebra guarda un `.base` (`writeObsidianBaseFile`).
 *
 * `replaceFileText`, en UN turno de la cola y en este orden:
 * 1. Registro de idempotencia (`hebra_mcp_operations`, huella propia `replaceFileText`):
 *    otro `operationId` de otra escritura, `operation_id_reused`.
 * 2. Privacidad con la configuración de quien pide, sobre el almacén del turno (el filtro
 *    de ficheros de D10: carpeta privada, también ya borrada, o enlazado desde una nota
 *    oculta). Oculto, inexistente, lápida o en la papelera: `not_found`, todos igual.
 * 3. Reintento: `done`, lo anotado con `replayed`; `started` y el fichero ya tiene el
 *    contenido nuevo, se guardó antes de un corte (se cierra el registro).
 * 4. «Ya estaba»: el fichero ya tiene ese contenido; no escribe ni pide ronda.
 * 5. Base: el SHA-256 actual tiene que ser `expectedSha256`; si no, `file_changed` sin
 *    escribir.
 * 6. Solo texto y solo hasta `FILE_TEXT_REPLACE_MAX_BYTES`: los bytes actuales (si no
 *    están aquí, `file_unavailable`), su tipo por el contenido (`file_type_not_allowed`)
 *    y su tamaño (`file_too_large`). El texto nuevo, con el mismo tipo, tiene que seguir
 *    leyéndose como texto.
 * 7. El contenido nuevo no puede dejar el fichero oculto por la regla (b): si una nota
 *    oculta enlaza esos bytes por su SHA-256, `not_found` sin escribir (como la regla 4
 *    de D2 con una etiqueta privada).
 * 8. Se guarda el texto anterior (`./file-previous.ts`) y el registro pasa a `started`;
 *    después `blobPut` del texto nuevo y `fileReplace` con la base; la prueba de lo
 *    guardado se lee del almacén (el SHA-256 de la fila y los bytes de ese blob).
 * Con `undoOperationId` en vez de `text`, el texto nuevo es el que guardó el paso 8 de
 * ese reemplazo, del mismo fichero y en sus 7 días; es un reemplazo más, con su base.
 */
import { createHash } from 'node:crypto';
import { LibraryError } from '../hebra';
import type { PrivacyConfig } from '../privacy/config';
import { FileFilter } from '../privacy/file-filter';
import { writeRejected } from './errors';
import {
  detectFileType,
  encodeFileText,
  FILE_READ_MAX_BYTES,
  FILE_TEXT_REPLACE_MAX_BYTES
} from './file-content';
import { OPERATION_ID_MAX_LENGTH } from './operations';
import {
  priorOperation,
  privacyInTurn,
  type LocalWrite,
  type NoteWriteStore,
  type NoteWriteTarget
} from './writes';

/** Traer al disco los bytes de un fichero suelto visible (`hebra_read_file`). */
export interface FetchFileInput {
  id: string;
  /** La configuración de privados de quien pide, como `EditNoteInput.privacy`. */
  privacy: PrivacyConfig;
}

/** `hebra_replace_file_text`: `text` O `undoOperationId`, exactamente uno. */
export interface ReplaceFileTextInput {
  id: string;
  /** SHA-256 (hexadecimal) del contenido sobre el que se escribe: el que dio la lectura. */
  expectedSha256: string;
  /** El contenido nuevo ENTERO. */
  text?: string;
  /** Volver al contenido que tenía el fichero antes del reemplazo con ese `operationId`. */
  undoOperationId?: string;
  /** Idempotencia, en el registro compartido. */
  operationId: string;
  privacy: PrivacyConfig;
}

/** Lo que queda tras reemplazar: la prueba de lo guardado, leída del almacén. */
export interface ReplaceFileTextSaved {
  id: string;
  /** `saved`: escrito ahora; `already`: el fichero ya tenía ese contenido. */
  outcome: 'saved' | 'already';
  /** SHA-256 del contenido guardado (sirve como `expectedSha256` del siguiente). */
  sha256: string;
  byteLength: number;
  mimeType: string;
  /** SHA-256 del contenido de antes (igual que `sha256` con `already`). */
  previousSha256: string;
  replayed?: true;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function bytesSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function textSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Huella de la petición (comparte registro con las escrituras de notas): un
 *  `operationId` de otra operación da `operation_id_reused`. El texto entra por su hash. */
function replaceFileFingerprint(input: ReplaceFileTextInput, expectedSha256: string): string {
  const source =
    input.text !== undefined ? ['text', textSha256(input.text)] : ['undo', input.undoOperationId];
  return textSha256(JSON.stringify(['replaceFileText', input.id, expectedSha256, source]));
}

/** Un `ReplaceFileTextSaved` del registro (no se fía de su forma). */
export function isReplaceFileTextSaved(value: unknown): value is ReplaceFileTextSaved {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    (record.outcome === 'saved' || record.outcome === 'already') &&
    typeof record.sha256 === 'string' &&
    typeof record.byteLength === 'number' &&
    typeof record.mimeType === 'string' &&
    typeof record.previousSha256 === 'string'
  );
}

/** El SHA-256 esperado, en minúsculas; si no es uno, `invalid_input`. */
function expectedShaOf(raw: string): string {
  const sha = raw.trim().toLowerCase();
  if (!SHA256_HEX.test(sha)) throw writeRejected('invalid_input');
  return sha;
}

/** Los bytes del texto nuevo, revalidados aquí aunque la herramienta ya los mirara (la
 *  petición puede llegar de un lector por `writer.sock`). */
function newTextBytes(text: string): Uint8Array {
  const bytes = encodeFileText(text);
  if (bytes === null) throw writeRejected('invalid_input');
  if (bytes.length > FILE_TEXT_REPLACE_MAX_BYTES) throw writeRejected('file_too_large');
  return bytes;
}

/** El fichero VISIBLE y vivo con el filtro de quien pide, sobre el almacén del turno; si
 *  no, `not_found` (oculto, inexistente, lápida o en la papelera, todo igual). */
function visibleLiveFile(store: NoteWriteStore, id: string, privacy: PrivacyConfig) {
  const live = privacyInTurn(store, privacy);
  const files = FileFilter.fromSnapshot(live, store.filesIndex(), privacy);
  const content = files.contentOf(id);
  if (!content || content.file.trashedAt !== null) throw writeRejected('not_found');
  return { files, content };
}

/** El texto anterior con su BOM, si lo tenía: así volver atrás deja los mismos bytes. */
function exactText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** Los errores del motor que `fileReplace` y `blobPut` pueden dar dentro del turno. */
function replaceRejection(error: unknown): unknown {
  if (!(error instanceof LibraryError)) return error;
  if (error.code === 'file_stale') return writeRejected('file_changed');
  if (error.code === 'file_not_found') return writeRejected('not_found');
  if (error.code === 'blob_missing') return writeRejected('file_unavailable');
  return error;
}

/**
 * Trae al disco los bytes de un fichero visible y vivo (`FetchFileInput`). En UN turno, con
 * la configuración de quien pide: oculto, inexistente o en la papelera, `not_found`; un
 * tamaño ya sabido de más de `FILE_READ_MAX_BYTES`, `file_too_large` (no se baja). Después,
 * fuera del turno, `download` (`readBlob` del motor de sync, que mira primero lo local y
 * verifica el hash). Sin `download` (sin sync), solo dice si ya estaban.
 */
export async function fetchFileBytes(
  target: NoteWriteTarget,
  input: FetchFileInput,
  download: ((sha256: string) => Promise<boolean>) | null
): Promise<boolean> {
  const { sha256, present } = await target.writeExclusive(async (store) => {
    const { content } = visibleLiveFile(store, input.id, input.privacy);
    if (content.file.byteLength !== null && content.file.byteLength > FILE_READ_MAX_BYTES) {
      throw writeRejected('file_too_large');
    }
    const local = download ? null : await store.blobRead(content.sha256);
    return { sha256: content.sha256, present: local !== null };
  });
  return download ? download(sha256) : present;
}

/**
 * Reemplaza el contenido de un fichero de texto (ver la cabecera). `download` trae antes
 * los bytes actuales si este dispositivo no los tiene (hacen falta para comprobar que es
 * texto y para guardar el contenido anterior); `onWritten` pide la ronda de después.
 */
export async function replaceFileText(
  target: NoteWriteTarget,
  input: ReplaceFileTextInput,
  download: ((sha256: string) => Promise<boolean>) | null,
  onWritten: () => void
): Promise<LocalWrite<ReplaceFileTextSaved>> {
  if (input.id.length === 0) throw writeRejected('invalid_input');
  if (input.operationId.length === 0 || input.operationId.length > OPERATION_ID_MAX_LENGTH) {
    throw writeRejected('invalid_input');
  }
  if ((input.text === undefined) === (input.undoOperationId === undefined)) {
    throw writeRejected('invalid_input');
  }
  const expected = expectedShaOf(input.expectedSha256);
  const textBytes = input.text === undefined ? null : newTextBytes(input.text);
  const fingerprint = replaceFileFingerprint(input, expected);

  // Los bytes de la base, si faltan aquí: solo los de un fichero visible y vivo cuyo
  // contenido es todavía el esperado (nunca un hash cualquiera que mande el agente).
  if (download) {
    const fetchable = await target.writeExclusive(async (store) => {
      if (store.operations.lookup(input.operationId)?.state === 'done') return false;
      try {
        const { content } = visibleLiveFile(store, input.id, input.privacy);
        return content.sha256 === expected && (await store.blobRead(expected)) === null;
      } catch {
        return false; // El turno de abajo responde lo que toque, con sus comprobaciones.
      }
    });
    if (fetchable) await download(expected);
  }

  const outcome = await target.writeExclusive(
    async (store): Promise<LocalWrite<ReplaceFileTextSaved>> => {
      const now = Date.now();
      const log = store.operations;
      const previous = priorOperation(log, input.operationId, fingerprint, now);
      store.looseFilePrevious.purgeExpired(now);
      const { files, content } = visibleLiveFile(store, input.id, input.privacy);
      const { file } = content;

      if (previous?.state === 'done' && isReplaceFileTextSaved(previous.result)) {
        return { result: { ...previous.result, replayed: true }, wrote: false };
      }

      // El contenido nuevo: el texto, o el que guardó el reemplazo que se deshace.
      let bytes: Uint8Array;
      let undoMime: string | null = null;
      if (textBytes) {
        bytes = textBytes;
      } else {
        const saved = store.looseFilePrevious.lookup(input.undoOperationId!, now);
        if (!saved || saved.fileId !== input.id) throw writeRejected('invalid_input');
        bytes = newTextBytes(saved.previousText);
        undoMime = saved.mime;
      }
      const newSha = bytesSha256(bytes);
      const writtenType = detectFileType(bytes, undoMime ?? file.mime, file.name);

      if (content.sha256 === newSha) {
        const mimeType = writtenType.mimeType ?? 'text/plain';
        if (previous?.state === 'started') {
          // Murió entre el reemplazo y `finish`: se guardó. Se completa el registro.
          const before = store.looseFilePrevious.lookup(input.operationId, now);
          const saved: ReplaceFileTextSaved = {
            id: input.id,
            outcome: 'saved',
            sha256: newSha,
            byteLength: bytes.length,
            mimeType,
            previousSha256: before?.previousSha256 ?? expected
          };
          log.finish(input.operationId, saved);
          return { result: { ...saved, replayed: true }, wrote: false };
        }
        const already: ReplaceFileTextSaved = {
          id: input.id,
          outcome: 'already',
          sha256: newSha,
          byteLength: bytes.length,
          mimeType,
          previousSha256: newSha
        };
        log.begin({
          operationId: input.operationId,
          fingerprint,
          noteId: input.id,
          targetBodySha256: newSha,
          now
        });
        log.finish(input.operationId, already);
        return { result: already, wrote: false };
      }

      if (content.sha256 !== expected) throw writeRejected('file_changed');

      const current = await store.blobRead(content.sha256);
      if (current === null) throw writeRejected('file_unavailable');
      if (current.length > FILE_TEXT_REPLACE_MAX_BYTES) throw writeRejected('file_too_large');
      const currentType = detectFileType(current, file.mime, file.name);
      if (!currentType.allowed || currentType.kind !== 'text') {
        throw writeRejected('file_type_not_allowed');
      }
      // Se escribe con el tipo con que se lee hoy; el texto nuevo tiene que seguir
      // leyéndose como texto con él (uno que empiece como la firma de un GIF o un PDF, no).
      const mime = undoMime ?? currentType.mimeType;
      const nextType = detectFileType(bytes, mime, file.name);
      if (!nextType.allowed || nextType.kind !== 'text') throw writeRejected('invalid_input');

      // Regla (b) de D10 sobre el contenido NUEVO: si una nota oculta enlaza esos bytes,
      // el fichero pasaría a oculto. No se escribe, y responde como uno inexistente.
      if (store.notesLinkingBlob(newSha).some((ref) => files.isHiddenReference(ref))) {
        throw writeRejected('not_found');
      }

      log.begin({
        operationId: input.operationId,
        fingerprint,
        noteId: input.id,
        targetBodySha256: newSha,
        now
      });
      store.looseFilePrevious.save({
        operationId: input.operationId,
        fileId: input.id,
        previousSha256: content.sha256,
        previousText: exactText(current),
        mime: currentType.mimeType,
        createdAt: now
      });
      let savedSha: string;
      try {
        const put = await store.blobPut(bytes, { mime, expectedSha256: newSha });
        savedSha = (await store.fileReplace(input.id, put.sha256, expected)).sha256.toLowerCase();
      } catch (error) {
        throw replaceRejection(error);
      }
      // Prueba de lo guardado: el hash de la fila y los bytes de ese blob, leídos ahora.
      const stored = await store.blobRead(savedSha);
      const result: ReplaceFileTextSaved = {
        id: input.id,
        outcome: 'saved',
        sha256: stored ? bytesSha256(stored) : savedSha,
        byteLength: stored ? stored.length : bytes.length,
        mimeType: nextType.mimeType,
        previousSha256: content.sha256
      };
      log.finish(input.operationId, result);
      return { result, wrote: true };
    }
  );
  if (outcome.wrote) {
    try {
      onWritten();
    } catch {
      // Ya está en disco; la ronda periódica lo subirá.
    }
  }
  return outcome;
}
