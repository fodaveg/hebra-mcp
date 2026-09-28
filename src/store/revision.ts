/**
 * Revisión de una nota (D2 ampliada, 28 sep 2026): lo que `hebra_read_note` entrega y
 * `hebra_edit_note` exige como `expectedRevision`. Es la BASE de la edición: la versión
 * que el agente leyó, no la que haya ahora en el almacén.
 *
 * Por qué no vale `updatedAt`: mover, marcar como favorita o archivar no lo cambian
 * (`touchNote` de `sqlite-engine.ts`), y dos guardados en el mismo milisegundo tampoco.
 * Por qué no vale leer el `local_seq` de la nota ACTUAL al escribir: eso certificaría la
 * edición contra un cuerpo que el agente nunca vio.
 *
 * Contenido: id de biblioteca (`meta.library_id`), id de nota, `local_seq` y SHA-256
 * del cuerpo leídos. Formato `r1.` + base64url de un JSON `[biblioteca, nota, seq, sha]`.
 * Es opaco para el agente, pero NO es un secreto ni va firmado: quien lo falsifique solo
 * puede describir una versión que ya podría leer, y la comprobación de verdad es el
 * SHA-256 del cuerpo contra el almacén (`NoteWriter.editNote`).
 */

export interface NoteRevision {
  libraryId: string;
  noteId: string;
  localSeq: number;
  bodySha256: string;
}

const PREFIX = 'r1.';
/** Una revisión legítima mide unos 200 caracteres; esto solo acota lo que se decodifica. */
export const REVISION_MAX_LENGTH = 1_024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function encodeRevision(revision: NoteRevision): string {
  const payload = JSON.stringify([
    revision.libraryId,
    revision.noteId,
    revision.localSeq,
    revision.bodySha256
  ]);
  return `${PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

/** `null` si `raw` no es una revisión de este formato (nunca lanza). */
export function decodeRevision(raw: unknown): NoteRevision | null {
  if (typeof raw !== 'string' || raw.length > REVISION_MAX_LENGTH || !raw.startsWith(PREFIX)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [libraryId, noteId, localSeq, bodySha256] = value as unknown[];
  if (typeof libraryId !== 'string' || libraryId.length === 0) return null;
  if (typeof noteId !== 'string' || noteId.length === 0) return null;
  if (typeof localSeq !== 'number' || !Number.isSafeInteger(localSeq) || localSeq < 0) return null;
  if (typeof bodySha256 !== 'string' || !SHA256_HEX.test(bodySha256)) return null;
  return { libraryId, noteId, localSeq, bodySha256 };
}
