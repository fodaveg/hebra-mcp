/**
 * Crear, renombrar, mover y duplicar un FICHERO SUELTO (D17, decisión de David del 12 oct
 * 2026: «que pueda crear bases» y «no solo crear, dale todos los verbos que necesite»;
 * diseño de la sesión principal; SPEC.md §3, §5 y §6.3), en turnos exclusivos del
 * escritor, como `./writes.ts` y `./file-writes.ts`. Purgar sigue fuera (D2).
 *
 * Las cuatro, en UN turno de la cola y en este orden:
 * 1. Registro de idempotencia (`hebra_mcp_operations`, huella propia por acción): otro
 *    `operationId` de otra escritura, `operation_id_reused`; uno ya terminado con la misma
 *    petición, lo anotado con `replayed` (si el fichero que nombra sigue visible; si no,
 *    `not_found`).
 * 2. Privacidad con la configuración de quien pide, sobre el almacén del turno: la carpeta
 *    de destino tiene que existir y verse (si no, `not_found`, como `hebra_move_note`), y
 *    el fichero de origen tiene que ser visible y vivo (oculto, inexistente, lápida o en
 *    la papelera, `not_found`, todos igual).
 * 3. La extensión no cambia al renombrar ni al duplicar (`invalid_input`); duplicar copia
 *    hasta `FILE_DUPLICATE_MAX_BYTES` (`file_too_large`) y necesita los bytes aquí (si no
 *    se pudieron bajar, `file_unavailable`).
 * 4. «Ya estaba»: renombrar al nombre que tiene, o mover a la carpeta donde está, no
 *    escribe ni pide ronda (`outcome: "already"`).
 * 5. Nombre repetido: el motor no lo impide, así que lo mira el MCP. Si en la carpeta de
 *    destino hay un fichero suelto VIVO y VISIBLE con ese nombre (sin distinguir mayúsculas
 *    ni la forma de una tilde: lo que choca en macOS y en Obsidian), `file_exists` con su
 *    id. Un homónimo oculto no cuenta: decir que existe lo revelaría.
 * 6. El resultado no puede quedar oculto: si una nota oculta enlaza el nombre nuevo o los
 *    bytes (regla (b) de D10), o hay una nota bloqueada oculta y el nombre se puede
 *    incrustar (D16, punto 1), no se escribe: `not_found` al renombrar, mover o duplicar
 *    (como D15 con el contenido) y `file_name_unavailable` al crear.
 * 7. La escritura del motor (`blobPut` + `fileCreate`, `fileRename`, `fileMove`) y la
 *    prueba de lo guardado, leída del almacén: `sha256` de la fila, y los bytes de ese blob
 *    o lo que su fila de `blobs` sabe.
 *
 * Registro: renombrar y mover lo empiezan (`started`) antes de escribir, con el id del
 * fichero; si el proceso muere entre la escritura y `finish`, el reintento ve el fichero
 * ya con el nombre o la carpeta pedidos y lo da por guardado. Crear y duplicar no saben el
 * id antes de `fileCreate` (lo pone el motor): anotan `started` y `done` justo después, en
 * el mismo turno. Si el proceso muere entre medias, el reintento no duplica: el fichero ya
 * existe en esa carpeta con ese nombre y responde `file_exists` con su id.
 */
import { createHash } from 'node:crypto';
import { LibraryError } from '../hebra';
import type { PrivacyConfig } from '../privacy/config';
import { FileFilter } from '../privacy/file-filter';
import { existingFileRejected, writeRejected } from './errors';
import {
  createFileMime,
  detectFileType,
  encodeFileText,
  nameExtension,
  FILE_CREATE_MAX_BYTES,
  FILE_DUPLICATE_MAX_BYTES,
  looseFileMime,
  validFileName
} from './file-content';
import { OPERATION_ID_MAX_LENGTH } from './operations';
import {
  hiddenOperationTarget,
  priorOperation,
  privacyInTurn,
  type FileRow,
  type LocalWrite,
  type NoteWriteStore,
  type NoteWriteTarget
} from './writes';

/** Las cuatro acciones (D17). La carpeta, por id (`"root"` es la raíz); la herramienta
 *  resuelve antes la ruta. */
