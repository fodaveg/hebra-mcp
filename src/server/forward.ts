/**
 * Escrituras desde cualquier sesión (SPEC.md §8): una instancia lectora reenvía sus
 * escrituras al escritor único por `writer.sock` (`src/ipc/writer-socket.ts`), y toma el
 * relevo si el escritor ya no está.
 *
 * Lado del lector, `buildRoutedWriteContext`: un `WriteContext` que
 * - en el escritor, escribe en local, como siempre;
 * - en un lector, reenvía `createNote`, `appendToNote`, `editNote`, `organize` (que
 *   incluye mandar a la papelera y sacar de ella), `restoreVersion`, desde D9 (3 oct
 *   2026), `createFolder`, `renameFolder` y `addAttachment`, y desde D10 (9 oct 2026),
 *   `organizeFile` (la papelera de los ficheros sueltos) al escritor. Todas
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
 *   el relevo para la siguiente llamada y se responde `busy_other_instance`. Las que
 *   llevan `operationId` (también `appendToNote` si lo trae, 10 oct 2026) se pueden
 *   reintentar sin duplicar;
 * - si el primer intento de relevo no toma el bloqueo y el escritor se fue (B2: un zombi
 *   tras SIGKILL todavía cuenta como vivo), se intenta otra vez a los 100 ms.
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
import type {
  ReplaceBodyInput,
  ReplaceBodyResult,
  TrashConflictCopiesInput,
  TrashConflictCopiesResult
} from '../store/body-writes';
import { busyOtherInstance } from '../store/errors';
import { HEADING_PROOF_MAX_CHARS } from '../store/sections';
import { EDITS_MAX_COUNT, WRITE_PROOF_TAIL_CHARS, type AppliedEdit } from '../store/edits';
import type {
  AddAttachmentInput,
  AppendedProof,
  AppendToNoteInput,
  AppendToNoteResult,
  CreateFolderInput,
  CreateNoteInput,
  CreateNoteResult,
  EditNoteInput,
  FetchAttachmentInput,
  OrganizeFileInput,
  OrganizeInput,
  RenameFolderInput,
  RestoreVersionInput
} from '../store/writes';
import type { InstanceStatus, WriterRole } from '../sync/library-instance';
import {
  AWAIT_ROUND_TIMEOUT_MS,
  appendAndAwaitRound,
  type AddAttachmentOutcome,
  type EditNoteOutcome,
  type FileOutcome,
  type FolderOutcome,
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
  // Bajar y descifrar un adjunto del relé (hasta el máximo de Hebra, 25 MiB).
  fetchAttachment: 60_000,
  createFolder: AWAIT_ROUND_TIMEOUT_MS + 15_000,
  renameFolder: AWAIT_ROUND_TIMEOUT_MS + 15_000,
  // Hasta 7 MB de petición, el `blobPut` (con `fsync`) y la ronda.
  addAttachment: AWAIT_ROUND_TIMEOUT_MS + 30_000,
  organizeFile: AWAIT_ROUND_TIMEOUT_MS + 15_000,
  // Ficheros de trabajo (SPEC.md §13): sin ronda dentro (la espera `syncRound`, una vez).
  replaceBody: 15_000,
  trashConflictCopies: 15_000,
  syncRound: AWAIT_ROUND_TIMEOUT_MS + 15_000,
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
  /** Tests: espera antes del segundo intento de relevo (`TAKEOVER_RETRY_MS`). */
  takeoverRetryMs?: number;
}

export type WriteOp = Exclude<WriterSocketOp, 'status'>;

/**
 * Segundo intento de relevo (B2 del audit de robustez, 10 oct 2026). Tras un SIGKILL,
 * hasta que el padre recoge al muerto, `process.kill(pid, 0)` lo da por vivo (es un
 * zombi) y el primer `checkWriter` no toma el bloqueo. Si el escritor se fue (nadie
 * escucha en el socket, o cortó la conexión tras recibir la petición), se vuelve a mirar
 * una vez pasado este tiempo. Con un escritor vivo pero lento (`timeout`) no: no se va a
 * morir en 100 ms y solo retrasaría el `busy_other_instance`.
 */
export const TAKEOVER_RETRY_MS = 100;
const TAKEOVER_RETRY_REASONS: ReadonlySet<string> = new Set(['refused', 'closed']);

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

