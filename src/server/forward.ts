/**
 * Escrituras desde cualquier sesión (SPEC.md §8): una instancia lectora reenvía sus
 * escrituras al escritor único por `writer.sock` (`src/ipc/writer-socket.ts`), y toma el
 * relevo si el escritor ya no está.
 *
 * Lado del lector, `buildRoutedWriteContext`: un `WriteContext` que
 * - en el escritor, escribe en local, como siempre;
 * - en un lector, reenvía `createNote`, `appendToNote`, `editNote`, `organize` (que
 *   incluye mandar a la papelera y sacar de ella) y `restoreVersion` al escritor. Todas
 *   menos la primera vuelven ya con la ronda esperada allí (`appendAndAwaitRound`,
 *   `WriteContext.editNote`/`organize`/`restoreVersion`), así que `awaitRound` y
 *   `onConflictCopy` de este lado no tienen nada que esperar (un lector no tiene runner).
 *   Todas llevan además la configuración de privados de ESTE lector, que el escritor
 *   aplica dentro del turno en que escribe;
 * - si el escritor no responde porque no hay socket, nadie escucha o no contesta a
 *   tiempo, intenta tomar el bloqueo EN ESE MOMENTO (`checkWriter`). Si lo consigue,
 *   escribe en local como nuevo escritor; si no, `busy_other_instance`, como antes;
 * - si la conexión se cierra DESPUÉS de enviar la petición y sin respuesta, el escritor
 *   pudo ejecutarla antes de morir: no se repite (sería un texto duplicado). Se intenta
 *   el relevo para la siguiente llamada y se responde `busy_other_instance`.
 *
 * El filtro de privados y los límites de tamaño NO están aquí: los aplica la herramienta
 * que recibe la llamada, antes de llegar a `ctx.write`, con la configuración de privados
 * de ESTA instancia. El escritor no la conoce ni la supone igual: la recibe con cada
 * escritura y la vuelve a aplicar dentro del turno en que escribe.
 *
 * Lado del escritor, `writerSocketHandlers`: lo que hace con cada petición, sobre su
 * `WriteContext` local.
 *
 * `hebra_status` de un lector (`RoutedStatusSource`) pide al escritor su estado de sync
 * y responde con `writer: "other_instance"`. Si el escritor no responde, intenta el
 * relevo igual que una escritura y responde con el estado local.
 *
 * Logs (§6.4): `write.forward` con `op`, `outcome` y códigos cerrados. Nunca cuerpos,
 * textos ni ids de nota.
 */
import {
  isWriterUnavailable,
  requestWriter,
  type WriterSocketHandlers,
  type WriterSocketOp,
  type WriterSyncStatus
} from '../ipc/writer-socket';
import { logEvent } from '../log/logger';
import type { HebraStatus, StatusSource } from '../status/status-source';
import { busyOtherInstance } from '../store/errors';
import type {
  AppendToNoteInput,
  AppendToNoteResult,
  CreateNoteInput,
  CreateNoteResult,
  EditNoteInput,
  OrganizeInput,
  RestoreVersionInput
} from '../store/writes';
import type { InstanceStatus, WriterRole } from '../sync/library-instance';
import {
  AWAIT_ROUND_TIMEOUT_MS,
  appendAndAwaitRound,
  type EditNoteOutcome,
  type OrganizeOutcome,
  type SyncFields,
  type SyncState,
  type WriteContext
} from './write-context';

/** Tiempos de espera del reenvío. `appendToNote` incluye los 10 s de la ronda del
 *  escritor (`AWAIT_ROUND_TIMEOUT_MS`) y un margen para la escritura. */
export const FORWARD_TIMEOUT_MS: Record<WriterSocketOp, number> = {
  createNote: 15_000,
  appendToNote: AWAIT_ROUND_TIMEOUT_MS + 15_000,
  editNote: AWAIT_ROUND_TIMEOUT_MS + 15_000,
  organize: AWAIT_ROUND_TIMEOUT_MS + 15_000,
  restoreVersion: AWAIT_ROUND_TIMEOUT_MS + 15_000,
  status: 5_000
};

/** Lo que el reenvío necesita de la instancia (`LibraryInstance`). */
export interface ForwardingInstance {
  readonly role: WriterRole;
  readonly writerSocketPath: string;
  /** Toma el bloqueo si el escritor murió (y pasa a escritor). */
  checkWriter(): Promise<void>;
  status(): Promise<InstanceStatus>;
}

export interface ForwardOptions {
  /** Tests: tiempos de espera más cortos. */
  timeoutMs?: Partial<Record<WriterSocketOp, number>>;
}

