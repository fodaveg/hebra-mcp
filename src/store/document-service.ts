/**
 * El lado del escritor de la op `documentOps` (paquete B-I01): une las piezas de documentos
 * (`.ods`, `.odp`) con la instancia. Aquí no hay reglas nuevas, solo el cableado:
 *
 * - `runDocumentRequest`: un lote (`runDocumentOps`), un deshacer (`undoDocumentOps`) o una
 *   creación (`createDocumentFile`), con el turno real (`documentTurnOf`). Lo creado sale ya con
 *   su cabecera `/h` (`ensureCreatedHead`, H-79), lista para editarse desde el MCP.
 * - Tras un lote o un deshacer que escribieron: `checkpointThenClean`, con el exportador
 *   registrado, el diario en disco y `otherPins` leído de `doc_pins`. Nunca lanza: lo aplicado
 *   no se rompe por un punto de control que falle. Después, la ronda de sync.
 * - `prepareDocumentCopy`: antes de duplicar un documento con cabecera, su punto de control al
 *   día (D17 y D28, protección 12). Sin él, la copia saldría con la última versión guardada.
 * - El log de cada resultado (D28, protección 13), con códigos cerrados.
 *
 * Los formatos se registran con `registerDocumentFormat` y hoy no hay ninguno: sin el suyo, un
 * lote responde `op_unsupported` sin tocar nada. Los dan de alta los paquetes de integración de
 * cada editor (`P-110`, `H-177`), junto con sus herramientas.
 */
import type { DocFormat, DocFormatAdapter } from '../../vendor/hebra/src/lib/documents/contract';
import { checkpointPins } from '../../vendor/hebra/src/lib/documents/sync/checkpoint';
import { initialGeneration } from '../../vendor/hebra/src/lib/documents/sync/generation-flow';
import { newDocumentHead } from '../../vendor/hebra/src/lib/documents/sync/lifecycle';
import { documentLogCode, logDocumentEvent, type DocumentLogEntry } from '../log/logger';
import type { PrivacyConfig } from '../privacy/config';
import {
  checkpointThenClean,
  FsSupersededJournal,
  type CleanupResult
} from './document-blob-cleanup';
import { getDocumentExporter, type DocumentChannelSource } from './document-channel';
import { checkpointAfterBatch, type CheckpointOutcome } from './document-checkpoint';
import { createDocumentFile } from './document-create';
import {
  runDocumentOps,
  type DocumentComputeJob,
  type DocumentComputeResult,
  type DocumentOpsInput,
  type DocumentOpsResult,
  type RunDocumentOpsOptions
} from './document-ops';
import { documentBytesForCopy, DocumentReadError } from './document-read';
import type { DocumentError } from './document-types';
import { documentTurnOf, undoDocumentOps, type DocumentUndoInput } from './document-undo';
import { writeRejected } from './errors';
import type { NoteWriteStore } from './writes';

/** Una petición de `documentOps`. `opsVersion` lo comprueba el socket del escritor. */
export type DocumentOpsRequest = {
  opsVersion: number;
  format: DocFormat;
  privacy: PrivacyConfig;
} & (
  | { action: 'edit'; input: DocumentOpsInput<unknown> }
  | { action: 'undo'; input: DocumentUndoInput }
  | { action: 'create'; operationId: string; folderId: string; name: string; bytes: Uint8Array }
);

/** Lo creado por `action: 'create'`, con su estado de sync. */
export interface DocumentCreated {
  id: string;
  sha256: string;
  outcome: 'saved' | 'already';
  replayed?: true;
  sync: string;
  syncError?: string;
}

/** Lo que responde `documentOps`: un lote o deshacer, o lo creado. */
export type DocumentOpsOutcome = DocumentOpsResult | { ok: true; created: DocumentCreated };

/** El estado de sync de la ronda de después de escribir. No debe lanzar. */
export type DocumentAfterCommit = () => Promise<{ sync: string; syncError?: string }>;

/** Lo que un formato aporta para editarse desde el MCP. */
export interface DocumentFormatEntry<Model = unknown, Op = unknown> {
  adapter: DocFormatAdapter<Model, Op>;
  /** Fase 2 de `runDocumentOps`: el cálculo en el hilo. */
  compute(job: DocumentComputeJob, signal: AbortSignal): Promise<DocumentComputeResult>;
  /** Si una operación direcciona por A1 o índice (regla de `./document-address.ts`). */
  isAddressed?: RunDocumentOpsOptions<Op>['isAddressed'];
}

const formats = new Map<DocFormat, DocumentFormatEntry>();

