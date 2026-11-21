/**
 * Crear un documento binario (`.ods` u `.odp`) desde el MCP (paquete B-N20, decisión 14 y R30).
 * Es la operación común de `hebra_create_sheet` y `hebra_create_presentation`: los bytes los
 * produce el escritor del formato y aquí solo se guardan, con las mismas guardas que la
 * importación de ofimática.
 *
 * Todo ocurre DENTRO del turno de `writeExclusive` que pasa quien llama, y las comprobaciones
 * van antes de escribir el primer byte:
 * 1. Entrada válida: `operationId` obligatorio (D28, protección 7), nombre de fichero con la
 *    extensión del formato, bytes no vacíos, bajo `DOCUMENT_MAX_BYTES` y con el tipo ODF del
 *    formato en su contenido (`odfMimetypeOf`, D28, punto 8).
 * 2. `assertOfficeWritable` (C-29): una carpeta privada, oculta o inexistente da `not_found`.
 *    El rol del espacio ya lo comprobó el turno: uno de solo lectura rechaza con
 *    `client_outdated` y este callback ni corre (ver `./office-guards.ts`, punto 4).
 * 3. El registro de operaciones: el mismo `operationId` con la misma petición devuelve lo creado
 *    (`replayed`), si sigue visible; con otra petición, `operation_id_reused`.
 * 4. Como al crear un fichero en `./file-verbs.ts`: un homónimo visible en la carpeta es
 *    `file_exists` y un nombre o unos bytes que dejaría oculta una nota oculta,
 *    `file_name_unavailable`.
 * 5. `blobPut`, `fileCreate` y `finish`. No son una transacción: un corte entre medias deja el
 *    registro en `started`, y el reintento reconoce su fichero por nombre y bytes.
 */
import { createHash } from 'node:crypto';
import type { DocFormat } from '../../vendor/hebra/src/lib/documents/contract';
import { DOCUMENT_MAX_BYTES } from './document-limits';
import { documentFingerprint } from './document-ops';
import { guardDocumentRead } from './document-privacy';
import { existingFileRejected, operationReused, writeRejected } from './errors';
import { nameExtension, validFileName } from './file-content';
import { assertOfficeWritable, type OfficeGuardTurn } from './office-guards';
import { OPERATION_ID_MAX_LENGTH } from './operations';
import { looseFilesFilterInTurn } from './writes';

/** El turno de escritura: el almacén de `writeExclusive` y los privados de quien pide. */
export type WriteTurn = OfficeGuardTurn;

/** Lo que se crea. */
export interface CreateDocumentInput {
  format: DocFormat;
  /** Carpeta de destino, por id (`"root"` es la raíz). */
  folderId: string;
  /** Nombre del fichero, con la extensión del formato. */
  name: string;
  /** El documento ya escrito por el escritor del formato. */
  bytes: Uint8Array;
  /** Obligatorio: reintentar con el mismo no crea otro fichero. */
  operationId: string;
}

/** Lo creado. `replayed`: lo había creado ya este `operationId` y no se escribió nada. */
export interface CreatedDocument {
  fileId: string;
  sha256: string;
  replayed?: true;
}

/** Tipo con que se guarda cada formato. */
const DOCUMENT_MIME: Record<DocFormat, string> = {
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation'
};

/** Cabecera local de ZIP, y dónde lleva cada campo. */
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_LOCAL_HEADER_BYTES = 30;
/** Más largo que cualquier tipo ODF: lo que no cabe no es un `mimetype`. */
const ODF_MIMETYPE_MAX_BYTES = 128;

/**
 * El tipo ODF de unos bytes por su CONTENIDO, o `null`: un ZIP cuya primera entrada es
 * `mimetype`, sin comprimir, como exige ODF. No se fía de la extensión del nombre.
 */
export function odfMimetypeOf(bytes: Uint8Array): string | null {
  if (bytes.length < ZIP_LOCAL_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== ZIP_LOCAL_SIGNATURE) return null;
  if (view.getUint16(8, true) !== 0) return null;
  const size = view.getUint32(18, true);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  if (nameLength !== 8 || size === 0 || size > ODF_MIMETYPE_MAX_BYTES) return null;
  const decoder = new TextDecoder();
  const nameEnd = ZIP_LOCAL_HEADER_BYTES + nameLength;
  if (nameEnd > bytes.length || decoder.decode(bytes.subarray(ZIP_LOCAL_HEADER_BYTES, nameEnd)) !== 'mimetype') {
    return null;
  }
  const start = nameEnd + extraLength;
  if (start + size > bytes.length) return null;
  return decoder.decode(bytes.subarray(start, start + size));
}