/** Un tamaño que viene del escritor: entero no negativo. */
function asCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('writer_protocol');
  }
  return value;
}

/** Un `tail` de la prueba de lo guardado: texto de a lo sumo `WRITE_PROOF_TAIL_CHARS`. */
function asTail(value: unknown): string {
  if (typeof value !== 'string' || value.length > WRITE_PROOF_TAIL_CHARS) {
    throw new Error('writer_protocol');
  }
  return value;
}

/** Valida `applied` de una edición guardada (D11). */
function asApplied(value: unknown): AppliedEdit[] {
  if (!Array.isArray(value) || value.length > EDITS_MAX_COUNT) throw new Error('writer_protocol');
  return value.map((entry): AppliedEdit => {
    if (!isRecord(entry)) throw new Error('writer_protocol');
    const chars = asCount(entry.chars);
    if (entry.moved === true) return { chars, moved: true };
    return { chars, tail: asTail(entry.tail) };
  });
}

/** Valida el `EditNoteOutcome` que devuelve el escritor (no se fía de su forma). La
 *  prueba de lo guardado (`totalChars`, `applied`) es opcional: un escritor de una
 *  versión anterior no la manda. */
function asEditOutcome(value: unknown, id: string): EditNoteOutcome {
  if (!isRecord(value)) throw new Error('writer_protocol');
  const sync = syncFieldsFrom(value);
  const replayed = value.replayed === true ? { replayed: true as const } : {};
  if (value.outcome === 'saved' && typeof value.revision === 'string') {
    const proof: { totalChars?: number; applied?: AppliedEdit[] } = {};
    if (value.totalChars !== undefined) proof.totalChars = asCount(value.totalChars);
    if (value.applied !== undefined) proof.applied = asApplied(value.applied);
    return { id, outcome: 'saved', revision: value.revision, ...proof, ...replayed, ...sync };
  }
  if (value.outcome === 'conflict_copy' && typeof value.copyId === 'string') {
    return { id, outcome: 'conflict_copy', copyId: value.copyId, ...replayed, ...sync };
  }
  throw new Error('writer_protocol');
}

/** Valida el `FolderOutcome` que devuelve el escritor (D9). */
function asFolderOutcome(value: unknown): FolderOutcome {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.changed !== 'boolean') {
    throw new Error('writer_protocol');
  }
  return { id: value.id, changed: value.changed, ...syncFieldsFrom(value) };
}

/** Valida el `FileOutcome` que devuelve el escritor (D10). */
function asFileOutcome(value: unknown): FileOutcome {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.folderId !== 'string' ||
    typeof value.trashed !== 'boolean'
  ) {
    throw new Error('writer_protocol');
  }
  return {
    id: value.id,
    folderId: value.folderId,
    trashed: value.trashed,
    ...syncFieldsFrom(value)
  };
}

/** Valida el `AddAttachmentOutcome` que devuelve el escritor (D9): el de una edición más
 *  el adjunto. */
