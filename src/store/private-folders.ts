/**
 * Memoria de las carpetas privadas (A3 del audit de privacidad adversarial del 10 oct 2026;
 * SPEC.md §6.3, D16): a qué carpetas resolvió alguna vez cada ruta de `privateFolders`.
 *
 * La configuración es por RUTA (`Diario`), y la ruta se resuelve a carpetas en cada llamada.
 * Si en Hebra se mueve la carpeta privada dentro de otra (`Historial/Diario`) y se crea una
 * nueva con el mismo nombre, la ruta pasa a nombrar la nueva y la vieja, con todo lo que
 * tenía, dejaba de estar oculta. Con esta memoria el filtro oculta la UNIÓN de las carpetas
 * de la ruta de ahora y las que ya resolvió antes (`PrivacyConfig.knownPrivateFolderIds`).
 *
 * Dónde vive: en una tabla propia de hebra-mcp en `library.sqlite`
 * (`hebra_mcp_private_folders`), como el registro de operaciones (`./operations.ts`) y el
 * contenido anterior de los ficheros (`./file-previous.ts`): sobrevive a un reinicio, no
 * viaja por sync, y va ligada a la biblioteca cuyos ids de carpeta nombra (otra biblioteca,
 * otra SQLite, otra memoria). La crea y la escribe solo el escritor; un lector la lee (si
 * aún no existe, no tiene nada que leer) y lo que anota él lo guarda en su proceso
 * (`NodeLibraryPort`).
 *
 * Una ruta que deja de estar configurada se olvida al anotar (`forget`): sus filas se
 * borran, así que volver a configurarla oculta solo las carpetas de la ruta de entonces.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { RememberedPrivateFolder } from './types';

const TABLE = 'hebra_mcp_private_folders';

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  path_key TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (path_key, folder_id)
) WITHOUT ROWID`;

/** Crea la tabla si falta. Solo en la conexión de lectura-escritura del escritor. */
export function ensurePrivateFoldersTable(db: DatabaseSync): void {
  db.exec(TABLE_SQL);
}

/** Lo anotado en la tabla; nada si aún no existe (un lector de una base que todavía no
 *  abrió un escritor de esta versión). */
export function readPrivateFolders(db: DatabaseSync): RememberedPrivateFolder[] {
  const exists = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE);
  if (!exists) return [];
  const rows = db.prepare(`SELECT path_key, folder_id FROM ${TABLE} ORDER BY path_key, folder_id`).all() as Array<{
    path_key: string;
    folder_id: string;
  }>;
  return rows.map((row) => ({ pathKey: String(row.path_key), folderId: String(row.folder_id) }));
}

/**
 * Anota `fresh` (las que ya estén, sin cambios) y borra las filas de las rutas que no están
 * en `configured`, en una transacción. Solo el escritor (la tabla tiene que existir).
 */
export function writePrivateFolders(
  db: DatabaseSync,
  fresh: readonly RememberedPrivateFolder[],
  configured: readonly string[],
  now: number
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${TABLE} (path_key, folder_id, first_seen_at) VALUES (?, ?, ?)`
    );
    for (const entry of fresh) insert.run(entry.pathKey, entry.folderId, now);
    const keep = JSON.stringify([...configured]);
    db.prepare(`DELETE FROM ${TABLE} WHERE path_key NOT IN (SELECT value FROM json_each(?))`).run(keep);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
