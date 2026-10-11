/**
 * SQL propio de hebra-mcp para el filtro de privados (SPEC.md §6.3), sobre `notes`,
 * `note_tags` y `folders` de `schema.sql` de Hebra: lo que leen `PrivacyFilter` (notas vivas)
 * y `TrashFilter` (papelera). Estaba en `./node-port.ts`; salió de ahí con el audit de
 * privacidad adversarial del 10 oct 2026 (A1 y A2), porque el puerto ya comparte con Hebra
 * casi todas las líneas que tolera `scripts/check-no-hebra-code.mjs`. Lo usan el puerto (en
 * su cola y dentro del turno de escritura) y `hebra_grep` (`./grep-sql.ts`).
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  FolderRowFact,
  NoteStamp,
  NoteVisibilityEntry,
  RememberedPrivateFolder,
  TrashIndex
} from './types';

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
  local_seq?: number | bigint | null;
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
    if (row.local_seq !== undefined && row.local_seq !== null) entry.localSeq = Number(row.local_seq);
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
 * (`'root'` de `schema.sql`), así que una nota de la raíz nunca lleva guardada. Y
 * `local_seq`, el sello de la fila con la que se decidió (la puerta final,
 * `src/server/privacy-gate.ts`).
 */
export const VISIBILITY_COLUMNS = `CASE WHEN f.id IS NOT NULL AND f.deleted = 0 THEN n.folder_id ELSE 'root' END AS folder_id,
       CASE WHEN f.id IS NULL OR f.deleted <> 0 THEN n.folder_id END AS stored_folder_id,
       n.locked AS locked, n.local_seq AS local_seq`;

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
 * El sello de cada nota de `ids` que no es lápida, viva o de la papelera: `local_seq`, que
 * sube con cada guardado de la fila (también los que trae el sync, y mover, bloquear o
 * mandar a la papelera), y si está en la papelera. Lo que mira la puerta final
 * (`src/server/privacy-gate.ts`) para saber que la fila que usó la respuesta es la misma que
 * juzga ahora. `updated_at` no sirve (2.ª revisión de Codex,
 * `test/privacy/codex2-updated-at-collision.test.ts`): tiene resolución de milisegundos, y dos
 * guardados seguidos pueden compartirlo. Una lápida no sale.
 */
export function noteStamps(db: DatabaseSync, ids: readonly string[]): Map<string, NoteStamp> {
  const stamps = new Map<string, NoteStamp>();
  if (ids.length === 0) return stamps;
  const rows = db
    .prepare(
      `SELECT n.id AS id, n.local_seq AS local_seq, n.trashed_at IS NOT NULL AS trashed
       FROM json_each(?) AS wanted
       JOIN notes AS n ON n.id = wanted.value
       WHERE n.deleted = 0`
    )
    .all(JSON.stringify([...new Set(ids)])) as Array<{
    id: string;
    local_seq: number | bigint;
    trashed: number | bigint;
  }>;
  for (const row of rows) {
    stamps.set(String(row.id), { localSeq: Number(row.local_seq), trashed: Number(row.trashed) !== 0 });
  }
  return stamps;
}

/**
 * La ÉPOCA de privacidad del almacén (puerta final, `src/server/privacy-gate.ts`): una huella
 * que cambia con cualquier cosa que pueda cambiar lo que es privado. `local_seq` del motor NO
 * es una secuencia global (cada fila lleva la suya y la sube en cada guardado, también los que
 * trae el sync, mover, bloquear, mandar a la papelera o volver lápida), así que no vale su
 * máximo: se toma, por tabla, el número de filas y la SUMA de `local_seq`, que sube con
 * cualquier cambio de cualquier fila (y el número, con una fila nueva o purgada): `notes`
 * (vivas, de la papelera y lápidas, con sus etiquetas, carpeta y bloqueo, que se guardan con
 * la fila), `folders` (vivas y lápidas: nombre y padre) y `files`. Y la memoria de las carpetas
 * privadas (A3), la de la tabla y la del proceso (`remembered`), entera. Y `data_version` de
 * SQLite, que cambia con cada escritura que confirma OTRA conexión. Lo que no cubre: lo que
 * esta misma conexión reescribe sin subir `local_seq` (al abrir una biblioteca de una versión
 * anterior, las derivadas de `deriveVersion`, antes de servir nada; vaciar la biblioteca lo
 * cuenta el puerto, `NodeLibraryPort.epochRow`).
 */
/**
 * Índices propios de hebra-mcp para la época (`privacyEpochOf`): con `local_seq` en un índice,
 * la suma se lee del índice y no recorre las filas (el cuerpo va en la fila de `notes`, y con
 * notas largas eso eran megas por llamada). Solo el escritor los crea, al abrir, como sus tablas
 * propias; un lector usa los que haya (sin ellos, la misma suma, más lenta). Un índice más en
 * una tabla del motor no cambia nada de lo que guarda ni de lo que sincroniza.
 */
export function ensurePrivacyEpochIndexes(db: DatabaseSync): void {
  db.exec('CREATE INDEX IF NOT EXISTS hebra_mcp_epoch_notes ON notes(local_seq)');
  db.exec('CREATE INDEX IF NOT EXISTS hebra_mcp_epoch_folders ON folders(local_seq)');
  db.exec('CREATE INDEX IF NOT EXISTS hebra_mcp_epoch_files ON files(local_seq)');
}

export function privacyEpochOf(db: DatabaseSync, remembered: readonly RememberedPrivateFolder[]): string {
  const sums = db
    .prepare(
      `SELECT (SELECT count(*) || '.' || coalesce(sum(local_seq), 0) FROM notes) AS notes,
              (SELECT count(*) || '.' || coalesce(sum(local_seq), 0) FROM folders) AS folders,
              (SELECT count(*) || '.' || coalesce(sum(local_seq), 0) FROM files) AS files`
    )
    .get() as { notes: string; folders: string; files: string };
  // Y cualquier escritura confirmada por OTRA conexión (otro proceso, el escritor visto desde
  // un lector): cubre lo que las sumas no ven, como reindexar etiquetas sin subir `local_seq`
  // o vaciar y volver a importar lo mismo (R4-2 y R4-3 de la 4.ª revisión de Codex). Cuenta
  // de más (también lo que no toca la privacidad), nunca de menos.
  const dataVersion = (db.prepare('PRAGMA data_version').get() as { data_version: number | bigint }).data_version;
  const memory = remembered.map((entry) => `${entry.pathKey}\u0000${entry.folderId}`).sort();
  return JSON.stringify([
    String(sums.notes),
    String(sums.folders),
    String(sums.files),
    String(dataVersion),
    memory
  ]);
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
              n.trashed_at AS trashed_at, n.local_seq AS local_seq,
              GROUP_CONCAT(t.tag, char(10)) AS tags
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
    local_seq: number | bigint;
    tags: string | null;
  }>;
  return {
    notes: notes.map((row) => ({
      id: String(row.id),
      folderId: String(row.folder_id),
      tags: row.tags ? String(row.tags).split('\n') : [],
      trashedAt: Number(row.trashed_at),
      localSeq: Number(row.local_seq),
      ...(row.locked !== null && Number(row.locked) !== 0 ? { locked: true } : {})
    })),
    folders: folderRowFacts(db)
  };
}
