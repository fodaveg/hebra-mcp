/**
 * Planes de `hebra_jd_new_id` (D18, SPEC.md §5): lo que simuló el escritor, para aplicarlo
 * EXACTAMENTE igual. Una tabla propia de hebra-mcp, como el registro de operaciones
 * (`./operations.ts`) y los planes de `hebra_replace_in_notes` (`./replace-plans.ts`), pero en
 * su PROPIO fichero, `jd-plans.sqlite`, junto a `library.sqlite` (`openJdPlansDatabase`): la
 * época de privacidad de la puerta final incluye `data_version` de la biblioteca, que sube con
 * cualquier escritura de OTRA conexión, también la de un plan; en la misma base, una
 * simulación pedida desde un lector cambiaría la época de su propia llamada y la puerta la
 * repetiría hasta responder el estado fresco. Hebra no lo conoce y no viaja por sync. Lo crea
 * el escritor al abrir en lectura-escritura; un lector nunca lo lee ni lo escribe (simular y
 * aplicar pasan por el escritor, también desde un lector por `writer.sock`).
 *
 * El plan (`NewIdPlan` del motor JD, JSON plano) se guarda entero y NUNCA se acepta del
 * agente: este solo trae el `planId`. Vive en disco, no en memoria: si un `apply` se corta a
 * mitad (la nota creada, la carpeta no) y el proceso muere, el reintento con el mismo
 * `operationId` encuentra el plan y lo completa.
 *
 * Caducidad (`purgeExpired`, al empezar cada operación de plan): un plan se puede aplicar
 * durante una hora (`JD_PLAN_APPLY_TTL_MS`; después, `plan_expired`) y se borra a las 24 h
 * (`JD_PLAN_KEEP_MS`; después, `plan_not_found`). Como mucho `JD_STORED_PLANS_MAX` planes sin
 * aplicar: al guardar uno que lo pasaría, cae el más antiguo de ellos. Desde D19 (mover a un
 * ID) los planes llevan su herramienta (`kind`) y, los de mover, cuándo se aplicaron: un plan
 * aplicado se guarda 7 días (`JD_MOVE_UNDO_RETENTION_MS`) para deshacerlo y no cuenta para el
 * tope. `unpair` borra el directorio de datos y, con él, esto.
 */
