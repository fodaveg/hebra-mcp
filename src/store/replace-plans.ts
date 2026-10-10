/**
 * Planes de `hebra_replace_in_notes` (D14, SPEC.md §5): lo simulado, lo aplicado y lo
 * necesario para deshacerlo, en DOS tablas propias de hebra-mcp en la MISMA SQLite de la
 * biblioteca, como el registro de operaciones (`./operations.ts`): Hebra no las conoce, no
 * viajan por sync y no las toca `libraryReset`. Las crea el escritor al abrir en
 * lectura-escritura; un lector nunca las lee ni las escribe (todo el lote pasa por el
 * escritor, también desde un lector por `writer.sock`). Viven en disco, no en memoria:
 * un plan sobrevive a un reinicio y a un relevo del escritor, que es lo que hace repetible
 * un `apply` cortado (AC5).
 *
 * - `hebra_mcp_replace_plans`: una fila por plan. A qué biblioteca y a qué configuración de
 *   privados pertenece (`privacyFingerprint`), cuándo se simuló, el `operationId` de la
 *   aplicación (un plan se aplica con UN `operationId`), su estado (`simulated`,
 *   `applying`, `applied`, `undoing`, `undone` y `expired`) y el tamaño de sus cuerpos
 *   resultantes (para el tope de lo guardado sin aplicar).
 * - `hebra_mcp_replace_plan_notes`: una fila por nota del plan, en orden (`position`): el
 *   SHA-256 del cuerpo base y del resultante, el cuerpo resultante ENTERO (aplicar escribe
 *   exactamente lo simulado, sin volver a ejecutar la expresión), la vista previa, y lo que
 *   se va sabiendo: cuándo se intentó escribir por primera vez, el cuerpo base (guardado
 *   ANTES de escribir la nota: AC6), el resultado de aplicar con su prueba y si la copia de
 *   conflicto es de ESTE plan, y el de deshacer.
 *
 * Caducidad (`purgeExpired`: al empezar cada operación de plan, al pasar a escritor y en
 * cada `checkWriter`, un turno corto): un plan sin aplicar se borra a las 24 h
 * (`PLAN_UNAPPLIED_KEEP_MS`; se puede aplicar solo la primera hora, `PLAN_APPLY_TTL_MS`);
 * uno aplicado pierde sus cuerpos a los 7 días de empezar a aplicarlo
 * (`PLAN_UNDO_RETENTION_MS`, lo que dura su vuelta atrás) y queda como lápida `expired`
 * (sin cuerpos ni notas: solo para responder `plan_expired`), que se borra 30 días después
 * (`PLAN_TOMBSTONE_KEEP_MS`). Tope de lo guardado sin aplicar (`STORED_PLANS_MAX`,
 * `STORED_PLAN_CHARS_MAX`): al guardar uno nuevo que lo pasaría, caen los más antiguos SIN
 * aplicar, nunca uno aplicado o a medias (hacen falta para deshacer). `unpair` borra el
 * directorio de datos y, con él, todo esto.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';

/** Un plan simulado se puede aplicar durante una hora (y un `apply` cortado se puede
 *  reanudar durante una hora desde que empezó). */
export const PLAN_APPLY_TTL_MS = 60 * 60 * 1000;
/** Un plan que no se aplicó se conserva un día (para responder `plan_expired` y no
 *  `plan_not_found`), y después se borra. */
export const PLAN_UNAPPLIED_KEEP_MS = 24 * 60 * 60 * 1000;
/** Lo que dura la vuelta atrás de un plan aplicado: sus cuerpos base se conservan 7 días
 *  desde que se empezó a aplicar (como las versiones anteriores de Hebra que no son de las
 *  5 más recientes). */