type WriteOp = Exclude<WriterSocketOp, 'status'>;

const SYNC_STATES: ReadonlySet<string> = new Set<SyncState>([
  'uploaded',
  'pending',
  'error',
  'not_linked'
]);

function syncFieldsFrom(value: Record<string, unknown>): SyncFields {
  if (typeof value.sync !== 'string' || !SYNC_STATES.has(value.sync)) {
    throw new Error('writer_protocol');
  }
  const sync: SyncFields = { sync: value.sync as SyncState };
  if (typeof value.syncError === 'string') sync.syncError = value.syncError;
  return sync;
}

/** Valida el `OrganizeOutcome` que devuelve el escritor. */
function asOrganizeOutcome(value: unknown): OrganizeOutcome {
  if (!isRecord(value) || typeof value.id !== 'string') throw new Error('writer_protocol');
  const sync = syncFieldsFrom(value);
  if (
    typeof value.folderId === 'string' &&
    typeof value.favorite === 'boolean' &&
    typeof value.archived === 'boolean' &&
    typeof value.trashed === 'boolean'
  ) {
    return {
      id: value.id,
      folderId: value.folderId,
      favorite: value.favorite,
      archived: value.archived,
      trashed: value.trashed,
      ...sync
    };
  }
  throw new Error('writer_protocol');
}