/** Da de alta un formato, o lo retira con `null`. */
export function registerDocumentFormat<Model, Op>(
  format: DocFormat,
  entry: DocumentFormatEntry<Model, Op> | null
): void {
  if (entry) formats.set(format, entry as unknown as DocumentFormatEntry);
  else formats.delete(format);
}

/** Lo que el servicio necesita de la instancia (`LibraryInstance`). */
export interface DocumentServiceTarget {
  port: { documentSource(): DocumentChannelSource };
  writeExclusive<T>(operation: (store: NoteWriteStore) => Promise<T>): Promise<T>;
}

export interface DocumentServiceHooks {
  /** Tras una escritura confirmada (la lista de subidas pendientes de la instancia). */
  onWritten?(): void;
  /** La ronda de sync, fuera del turno. */
  afterCommit: DocumentAfterCommit;
}

/** Los errores de la sesión del turno, que salen como texto, a su código recuperable. */
function sessionRefusal(error: unknown): DocumentError | null {
  if (!(error instanceof Error)) return null;
  if (error.message === 'doc_head_missing') return { code: 'doc_head_invalid' };
  if (error.message === 'blob_missing') return { code: 'file_unavailable' };
  return null;
}

/** El punto de control y la limpieza tras un lote. No lanza: solo deja su rastro en el log. */
async function checkpointAfterWrite(
  target: DocumentServiceTarget,
  fileId: string,
  privacy: PrivacyConfig
): Promise<void> {
  const source = target.port.documentSource();
  const checkpoint = {
    source,
    writeExclusive: <T>(operation: (store: NoteWriteStore) => Promise<T>) => target.writeExclusive(operation),
    privacy,
    exportDocument: getDocumentExporter()
  };
  let outcome: CheckpointOutcome;
  let cleanup: CleanupResult = { removed: 0, kept: 0 };
  if (source.cleanup) {
    ({ outcome, cleanup } = await checkpointThenClean(
      {
        checkpoint,
        cleanup: {
          blobs: source.cleanup.blobs,
          journal: new FsSupersededJournal(source.cleanup.root),
          otherPins: (id) => source.otherPins(id)
        }
      },
      fileId
    ));
  } else {
    outcome = await checkpointAfterBatch(checkpoint, fileId);
  }
  logDocumentEvent({ event: 'document.checkpoint', status: outcome.status, removed: cleanup.removed, kept: cleanup.kept });
}

/** El evento de log de un lote o deshacer ya resuelto. */
function resultEvent(
  request: Extract<DocumentOpsRequest, { action: 'edit' | 'undo' }>,
  result: DocumentOpsResult
): DocumentLogEntry {
  const base = {
    event: 'document.write' as const,
    action: request.action,
    format: request.format,
    ...(request.action === 'edit' && Array.isArray(request.input.ops) ? { ops: request.input.ops.length } : {})
  };
  if (!result.ok) return { ...base, outcome: 'error', code: documentLogCode(result.error) };
  return {
    ...base,
    outcome: result.out.outcome,
    ...(result.out.replayed ? { replayed: true as const } : {})
  };
}

/**
 * Atiende una petición de `documentOps` en el escritor. Los rechazos del almacén (`not_found`,
 * `space_access_denied`…) se lanzan; los recuperables salen como `{ ok: false, error }`.
 */
export async function runDocumentRequest(
  target: DocumentServiceTarget,
  request: DocumentOpsRequest,
  hooks: DocumentServiceHooks
): Promise<DocumentOpsOutcome> {
  if (request.action === 'create') return createRequest(target, request, hooks);
  const entry = formats.get(request.format);
  const { privacy } = request;
  const afterCommit = async (): Promise<{ sync: string; syncError?: string }> => {
    hooks.onWritten?.();
    await checkpointAfterWrite(target, request.input.id, privacy);
    return hooks.afterCommit();
  };
  const turn = <T>(operation: (turn: ReturnType<typeof documentTurnOf>) => Promise<T>): Promise<T> =>
    target.writeExclusive((store) => operation(documentTurnOf(store, privacy)));
  try {
    let result: DocumentOpsResult;
    if (!entry) {
      result = { ok: false, error: { code: 'op_unsupported' } };
    } else if (request.action === 'edit') {
      result = await runDocumentOps(
        { turn, compute: (job, signal) => entry.compute(job, signal), now: () => Date.now(), afterCommit },
        request.input,
        entry.adapter,
        entry.isAddressed ? { isAddressed: entry.isAddressed } : {}
      );
    } else {
      result = await undoDocumentOps({ turn, now: () => Date.now(), afterCommit }, request.input, entry.adapter);
    }
    logDocumentEvent(resultEvent(request, result));
    return result;
  } catch (error) {
    const refusal = sessionRefusal(error);
    if (refusal) {
      const result: DocumentOpsResult = { ok: false, error: refusal };
      logDocumentEvent(resultEvent(request, result));
      return result;
    }
    logDocumentEvent({
      event: 'document.write',
      action: request.action,
      format: request.format,
      outcome: 'error',
      code: documentLogCode(error)
    });
    throw error;
  }
}

