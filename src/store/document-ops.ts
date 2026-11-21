/**
 * Escritura por lotes de un documento (`.ods`, `.odp`) en tres fases (paquete B-M03, estudio
 * MCP de documentos, apartado 4). Es lo que llaman las herramientas `hebra_edit_*`:
 *
 * 1. Turno corto de la cola del almacén: el documento es un fichero vivo y visible (D10),
 *    las imágenes del lote también, y el registro de operaciones (`./operations.ts`) decide si
 *    es un reintento (`already`), un `operationId` ajeno (`operation_id_reused`) o una
 *    petición nueva (`begin`).
 * 2. Fuera del turno, en el hilo (`compute`): proyectar, validar y preparar el informe. Con
 *    `dryRun` se termina aquí (`validated`), sin tocar el registro.
 * 3. Otro turno: se repite TODO lo del primero (la privacidad y el acceso pueden haber
 *    cambiado durante el cálculo, que dura hasta 15 s) y se llama a `session.apply(ops, 'agent')`,
 *    que vuelve a evaluar cada `expect` sobre el estado de ahora. En la MISMA transacción que el
 *    `docAppend` (el `inTx` de `apply`) se guarda la inversa para deshacer y `log.finish`: o se
 *    confirma todo o nada, así que un corte entre el append y la respuesta no deja un lote
 *    aplicado y sin registrar, y el reintento no lo repite (R18).
 * 4. Fuera del turno: la ronda de sync, que solo informa (`sync`, `syncError`).
 *
 * Qué pone cada capa: el `DocumentOpsStore` lo aporta quien cablea (el puerto del almacén y el
 * hilo de `./document-jobs.ts`); la sesión de la fase 3 la abre el propio turno
 * (`turn.openSession`) para que su `docAppendWith` escriba DENTRO del turno en curso: una sesión
 * que entrara por la cola (`sessionPortOf`) se esperaría a sí misma.
 *
 * Los errores recuperables salen como `{ ok: false, error }` (`DocumentError`). Los rechazos del
 * almacén (`not_found`, `space_access_denied`) y los del hilo (`DocumentJobError`) se lanzan:
 * los traduce la capa de herramientas, igual que en el resto de escrituras.
 */
import { createHash } from 'node:crypto';
import { assertAddressRule, DocumentAddressError } from './document-address';
import { UNDO_ENTRY_MAX_BYTES, UNDO_MAX_AGE_DAYS } from './document-limits';
import { guardAsset, guardDocumentWrite, type DocumentGuardTurn } from './document-privacy';
import type {
  BatchIssue,
  DocSessionLike,
  DocumentAsset,
  DocumentError,
  EditIn,
  GuardedOp,
  WriteOut
} from './document-types';
import type { DocFormatAdapter } from '../../vendor/hebra/src/lib/documents/contract';
import { OPERATION_ID_MAX_LENGTH, type OperationRecord, type OperationStore } from './operations';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Lo que se guarda para deshacer un lote; lo lee `undoDocumentOps` (B-M04). */
export interface DocumentUndoEntry<Op = unknown> {
  operationId: string;
  documentId: string;
  /** Las inversas, en el orden en que hay que aplicarlas. */
  inverse: readonly Op[];
  /** Revisión que dejó el lote: la inversa solo vale mientras siga siendo la de ahora. */
  revision: string;
  createdAt: number;
}

/** Registro de deshacer. Síncrono: se llama dentro de la transacción del `docAppend`. */
export interface DocumentUndoSink {
  record(entry: DocumentUndoEntry): void;
}

/** El turno de la cola del almacén, con lo que las fases 1 y 3 necesitan. */
export interface DocumentOpsTurn extends DocumentGuardTurn {
  /** Registro de idempotencia (`hebra_mcp_operations`) de la misma conexión del turno. */
  operations: OperationStore;
  /** Dónde guardar la inversa. Sin él, el lote no se puede deshacer. */
  undo?: DocumentUndoSink;
  /**
   * Abre la sesión del documento atada a ESTE turno: su `docAppendWith` escribe en la conexión
   * del turno, no por la cola.
   */
  openSession<Model, Op>(
    fileId: string,
    adapter: DocFormatAdapter<Model, Op>,
    signal: AbortSignal
  ): Promise<DocSessionLike<Model, Op>>;
}

