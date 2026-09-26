/**
 * Adaptador `node:sqlite` → `SqliteConn` (R3 de SPEC.md): el subconjunto de `Database` de
 * `@sqlite.org/sqlite-wasm` que usa `sqlite-engine.ts` de Hebra, por duck typing
 * (`exec`, `selectObject`, `selectObjects`, `selectValue`). Diferencias medidas entre los
 * dos drivers y cómo las resuelve este fichero:
 *
 * - `exec(sql)` SIN `bind` puede traer varias sentencias (el esquema entero, con `;`):
 *   `DatabaseSync.prototype.exec` ya lo soporta tal cual (como `sqlite3_exec`), igual que
 *   sqlite-wasm. CON `bind`, el motor solo manda una sentencia: aquí se prepara y se
 *   ejecuta con `run()`.
 * - Enteros: `node:sqlite` sin `readBigInts` lanza `RangeError` al leer un entero fuera
 *   de `Number.MAX_SAFE_INTEGER`; sqlite-wasm en cambio siempre devuelve `Number` (con
 *   pérdida de precisión silenciosa en ese caso extremo, nunca una excepción). Se abre
 *   con `readBigInts: true` para no explotar, y CADA valor `bigint` que vuelve de una
 *   fila se convierte con `Number(...)` antes de devolverlo: mismo comportamiento
 *   observable que sqlite-wasm (silencioso, nunca lanza), no uno nuevo.
 * - Filas: `node:sqlite` devuelve objetos con prototipo `null` (`Object.create(null)`).
 *   El motor solo hace acceso de propiedad normal (`row.body`, `Object.entries`…), que
 *   funciona igual en los dos, pero se normalizan a objetos con `Object.prototype` para
 *   que un `JSON.stringify` o un spread de otra parte del código no dependan de este
 *   detalle del driver.
 * - `undefined` y `boolean` en un bind: `node:sqlite` los rechaza («Provided value cannot
 *   be bound to SQLite parameter»). El motor ya convierte los booleanos a 0/1 antes de
 *   pasarlos (`toBit`, `sqlite-engine.ts`) y evita `undefined` con `?? null` en casi todo
 *   el código; por si acaso, este adaptador coacciona `undefined → null` y
 *   `boolean → 0/1` antes de enlazar, así que un valor así nunca llega a fallar aquí.
 * - `BLOB`: el motor nunca enlaza bytes en SQLite (los adjuntos van a un
 *   `BlobBytesStore` aparte); no hace falta traducir `Uint8Array`/`Buffer` en los binds.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { SqliteConn } from '$lib/library/sqlite-engine';

export type NodeSqliteBindValue = string | number | bigint | boolean | null | undefined;

function toBoundValue(value: unknown): string | number | bigint | null {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as string | number | bigint | null;
}

/** `bigint` (de `readBigInts: true`) → `Number`, igual que sqlite-wasm; el resto tal
 *  cual. Convierte además el objeto de prototipo `null` de `node:sqlite` en uno normal. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    normalized[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return normalized;
}

/**
 * Abre `path` (o `:memory:`) con `node:sqlite` y devuelve la conexión cruda (para los
 * pragmas propios de hebra-mcp, como WAL tras el arranque del motor: ver
 * `node-port.ts`) y el `SqliteConn` que espera `SqliteLibraryEngine.open`.
 */
export function openNodeSqliteConn(path: string): { db: DatabaseSync; conn: SqliteConn } {
  const db = new DatabaseSync(path, { readBigInts: true });
  const statements = new Map<string, StatementSync>();

  function statementFor(sql: string): StatementSync {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  }

  const conn: SqliteConn = {
    exec(sql, opts) {
      const bind = opts?.bind;
      if (!bind || bind.length === 0) {
        // Sin bind: puede ser un script con varias sentencias (el esquema, `BEGIN`,
        // `COMMIT`, pragmas). `db.exec` las ejecuta todas, como `sqlite3_exec`.
        db.exec(sql);
        return undefined;
      }
      // Con bind: una sola sentencia (R3). `run()` la prepara (o reusa la cacheada) y
      // la ejecuta con los parámetros posicionales `?1, ?2, …` que usa Hebra.
      statementFor(sql).run(...bind.map(toBoundValue));
      return undefined;
    },
    selectObject(sql, bind) {
      const statement = statementFor(sql);
      const row = bind ? statement.get(...bind.map(toBoundValue)) : statement.get();
      return row === undefined ? undefined : normalizeRow(row as Record<string, unknown>);
    },
    selectObjects(sql, bind) {
      const statement = statementFor(sql);
      const rows = bind ? statement.all(...bind.map(toBoundValue)) : statement.all();
      return (rows as Record<string, unknown>[]).map(normalizeRow);
    },
    selectValue(sql, bind) {
      const statement = statementFor(sql);
      const row = bind ? statement.get(...bind.map(toBoundValue)) : statement.get();
      if (row === undefined) return undefined;
      const [value] = Object.values(row as Record<string, unknown>);
      return typeof value === 'bigint' ? Number(value) : value;
    }
  };

  return { db, conn };
}
