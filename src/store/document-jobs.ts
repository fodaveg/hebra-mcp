/**
 * Cola e hilo de los trabajos de documentos (`.ods`, `.odp`) del MCP (estudio MCP de
 * documentos, apartado 4). Un trabajo (leer, editar, pintar) corre en un hilo aparte que se
 * puede matar, con tres cortes:
 *
 * - Cola: como mucho `DOCUMENT_JOBS_MAX` trabajos vivos en todo el proceso. Quien no entra en
 *   `DOCUMENT_QUEUE_WAIT_MS` (cola propia y reserva de la compuerta juntas) recibe
 *   `document_busy` sin que se arranque nada.
 * - Memoria: antes de arrancar aparta su reserva en el `CapacityGate` de la cuenta
 *   (`admit(signal, bytes, key)`, la misma compuerta y la misma fórmula que la conversión de
 *   ofimática) y la suelta con `done()` en todos los caminos: bien, mal, plazo o cancelación.
 * - Plazo: `DOCUMENT_READ_TIMEOUT_MS` para leer y pintar, `DOCUMENT_EDIT_TIMEOUT_MS` para
 *   editar. Al agotarse, `Worker.terminate()`.
 *
 * Los errores llevan solo un código cerrado, nunca texto del hilo: podría repetir contenido
 * del documento.
 */
import { Worker } from 'node:worker_threads';
import { ContextUnavailableError, type AdmissionTicket, type CapacityGate } from '../accounts/capacity';
import { realClock, type Clock } from '../accounts/lifecycle';
import {
  DOCUMENT_EDIT_TIMEOUT_MS,
  DOCUMENT_JOBS_MAX,
  DOCUMENT_QUEUE_WAIT_MS,
  DOCUMENT_READ_TIMEOUT_MS,
  DOCUMENT_WORKER_HEAP_MAX_BYTES,
  DOCUMENT_XML_INFLATED_MAX_BYTES
} from './document-limits';

const MIB = 1024 * 1024;

/** Tipos de trabajo. El render no está aquí: `renderSvgToPng` tiene su propio hilo (B-LR21). */
export type DocumentJobKind = 'read' | 'edit';

export type DocumentJobErrorCode = 'document_busy' | 'document_timeout' | 'document_job_failed';

export class DocumentJobError extends Error {
  constructor(readonly code: DocumentJobErrorCode) {
    super(code);
    this.name = 'DocumentJobError';
  }
}

/**
 * Lo que aparta un trabajo en la compuerta: el documento, sus partes XML descomprimidas (el
 * tope de `DOCUMENT_XML_INFLATED_MAX_BYTES`) y la salida, que no pasa del tamaño del documento.
 * Con el tope de 25 MiB son los 114 MiB del estudio. Provisional hasta que `C-07` y `V-01`
 * midan; la conversión de ofimática (`C-27`) usa la misma fórmula.
 */
export function documentReserveBytes(documentBytes: number): number {
  return 2 * Math.max(0, documentBytes) + DOCUMENT_XML_INFLATED_MAX_BYTES;
}

/** Fichero del hilo junto al empaquetado (`dist/document-worker.mjs`, `B-I01`). */
export const DOCUMENT_WORKER_FILE = new URL('./document-worker.mjs', import.meta.url);

export interface DocumentJobData {
  kind: DocumentJobKind;
  input: unknown;
}

/** Arranca el hilo de un trabajo. Los tests pasan uno propio. */
export type DocumentWorkerFactory = (data: DocumentJobData, heapMb: number) => Worker;

const defaultWorkerFactory: DocumentWorkerFactory = (data, heapMb) =>
  new Worker(DOCUMENT_WORKER_FILE, {
    workerData: data,
    resourceLimits: { maxOldGenerationSizeMb: heapMb },
    stdout: true,
    stderr: true
  });

export interface DocumentJobContext {
  /** La compuerta de capacidad de la cuenta. */
  gate: Pick<CapacityGate, 'admit'>;
  /** La cuenta que pide, para el turno rotatorio de la compuerta. */
  key: string;
  /** Tamaño del documento en bytes; fija la reserva (`documentReserveBytes`). */
  documentBytes?: number;
  /**
   * Lo que aparta en la compuerta, si el tipo de documento tiene su propia cifra medida (las
   * hojas: `sheetJobReserveBytes` de `./sheet-limits.ts`, H-95b). Sin él, `documentReserveBytes`.
   */
  reserveBytes?: number;
  /** Cancela el trabajo: sale de la cola o mata el hilo. Rechaza con `signal.reason`. */
  signal?: AbortSignal;
  /** Cambia el plazo por tipo (pruebas). */
  timeoutMs?: number;
}

export interface DocumentJobRunnerOptions {
  maxJobs?: number;
  queueWaitMs?: number;
  clock?: Clock;
  createWorker?: DocumentWorkerFactory;
}