/** El trabajo del hilo (fase 2). */
export interface DocumentComputeJob {
  id: string;
  /** SHA-256 del fichero tal como lo vio la fase 1. */
  sha256: string;
  ops: readonly unknown[];
  assets: readonly DocumentAsset[];
  expectedRevision?: string;
  expectedLayout?: string;
}

/** Lo que devuelve el hilo: el estado que vio y el informe, o un error recuperable. */
export type DocumentComputeResult =
  | { ok: true; revision: string; layoutRevision?: string; report?: unknown }
  | { ok: false; error: DocumentError };

/** Lo que `runDocumentOps` necesita de quien cablea. */
export interface DocumentOpsStore {
  /** Un turno de la cola del almacén (`NodeLibraryPort.writeExclusive`). Lo pide dos veces. */
  turn<T>(operation: (turn: DocumentOpsTurn) => Promise<T>): Promise<T>;
  /** Fase 2: corre en el hilo, fuera de todo turno (`runDocumentJob('edit', ...)`). */
  compute(job: DocumentComputeJob, signal: AbortSignal): Promise<DocumentComputeResult>;
  now(): number;
  /** Fase 4: la ronda de sync. Sin ella, `sync: 'pending'`. No debe lanzar. */
  afterCommit?(): Promise<{ sync: string; syncError?: string }>;
}

export interface RunDocumentOpsOptions<Op> {
  /** Si la operación direcciona por A1 o índice (regla de `./document-address.ts`). Sin ella no se aplica. */
  isAddressed?: (op: GuardedOp<Op>, index: number) => boolean;
  signal?: AbortSignal;
}

/** Entrada de un lote de operaciones (el otro caso de `EditIn` es deshacer, de B-M04). */
export type DocumentOpsInput<Op> = Extract<EditIn<Op>, { ops: unknown }>;

export type DocumentOpsResult =
  | { ok: true; out: WriteOut; report?: unknown }
  | { ok: false; error: DocumentError };