export const PLAN_UNDO_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** La lápida de un plan aplicado y caducado (sin cuerpos) dura 30 días más. */
export const PLAN_TOMBSTONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Tope de planes guardados SIN aplicar, y de la suma de sus cuerpos resultantes. */
export const STORED_PLANS_MAX = 20;
export const STORED_PLAN_CHARS_MAX = 50_000_000;

const TABLES_SQL = `CREATE TABLE IF NOT EXISTS hebra_mcp_replace_plans (
  plan_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  privacy_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  apply_operation_id TEXT,
  applied_at INTEGER,
  state TEXT NOT NULL,
  matches INTEGER NOT NULL,
  result_chars INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hebra_mcp_replace_plan_notes (
  plan_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  note_id TEXT NOT NULL,
  base_sha256 TEXT NOT NULL,
  result_sha256 TEXT NOT NULL,
  result_body TEXT NOT NULL,
  matches INTEGER NOT NULL,
  preview TEXT NOT NULL,
  base_body TEXT,
  outcome TEXT,
  copy_id TEXT,
  proof TEXT,
  undo_outcome TEXT,
  undo_copy TEXT,
  undo_proof TEXT,
  attempt_at INTEGER,
  copy_owned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, position)
)`;

/** Columnas añadidas después de la primera versión de las tablas (revisión de D14, 10 oct
 *  2026): una base que ya las tenía creadas las gana aquí. */
const ADDED_COLUMNS: ReadonlyArray<[table: string, column: string, definition: string]> = [
  ['hebra_mcp_replace_plans', 'result_chars', 'INTEGER NOT NULL DEFAULT 0'],
  ['hebra_mcp_replace_plan_notes', 'attempt_at', 'INTEGER'],
  ['hebra_mcp_replace_plan_notes', 'copy_owned', 'INTEGER NOT NULL DEFAULT 0']
];

export type PlanState = 'simulated' | 'applying' | 'applied' | 'undoing' | 'undone' | 'expired';

/** Cómo quedó una nota al aplicar. `unavailable`: borrada, en la papelera u oculta (o el
 *  resultado la dejaría con una etiqueta privada); NUNCA sale en el informe. */
export type ApplyOutcome = 'applied' | 'already' | 'conflict_copy' | 'locked' | 'unavailable';

/** Cómo quedó una nota al deshacer: `restored` (vuelve a la base), `already` (ya estaba en
 *  la base), `changed` (cambió después del lote: no se toca), `locked` o `unavailable`
 *  (no sale en el informe). */
export type UndoOutcome = 'restored' | 'already' | 'changed' | 'locked' | 'unavailable';

/** Lo que pasó con la copia de conflicto de una nota al deshacer: `trashed`, `already` (ya
 *  estaba en la papelera) o `changed` (no se toca: cambió, o no la creó este plan). */
export type UndoCopyOutcome = 'trashed' | 'already' | 'changed';

/** Prueba de lo guardado, leída de la nota en el mismo turno en que se escribió. */
export interface NoteProof {
  localSeq: number;
  bodySha256: string;
  totalChars: number;
}

export interface PlanRecord {
  planId: string;
  libraryId: string;
  privacySha256: string;
  createdAt: number;
  applyOperationId: string | null;
  appliedAt: number | null;
  state: PlanState;
  matches: number;
}

/** Una nota del plan sin sus cuerpos (que solo lee quien escribe, `bodies`). */
export interface PlanNoteRecord {
  position: number;
  noteId: string;
  baseSha256: string;
  resultSha256: string;
  matches: number;
  /** JSON de los cambios que enseña la simulación. */
  preview: string;
  hasBase: boolean;
  /** Cuándo se intentó escribir esta nota por primera vez (epoch ms), o `null`. */
  attemptAt: number | null;
  outcome: ApplyOutcome | null;
  copyId: string | null;
  /** Si la copia de conflicto la creó ESTE plan (solo esas se deshacen). */
  copyOwned: boolean;
  proof: NoteProof | null;
  undoOutcome: UndoOutcome | null;
  undoCopy: UndoCopyOutcome | null;
  undoProof: NoteProof | null;
}

