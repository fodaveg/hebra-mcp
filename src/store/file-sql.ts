/**
 * SQL propio de hebra-mcp para el reemplazo de ficheros sueltos (D15, 10 oct 2026), sobre
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
