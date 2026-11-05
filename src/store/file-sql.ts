/**
 * SQL propio de hebra-mcp para el reemplazo de ficheros sueltos (D15, 10 oct 2026) y para
 * crearlos, renombrarlos y duplicarlos (D17, 12 oct 2026), sobre
 * `links`, `note_blob_refs` y `notes` de `schema.sql` de Hebra. Fuera de
 * `./node-port.ts` a propósito: el puerto ya comparte con Hebra casi todas las líneas que
 * tolera `scripts/check-no-hebra-code.mjs`.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BlobNoteRef } from './types';

/**
 * Las notas (no lápidas, vivas o de la papelera) que enlazan unos bytes por su SHA-256:
 * las dos ramas «por hash» de la regla (b) de D10, como en `filesIndex`
 * (`NodeLibraryPort.filesRows`): un enlace `blob` de `links` y una fila de
 * `note_blob_refs` (lo único que queda de los adjuntos de una nota bloqueada). La rama
 * «por nombre» no hace falta: reemplazar el contenido no cambia el nombre.
 *
 * `sha256` en minúsculas, que es como lo guardan las dos tablas.
 */
export function blobNoteRefRows(db: DatabaseSync, sha256: string): BlobNoteRef[] {
  const rows = db
    .prepare(
      `SELECT n.id AS note_id, n.trashed_at IS NOT NULL AS note_trashed
       FROM links l JOIN notes n ON n.id = l.src_note_id
       WHERE l.target_kind = 'blob' AND l.target = ?1 AND n.deleted = 0
       UNION
       SELECT n.id AS note_id, n.trashed_at IS NOT NULL AS note_trashed
       FROM note_blob_refs r JOIN notes n ON n.id = r.note_id
       WHERE r.sha256 = ?1 AND n.deleted = 0`
    )
    .all(sha256) as Array<{ note_id: string; note_trashed: number | bigint }>;
  return rows.map((row) => ({
    noteId: String(row.note_id),
    noteTrashed: Number(row.note_trashed) !== 0
  }));
}

/**
 * Las notas VIVAS que `fileRenameAndRelink` del motor exige con su revisión al renombrar un
 * fichero (D23): las que tienen un enlace `file` con ese nombre exacto o uno `blob` con ese
 * SHA-256. Tiene que ser el mismo conjunto que mira el motor (si no, `file_stale` sin
 * escribir): sin las de la papelera y sin `note_blob_refs`, que el motor no mira.
 */
export function relinkNoteRows(db: DatabaseSync, fileId: string, name: string, sha256: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT l.src_note_id AS note_id
       FROM links l JOIN notes n ON n.id = l.src_note_id
       WHERE n.deleted = 0 AND n.trashed_at IS NULL AND n.id <> ?1
         AND ((l.target_kind = 'file' AND l.target = ?2) OR (l.target_kind = 'blob' AND l.target = ?3))`
    )
    .all(fileId, name, sha256) as Array<{ note_id: string }>;
  return rows.map((row) => String(row.note_id));
}

/**
 * Las notas (no lápidas, vivas o de la papelera) que enlazan un fichero por su NOMBRE: un
 * enlace `file` de `links` con ese nombre exacto, la rama «por nombre» de la regla (b) de
 * D10, como en `filesIndex`. Para saber, antes de crear, renombrar o duplicar un fichero
 * suelto (D17), si el nombre nuevo lo dejaría oculto. La ruta del enlace no se mira, como
 * allí: un homónimo cuenta.
 */
export function nameLinkNoteRefRows(db: DatabaseSync, name: string): BlobNoteRef[] {
  const rows = db
    .prepare(
      `SELECT n.id AS note_id, n.trashed_at IS NOT NULL AS note_trashed
       FROM links l JOIN notes n ON n.id = l.src_note_id
       WHERE l.target_kind = 'file' AND l.target = ?1 AND n.deleted = 0`
    )
    .all(name) as Array<{ note_id: string; note_trashed: number | bigint }>;
  return rows.map((row) => ({
    noteId: String(row.note_id),
    noteTrashed: Number(row.note_trashed) !== 0
  }));
}