export type LooseFileWriteAction =
  | { action: 'createFile'; folderId: string; name: string; text: string }
  | { action: 'renameFile'; id: string; name: string }
  | { action: 'moveFile'; id: string; folderId: string }
  /** Sin `folderId`, a la carpeta del origen. */
  | { action: 'duplicateFile'; id: string; name: string; folderId?: string };

export type LooseFileWriteActionName = LooseFileWriteAction['action'];

export type LooseFileWriteInput = LooseFileWriteAction & {
  /** Idempotencia, en el registro compartido. */
  operationId: string;
  /** La configuración de privados de quien pide, como `EditNoteInput.privacy`. */
  privacy: PrivacyConfig;
};

/** Lo que queda: la prueba de lo guardado, leída del almacén. La ruta para enseñar la
 *  calcula la herramienta con SU filtro. */
export interface LooseFileSaved {
  id: string;
  name: string;
  folderId: string;
  /** SHA-256 de los bytes, de la fila del fichero. */
  sha256: string;
  /** Tamaño y tipo: de los bytes (crear, duplicar) o de su fila de `blobs` (renombrar,
   *  mover); `null` si este dispositivo no tiene esa fila. */
  byteLength: number | null;
  mimeType: string | null;
  /** `saved`: escrito ahora; `already`: ya tenía ese nombre o estaba en esa carpeta. */
  outcome: 'saved' | 'already';
  replayed?: true;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function bytesSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function textSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Nombre para comparar sin distinguir mayúsculas ni la forma de una tilde (NFC), como la
 *  lista de `hebra_list_files`. */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Un `LooseFileSaved` del registro (no se fía de su forma). */
export function isLooseFileSaved(value: unknown): value is LooseFileSaved {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.folderId === 'string' &&
    typeof record.sha256 === 'string' &&
    SHA256_HEX.test(record.sha256) &&
    (record.byteLength === null || typeof record.byteLength === 'number') &&
    (record.mimeType === null || typeof record.mimeType === 'string') &&
    (record.outcome === 'saved' || record.outcome === 'already')
  );
}

/** Lo que se valida sin el almacén, otra vez aunque la herramienta ya lo mirara (la
 *  petición puede llegar de un lector por `writer.sock`): el nombre y, al crear, la
 *  extensión, el texto y su tamaño. Devuelve lo normalizado y los bytes a guardar. */
interface Prepared {
  name?: string;
  bytes?: Uint8Array;
  mime?: string;
}

function prepare(input: LooseFileWriteInput): Prepared {
  if (input.operationId.length === 0 || input.operationId.length > OPERATION_ID_MAX_LENGTH) {
    throw writeRejected('invalid_input');
  }
  switch (input.action) {
    case 'createFile': {
      if (input.folderId.length === 0) throw writeRejected('invalid_input');
      return prepareCreate(input.name, input.text);
    }
    case 'renameFile':
    case 'duplicateFile': {
      if (input.id.length === 0) throw writeRejected('invalid_input');
      if (input.action === 'duplicateFile' && input.folderId === '') throw writeRejected('invalid_input');
      const name = validFileName(input.name);
      if (name === null) throw writeRejected('invalid_input');
      return { name };
    }
    case 'moveFile':
      if (input.id.length === 0 || input.folderId.length === 0) throw writeRejected('invalid_input');
      return {};
  }
}

/** `hebra_create_file`: nombre válido, extensión de las permitidas (otra, o ninguna,
 *  `file_type_not_allowed`) con algo delante (`.base` a secas, `invalid_input`), texto
 *  codificable sin NUL ni suplentes sueltos y hasta `FILE_CREATE_MAX_BYTES`
 *  (`file_too_large`), que se siga leyendo como texto (uno que empieza como la firma de una
 *  imagen o un PDF, `invalid_input`). */
export function prepareCreate(rawName: string, text: string): Required<Prepared> {
  const name = validFileName(rawName);
  if (name === null) throw writeRejected('invalid_input');
  const mime = createFileMime(name);
  if (mime === undefined) throw writeRejected('file_type_not_allowed');
  if (name.lastIndexOf('.') === 0) throw writeRejected('invalid_input');
  const bytes = encodeFileText(text);
  if (bytes === null) throw writeRejected('invalid_input');
  if (bytes.length > FILE_CREATE_MAX_BYTES) throw writeRejected('file_too_large');
  const detected = detectFileType(bytes, mime, name);
  if (!detected.allowed || detected.kind !== 'text') throw writeRejected('invalid_input');
  return { name, bytes, mime };
}