import { chmodSync, closeSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** Un plan se aplica en la hora siguiente a simularlo. */
export const JD_PLAN_APPLY_TTL_MS = 60 * 60 * 1000;
/** Se conserva un día (para responder `plan_expired` y no `plan_not_found`). */
export const JD_PLAN_KEEP_MS = 24 * 60 * 60 * 1000;
/** Planes guardados como mucho: al pasarlo, cae el más antiguo. */
export const JD_STORED_PLANS_MAX = 50;

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS hebra_mcp_jd_plans (
  plan_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  privacy_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  plan TEXT NOT NULL
)`;

/** Un plan aplicado de mover a un ID (D19) se guarda 7 días para deshacerlo, como el de
 *  `hebra_replace_in_notes`. */
export const JD_MOVE_UNDO_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** De qué herramienta es un plan: no vale en la otra (`plan_not_found`). */
export type JdPlanKind = 'new_id' | 'move';

export interface JdPlanRecord {
  planId: string;
  libraryId: string;
  /** `privacyFingerprint` de la configuración con que se simuló: con otra, no vale. */
  privacySha256: string;
  createdAt: number;
  kind: JdPlanKind;
  /** Cuándo se aplicó por primera vez (solo los de mover se marcan), o `null`. */
  appliedAt: number | null;
  /** El plan del motor, ya leído del JSON (quien lo usa comprueba su forma). */
  plan: unknown;
}

export interface JdPlanStore {
  purgeExpired(now: number): void;
  /** Guarda un plan sin aplicar; si con él pasaría del tope de los sin aplicar, antes borra
   *  los más antiguos de ellos. */
  insert(record: Omit<JdPlanRecord, 'appliedAt'>): void;
  get(planId: string): JdPlanRecord | null;
  /** Marca un plan como aplicado (la primera vez): desde ahí vale 7 días para deshacerlo. */
  markApplied(planId: string, now: number): void;
  /** Borra un plan SIN aplicar (el de una simulación que la puerta final descartó). */
  delete(planId: string): void;
}

/** El fichero de los planes, junto al de la biblioteca. */
export const JD_PLANS_SQLITE_FILE = 'jd-plans.sqlite';

/**
 * Abre (y crea si falta) la base de los planes junto a `librarySqlitePath`, en 0600 como la
 * biblioteca (SPEC.md §6.1), con la tabla. Con una biblioteca `:memory:` (tests), en memoria.
 * Solo el escritor.
 */
export function openJdPlansDatabase(librarySqlitePath: string): DatabaseSync {
  const path = librarySqlitePath === ':memory:' ? ':memory:' : join(dirname(librarySqlitePath), JD_PLANS_SQLITE_FILE);
  if (path !== ':memory:') {
    // Nace en 0600 (`wx`: solo si no existe), sin un hueco entre crearlo y corregir el modo.
    // Uno que ya existía de antes con otro modo se deja en 0600.
    try {
      closeSync(openSync(path, 'wx', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      chmodSync(path, 0o600);
    }
  }
  const db = new DatabaseSync(path);
  try {
    db.exec(TABLE_SQL);
    ensureColumns(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Columnas añadidas con D19 (mover a un ID): una base de antes las gana al abrir. */
const ADDED_COLUMNS: ReadonlyArray<[column: string, definition: string]> = [
  ['kind', "TEXT NOT NULL DEFAULT 'new_id'"],
  ['applied_at', 'INTEGER']
];

function ensureColumns(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(hebra_mcp_jd_plans)').all() as Array<{ name: string }>;
  for (const [column, definition] of ADDED_COLUMNS) {
    if (!columns.some((entry) => entry.name === column)) {
      db.exec(`ALTER TABLE hebra_mcp_jd_plans ADD COLUMN ${column} ${definition}`);
    }
  }
}

export function sqliteJdPlanStore(db: DatabaseSync): JdPlanStore {
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
    purgeExpired(now) {
      statement('DELETE FROM hebra_mcp_jd_plans WHERE applied_at IS NULL AND created_at < ?').run(now - JD_PLAN_KEEP_MS);
      statement('DELETE FROM hebra_mcp_jd_plans WHERE applied_at IS NOT NULL AND applied_at < ?').run(
        now - JD_MOVE_UNDO_RETENTION_MS
      );
    },
    insert(record) {
      // El tope es de los planes sin aplicar: uno aplicado hace falta para deshacerlo.
      const count = Number(
        (statement('SELECT COUNT(*) AS n FROM hebra_mcp_jd_plans WHERE applied_at IS NULL').get() as {
          n: number | bigint;
        }).n
      );
      if (count >= JD_STORED_PLANS_MAX) {
        statement(
          `DELETE FROM hebra_mcp_jd_plans WHERE plan_id IN (
             SELECT plan_id FROM hebra_mcp_jd_plans WHERE applied_at IS NULL ORDER BY created_at, rowid LIMIT ?)`
        ).run(count - JD_STORED_PLANS_MAX + 1);
      }
      statement(
        `INSERT INTO hebra_mcp_jd_plans (plan_id, library_id, privacy_sha256, created_at, plan, kind, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      ).run(
        record.planId,
        record.libraryId,
        record.privacySha256,
        record.createdAt,
        JSON.stringify(record.plan),
        record.kind
      );
    },
    get(planId) {
      const row = statement(
        `SELECT plan_id, library_id, privacy_sha256, created_at, plan, kind, applied_at
         FROM hebra_mcp_jd_plans WHERE plan_id = ?`
      ).get(planId) as Record<string, unknown> | undefined;
      if (!row || (row.kind !== 'new_id' && row.kind !== 'move')) return null;
      let plan: unknown;
      try {
        plan = JSON.parse(String(row.plan));
      } catch {
        return null;
      }
      return {
        planId: String(row.plan_id),
        libraryId: String(row.library_id),
        privacySha256: String(row.privacy_sha256),
        createdAt: Number(row.created_at),
        kind: row.kind,
        appliedAt: row.applied_at === null || row.applied_at === undefined ? null : Number(row.applied_at),
        plan
      };
    },
    markApplied(planId, now) {
      statement('UPDATE hebra_mcp_jd_plans SET applied_at = ? WHERE plan_id = ? AND applied_at IS NULL').run(now, planId);
    },
    delete(planId) {
      statement('DELETE FROM hebra_mcp_jd_plans WHERE plan_id = ? AND applied_at IS NULL').run(planId);
    }
  };
}
