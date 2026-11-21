/**
 * Guardas de privacidad de las herramientas de documentos (`.ods`, `.odp`), paquete B-N11
 * (estudio MCP de documentos, protecciones 1 a 3): lo que se comprueba DENTRO del turno de
 * `writeExclusive`, con las reglas (a) y (b) de D10 (SPEC.md §6.3), sin cambiarlas.
 *
 * - `guardDocumentRead`: el documento es un fichero suelto vivo y visible. Oculto,
 *   inexistente, lápida y papelera dan el mismo `not_found`.
 * - `guardDocumentWrite`: lo mismo, y además, si se va a escribir un punto de control
 *   (`checkpointSha256`), la regla (b) sobre sus bytes: si una nota oculta (viva, de la
 *   papelera o bloqueada, esto último lo trae `FileFilter`) enlaza ese hash, no se escribe
 *   y responde `not_found`. Es la regla de `replaceFileText` aplicada al blob nuevo.
 * - `guardAsset`: una imagen de un lote por `fileId` o por adjunto de nota pasa el mismo
 *   filtro; los bytes en base64 no tienen nada que filtrar. Un adjunto cuyos bytes son
 *   también de algo oculto responde `not_found`, como `fetchAttachment`.
 *
 * Nada de esto escribe ni llama al puerto: solo lee el almacén del turno (llamar a
 * `libraryOpen()` desde dentro del turno lo dejaría esperándose a sí mismo). El rol de
 * escritura del espacio ya lo comprueba el turno (ver `./office-guards.ts`, punto 4).
 */
import type { PrivacyConfig } from '../privacy/config';
import type { DocumentAsset } from './document-types';
import { writeRejected } from './errors';
import {
  LOCKED_BODY_PREFIX,
  looseFilesFilterInTurn,
  type NoteWriteStore
} from './writes';

/** Lo que hace falta del turno para decidir. */
export interface DocumentGuardTurn {
  /** El almacén del turno de `writeExclusive`. */
  store: NoteWriteStore;
  /** La configuración de privados de quien pide. */
  privacy: PrivacyConfig;
}

/** El documento visible y vivo, tal como lo ve el filtro del turno. */
export interface GuardedDocument {
  id: string;
  /** SHA-256 (minúsculas) del contenido actual del fichero. */
  sha256: string;
  name: string;
}

/** Un recurso ya comprobado: su SHA-256, o `null` si viene en base64 y no hay nada que mirar. */
export interface GuardedAsset {
  sha256: string | null;
}

/** Notas ya conocidas por quien llama (las que enlazan unos bytes) que el filtro debe juzgar. */
function judge(turn: DocumentGuardTurn, extraNoteIds: readonly string[] = []) {
  const index = turn.store.filesIndex();
  return looseFilesFilterInTurn(turn.store, turn.privacy, index, extraNoteIds);
}

/**
 * El documento tiene que ser un fichero suelto VIVO y VISIBLE. Si no, `not_found`, igual
 * para un id oculto, inexistente, borrado (lápida) o en la papelera.
 */
export function guardDocumentRead(turn: DocumentGuardTurn, id: string): GuardedDocument {
  const { files } = judge(turn);
  const content = files.contentOf(id);
  if (!content || content.file.trashedAt !== null) throw writeRejected('not_found');
  return { id, sha256: content.sha256, name: content.file.name };
}

/**
 * Lo de `guardDocumentRead` y, con `checkpointSha256`, la regla (b) sobre los bytes del punto
 * de control que se va a escribir: si alguna nota oculta los enlaza, `not_found` sin escribir.
 */
export function guardDocumentWrite(
  turn: DocumentGuardTurn,
  id: string,
  checkpointSha256?: string
): GuardedDocument {
  const document = guardDocumentRead(turn, id);
  if (checkpointSha256 !== undefined) assertCheckpointNotHidden(turn, checkpointSha256);
  return document;
}

/**
 * Regla (b) de D10 sobre un hash: si una nota oculta (viva, de la papelera o bloqueada)
 * enlaza esos bytes, el fichero con ellos quedaría oculto. `not_found`.
 */
export function assertCheckpointNotHidden(turn: DocumentGuardTurn, sha256: string): void {
  const hash = sha256.toLowerCase();
  const linking = turn.store.notesLinkingBlob(hash);
  // Las notas que enlazan esos bytes no estaban en el filtro de antes (A8): se juzgan con uno
  // que también las lleva, en el mismo turno.
  const { files } = judge(
    turn,
    linking.map((ref) => ref.noteId)
  );
  if (linking.some((ref) => files.isHiddenReference(ref))) throw writeRejected('not_found');
}

/**
 * Una imagen de un lote. Por `fileId`: fichero vivo y visible. Por `noteId` y
 * `attachmentId` (el SHA-256 del adjunto, como en `hebra_read_attachment`): nota viva,
 * visible y no bloqueada, con ese adjunto, y bytes que no son también de algo oculto. En
 * base64: nada que filtrar.
 */
export async function guardAsset(turn: DocumentGuardTurn, asset: DocumentAsset): Promise<GuardedAsset> {
  if ('dataBase64' in asset) return { sha256: null };
  if ('fileId' in asset) return { sha256: guardDocumentRead(turn, asset.fileId).sha256 };

  const sha256 = asset.attachmentId.toLowerCase();
  const linking = turn.store.notesLinkingBlob(sha256);
  // Las notas que se juzgan (A8): la pedida y las que enlazan esos bytes.
  const { live, files } = judge(turn, [asset.noteId, ...linking.map((ref) => ref.noteId)]);
  const note = await turn.store.noteRead(asset.noteId);
  if (!note || note.trashedAt !== null || live.isHiddenNote(note.id)) throw writeRejected('not_found');
  if (note.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('not_found');
  if (!turn.store.noteAttachments(note.id).some((entry) => entry.sha256 === sha256)) {
    throw writeRejected('not_found');
  }
  const hidden = linking.some((ref) => files.isHiddenReference(ref)) || files.hidesContent(sha256);
  if (hidden) throw writeRejected('not_found');
  return { sha256 };
}