/**
 * La cabecera `/h` del documento recién creado, como hace la app al abrir un `.ods` que no la
 * tiene (`ensureHead` del cableado, H-ABRIR-ODS): base = los bytes creados, generación inicial
 * derivada del fichero y de sus bytes, y `docSetHeadIfAbsent`, que no pisa una cabecera ni un
 * estado que ya estén. Con cableado de sync va por `wiring.ensureHead`, que además avisa al
 * canal para que el `/h` suba; sin él (biblioteca sin vincular), directo al puerto. Fuera del
 * turno: las dos vías entran por la cola del almacén. Sin ella, la primera edición desde el MCP
 * daría `doc_head_invalid` hasta que la app abriera el documento.
 */
async function ensureCreatedHead(
  target: DocumentServiceTarget,
  format: DocFormat,
  fileId: string,
  sha256: string
): Promise<boolean> {
  const source = target.port.documentSource();
  if (source.wiring) return (await source.wiring.ensureHead(fileId)) !== null;
  const head = newDocumentHead(format, await initialGeneration(fileId, sha256), sha256);
  const result = await source.port.docSetHeadIfAbsent(fileId, head, checkpointPins(head, []));
  return result.head !== null;
}

/** Crear un documento: en un turno, con su `operationId`, su cabecera y la ronda si escribió. */
async function createRequest(
  target: DocumentServiceTarget,
  request: Extract<DocumentOpsRequest, { action: 'create' }>,
  hooks: DocumentServiceHooks
): Promise<DocumentOpsOutcome> {
  const { format, privacy, operationId, folderId, name, bytes } = request;
  try {
    const made = await target.writeExclusive((store) =>
      createDocumentFile({ store, privacy }, { format, folderId, name, bytes, operationId })
    );
    // También en un reintento: un corte entre el fichero y su cabecera se cura repitiendo.
    if (!(await ensureCreatedHead(target, format, made.fileId, made.sha256))) {
      logDocumentEvent({ event: 'document.write', action: 'create', format, outcome: 'error', code: 'doc_head_invalid' });
      return { ok: false, error: { code: 'doc_head_invalid' } };
    }
    logDocumentEvent({
      event: 'document.write',
      action: 'create',
      format,
      outcome: made.replayed ? 'already' : 'saved',
      ...(made.replayed ? { replayed: true as const } : {})
    });
    if (made.replayed) {
      return {
        ok: true,
        created: { id: made.fileId, sha256: made.sha256, outcome: 'already', replayed: true, sync: 'pending' }
      };
    }
    hooks.onWritten?.();
    const sync = await hooks.afterCommit();
    return { ok: true, created: { id: made.fileId, sha256: made.sha256, outcome: 'saved', ...sync } };
  } catch (error) {
    logDocumentEvent({ event: 'document.write', action: 'create', format, outcome: 'error', code: documentLogCode(error) });
    throw error;
  }
}

/**
 * Antes de duplicar `fileId`: si es un documento con cabecera, deja su punto de control al día
 * para que `files.sha256` lleve la última edición. Un fichero sin cabecera no se toca. Sin poder
 * exportar responde `file_unavailable`: nunca una copia con bytes viejos.
 */
export async function prepareDocumentCopy(
  target: DocumentServiceTarget,
  fileId: string,
  privacy: PrivacyConfig
): Promise<void> {
  const source = target.port.documentSource();
  // Oculto con cabecera: `not_found` en `documentBytesForCopy`. Oculto sin ella: lo da el verbo.
  const { head } = await source.port.docRead(fileId);
  if (!head) return;
  try {
    await documentBytesForCopy(source, fileId, {
      writeExclusive: (operation) => target.writeExclusive(operation),
      privacy
    });
    logDocumentEvent({ event: 'document.copy', outcome: 'ok' });
  } catch (error) {
    logDocumentEvent({ event: 'document.copy', outcome: 'error', code: documentLogCode(error) });
    if (error instanceof DocumentReadError) throw writeRejected('file_unavailable');
    throw error;
  }
}