/** Nombre para comparar sin distinguir mayúsculas ni la forma de una tilde (NFC). */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Lo que el registro guarda de una creación (no se fía de su forma al releerlo). */
function storedCreation(value: unknown): { fileId: string; sha256: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { fileId, sha256 } = value as Record<string, unknown>;
  return typeof fileId === 'string' && typeof sha256 === 'string' ? { fileId, sha256 } : null;
}

/**
 * Crea el fichero y devuelve su id y el SHA-256 de los bytes. Lanza `invalid_input`,
 * `file_too_large`, `not_found`, `operation_id_reused`, `file_exists` o
 * `file_name_unavailable` sin escribir nada.
 */
export async function createDocumentFile(
  turn: WriteTurn,
  input: CreateDocumentInput
): Promise<CreatedDocument> {
  const { store, privacy } = turn;
  const { operationId } = input;
  if (typeof operationId !== 'string' || operationId.length === 0 || operationId.length > OPERATION_ID_MAX_LENGTH) {
    throw writeRejected('invalid_input');
  }
  const mime = DOCUMENT_MIME[input.format];
  if (mime === undefined) throw writeRejected('invalid_input');
  const name = validFileName(input.name);
  if (name === null || name !== input.name || nameExtension(name) !== input.format) {
    throw writeRejected('invalid_input');
  }
  if (input.bytes.length === 0) throw writeRejected('invalid_input');
  if (input.bytes.length > DOCUMENT_MAX_BYTES) throw writeRejected('file_too_large');
  if (odfMimetypeOf(input.bytes) !== mime) throw writeRejected('invalid_input');

  // Guardas de privacidad (C-29): la carpeta de destino, antes de mirar nada más.
  assertOfficeWritable({ store, privacy }, { folderId: input.folderId });

  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const fingerprint = documentFingerprint(['documentCreate', input.format, input.folderId, name, sha256]);
  const now = Date.now();
  const log = store.operations;
  log.purgeExpired(now);
  const record = log.lookup(operationId);
  if (record) {
    if (record.fingerprint !== fingerprint) throw operationReused(record.noteId);
    const stored = record.state === 'done' ? storedCreation(record.result) : null;
    if (stored) {
      // Lo creado puede haber quedado oculto o en la papelera desde entonces: `not_found`.
      guardDocumentRead({ store, privacy }, stored.fileId);
      return { fileId: stored.fileId, sha256: stored.sha256, replayed: true };
    }
  }

  const key = nameKey(name);
  const { files } = looseFilesFilterInTurn(store, privacy, store.filesIndex());
  for (const visible of files.visibleFiles()) {
    if (visible.trashedAt === null && visible.folderId === input.folderId && nameKey(visible.name) === key) {
      // Un corte tras `fileCreate` dejó el registro a medias: este es el fichero de este intento.
      if (record && files.contentOf(visible.id)?.sha256.toLowerCase() === sha256) {
        log.finish(operationId, { fileId: visible.id, sha256 });
        return { fileId: visible.id, sha256, replayed: true };
      }
      throw existingFileRejected(visible.id);
    }
  }
  // Las notas que enlazan el nombre o los bytes se juzgan con un filtro que también las lleva.
  const refs = [...store.notesLinkingFileName(name), ...store.notesLinkingBlob(sha256)];
  const judged = looseFilesFilterInTurn(
    store,
    privacy,
    store.filesIndex(),
    refs.map((ref) => ref.noteId)
  ).files;
  if (judged.wouldHide(name, refs)) throw writeRejected('file_name_unavailable');

  if (!record) {
    log.begin({ operationId, fingerprint, noteId: input.folderId, targetBodySha256: sha256, now });
  }
  const put = await store.blobPut(input.bytes, { mime, expectedSha256: sha256 });
  const row = await store.fileCreate(input.folderId, name, put.sha256);
  const created = { fileId: row.id, sha256: row.sha256.toLowerCase() };
  log.finish(operationId, created);
  return created;
}
