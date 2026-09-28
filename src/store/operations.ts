/**
 * Registro durable de operaciones de `hebra_edit_note` (D2 ampliada, 28 sep 2026): que
 * reintentar con el mismo `operationId` tras perder la respuesta no vuelva a aplicar las
 * sustituciones, y que tras un reinicio se distinga «no se guardó» de «se guardó y falta
 * subirlo».
 *
 * Vive en la MISMA SQLite de la biblioteca, en una tabla propia de hebra-mcp
 * (`hebra_mcp_operations`), que Hebra no conoce: ni viaja por sync (el motor solo sube
 * filas de `notes`, `folders` y `files`) ni la toca `libraryReset`. La crea el escritor
 * al abrir en lectura-escritura; un lector nunca la escribe (sus escrituras van al
 * escritor por `writer.sock`).
 *
 * Dos fases, dentro del MISMO turno de la cola del almacén que el guardado
 * (`NodeLibraryPort.writeExclusive`):
 * 1. `begin`: `started`, con la huella de la petición y el SHA-256 del cuerpo resultante.
 * 2. `noteSave` del motor (su propia transacción).
 * 3. `finish`: `done`, con el resultado.
 * No es atómico con el guardado (`noteSave` abre y cierra su transacción; el motor no
 * admite anidar otra), así que un proceso que muera entre 2 y 3 deja `started`. Al
 * reintentar, el SHA-256 decide: si el cuerpo de la nota es el resultante, se guardó (y
 * se completa el registro); si no, no se guardó y la edición se ejecuta de nuevo, contra
 * la misma revisión.
 *
 * Límites (también en SPEC.md, D2):
 * - Caducan a las 24 h (`OPERATION_TTL_MS`). Un reintento posterior se trata como
 *   petición nueva: su revisión ya no casa con el cuerpo editado y sale
 *   `revision_conflict`, nunca un texto duplicado.
 * - Solo lo guarda el escritor de ESTE directorio de datos: el conector remoto y el Mac
 *   tienen registros distintos (y bibliotecas locales distintas, así que su revisión
 *   tampoco vale en el otro).
 * - `unpair` borra el directorio de datos y, con él, el registro.
 */
import type { DatabaseSync } from 'node:sqlite';

export const OPERATION_TTL_MS = 24 * 60 * 60 * 1000;
/** Longitud máxima de un `operationId` (un UUID mide 36; el margen es de sobra). */
export const OPERATION_ID_MAX_LENGTH = 200;

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS hebra_mcp_operations (
  operation_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  note_id TEXT NOT NULL,
  target_body_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL
) WITHOUT ROWID`;

export type OperationState = 'started' | 'done';

export interface OperationRecord {
  operationId: string;
  fingerprint: string;
  noteId: string;
  targetBodySha256: string;
  state: OperationState;
  /** JSON del resultado ya devuelto (solo con `done`). */
  result: unknown;
  createdAt: number;
}

export interface OperationStore {
  lookup(operationId: string): OperationRecord | null;
  begin(record: {
    operationId: string;
    fingerprint: string;
    noteId: string;
    targetBodySha256: string;
    now: number;
  }): void;
  finish(operationId: string, result: unknown): void;
  /** Borra lo caducado; se llama al empezar cada edición. */
  purgeExpired(now: number): void;
}

/** Crea la tabla si falta. Solo en la conexión de lectura-escritura del escritor. */
export function ensureOperationsTable(db: DatabaseSync): void {
  db.exec(TABLE_SQL);
}

export function sqliteOperationStore(db: DatabaseSync): OperationStore {
  return {
    lookup(operationId) {
      const row = db
        .prepare(
          `SELECT operation_id, fingerprint, note_id, target_body_sha256, state, result, created_at
           FROM hebra_mcp_operations WHERE operation_id = ?`
        )
        .get(operationId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        operationId: String(row.operation_id),
        fingerprint: String(row.fingerprint),
        noteId: String(row.note_id),
        targetBodySha256: String(row.target_body_sha256),
        state: row.state === 'done' ? 'done' : 'started',
        result: typeof row.result === 'string' ? (JSON.parse(row.result) as unknown) : null,
        createdAt: Number(row.created_at)
      };
    },
    begin(record) {
      db.prepare(
        `INSERT OR REPLACE INTO hebra_mcp_operations
           (operation_id, fingerprint, note_id, target_body_sha256, state, result, created_at)
         VALUES (?, ?, ?, ?, 'started', NULL, ?)`
      ).run(
        record.operationId,
        record.fingerprint,
        record.noteId,
        record.targetBodySha256,
        record.now
      );
    },
    finish(operationId, result) {
      db.prepare(
        `UPDATE hebra_mcp_operations SET state = 'done', result = ? WHERE operation_id = ?`
      ).run(JSON.stringify(result), operationId);
    },
    purgeExpired(now) {
      db.prepare('DELETE FROM hebra_mcp_operations WHERE created_at < ?').run(
        now - OPERATION_TTL_MS
      );
    }
  };
}