export interface NewPlanNote {
  noteId: string;
  baseSha256: string;
  resultSha256: string;
  resultBody: string;
  matches: number;
  preview: string;
}

/** Un plan sin aplicar, para el tope de lo guardado. */
export interface UnappliedPlan {
  planId: string;
  createdAt: number;
  resultChars: number;
}

export interface ReplacePlanStore {
  /** Borra lo caducado y deja la lápida de lo aplicado (ver la cabecera). */
  purgeExpired(now: number): void;
  /** Guarda un plan entero, en una transacción: o entra todo, o nada. */
  insert(plan: Omit<PlanRecord, 'applyOperationId' | 'appliedAt' | 'state'>, notes: readonly NewPlanNote[]): void;
  /** Los planes sin aplicar, el más antiguo primero. */
  unapplied(): UnappliedPlan[];
  /** Borra un plan sin aplicar (y sus notas). Uno aplicado o a medias no se toca. */
  deleteUnapplied(planId: string): void;
  plan(planId: string): PlanRecord | null;
  notes(planId: string): PlanNoteRecord[];
  /** Los dos cuerpos de una nota del plan (el base, si ya se guardó). */
  bodies(planId: string, position: number): { result: string; base: string | null } | null;
  /** Empieza la aplicación: el `operationId` queda ligado al plan. */
  startApply(planId: string, operationId: string, now: number): void;
  setState(planId: string, state: PlanState): void;
  /** Anota el primer intento de escribir una nota (si no lo tenía). */
  markAttempt(planId: string, position: number, now: number): void;
  /** Guarda el cuerpo base de una nota ANTES de escribirla (AC6). */
  saveBase(planId: string, position: number, body: string): void;
  recordApply(
    planId: string,
    position: number,
    outcome: ApplyOutcome,
    copyId: string | null,
    copyOwned: boolean,
    proof: NoteProof | null
  ): void;
  /** ¿Es esa copia de conflicto de OTRO plan? */
  copyOwnedElsewhere(copyId: string, planId: string): boolean;
  /** Empieza una vuelta atrás nueva: olvida el resultado de la anterior. */
  resetUndo(planId: string): void;
  recordUndo(
    planId: string,
    position: number,
    outcome: UndoOutcome | null,
    copy: UndoCopyOutcome | null,
    proof: NoteProof | null
  ): void;
}

/** Crea las dos tablas si faltan (y las columnas añadidas después). Solo en la conexión de
 *  lectura-escritura del escritor. */
