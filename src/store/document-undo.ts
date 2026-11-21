/**
 * Deshacer un lote de un documento (`.ods`, `.odp`) con su inversa guardada (paquete B-M04,
 * estudio MCP de documentos, apartado 4). Es lo que llama `hebra_edit_*` con `undoOperationId`.
 *
 * Dos piezas:
 *
 * - `sqliteDocumentUndoStore`: la tabla propia de hebra-mcp (`hebra_mcp_document_undo`) que
 *   cumple `DocumentUndoSink` de `./document-ops.ts` y además sabe leer y consumir. Como el
 *   registro de operaciones y `./file-previous.ts`, vive en `library.sqlite`, no viaja por sync
 *   y la crea solo el escritor (`ensureDocumentUndoTable`). Topes: 7 días, 200 entradas (caen
 *   las más antiguas, nunca la recién guardada) y 1 MiB por entrada (una mayor no se guarda: el
 *   lote ya dijo `undoAvailable: false`).
 * - `undoDocumentOps`: un solo turno de la cola del almacén. Repite las guardas de privacidad y
 *   de espacio del segundo turno de `runDocumentOps` (documento vivo y visible, si no
 *   `not_found` sin escribir) y reutiliza el registro de operaciones: el mismo `operationId` da
 *   `already`, otra petición con él da `operation_id_reused`. Aplica la inversa guardada con
 *   `session.apply(inverse, 'agent')`, y en la MISMA transacción del `docAppend` consume la
 *   entrada y cierra el registro (como R18 en el lote).
 *
 * Exactitud: la guarda es un `expect` sobre lo que ESCRIBIÓ el lote, evaluado contra el estado de
 * ahora. Si otra persona (o un lote posterior) cambió lo mismo, sale `precondition_failed` y no se
 * escribe nada. Hay dos formas de llevarla, y aquí no se quita ni se reescribe ninguna:
 * - Formato con `captureUndo` y `prepareUndo` (hojas, B-M04b): el lote guarda los pasos (`steps`,
 *   datos planos con sus `expect`), y al deshacer `prepareUndo` los comprueba sobre el `Y.Doc` de
 *   la sesión de ahora y entrega las operaciones con su guarda. La guarda que ata `prepareUndo` a
 *   las operaciones es por identidad y no sobrevive a guardarlas, por eso no se guardan las
 *   operaciones entregadas sino los pasos.
 * - Formato sin ellos (contrato genérico): la inversa del recibo, tal cual, con el `expect` que
 *   lleve; sin él pisaría el cambio ajeno.
 * No se compara la revisión del documento a propósito: con ella no se podrían deshacer dos lotes
 * seguidos, de más nuevo a más antiguo, que tocaron celdas distintas.
 *
 * Sin entrada (no existe, caducó, ya se deshizo o es de otro documento) sale `not_found`: no hay
 * un código propio y no revela nada del documento.
 *
 * El cableado real (B-M04b): `node-port` crea la tabla y pone el registro y la sesión atada al
 * turno en `NoteWriteStore` (`documentUndo`, `openDocumentSession`); `documentTurnOf` arma con
 * ellos el turno de `runDocumentOps` y de `undoDocumentOps`.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { DocFormatAdapter } from '../../vendor/hebra/src/lib/documents/contract';
import { UNDO_ENTRY_MAX_BYTES, UNDO_MAX_AGE_DAYS, UNDO_MAX_ENTRIES } from './document-limits';
import {
  documentFingerprint,
  type DocumentOpsResult,
  type DocumentOpsTurn,
  type DocumentUndoEntry,
  type DocumentUndoSink
} from './document-ops';
import { guardDocumentWrite } from './document-privacy';
import type { PrivacyConfig } from '../privacy/config';
import type { NoteWriteStore } from './writes';
import { undoCapable, type DocumentError, type EditIn, type WriteOut } from './document-types';
import { OPERATION_ID_MAX_LENGTH, type OperationRecord } from './operations';

const DAY_MS = 24 * 60 * 60 * 1000;
const UNDO_TTL_MS = UNDO_MAX_AGE_DAYS * DAY_MS;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS hebra_mcp_document_undo (
  operation_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  inverse TEXT NOT NULL,
  inverse_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  steps TEXT
) WITHOUT ROWID`;

/** Topes del almacén; los tests los bajan para medir el recorte. */
export interface DocumentUndoLimits {
  maxEntries: number;
  maxEntryBytes: number;
}