function asAttachmentOutcome(value: unknown, id: string): AddAttachmentOutcome {
  const edit = asEditOutcome(value, id);
  const record = value as Record<string, unknown>;
  if (typeof record.attachmentId !== 'string' || typeof record.markdown !== 'string') {
    throw new Error('writer_protocol');
  }
  return { ...edit, attachmentId: record.attachmentId, markdown: record.markdown };
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
  const replayed = isRecord(value) && value.replayed === true ? { replayed: true as const } : {};
  if (isRecord(value) && value.outcome === 'saved') {
    const saved: AppendToNoteResult & { outcome: 'saved' } = { id, outcome: 'saved', ...replayed };
    if (value.revision !== undefined) {
      if (typeof value.revision !== 'string') throw new Error('writer_protocol');
      saved.revision = value.revision;
    }
    if (value.totalChars !== undefined) saved.totalChars = asCount(value.totalChars);
    if (value.appended !== undefined) {
      const appended = value.appended;
      if (!isRecord(appended)) throw new Error('writer_protocol');
      const proof: AppendedProof = {
        chars: asCount(appended.chars),
        tail: asTail(appended.tail),
        line: asCount(appended.line)
      };
      if (appended.heading !== undefined) {
        if (typeof appended.heading !== 'string' || appended.heading.length > HEADING_PROOF_MAX_CHARS) {
          throw new Error('writer_protocol');
        }
        proof.heading = appended.heading;
      }
      saved.appended = proof;
    }
    return saved;
  }
  if (isRecord(value) && value.outcome === 'conflict_copy' && typeof value.copyId === 'string') {
    return { id, outcome: 'conflict_copy', copyId: value.copyId, ...replayed };
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
 * Una escritura: en local si esta instancia es el escritor; si no, reenviada al escritor
 * por `writer.sock`, con el relevo de la cabecera si no responde. La usan
 * `buildRoutedWriteContext` (las herramientas) y los ficheros de trabajo
 * (`src/workdir/library.ts`, SPEC.md §13).
 */
export async function routeWrite<T>(
  instance: ForwardingInstance,
  op: WriteOp,
  params: Record<string, unknown>,
  parse: (value: unknown) => T,
  writeLocally: () => Promise<T>,
  options: ForwardOptions = {}
): Promise<T> {
  if (instance.role === 'this') return writeLocally();
  const timeoutMs = options.timeoutMs?.[op] ?? FORWARD_TIMEOUT_MS[op];
  let result: unknown;
  try {
    result = await requestWriter(instance.writerSocketPath, op, params, timeoutMs);
  } catch (error) {
    if (!isWriterUnavailable(error)) {
      logEvent({ event: 'write.forward', op, outcome: 'remote_error', code: remoteCodeOf(error) });
      throw error;
    }
    const reason = error.reason;
    // Sin escritor que responda: relevo AHORA. `checkWriter` solo toma el bloqueo si
    // su poseedor está muerto o se fue; con un escritor vivo pero lento, no cambia nada.
    await instance.checkWriter();
    if ((instance.role as WriterRole) !== 'this' && TAKEOVER_RETRY_REASONS.has(reason)) {
      await new Promise((resolve) =>
        setTimeout(resolve, options.takeoverRetryMs ?? TAKEOVER_RETRY_MS)
      );
      await instance.checkWriter();
    }
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

/**
 * El `WriteContext` de `serve`: local en el escritor, reenviado en un lector.
 * `local` es el de siempre, sobre la instancia (`buildWriteContext`).
 */
export function buildRoutedWriteContext(
  instance: ForwardingInstance,
  local: WriteContext,
  options: ForwardOptions = {}
): WriteContext {
  const routed = <T>(
    op: WriteOp,
    params: Record<string, unknown>,
    parse: (value: unknown) => T,
    writeLocally: () => Promise<T>
  ): Promise<T> => routeWrite(instance, op, params, parse, writeLocally, options);

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
        {
          id: input.id,
          text: input.text,
          ...(input.heading !== undefined ? { heading: input.heading } : {}),
          ...(input.headingOccurrence !== undefined
            ? { headingOccurrence: input.headingOccurrence }
            : {}),
          // Con él, el reintento tras un corte (`busy_other_instance`) no duplica el texto:
          // lo sirve el registro del escritor que lo guardó, o el del relevo (es la misma
          // SQLite).
          ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
          privacy: input.privacy
        },
        (value) => {
          const result = asAppendResult(value, input.id);
          // Un escritor de una versión anterior ignora `operationId` sin decirlo: el texto
          // se guardó, pero un reintento lo duplicaría. El escritor actual lo devuelve; si
          // no vuelve, queda en el log (sin texto ni id de nota) y la respuesta es la suya.
          if (
            input.operationId !== undefined &&
            (!isRecord(value) || value.operationId !== input.operationId)
          ) {
            logEvent({ event: 'forward.operation_id_ignored', op: 'appendToNote' });
          }
          return result;
        },
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
    // Solo trae los bytes al disco compartido; el lector los lee de ahí con su filtro.
    fetchAttachment: (input: FetchAttachmentInput) =>
      routed(
        'fetchAttachment',
        { noteId: input.noteId, sha256: input.sha256, privacy: input.privacy },
        (value) => {
          if (!isRecord(value) || typeof value.available !== 'boolean') {
            throw new Error('writer_protocol');
          }
          return { available: value.available };
        },
        () => local.fetchAttachment(input)
      ),
    // Carpetas y adjuntos (D9): todo en el escritor, con la privacidad de ESTE lector.
    createFolder: (input: CreateFolderInput) =>
      routed(
        'createFolder',
        { parentId: input.parentId, name: input.name, privacy: input.privacy },
        asFolderOutcome,
        () => local.createFolder(input)
      ),
    renameFolder: (input: RenameFolderInput) =>
      routed(
        'renameFolder',
        { id: input.id, name: input.name, privacy: input.privacy },
        asFolderOutcome,
        () => local.renameFolder(input)
      ),
    // Los bytes viajan en base64 (el escritor los vuelve a validar). Como una edición, si
    // la conexión se corta tras enviarla no se repite: el agente reintenta con el mismo
    // `operationId` sin duplicar la referencia.
    addAttachment: (input: AddAttachmentInput) =>
      routed(
        'addAttachment',
        {
          id: input.id,
          name: input.name,
          dataBase64: Buffer.from(input.bytes).toString('base64'),
          mimeType: input.mimeType,
          operationId: input.operationId,
          privacy: input.privacy
        },
        (value) => asAttachmentOutcome(value, input.id),
        () => local.addAttachment(input)
      ),
    // Ficheros sueltos (D10): como `organize`, todo en el escritor y con la privacidad de
    // ESTE lector. Solo viajan la acción y el id.
    organizeFile: (input: OrganizeFileInput) =>
      routed(
        'organizeFile',
        { action: input.action, id: input.id, privacy: input.privacy },
        asFileOutcome,
        () => local.organizeFile(input)
      ),
    onConflictCopy: (listener) => local.onConflictCopy(listener),
    // Un lector no tiene ronda (ni copias que anotar): lo anota el escritor. Tras un
    // relevo, esta instancia ya es el escritor y lo anota en local.
    recordEditConflict: (operationId, id, copyId) =>
      local.recordEditConflict(operationId, id, copyId),
    awaitRound: (timeoutMs) => local.awaitRound(timeoutMs)
  };
}

/** Lo que el escritor necesita para atender los ficheros de trabajo (SPEC.md §13):
 *  `LibraryInstance` lo tiene. Sin ello (tests de otros lotes), esas ops responden
 *  `invalid_request`. */
export interface WorkdirWriterInstance {
  replaceBodyLocal(input: ReplaceBodyInput): Promise<ReplaceBodyResult>;
  trashConflictCopiesLocal(input: TrashConflictCopiesInput): Promise<TrashConflictCopiesResult>;
}

function hasWorkdirWrites(instance: object): instance is WorkdirWriterInstance {
  const candidate = instance as Partial<WorkdirWriterInstance>;
  return typeof candidate.replaceBodyLocal === 'function' && typeof candidate.trashConflictCopiesLocal === 'function';
}

/** Lo que hace el escritor con lo que le reenvían (`LibraryInstance.open({ writerSocket })`). */
export function writerSocketHandlers(
  local: WriteContext,
  instance: Pick<ForwardingInstance, 'status'> & Partial<WorkdirWriterInstance>
): WriterSocketHandlers {
  // Ficheros de trabajo: cuerpo entero con base comprobada y papelera de copias, en el
  // turno de ESTE escritor; la ronda la espera `syncRound`, una vez por lote.
  const workdir = hasWorkdirWrites(instance)
    ? {
        replaceBody: (input: ReplaceBodyInput) => instance.replaceBodyLocal(input),
        trashConflictCopies: (input: TrashConflictCopiesInput) =>
          instance.trashConflictCopiesLocal(input),
        syncRound: () => local.awaitRound(AWAIT_ROUND_TIMEOUT_MS)
      }
    : {};
  return {
    ...workdir,
    createNote: (input) => local.createNote(input),
    // Devuelve el `operationId` que atendió: así el lector sabe que este escritor lo
    // entiende (uno anterior lo ignoraría sin decirlo).
    appendToNote: async (input) => {
      const result = await appendAndAwaitRound(local, input);
      return input.operationId === undefined ? result : { ...result, operationId: input.operationId };
    },
    editNote: (input) => local.editNote(input),
    organize: (input) => local.organize(input),
    restoreVersion: (input) => local.restoreVersion(input),
    fetchAttachment: (input) => local.fetchAttachment(input),
    createFolder: (input) => local.createFolder(input),
    renameFolder: (input) => local.renameFolder(input),
    addAttachment: (input) => local.addAttachment(input),
    organizeFile: (input) => local.organizeFile(input),
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