/** Huella de la petición (comparte registro con las demás escrituras): la acción va en
 *  ella, así que un `operationId` de otra operación da `operation_id_reused`. El texto, por
 *  su hash. */
function fingerprintOf(input: LooseFileWriteInput, prepared: Prepared): string {
  const parts: unknown[] = ['looseFile', input.action];
  switch (input.action) {
    case 'createFile':
      parts.push(input.folderId, prepared.name, bytesSha256(prepared.bytes!));
      break;
    case 'renameFile':
      parts.push(input.id, prepared.name);
      break;
    case 'moveFile':
      parts.push(input.id, input.folderId);
      break;
    case 'duplicateFile':
      parts.push(input.id, prepared.name, input.folderId ?? null);
      break;
  }
  return textSha256(JSON.stringify(parts));
}

/** Los errores del motor que crear, renombrar o mover pueden dar dentro del turno. */
function verbRejection(error: unknown): unknown {
  if (!(error instanceof LibraryError)) return error;
  switch (error.code) {
    case 'file_not_found':
    case 'folder_not_found':
      return writeRejected('not_found');
    case 'invalid_name':
      return writeRejected('invalid_input');
    case 'blob_missing':
      return writeRejected('file_unavailable');
    default:
      return error;
  }
}

/** Lo que hace falta del turno para decidir. */
interface Turn {
  store: NoteWriteStore;
  files: FileFilter;
  live: ReturnType<typeof privacyInTurn>;
}

/** La carpeta de destino, viva y visible; si no, `not_found` (como `hebra_move_note`: una
 *  privada responde igual que una que no existe). */
function requireVisibleFolder(turn: Turn, folderId: string): void {
  if (!turn.live.folderExists(folderId) || turn.live.isFolderHidden(folderId)) {
    throw writeRejected('not_found');
  }
}

/** El fichero de origen, visible y vivo; si no, `not_found` (oculto, inexistente, lápida o
 *  en la papelera, todo igual). */
function requireVisibleLiveFile(turn: Turn, id: string) {
  const content = turn.files.contentOf(id);
  if (!content || content.file.trashedAt !== null) throw writeRejected('not_found');
  return content;
}

/** Paso 5 de la cabecera: un fichero VIVO y VISIBLE de `folderId` con ese nombre (sin
 *  distinguir mayúsculas), que no sea `self`, da `file_exists` con su id. */
function rejectVisibleHomonym(turn: Turn, folderId: string, name: string, self?: string): void {
  const key = nameKey(name);
  for (const file of turn.files.visibleFiles()) {
    if (
      file.trashedAt === null &&
      file.folderId === folderId &&
      file.id !== self &&
      nameKey(file.name) === key
    ) {
      throw existingFileRejected(file.id);
    }
  }
}

/** Paso 6 de la cabecera: ¿quedaría oculto un fichero con ese nombre y esos bytes? */
function wouldHide(turn: Turn, name: string, sha256: string): boolean {
  return turn.files.wouldHide(name, [
    ...turn.store.notesLinkingFileName(name),
    ...turn.store.notesLinkingBlob(sha256)
  ]);
}

/** La prueba de lo guardado de un fichero recién creado (crear, duplicar): el SHA-256 de la
 *  fila y los bytes de ese blob, leídos ahora. */
async function createdProof(
  store: NoteWriteStore,
  row: FileRow,
  fallback: Uint8Array,
  declaredMime: string | null
): Promise<LooseFileSaved> {
  const sha256 = row.sha256.toLowerCase();
  const stored = (await store.blobRead(sha256)) ?? fallback;
  const detected = detectFileType(stored, declaredMime, row.name);
  return {
    id: row.id,
    name: row.name,
    folderId: row.folderId,
    sha256: stored === fallback ? sha256 : bytesSha256(stored),
    byteLength: stored.length,
    mimeType: detected.mimeType ?? looseFileMime(declaredMime, row.name),
    outcome: 'saved'
  };
}