/** El registro de deshacer con lectura: lo que escribe `runDocumentOps` y lo que lee el deshacer. */
export interface DocumentUndoStore extends DocumentUndoSink {
  /** La entrada de `operationId`, si existe y no ha caducado (7 días). */
  lookup(operationId: string, now: number): DocumentUndoEntry | null;
  /** La borra: un lote se deshace una sola vez. */
  consume(operationId: string): void;
  /** Borra lo caducado. */
  purgeExpired(now: number): void;
}

/** Crea la tabla si falta. Solo en la conexión de lectura-escritura del escritor. */
export function ensureDocumentUndoTable(db: DatabaseSync): void {
  db.exec(TABLE_SQL);
  // Una tabla de antes de B-M04b no tiene `steps`: se añade (las entradas viejas siguen con su inversa).
  const columns = db.prepare('PRAGMA table_info(hebra_mcp_document_undo)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'steps')) {
    db.exec('ALTER TABLE hebra_mcp_document_undo ADD COLUMN steps TEXT');
  }
}

/**
 * El registro sobre la SQLite del turno. `record` no lleva `now`: usa el `createdAt` de la
 * entrada, que es el reloj del lote.
 */
export function sqliteDocumentUndoStore(
  db: DatabaseSync,
  limits: DocumentUndoLimits = { maxEntries: UNDO_MAX_ENTRIES, maxEntryBytes: UNDO_ENTRY_MAX_BYTES }
): DocumentUndoStore {
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
    record(entry) {
      const inverse = JSON.stringify(entry.inverse);
      const steps = entry.steps === undefined ? null : JSON.stringify(entry.steps);
      const bytes = Buffer.byteLength(inverse, 'utf8') + (steps === null ? 0 : Buffer.byteLength(steps, 'utf8'));
      // Una inversa que no cabe no se guarda: el lote ya respondió `undoAvailable: false`.
      if (bytes > limits.maxEntryBytes) return;
      statement(
        `INSERT OR REPLACE INTO hebra_mcp_document_undo
           (operation_id, document_id, revision, inverse, inverse_bytes, created_at, steps)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(entry.operationId, entry.documentId, entry.revision, inverse, bytes, entry.createdAt, steps);
      // La recién guardada se queda siempre; de las demás, las más recientes hasta el tope.
      const rows = statement(
        `SELECT operation_id FROM hebra_mcp_document_undo
         WHERE operation_id <> ?
         ORDER BY created_at DESC, operation_id DESC`
      ).all(entry.operationId) as Array<{ operation_id: string }>;
      rows.forEach((row, index) => {
        if (index + 1 >= limits.maxEntries) {
          statement('DELETE FROM hebra_mcp_document_undo WHERE operation_id = ?').run(row.operation_id);
        }
      });
    },
    lookup(operationId, now) {
      const row = statement(
        `SELECT operation_id, document_id, revision, inverse, created_at, steps
         FROM hebra_mcp_document_undo WHERE operation_id = ? AND created_at >= ?`
      ).get(operationId, now - UNDO_TTL_MS) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        operationId: String(row.operation_id),
        documentId: String(row.document_id),
        revision: String(row.revision),
        inverse: JSON.parse(String(row.inverse)) as unknown[],
        ...(typeof row.steps === 'string' ? { steps: JSON.parse(row.steps) as unknown[] } : {}),
        createdAt: Number(row.created_at)
      };
    },
    consume(operationId) {
      statement('DELETE FROM hebra_mcp_document_undo WHERE operation_id = ?').run(operationId);
    },
    purgeExpired(now) {
      statement('DELETE FROM hebra_mcp_document_undo WHERE created_at < ?').run(now - UNDO_TTL_MS);
    }
  };
}

/** El turno del deshacer: el de las escrituras, con el registro de deshacer que además lee. */
export interface DocumentUndoTurn extends Omit<DocumentOpsTurn, 'undo'> {
  undo: DocumentUndoStore;
}

/**
 * El turno de un documento sobre el almacén de `writeExclusive` (B-M04b): el registro de
 * operaciones, el de deshacer y la sesión atada al turno son los del propio `store`, es decir,
 * los de la conexión del turno. Sirve para escribir (`runDocumentOps`) y para deshacer.
 */
export function documentTurnOf(store: NoteWriteStore, privacy: PrivacyConfig): DocumentUndoTurn {
  return {
    store,
    privacy,
    operations: store.operations,
    undo: store.documentUndo,
    openSession: (fileId, adapter, signal) => store.openDocumentSession(fileId, adapter, signal)
  };
}

/** Lo que `undoDocumentOps` necesita de quien cablea. */
export interface DocumentUndoOpsStore {
  /** Un turno de la cola del almacén (`NodeLibraryPort.writeExclusive`). */
  turn<T>(operation: (turn: DocumentUndoTurn) => Promise<T>): Promise<T>;
  now(): number;
  /** La ronda de sync, fuera del turno. Sin ella, `sync: 'pending'`. No debe lanzar. */
  afterCommit?(): Promise<{ sync: string; syncError?: string }>;
}

export interface UndoDocumentOptions {
  signal?: AbortSignal;
}

/** Entrada de un deshacer (el otro caso de `EditIn` es un lote de operaciones, de B-M03). */
export type DocumentUndoInput = Extract<EditIn<unknown>, { undoOperationId: string }>;

function refuse(error: DocumentError): DocumentOpsResult {
  return { ok: false, error };
}

function invalid(path: string, reason: string, expected?: string): DocumentOpsResult {
  return refuse({
    code: 'batch_invalid',
    issues: [{ opIndex: 0, path, reason, ...(expected ? { expected } : {}) }]
  });
}

/** Huella de la petición: la acción y el formato van en ella, así que otro uso del `operationId` es `operation_id_reused`. */
function fingerprintOf(input: DocumentUndoInput, format: string): string {
  return documentFingerprint([
    'documentUndo',
    format,
    input.id,
    input.undoOperationId,
    input.expectedRevision ?? null,
    input.expectedLayout ?? null
  ]);
}

function isWriteOut(value: unknown): value is WriteOut {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.revision === 'string';
}

/** El resultado de un reintento: lo guardado, marcado como repetido. */
function replayOf(record: OperationRecord): WriteOut | null {
  if (record.state !== 'done' || !isWriteOut(record.result)) return null;
  const { replayed: _replayed, syncError: _syncError, ...stored } = record.result;
  return { ...stored, outcome: 'already', replayed: true, sync: 'pending' };
}

function validate(input: DocumentUndoInput): DocumentOpsResult | null {
  if (typeof input.id !== 'string' || input.id.length === 0) return invalid('id', 'id vacio');
  for (const field of ['operationId', 'undoOperationId'] as const) {
    const value = input[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > OPERATION_ID_MAX_LENGTH) {
      return invalid(field, `${field} vacio o demasiado largo`);
    }
  }
  if (input.operationId === input.undoOperationId) {
    return invalid('undoOperationId', 'un deshacer no puede usar el operationId del lote que deshace');
  }
  if (input.dryRun === true) return invalid('dryRun', 'deshacer no admite dryRun');
  return null;
}

/**
 * Deshace el lote `undoOperationId` del documento `id`. Ver la cabecera del fichero.
 * Los rechazos del almacén (`not_found`, `space_access_denied`) se lanzan, igual que en
 * `runDocumentOps`; los recuperables salen como `{ ok: false, error }`.
 */
export async function undoDocumentOps<Model, Op>(
  store: DocumentUndoOpsStore,
  input: DocumentUndoInput,
  adapter: DocFormatAdapter<Model, Op>,
  options: UndoDocumentOptions = {}
): Promise<DocumentOpsResult> {
  const refused = validate(input);
  if (refused) return refused;
  const signal = options.signal ?? new AbortController().signal;
  const fingerprint = fingerprintOf(input, adapter.format);

  const applied = await store.turn((turn) => undoIn(turn, store, input, adapter, fingerprint, signal));
  // Sin cambios (`already`) no se escribió nada: ni ronda ni punto de control.
  if (!applied.ok || applied.out.replayed || applied.out.outcome === 'already') return applied;

  const sync = (await store.afterCommit?.().catch(() => undefined)) ?? { sync: 'pending' };
  const out: WriteOut = { ...applied.out, sync: sync.sync };
  if (sync.syncError !== undefined) out.syncError = sync.syncError;
  return { ok: true, out };
}

async function undoIn<Model, Op>(
  turn: DocumentUndoTurn,
  store: DocumentUndoOpsStore,
  input: DocumentUndoInput,
  adapter: DocFormatAdapter<Model, Op>,
  fingerprint: string,
  signal: AbortSignal
): Promise<DocumentOpsResult> {
  const now = store.now();
  turn.operations.purgeExpired(now);
  turn.undo.purgeExpired(now);
  // Lanza `not_found` igual para oculto, inexistente, lápida y papelera; antes de leer o escribir nada.
  const document = guardDocumentWrite(turn, input.id);

  const record = turn.operations.lookup(input.operationId);
  if (record) {
    if (record.fingerprint !== fingerprint) return refuse({ code: 'operation_id_reused' });
    const replay = replayOf(record);
    if (replay) return { ok: true, out: replay };
  }

  const entry = turn.undo.lookup(input.undoOperationId, now);
  if (!entry || entry.documentId !== input.id) return refuse({ code: 'not_found' });

  if (!record) {
    turn.operations.begin({
      operationId: input.operationId,
      fingerprint,
      noteId: input.id,
      targetBodySha256: SHA256_HEX.test(document.sha256) ? document.sha256 : '',
      now
    });
  }

  const session = await turn.openSession(input.id, adapter, signal);
  try {
    const previousRevision = session.revision();
    if (input.expectedRevision !== undefined && input.expectedRevision !== previousRevision) {
      return refuse({ code: 'precondition_failed', opIndex: 0, target: 'expectedRevision' });
    }
    if (input.expectedLayout !== undefined && input.expectedLayout !== session.layoutRevision()) {
      return refuse({ code: 'precondition_failed', opIndex: 0, target: 'expectedLayout' });
    }

    // Con pasos guardados, la guarda se reconstruye sobre el `Y.Doc` de ahora: `prepareUndo`
    // comprueba todos los `expect` antes de devolver nada y ata la guarda a las operaciones que
    // entrega (por identidad, así que se pasan tal cual a `apply`). Sin pasos, la inversa genérica.
    let inverse = entry.inverse as readonly Op[];
    const undoer = entry.steps !== undefined ? undoCapable<Op>(adapter) : null;
    if (entry.steps !== undefined) {
      if (!undoer || !session.doc) return refuse({ code: 'op_invalid' });
      try {
        inverse = undoer.prepareUndo(session.doc, entry.steps);
      } catch (error) {
        const code = (error as { name?: string; code?: string } | null)?.name === 'DocOpError'
          ? (error as { code: string }).code
          : null;
        if (code === 'precondition_failed') {
          return refuse({ code: 'precondition_failed', opIndex: 0, target: 'inverse[0]' });
        }
        if (code === 'op_invalid') return refuse({ code: 'op_invalid' });
        throw error;
      }
    }

    const withLayout = adapter.format === 'ods';
    const done: { out: WriteOut | null } = { out: null };
    const result = await session.apply(inverse, 'agent', {
      // Determinista: el reintento de un deshacer que no llegó a confirmarse da los mismos ids.
      seed: input.operationId,
      project: false,
      inTx: (receipt) => {
        const out: WriteOut = {
          id: input.id,
          outcome: 'saved',
          revision: receipt.revision,
          previousRevision,
          sync: 'pending',
          undoAvailable: false
        };
        // Dentro de la transacción del append: o se confirma todo o nada (R18).
        turn.undo.consume(input.undoOperationId);
        turn.operations.finish(input.operationId, out);
        done.out = out;
      }
    });

    if (!result.ok) {
      switch (result.code) {
        case 'precondition_failed':
          return refuse({
            code: 'precondition_failed',
            opIndex: result.opIndex ?? 0,
            target: `inverse[${result.opIndex ?? 0}]`
          });
        case 'generation_changed':
          return refuse({ code: 'generation_changed' });
        case 'too_large':
          return refuse({ code: 'too_large' });
        default:
          return refuse({ code: 'op_invalid' });
      }
    }

    // Una inversa que no cambia nada no escribe update y `inTx` no corre: se registra aquí,
    // como `already` (D28, protección 11).
    const registered = done.out;
    const base: WriteOut = registered ?? {
      id: input.id,
      outcome: 'already',
      revision: result.revision,
      previousRevision,
      sync: 'pending',
      undoAvailable: false
    };
    const out: WriteOut = {
      ...base,
      revision: result.revision,
      ...(withLayout ? { layoutRevision: result.layoutRevision } : {})
    };
    if (registered === null) {
      turn.undo.consume(input.undoOperationId);
      turn.operations.finish(input.operationId, out);
    } else {
      // La revisión de disposición se anota también en el registro. Si falla, el deshacer ya
      // está confirmado y el reintento devuelve lo anterior.
      try {
        turn.operations.finish(input.operationId, out);
      } catch {
        // nada: ya quedó registrado dentro de la transacción.
      }
    }
    return { ok: true, out };
  } finally {
    await session.close().catch(() => undefined);
  }
}
