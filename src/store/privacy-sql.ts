/**
 * SQL propio de hebra-mcp para el filtro de privados (SPEC.md §6.3), sobre `notes`,
 * `note_tags` y `folders` de `schema.sql` de Hebra: lo que leen `PrivacyFilter` (notas vivas)
 * y `TrashFilter` (papelera). Estaba en `./node-port.ts`; salió de ahí con el audit de
 * privacidad adversarial del 10 oct 2026 (A1 y A2), porque el puerto ya comparte con Hebra
 * casi todas las líneas que tolera `scripts/check-no-hebra-code.mjs`. Lo usan el puerto (en
 * su cola y dentro del turno de escritura) y `hebra_grep` (`./grep-sql.ts`).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { FolderRowFact, NoteVisibilityEntry, TrashIndex } from './types';

/** Todas las filas de carpeta, vivas y lápidas, con su padre GUARDADO. */
export function folderRowFacts(db: DatabaseSync): FolderRowFact[] {
  const rows = db.prepare('SELECT id, parent_id, name, deleted FROM folders').all() as Array<{
    id: string;
    parent_id: string | null;
    name: string | null;
    deleted: number | bigint;
  }>;
  return rows.map((row) => ({
    id: String(row.id),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    name: row.name === null ? null : String(row.name),
    deleted: Number(row.deleted) !== 0
  }));
}

/**
 * Las filas de carpeta desde `storedFolderId` hacia arriba hasta la primera viva (sin
 * ella): lo que necesita el filtro para subir por las lápidas (`climbFolder`,
 * `src/privacy/tombstones.ts`). Se corta, sin error, donde falta una fila o se repite una
 * (ciclo): el filtro no llega a una carpeta viva y la nota queda oculta.
 */
function trailOf(storedFolderId: string, rows: ReadonlyMap<string, FolderRowFact>): FolderRowFact[] {
  const trail: FolderRowFact[] = [];
  const seen = new Set<string>();
  let current: string | null = storedFolderId;
  while (current !== null && !seen.has(current)) {
    const row = rows.get(current);
    if (!row || !row.deleted) break;
    seen.add(current);
    trail.push(row);
    current = row.parentId;
  }
  return trail;
}

/** Fila de nota viva tal como sale de las consultas de abajo. */
interface VisibilityRow {
  id: string;
  folder_id: string;
  stored_folder_id: string | null;
  locked: number | bigint | null;
  tags: string | null;
}

/**
 * De filas de notas vivas a `NoteVisibilityEntry`, con la subida por las lápidas de las que
 * tienen la carpeta guardada sin vivir (A2): las filas de carpeta se leen UNA vez, y solo si
 * alguna nota lo necesita.
 */
export function visibilityEntries(db: DatabaseSync, rows: readonly VisibilityRow[]): NoteVisibilityEntry[] {
  let folders: Map<string, FolderRowFact> | null = null;
  return rows.map((row) => {
    const entry: NoteVisibilityEntry = {
      id: String(row.id),
      folderId: String(row.folder_id),
      tags: row.tags ? String(row.tags).split('\n') : []
    };
    if (row.locked !== null && Number(row.locked) !== 0) entry.locked = true;
    if (row.stored_folder_id !== null) {
      folders ??= new Map(folderRowFacts(db).map((folder) => [folder.id, folder]));
      entry.storedFolderId = String(row.stored_folder_id);
      entry.folderTrail = trailOf(entry.storedFolderId, folders);
    }
    return entry;
  });
}

/**
 * Columnas de una nota viva para el filtro, sobre `notes n LEFT JOIN folders f ON f.id =
 * n.folder_id`. Carpeta efectiva: la propia `folder_id` si esa carpeta existe y no es
 * lápida, si no la raíz — la misma regla que `rowToNote` de `sqlite-engine.ts` —; y, si no
 * es la viva, la guardada (`stored_folder_id`): una lápida (`folder_state = 'deleted'` del
 * motor) o una fila que aún no llegó (`'pending'`). La raíz es una fila fija y viva
 * (`'root'` de `schema.sql`), así que una nota de la raíz nunca lleva guardada.
 */
export const VISIBILITY_COLUMNS = `CASE WHEN f.id IS NOT NULL AND f.deleted = 0 THEN n.folder_id ELSE 'root' END AS folder_id,
       CASE WHEN f.id IS NULL OR f.deleted <> 0 THEN n.folder_id END AS stored_folder_id,
       n.locked AS locked`;

/**
 * Carpeta efectiva, carpeta guardada (si no está viva), si está bloqueada y etiquetas de
 * cada nota viva, en UNA consulta (comentario de `notesVisibilityIndex` en `./types.ts`).
 * Etiquetas: `GROUP_CONCAT` con `\n` como separador (una etiqueta canónica nunca lleva
 * salto de línea) en vez de una subconsulta por nota; de cero filas es `NULL`.
 */
export function noteVisibilityRows(db: DatabaseSync): NoteVisibilityEntry[] {
  const rows = db
    .prepare(
      `SELECT n.id AS id, ${VISIBILITY_COLUMNS},
              GROUP_CONCAT(t.tag, char(10)) AS tags
       FROM notes n
       LEFT JOIN folders f ON f.id = n.folder_id
       LEFT JOIN note_tags t ON t.note_id = n.id
       WHERE n.deleted = 0 AND n.trashed_at IS NULL
       GROUP BY n.id`
    )
    .all() as unknown as VisibilityRow[];
  return visibilityEntries(db, rows);
}

/**
 * El índice de la papelera: sus notas con la carpeta GUARDADA (no la efectiva), si están
 * bloqueadas, y TODAS las filas de carpeta, lápidas incluidas. `folderTrash` de Hebra deja
 * las carpetas como lápida (`deleted = 1`, con su nombre y su padre) y manda sus notas a la
 * papelera sin tocar su `folder_id`, así que solo subiendo por esas filas se sabe si una
 * nota de la papelera venía de una carpeta privada (`src/privacy/trash-filter.ts`).
 */
export function trashIndexRows(db: DatabaseSync): TrashIndex {
  const notes = db
    .prepare(
      `SELECT n.id AS id, coalesce(n.folder_id, 'root') AS folder_id, n.locked AS locked,
              n.trashed_at AS trashed_at, GROUP_CONCAT(t.tag, char(10)) AS tags
       FROM notes n
       LEFT JOIN note_tags t ON t.note_id = n.id
       WHERE n.deleted = 0 AND n.trashed_at IS NOT NULL
       GROUP BY n.id`
    )
    .all() as Array<{
    id: string;
    folder_id: string;
    locked: number | bigint | null;
    trashed_at: number | bigint;
    tags: string | null;
  }>;
  return {
    notes: notes.map((row) => ({
      id: String(row.id),
      folderId: String(row.folder_id),
      tags: row.tags ? String(row.tags).split('\n') : [],
      trashedAt: Number(row.trashed_at),
      ...(row.locked !== null && Number(row.locked) !== 0 ? { locked: true } : {})
    })),
    folders: folderRowFacts(db)
  };
}