/** Valida el `EditNoteOutcome` que devuelve el escritor (no se fía de su forma). */
function asEditOutcome(value: unknown, id: string): EditNoteOutcome {
  if (!isRecord(value)) throw new Error('writer_protocol');
  const sync = syncFieldsFrom(value);
  const replayed = value.replayed === true ? { replayed: true as const } : {};
  if (value.outcome === 'saved' && typeof value.revision === 'string') {
    return { id, outcome: 'saved', revision: value.revision, ...replayed, ...sync };
  }
  if (value.outcome === 'conflict_copy' && typeof value.copyId === 'string') {
    return { id, outcome: 'conflict_copy', copyId: value.copyId, ...replayed, ...sync };
  }
  throw new Error('writer_protocol');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asCreateResult(value: unknown): CreateNoteResult {
  if (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.folderId === 'string'
  ) {
    return { id: value.id, title: value.title, folderId: value.folderId };
  }
  throw new Error('writer_protocol');
}

function asAppendResult(value: unknown, id: string): AppendToNoteResult {
  if (isRecord(value) && value.outcome === 'saved') return { id, outcome: 'saved' };
  if (isRecord(value) && value.outcome === 'conflict_copy' && typeof value.copyId === 'string') {
    return { id, outcome: 'conflict_copy', copyId: value.copyId };
  }
  throw new Error('writer_protocol');
}

function asWriterStatus(value: unknown): WriterSyncStatus | null {
  if (!isRecord(value)) return null;
  const { lastSyncAt, lastSyncOutcome, pendingUpload, errorsByCode, revoked } = value;
  if (lastSyncAt !== null && typeof lastSyncAt !== 'string') return null;
  if (lastSyncOutcome !== null && typeof lastSyncOutcome !== 'string') return null;
  if (typeof pendingUpload !== 'number' || typeof revoked !== 'boolean') return null;
  if (!isRecord(errorsByCode)) return null;
  const errors: Record<string, number> = {};
  for (const [code, count] of Object.entries(errorsByCode)) {
    if (typeof count !== 'number') return null;
    errors[code] = count;
  }
  return { lastSyncAt, lastSyncOutcome, pendingUpload, errorsByCode: errors, revoked };
}

/** Código cerrado de un error del escritor para el log (nunca su mensaje). */
function remoteCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

/**
 * El `WriteContext` de `serve`: local en el escritor, reenviado en un lector.
 * `local` es el de siempre, sobre la instancia (`buildWriteContext`).
 */
export function buildRoutedWriteContext(
  instance: ForwardingInstance,
  local: WriteContext,
  options: ForwardOptions = {}
): WriteContext {
  const timeoutOf = (op: WriterSocketOp): number => options.timeoutMs?.[op] ?? FORWARD_TIMEOUT_MS[op];

  async function routed<T>(
    op: WriteOp,
    params: Record<string, unknown>,
    parse: (value: unknown) => T,
    writeLocally: () => Promise<T>
  ): Promise<T> {
    if (instance.role === 'this') return writeLocally();
    let result: unknown;
    try {
      result = await requestWriter(instance.writerSocketPath, op, params, timeoutOf(op));
    } catch (error) {
      if (!isWriterUnavailable(error)) {
        logEvent({ event: 'write.forward', op, outcome: 'remote_error', code: remoteCodeOf(error) });
        throw error;
      }
      const reason = error.reason;
      // Sin escritor que responda: relevo AHORA. `checkWriter` solo toma el bloqueo si
      // su poseedor está muerto o se fue; con un escritor vivo pero lento, no cambia nada.
      await instance.checkWriter();
      // Releído tras `checkWriter`, que cambia el papel (TS lo daría por estrechado).
      const tookOver = (instance.role as WriterRole) === 'this';
      if (tookOver && reason !== 'closed') {
        logEvent({ event: 'write.forward', op, outcome: 'takeover', reason });
        return writeLocally();
      }
      logEvent({ event: 'write.forward', op, outcome: 'busy', reason, tookOver });
      throw busyOtherInstance();
    }
    const parsed = parse(result);
    logEvent({ event: 'write.forward', op, outcome: 'forwarded' });
    return parsed;
  }

  return {
    createNote: (input: CreateNoteInput) =>
      routed(
        'createNote',
        { body: input.body, folderId: input.folderId ?? null, privacy: input.privacy },
        asCreateResult,
        () => local.createNote(input)
      ),
    appendToNote: (input: AppendToNoteInput) =>
      routed(
        'appendToNote',
        { id: input.id, text: input.text, privacy: input.privacy },
        (value) => asAppendResult(value, input.id),
        () => local.appendToNote(input)
      ),
    // La edición entera (guardado, ronda y estado de sync) ocurre en el escritor. Si la
    // conexión se corta tras enviarla, no se repite (igual que las demás): el agente
    // puede reintentar con el mismo `operationId` sin duplicar nada.
    editNote: (input: EditNoteInput) =>
      routed(
        'editNote',
        {
          id: input.id,
          edits: input.edits,
          expectedRevision: input.expectedRevision,
          operationId: input.operationId,
          privacy: input.privacy
        },
        (value) => asEditOutcome(value, input.id),
        () => local.editNote(input)
      ),
    organize: (input: OrganizeInput) =>
      routed(
        'organize',
        { ...input, privacy: input.privacy },
        asOrganizeOutcome,
        () => local.organize(input)
      ),
    // Como `editNote`: todo en el escritor, y un reintento con el mismo `operationId` no
    // restaura dos veces.
    restoreVersion: (input: RestoreVersionInput) =>
      routed(
        'restoreVersion',
        {
          id: input.id,
          versionId: input.versionId,
          expectedRevision: input.expectedRevision,
          operationId: input.operationId,
          privacy: input.privacy
        },
        (value) => asEditOutcome(value, input.id),
        () => local.restoreVersion(input)
      ),
    onConflictCopy: (listener) => local.onConflictCopy(listener),
    awaitRound: (timeoutMs) => local.awaitRound(timeoutMs)
  };
}

/** Lo que hace el escritor con lo que le reenvían (`LibraryInstance.open({ writerSocket })`). */
export function writerSocketHandlers(
  local: WriteContext,
  instance: Pick<ForwardingInstance, 'status'>
): WriterSocketHandlers {
  return {
    createNote: (input) => local.createNote(input),
    appendToNote: (input) => appendAndAwaitRound(local, input),
    editNote: (input) => local.editNote(input),
    organize: (input) => local.organize(input),
    restoreVersion: (input) => local.restoreVersion(input),
    async status() {
      const { writer: _writer, ...sync } = await instance.status();
      return sync;
    }
  };
}

/** `hebra_status` en `serve`: el del escritor, aunque lo pregunte un lector (§5). */
export class RoutedStatusSource implements StatusSource {
  constructor(
    private readonly instance: ForwardingInstance,
    private readonly linked: boolean,
    private readonly options: ForwardOptions = {}
  ) {}

  async getStatus(): Promise<HebraStatus> {
    if (this.instance.role !== 'this') {
      try {
        const remote = asWriterStatus(
          await requestWriter(
            this.instance.writerSocketPath,
            'status',
            {},
            this.options.timeoutMs?.status ?? FORWARD_TIMEOUT_MS.status
          )
        );
        if (remote) {
          logEvent({ event: 'write.forward', op: 'status', outcome: 'forwarded' });
          return { linked: this.linked, ...remote, writer: 'other_instance' };
        }
        logEvent({ event: 'write.forward', op: 'status', outcome: 'local', reason: 'protocol' });
      } catch (error) {
        const reason = isWriterUnavailable(error) ? error.reason : remoteCodeOf(error);
        if (isWriterUnavailable(error)) await this.instance.checkWriter();
        logEvent({ event: 'write.forward', op: 'status', outcome: 'local', reason });
      }
    }
    return { linked: this.linked, ...(await this.instance.status()) };
  }
}