/** Un reintento ya hecho, o el visto bueno de la fase 1. */
type Gate = { kind: 'replay'; out: WriteOut } | { kind: 'go'; sha256: string } | { kind: 'refused'; error: DocumentError };

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Huella de la petición: la acción va en ella, así que otro uso del `operationId` es `operation_id_reused`. */
function fingerprintOf<Op>(input: DocumentOpsInput<Op>): string {
  const parts = [
    'documentOps',
    input.id,
    input.expectedRevision ?? null,
    input.expectedLayout ?? null,
    input.ops,
    input.assets ?? []
  ];
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

/** Un `WriteOut` del registro (no se fía de su forma). */
function isWriteOut(value: unknown): value is WriteOut {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.revision === 'string';
}

function invalid(path: string, reason: string, expected?: string): DocumentOpsResult {
  const issue: BatchIssue = { opIndex: 0, path, reason, ...(expected ? { expected } : {}) };
  return { ok: false, error: { code: 'batch_invalid', issues: [issue] } };
}

/** Lo que se valida sin el almacén, otra vez aunque la herramienta ya lo mirara. */
function validate<Op>(input: DocumentOpsInput<Op>): DocumentOpsResult | null {
  if (typeof input.id !== 'string' || input.id.length === 0) return invalid('id', 'id vacio');
  const id = input.operationId;
  if (typeof id !== 'string' || id.length === 0 || id.length > OPERATION_ID_MAX_LENGTH) {
    return invalid('operationId', 'operationId vacio o demasiado largo');
  }
  if (!Array.isArray(input.ops) || input.ops.length === 0) {
    return invalid('ops', 'sin operaciones', 'ops con al menos una operacion');
  }
  return null;
}

/** El resultado de un reintento: lo guardado, marcado como repetido. */
function replayOf(record: OperationRecord): WriteOut | null {
  if (record.state !== 'done' || !isWriteOut(record.result)) return null;
  const { replayed: _replayed, syncError: _syncError, ...stored } = record.result;
  return { ...stored, outcome: 'already', replayed: true, sync: 'pending' };
}

/**
 * Fases 1 y 3 comparten esto: documento e imágenes visibles, y el registro de operaciones.
 * Sin registro previo se abre (`begin`), también en la 3 si caducó entre medias.
 */
async function gateIn<Op>(
  turn: DocumentOpsTurn,
  input: DocumentOpsInput<Op>,
  fingerprint: string,
  now: number
): Promise<Gate> {
  turn.operations.purgeExpired(now);
  // Lanza `not_found` igual para oculto, inexistente, lápida y papelera.
  const document = guardDocumentWrite(turn, input.id);
  for (const asset of input.assets ?? []) await guardAsset(turn, asset);
  if (input.dryRun !== true) {
    const record = turn.operations.lookup(input.operationId);
    if (record) {
      if (record.fingerprint !== fingerprint) {
        return { kind: 'refused', error: { code: 'operation_id_reused' } };
      }
      const replay = replayOf(record);
      if (replay) return { kind: 'replay', out: replay };
    } else {
      turn.operations.begin({
        operationId: input.operationId,
        fingerprint,
        noteId: input.id,
        targetBodySha256: SHA256_HEX.test(document.sha256) ? document.sha256 : '',
        now
      });
    }
  }
  return { kind: 'go', sha256: document.sha256 };
}

/**
 * Aplica un lote de operaciones a un documento en tres fases. Ver la cabecera del fichero.
 * `dryRun` valida sin escribir (`validated`); un reintento con el mismo `operationId` devuelve
 * lo guardado (`already`, `replayed`) sin aplicar de nuevo.
 */
export async function runDocumentOps<Model, Op>(
  store: DocumentOpsStore,
  input: DocumentOpsInput<Op>,
  adapter: DocFormatAdapter<Model, Op>,
  options: RunDocumentOpsOptions<Op> = {}
): Promise<DocumentOpsResult> {
  const refused = validate(input);
  if (refused) return refused;
  if (options.isAddressed) {
    try {
      assertAddressRule(input, options.isAddressed);
    } catch (error) {
      if (error instanceof DocumentAddressError) return { ok: false, error: error.error };
      throw error;
    }
  }
  const signal = options.signal ?? new AbortController().signal;
  const fingerprint = fingerprintOf(input);

  // Fase 1.
  const first = await store.turn((turn) => gateIn(turn, input, fingerprint, store.now()));
  if (first.kind === 'replay') return { ok: true, out: first.out };
  if (first.kind === 'refused') return { ok: false, error: first.error };

  // Fase 2.
  const computed = await store.compute(
    {
      id: input.id,
      sha256: first.sha256,
      ops: input.ops,
      assets: input.assets ?? [],
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      ...(input.expectedLayout !== undefined ? { expectedLayout: input.expectedLayout } : {})
    },
    signal
  );
  if (!computed.ok) return { ok: false, error: computed.error };
  if (input.dryRun === true) {
    const out: WriteOut = {
      id: input.id,
      outcome: 'validated',
      revision: computed.revision,
      ...(computed.layoutRevision !== undefined ? { layoutRevision: computed.layoutRevision } : {}),
      sync: 'not_applicable'
    };
    return { ok: true, out, report: computed.report };
  }

  // Fase 3.
  const applied = await store.turn((turn) => applyIn(turn, store, input, adapter, fingerprint, signal));
  if (!applied.ok || applied.out.replayed) return applied;

  // Fase 4.
  const sync = (await store.afterCommit?.().catch(() => undefined)) ?? { sync: 'pending' };
  const out: WriteOut = { ...applied.out, sync: sync.sync };
  if (sync.syncError !== undefined) out.syncError = sync.syncError;
  return { ok: true, out, report: computed.report };
}

/** La fase 3: dentro del turno, con todo comprobado otra vez. */
async function applyIn<Model, Op>(
  turn: DocumentOpsTurn,
  store: DocumentOpsStore,
  input: DocumentOpsInput<Op>,
  adapter: DocFormatAdapter<Model, Op>,
  fingerprint: string,
  signal: AbortSignal
): Promise<DocumentOpsResult> {
  const gate = await gateIn(turn, input, fingerprint, store.now());
  if (gate.kind === 'replay') return { ok: true, out: gate.out };
  if (gate.kind === 'refused') return { ok: false, error: gate.error };

  const session = await turn.openSession(input.id, adapter, signal);
  try {
    const previousRevision = session.revision();
    // Las garantías del lote son de la capa del MCP: la sesión no las conoce.
    if (input.expectedRevision !== undefined && input.expectedRevision !== previousRevision) {
      return { ok: false, error: { code: 'precondition_failed', opIndex: 0, target: 'expectedRevision' } };
    }
    if (input.expectedLayout !== undefined && input.expectedLayout !== session.layoutRevision()) {
      return { ok: false, error: { code: 'precondition_failed', opIndex: 0, target: 'expectedLayout' } };
    }

    const withLayout = adapter.format === 'ods';
    const done: { out: WriteOut | null } = { out: null };
    const result = await session.apply(input.ops as readonly Op[], 'agent', {
      // Determinista: el reintento de un lote que no llegó a confirmarse da los mismos ids.
      seed: input.operationId,
      // La respuesta no lleva el modelo: no se proyecta dentro del turno (H23).
      project: false,
      inTx: (receipt) => {
        const out: WriteOut = {
          id: input.id,
          outcome: 'saved',
          revision: receipt.revision,
          previousRevision,
          sync: 'pending'
        };
        if (turn.undo) {
          const entry: DocumentUndoEntry<Op> = {
            operationId: input.operationId,
            documentId: input.id,
            inverse: receipt.inverse,
            revision: receipt.revision,
            createdAt: store.now()
          };
          if (JSON.stringify(entry.inverse).length <= UNDO_ENTRY_MAX_BYTES) {
            turn.undo.record(entry);
            out.undoAvailable = true;
            out.undoUntil = new Date(store.now() + UNDO_MAX_AGE_DAYS * DAY_MS).toISOString();
          } else {
            out.undoAvailable = false;
          }
        }
        // Dentro de la transacción del append: o se confirman los dos o ninguno (R18).
        turn.operations.finish(input.operationId, out);
        done.out = out;
      }
    });

    if (!result.ok) {
      switch (result.code) {
        case 'precondition_failed':
          return {
            ok: false,
            error: { code: 'precondition_failed', opIndex: result.opIndex ?? 0, target: `ops[${result.opIndex ?? 0}]` }
          };
        case 'generation_changed':
          return { ok: false, error: { code: 'generation_changed' } };
        case 'too_large':
          return { ok: false, error: { code: 'too_large' } };
        default:
          return { ok: false, error: { code: 'op_invalid' } };
      }
    }

    // Un lote que no cambia nada no escribe update y `inTx` no corre: se registra aquí.
    const registered = done.out;
    const base: WriteOut = registered ?? {
      id: input.id,
      outcome: 'saved',
      revision: result.revision,
      previousRevision,
      sync: 'pending'
    };
    const out: WriteOut = {
      ...base,
      revision: result.revision,
      ...(withLayout ? { layoutRevision: result.layoutRevision } : {})
    };
    if (registered === null) {
      turn.operations.finish(input.operationId, out);
    } else {
      // La revisión de disposición se firma después de confirmar: se anota también en el
      // registro. Si falla, el lote ya está confirmado y el reintento devuelve lo anterior.
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