/**
 * Semáforo de huecos con espera acotada y salida por aborto; los huecos van por orden de llegada.
 * Lo usa también la cola de los trabajos de hojas (`./sheet-jobs.ts`).
 */
export class SlotQueue {
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  get active(): number {
    return this.inUse;
  }

  /** Espera un hueco; si `signal` aborta antes, sale de la cola y rechaza con su razón. */
  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.inUse < this.max) {
      this.inUse += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      this.waiters.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Pasa el hueco al primero de la cola; sin cola, lo libera. */
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.inUse -= 1;
  }
}

/**
 * Crea un ejecutor con su propia cola. `runDocumentJob` usa el del proceso; los tests crean uno
 * con reloj y hilo simulados.
 */
export function createDocumentJobRunner(options: DocumentJobRunnerOptions = {}) {
  const clock = options.clock ?? realClock;
  const queueWaitMs = options.queueWaitMs ?? DOCUMENT_QUEUE_WAIT_MS;
  const createWorker = options.createWorker ?? defaultWorkerFactory;
  const slots = new SlotQueue(options.maxJobs ?? DOCUMENT_JOBS_MAX);

  /** Espera hueco y reserva dentro de `queueWaitMs`; devuelve lo que hay que soltar. */
  async function enter(
    context: DocumentJobContext
  ): Promise<{ ticket: AdmissionTicket; leave(): void }> {
    const busy = new DocumentJobError('document_busy');
    const queue = new AbortController();
    const cancelTimer = clock.setTimer(() => queue.abort(busy), queueWaitMs);
    const onOuterAbort = (): void => queue.abort(context.signal?.reason);
    if (context.signal?.aborted) onOuterAbort();
    context.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const detach = (): void => {
      cancelTimer();
      context.signal?.removeEventListener('abort', onOuterAbort);
    };
    try {
      await slots.acquire(queue.signal);
    } catch (error) {
      detach();
      throw error;
    }
    let ticket: AdmissionTicket;
    try {
      const bytes = context.reserveBytes ?? documentReserveBytes(context.documentBytes ?? 0);
      ticket = await context.gate.admit(queue.signal, bytes, context.key);
    } catch (error) {
      detach();
      slots.release();
      // La compuerta tiene su propia espera: agotarla es lo mismo que agotar la cola.
      throw error instanceof ContextUnavailableError ? busy : error;
    }
    detach();
    return { ticket, leave: () => { ticket.done(); slots.release(); } };
  }

  /** Corre el hilo hasta su respuesta, el plazo o la cancelación. Siempre lo deja terminado. */
  function runInWorker(
    data: DocumentJobData,
    timeoutMs: number,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const worker = createWorker(data, Math.ceil(DOCUMENT_WORKER_HEAP_MAX_BYTES / MIB));
      worker.unref();
      let settled = false;
      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        cancelTimer();
        signal?.removeEventListener('abort', onAbort);
        void worker.terminate();
        settle();
      };
      const onAbort = (): void => finish(() => reject(signal?.reason));
      const cancelTimer = clock.setTimer(
        () => finish(() => reject(new DocumentJobError('document_timeout'))),
        timeoutMs
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.once('message', (reply: { ok?: boolean; result?: unknown; code?: string }) =>
        finish(() => (reply?.ok === true ? resolve(reply.result) : reject(new DocumentJobError('document_job_failed'))))
      );
      // Sin oyente, un `error` del hilo (sin memoria, por ejemplo) tumbaría el proceso.
      worker.once('error', () => finish(() => reject(new DocumentJobError('document_job_failed'))));
      worker.once('exit', () => finish(() => reject(new DocumentJobError('document_job_failed'))));
      if (signal?.aborted) onAbort();
    });
  }

  return {
    /** Trabajos con hueco ahora (diagnóstico y pruebas). */
    get active(): number {
      return slots.active;
    },
    async run(kind: DocumentJobKind, input: unknown, context: DocumentJobContext): Promise<unknown> {
      const { leave } = await enter(context);
      try {
        const timeoutMs =
          context.timeoutMs ?? (kind === 'edit' ? DOCUMENT_EDIT_TIMEOUT_MS : DOCUMENT_READ_TIMEOUT_MS);
        return await runInWorker({ kind, input }, timeoutMs, context.signal);
      } finally {
        leave();
      }
    }
  };
}

const processRunner = createDocumentJobRunner();

/**
 * Corre un trabajo de documentos en el hilo. Rechaza con `DocumentJobError`
 * (`document_busy`, `document_timeout`, `document_job_failed`) o con la razón de `signal`.
 */
export function runDocumentJob(
  kind: DocumentJobKind,
  input: unknown,
  context: DocumentJobContext
): Promise<unknown> {
  return processRunner.run(kind, input, context);
}
