/**
 * Crear un documento binario (`.ods` u `.odp`) desde el MCP (paquete B-N20, decisión 14 y R30).
 * Es la operación común de `hebra_create_sheet` y `hebra_create_presentation`: los bytes los
 * produce el escritor del formato y aquí solo se guardan, con las mismas guardas que la
 * importación de ofimática.
 *
 * Todo ocurre DENTRO del turno de `writeExclusive` que pasa quien llama, y las comprobaciones
 * van antes de escribir el primer byte:
 * 1. Entrada válida: nombre de fichero con la extensión del formato, bytes no vacíos y bajo
 *    `DOCUMENT_MAX_BYTES`.
 * 2. `assertOfficeWritable` (C-29): una carpeta privada, oculta o inexistente da `not_found`.
 *    El rol del espacio ya lo comprobó el turno: uno de solo lectura rechaza con
 *    `client_outdated` y este callback ni corre (ver `./office-guards.ts`, punto 4).
 * 3. Como al crear un fichero en `./file-verbs.ts`: un homónimo visible en la carpeta es
 *    `file_exists` y un nombre o unos bytes que dejaría oculta una nota oculta,
 *    `file_name_unavailable`.
 * 4. `blobPut` y `fileCreate`.
 */
import { createHash } from 'node:crypto';
import type { DocFormat } from '../../vendor/hebra/src/lib/documents/contract';
import { DOCUMENT_MAX_BYTES } from './document-limits';
import { existingFileRejected, writeRejected } from './errors';
import { nameExtension, validFileName } from './file-content';
import { assertOfficeWritable, type OfficeGuardTurn } from './office-guards';
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
}

/** Tipo con que se guarda cada formato. */
const DOCUMENT_MIME: Record<DocFormat, string> = {
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation'
};

/** Nombre para comparar sin distinguir mayúsculas ni la forma de una tilde (NFC). */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Crea el fichero y devuelve su id y el SHA-256 de los bytes. Lanza `invalid_input`,
 * `file_too_large`, `not_found`, `file_exists` o `file_name_unavailable` sin escribir nada.
 */
export async function createDocumentFile(
  turn: WriteTurn,
  input: CreateDocumentInput
): Promise<{ fileId: string; sha256: string }> {
  const { store, privacy } = turn;
  const mime = DOCUMENT_MIME[input.format];
  if (mime === undefined) throw writeRejected('invalid_input');
  const name = validFileName(input.name);
  if (name === null || name !== input.name || nameExtension(name) !== input.format) {
    throw writeRejected('invalid_input');
  }
  if (input.bytes.length === 0) throw writeRejected('invalid_input');
  if (input.bytes.length > DOCUMENT_MAX_BYTES) throw writeRejected('file_too_large');

  // Guardas de privacidad (C-29): la carpeta de destino, antes de mirar nada más.
  assertOfficeWritable({ store, privacy }, { folderId: input.folderId });

  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const key = nameKey(name);
  const { files } = looseFilesFilterInTurn(store, privacy, store.filesIndex());
  for (const visible of files.visibleFiles()) {
    if (visible.trashedAt === null && visible.folderId === input.folderId && nameKey(visible.name) === key) {
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

  const put = await store.blobPut(input.bytes, { mime, expectedSha256: sha256 });
  const row = await store.fileCreate(input.folderId, name, put.sha256);
  return { fileId: row.id, sha256: row.sha256.toLowerCase() };
}