export function ensureReplacePlanTables(db: DatabaseSync): void {
  db.exec(TABLES_SQL);
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

const PLAN_STATES: ReadonlySet<string> = new Set<PlanState>([
  'simulated',
  'applying',
  'applied',
  'undoing',
  'undone',
  'expired'
]);
const APPLY_OUTCOMES: ReadonlySet<string> = new Set<ApplyOutcome>([
  'applied',
  'already',
  'conflict_copy',
  'locked',
  'unavailable'
]);
const UNDO_OUTCOMES: ReadonlySet<string> = new Set<UndoOutcome>([
  'restored',
  'already',
  'changed',
  'locked',
  'unavailable'
]);
const UNDO_COPY_OUTCOMES: ReadonlySet<string> = new Set<UndoCopyOutcome>(['trashed', 'already', 'changed']);

function oneOf<T extends string>(value: unknown, allowed: ReadonlySet<string>): T | null {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : null;
}

function proofOf(value: unknown): NoteProof | null {
  if (typeof value !== 'string') return null;
  const parsed = JSON.parse(value) as Partial<NoteProof>;
  if (
    typeof parsed.localSeq !== 'number' ||
    typeof parsed.bodySha256 !== 'string' ||
    typeof parsed.totalChars !== 'number'
  ) {
    return null;
  }
  return { localSeq: parsed.localSeq, bodySha256: parsed.bodySha256, totalChars: parsed.totalChars };
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function sqliteReplacePlanStore(db: DatabaseSync): ReplacePlanStore {
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
      statement('DELETE FROM hebra_mcp_replace_plans WHERE applied_at IS NULL AND created_at < ?').run(
        now - PLAN_UNAPPLIED_KEEP_MS
      );
      statement(
        `UPDATE hebra_mcp_replace_plans SET state = 'expired'
         WHERE applied_at IS NOT NULL AND applied_at < ? AND state <> 'expired'`
      ).run(now - PLAN_UNDO_RETENTION_MS);
      statement(
        `DELETE FROM hebra_mcp_replace_plans WHERE state = 'expired' AND applied_at < ?`
      ).run(now - PLAN_UNDO_RETENTION_MS - PLAN_TOMBSTONE_KEEP_MS);
      statement(
        `DELETE FROM hebra_mcp_replace_plan_notes
         WHERE plan_id NOT IN (SELECT plan_id FROM hebra_mcp_replace_plans WHERE state <> 'expired')`
      ).run();
    },
    insert(plan, notes) {
      db.exec('BEGIN');
      try {
        statement(
          `INSERT INTO hebra_mcp_replace_plans
             (plan_id, library_id, privacy_sha256, created_at, apply_operation_id, applied_at, state, matches,
              result_chars)
           VALUES (?, ?, ?, ?, NULL, NULL, 'simulated', ?, ?)`
        ).run(
          plan.planId,
          plan.libraryId,
          plan.privacySha256,
          plan.createdAt,
          plan.matches,
          notes.reduce((sum, note) => sum + note.resultBody.length, 0)
        );
        const insertNote = statement(
          `INSERT INTO hebra_mcp_replace_plan_notes
             (plan_id, position, note_id, base_sha256, result_sha256, result_body, matches, preview)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        notes.forEach((note, position) => {
          insertNote.run(
            plan.planId,
            position,
            note.noteId,
            note.baseSha256,
            note.resultSha256,
            note.resultBody,
            note.matches,
            note.preview
          );
        });
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Sin transacción abierta: se propaga el error de verdad.
        }
        throw error;
      }
    },
    unapplied() {
      const rows = statement(
        `SELECT plan_id, created_at, result_chars FROM hebra_mcp_replace_plans
         WHERE state = 'simulated' ORDER BY created_at, rowid`
      ).all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        planId: String(row.plan_id),
        createdAt: Number(row.created_at),
        resultChars: Number(row.result_chars)
      }));
    },
    deleteUnapplied(planId) {
      statement(`DELETE FROM hebra_mcp_replace_plans WHERE plan_id = ? AND state = 'simulated'`).run(planId);
      statement(
        `DELETE FROM hebra_mcp_replace_plan_notes
         WHERE plan_id = ? AND plan_id NOT IN (SELECT plan_id FROM hebra_mcp_replace_plans)`
      ).run(planId);
    },
    plan(planId) {
      const row = statement(
        `SELECT plan_id, library_id, privacy_sha256, created_at, apply_operation_id, applied_at, state, matches
         FROM hebra_mcp_replace_plans WHERE plan_id = ?`
      ).get(planId) as Record<string, unknown> | undefined;
      if (!row) return null;
      const state = oneOf<PlanState>(row.state, PLAN_STATES);
      if (!state) return null;
      return {
        planId: String(row.plan_id),
        libraryId: String(row.library_id),
        privacySha256: String(row.privacy_sha256),
        createdAt: Number(row.created_at),
        applyOperationId: typeof row.apply_operation_id === 'string' ? row.apply_operation_id : null,
        appliedAt: numberOrNull(row.applied_at),
        state,
        matches: Number(row.matches)
      };
    },
    notes(planId) {
      const rows = statement(
        `SELECT position, note_id, base_sha256, result_sha256, matches, preview,
                base_body IS NOT NULL AS has_base, attempt_at, outcome, copy_id, copy_owned, proof,
                undo_outcome, undo_copy, undo_proof
         FROM hebra_mcp_replace_plan_notes WHERE plan_id = ? ORDER BY position`
      ).all(planId) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        position: Number(row.position),
        noteId: String(row.note_id),
        baseSha256: String(row.base_sha256),
        resultSha256: String(row.result_sha256),
        matches: Number(row.matches),
        preview: String(row.preview),
        hasBase: Number(row.has_base) !== 0,
        attemptAt: numberOrNull(row.attempt_at),
        outcome: oneOf<ApplyOutcome>(row.outcome, APPLY_OUTCOMES),
        copyId: typeof row.copy_id === 'string' ? row.copy_id : null,
        copyOwned: Number(row.copy_owned) !== 0,
        proof: proofOf(row.proof),
        undoOutcome: oneOf<UndoOutcome>(row.undo_outcome, UNDO_OUTCOMES),
        undoCopy: oneOf<UndoCopyOutcome>(row.undo_copy, UNDO_COPY_OUTCOMES),
        undoProof: proofOf(row.undo_proof)
      }));
    },
    bodies(planId, position) {
      const row = statement(
        `SELECT result_body, base_body FROM hebra_mcp_replace_plan_notes WHERE plan_id = ? AND position = ?`
      ).get(planId, position) as { result_body: string; base_body: string | null } | undefined;
      if (!row) return null;
      return { result: String(row.result_body), base: typeof row.base_body === 'string' ? row.base_body : null };
    },
    startApply(planId, operationId, now) {
      statement(
        `UPDATE hebra_mcp_replace_plans SET apply_operation_id = ?, applied_at = ?, state = 'applying'
         WHERE plan_id = ?`
      ).run(operationId, now, planId);
    },
    setState(planId, state) {
      statement('UPDATE hebra_mcp_replace_plans SET state = ? WHERE plan_id = ?').run(state, planId);
    },
    markAttempt(planId, position, now) {
      statement(
        `UPDATE hebra_mcp_replace_plan_notes SET attempt_at = ?
         WHERE plan_id = ? AND position = ? AND attempt_at IS NULL`
      ).run(now, planId, position);
    },
    saveBase(planId, position, body) {
      statement(
        `UPDATE hebra_mcp_replace_plan_notes SET base_body = ? WHERE plan_id = ? AND position = ?`
      ).run(body, planId, position);
    },
    recordApply(planId, position, outcome, copyId, copyOwned, proof) {
      statement(
        `UPDATE hebra_mcp_replace_plan_notes SET outcome = ?, copy_id = ?, copy_owned = ?, proof = ?
         WHERE plan_id = ? AND position = ?`
      ).run(outcome, copyId, copyOwned ? 1 : 0, proof ? JSON.stringify(proof) : null, planId, position);
    },
    copyOwnedElsewhere(copyId, planId) {
      return (
        statement(
          `SELECT 1 AS found FROM hebra_mcp_replace_plan_notes
           WHERE copy_id = ? AND copy_owned = 1 AND plan_id <> ? LIMIT 1`
        ).get(copyId, planId) !== undefined
      );
    },
    resetUndo(planId) {
      statement(
        `UPDATE hebra_mcp_replace_plan_notes SET undo_outcome = NULL, undo_copy = NULL, undo_proof = NULL
         WHERE plan_id = ?`
      ).run(planId);
    },
    recordUndo(planId, position, outcome, copy, proof) {
      statement(
        `UPDATE hebra_mcp_replace_plan_notes SET undo_outcome = ?, undo_copy = ?, undo_proof = ?
         WHERE plan_id = ? AND position = ?`
      ).run(outcome, copy, proof ? JSON.stringify(proof) : null, planId, position);
    }
  };
}