/** Lo que se enseña de un fichero renombrado o movido, sin leer sus bytes: el SHA-256 de su
 *  fila (la que devuelve el motor tras escribir) y lo que la fila de `blobs` sabe. */
function rowProof(
  row: { id: string; name: string; folderId: string; sha256: string },
  byteLength: number | null,
  mime: string | null,
  outcome: 'saved' | 'already'
): LooseFileSaved {
  return {
    id: row.id,
    name: row.name,
    folderId: row.folderId,
    sha256: row.sha256.toLowerCase(),
    byteLength,
    mimeType: looseFileMime(mime, row.name),
    outcome
  };
}

/**
 * Crea, renombra, mueve o duplica un fichero suelto (ver la cabecera). `download` trae
 * antes los bytes del origen de un duplicado si este dispositivo no los tiene (la vía de
 * `hebra_read_file`, `readBlob` del motor de sync); `onWritten` pide la ronda de después.
 */
export async function writeLooseFile(
  target: NoteWriteTarget,
  input: LooseFileWriteInput,
  download: ((sha256: string) => Promise<boolean>) | null,
  onWritten: () => void
): Promise<LocalWrite<LooseFileSaved>> {
  const prepared = prepare(input);
  const fingerprint = fingerprintOf(input, prepared);

  // Duplicar: los bytes del origen, si faltan aquí. Solo los de un fichero visible y vivo
  // que no se sabe ya demasiado grande (nunca un hash que mande el agente).
  if (input.action === 'duplicateFile' && download) {
    const fetchable = await target.writeExclusive(async (store) => {
      if (store.operations.lookup(input.operationId)?.state === 'done') return null;
      try {
        const live = privacyInTurn(store, input.privacy);
        const files = FileFilter.fromSnapshot(live, store.filesIndex(), input.privacy);
        const content = requireVisibleLiveFile({ store, files, live }, input.id);
        const known = content.file.byteLength;
        if (known !== null && known > FILE_DUPLICATE_MAX_BYTES) return null;
        return (await store.blobRead(content.sha256)) === null ? content.sha256 : null;
      } catch {
        return null; // El turno de abajo responde lo que toque, con sus comprobaciones.
      }
    });
    if (fetchable) await download(fetchable).catch(() => false);
  }

  const outcome = await target.writeExclusive(async (store): Promise<LocalWrite<LooseFileSaved>> => {
    const now = Date.now();
    const log = store.operations;
    const live = privacyInTurn(store, input.privacy);
    const previous = priorOperation(
      log,
      input.operationId,
      fingerprint,
      now,
      hiddenOperationTarget(store, live, input.privacy)
    );
    const files = FileFilter.fromSnapshot(live, store.filesIndex(), input.privacy);
    const turn: Turn = { store, files, live };

    if (previous?.state === 'done' && isLooseFileSaved(previous.result)) {
      // Lo que nombra (el fichero y la carpeta anotada) tiene que seguir viéndose: si no,
      // como uno que no existe.
      if (!files.visibleMeta(previous.result.id)) throw writeRejected('not_found');
      requireVisibleFolder(turn, previous.result.folderId);
      return { result: { ...previous.result, replayed: true }, wrote: false };
    }

    /** Anota en el registro lo que ya está hecho (`started` y `done` seguidos). */
    const record = (result: LooseFileSaved): LooseFileSaved => {
      log.begin({
        operationId: input.operationId,
        fingerprint,
        noteId: result.id,
        targetBodySha256: result.sha256,
        now
      });
      log.finish(input.operationId, result);
      return result;
    };

    try {
      switch (input.action) {
        case 'createFile': {
          requireVisibleFolder(turn, input.folderId);
          const { name, bytes, mime } = prepared as Required<Prepared>;
          rejectVisibleHomonym(turn, input.folderId, name);
          if (wouldHide(turn, name, bytesSha256(bytes))) throw writeRejected('file_name_unavailable');
          const put = await store.blobPut(bytes, { mime, expectedSha256: bytesSha256(bytes) });
          const row = await store.fileCreate(input.folderId, name, put.sha256);
          return { result: record(await createdProof(store, row, bytes, mime)), wrote: true };
        }

        case 'duplicateFile': {
          const source = requireVisibleLiveFile(turn, input.id);
          const name = prepared.name!;
          if (nameExtension(name) !== nameExtension(source.file.name)) {
            throw writeRejected('invalid_input');
          }
          const folderId = input.folderId ?? source.file.folderId;
          requireVisibleFolder(turn, folderId);
          const known = source.file.byteLength;
          if (known !== null && known > FILE_DUPLICATE_MAX_BYTES) throw writeRejected('file_too_large');
          const bytes = await store.blobRead(source.sha256);
          if (bytes === null) throw writeRejected('file_unavailable');
          if (bytes.length > FILE_DUPLICATE_MAX_BYTES) throw writeRejected('file_too_large');
          rejectVisibleHomonym(turn, folderId, name);
          if (wouldHide(turn, name, source.sha256)) throw writeRejected('not_found');
          // Los bytes ya están (el blob es por contenido): la fila nueva los comparte.
          const row = await store.fileCreate(folderId, name, source.sha256);
          return {
            result: record(await createdProof(store, row, bytes, source.file.mime)),
            wrote: true
          };
        }

        case 'renameFile': {
          const source = requireVisibleLiveFile(turn, input.id);
          const name = prepared.name!;
          if (nameExtension(name) !== nameExtension(source.file.name)) {
            throw writeRejected('invalid_input');
          }
          const current = {
            id: input.id,
            name: source.file.name,
            folderId: source.file.folderId,
            sha256: source.sha256
          };
          if (source.file.name === name) {
            const done = rowProof(current, source.file.byteLength, source.file.mime, 'already');
            if (previous?.state === 'started') {
              // Murió entre el renombrado y `finish`: se guardó. Se completa el registro.
              const saved = { ...done, outcome: 'saved' as const };
              log.finish(input.operationId, saved);
              return { result: { ...saved, replayed: true }, wrote: false };
            }
            return { result: record(done), wrote: false };
          }
          rejectVisibleHomonym(turn, source.file.folderId, name, input.id);
          if (wouldHide(turn, name, source.sha256)) throw writeRejected('not_found');
          log.begin({
            operationId: input.operationId,
            fingerprint,
            noteId: input.id,
            targetBodySha256: source.sha256,
            now
          });
          const row = await store.fileRename(input.id, name);
          const saved = rowProof(row, source.file.byteLength, source.file.mime, 'saved');
          log.finish(input.operationId, saved);
          return { result: saved, wrote: true };
        }

        case 'moveFile': {
          const source = requireVisibleLiveFile(turn, input.id);
          requireVisibleFolder(turn, input.folderId);
          const current = {
            id: input.id,
            name: source.file.name,
            folderId: source.file.folderId,
            sha256: source.sha256
          };
          if (source.file.folderId === input.folderId) {
            const done = rowProof(current, source.file.byteLength, source.file.mime, 'already');
            if (previous?.state === 'started') {
              const saved = { ...done, outcome: 'saved' as const };
              log.finish(input.operationId, saved);
              return { result: { ...saved, replayed: true }, wrote: false };
            }
            return { result: record(done), wrote: false };
          }
          rejectVisibleHomonym(turn, input.folderId, source.file.name, input.id);
          // Ni el nombre ni los bytes cambian (uno visible no lo enlaza ninguna nota
          // oculta), pero se mira igual: la regla es la de las cuatro.
          if (wouldHide(turn, source.file.name, source.sha256)) throw writeRejected('not_found');
          log.begin({
            operationId: input.operationId,
            fingerprint,
            noteId: input.id,
            targetBodySha256: source.sha256,
            now
          });
          const row = await store.fileMove(input.id, input.folderId);
          const saved = rowProof(row, source.file.byteLength, source.file.mime, 'saved');
          log.finish(input.operationId, saved);
          return { result: saved, wrote: true };
        }
      }
    } catch (error) {
      throw verbRejection(error);
    }
  });
  if (outcome.wrote) {
    try {
      onWritten();
    } catch {
      // Ya está en disco; la ronda periódica lo subirá.
    }
  }
  return outcome;
}
