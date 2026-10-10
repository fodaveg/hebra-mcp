/**
 * El contenido anterior de un fichero suelto que reemplazó `hebra_replace_file_text`
 * (D15, decidido por David el 10 oct 2026; SPEC.md §5), para poder volver atrás.
 *
 * Hebra no guarda versiones de los ficheros sueltos: `fileReplace` del motor cambia el
 * `sha256` de la fila y nada más (`docs/FACHADA-NODE.md` §2.5 del submódulo). Los bytes
 * viejos siguen en el almacén de blobs (ningún gesto local los borra), pero ya no cuentan
 * como referenciados, y depender de eso sería depender de un detalle del motor. Así que
 * el escritor guarda aquí el TEXTO anterior, en el mismo turno y ANTES de reemplazar, y
 * `hebra_replace_file_text` con `undoOperationId` lo vuelve a escribir como un reemplazo
 * más (con su base comprobada).
 *
 * Tabla propia de hebra-mcp en `library.sqlite` (`hebra_mcp_file_previous`), como el
 * registro de operaciones: no viaja por sync ni la toca `libraryReset`, la crea el
 * escritor al abrir en lectura-escritura y un lector nunca la escribe. El texto va en
 * claro, como el resto de la biblioteca local y los cuerpos base de D14.
 *
 * Límites: cada entrada caduca a los 7 días (`FILE_PREVIOUS_TTL_MS`) y, entre todas, como
 * mucho `FILE_PREVIOUS_MAX_ENTRIES` entradas y `FILE_PREVIOUS_MAX_BYTES` bytes de texto;
 * al guardar una que lo pasaría, caen las más antiguas. Se purga al empezar cada
 * reemplazo, en el mismo turno.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';

/** Cuánto dura la vuelta atrás de un reemplazo: lo mismo que deshacer un lote (D14). */
export const FILE_PREVIOUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Entradas guardadas como mucho, y bytes de texto entre todas. */
export const FILE_PREVIOUS_MAX_ENTRIES = 200;
export const FILE_PREVIOUS_MAX_BYTES = 50_000_000;

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS hebra_mcp_file_previous (
  operation_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  previous_sha256 TEXT NOT NULL,
  previous_text TEXT NOT NULL,
  previous_bytes INTEGER NOT NULL,
  mime TEXT,
  created_at INTEGER NOT NULL
) WITHOUT ROWID`;

/** El contenido de un fichero antes de un reemplazo. */
export interface FilePreviousEntry {
  /** El `operationId` del reemplazo que lo sustituyó. */
  operationId: string;
  fileId: string;
  previousSha256: string;
  previousText: string;
  /** Tipo con el que se leyó (`text/yaml`, `text/plain`…), para volver a escribirlo así. */
  mime: string | null;
  createdAt: number;
}

export interface FilePreviousStore {
  /** La entrada de `operationId`, si existe y no ha caducado. */
  lookup(operationId: string, now: number): FilePreviousEntry | null;
  /** Guarda (o sustituye) la entrada y recorta las más antiguas hasta caber. */
  save(entry: FilePreviousEntry): void;
  /** Borra lo caducado. */
  purgeExpired(now: number): void;
}

/** Crea la tabla si falta. Solo en la conexión de lectura-escritura del escritor. */
export function ensureFilePreviousTable(db: DatabaseSync): void {
  db.exec(TABLE_SQL);
}

export function sqliteFilePreviousStore(db: DatabaseSync): FilePreviousStore {
  const prepared = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let found = prepared.get(sql);
    if (!found) {
      found = db.prepare(sql);
      prepared.set(sql, found);
    }
    return found;
  };
  return {
    lookup(operationId, now) {
      const row = statement(
        `SELECT operation_id, file_id, previous_sha256, previous_text, mime, created_at
         FROM hebra_mcp_file_previous WHERE operation_id = ? AND created_at >= ?`
      ).get(operationId, now - FILE_PREVIOUS_TTL_MS) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        operationId: String(row.operation_id),
        fileId: String(row.file_id),
        previousSha256: String(row.previous_sha256),
        previousText: String(row.previous_text),
        mime: typeof row.mime === 'string' ? row.mime : null,
        createdAt: Number(row.created_at)
      };
    },
    save(entry) {
      const bytes = Buffer.byteLength(entry.previousText, 'utf8');
      statement(
        `INSERT OR REPLACE INTO hebra_mcp_file_previous
           (operation_id, file_id, previous_sha256, previous_text, previous_bytes, mime, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.operationId,
        entry.fileId,
        entry.previousSha256,
        entry.previousText,
        bytes,
        entry.mime,
        entry.createdAt
      );
      // Las más recientes primero; se borra todo lo que quede por detrás del tope de
      // entradas o del de bytes (la recién guardada cabe siempre: pesa como mucho el tope
      // de un reemplazo, muy por debajo del de bytes).
      const rows = statement(
        `SELECT operation_id, previous_bytes FROM hebra_mcp_file_previous
         ORDER BY created_at DESC, operation_id DESC`
      ).all() as Array<{ operation_id: string; previous_bytes: number | bigint }>;
      let total = 0;
      rows.forEach((row, index) => {
        total += Number(row.previous_bytes);
        if (index >= FILE_PREVIOUS_MAX_ENTRIES || total > FILE_PREVIOUS_MAX_BYTES) {
          statement('DELETE FROM hebra_mcp_file_previous WHERE operation_id = ?').run(
            row.operation_id
          );
        }
      });
    },
    purgeExpired(now) {
      statement('DELETE FROM hebra_mcp_file_previous WHERE created_at < ?').run(
        now - FILE_PREVIOUS_TTL_MS
      );
    }
  };
}
