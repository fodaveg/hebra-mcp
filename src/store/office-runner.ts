/**
 * Hilo de conversión de ofimática del MCP (C-27, `hebra_import_office`). `analyze` y `convert`
 * de un convertidor de Hebra corren en un hilo aparte (`./office-worker.ts`, empaquetado como
 * `dist/office-worker.mjs`) que se puede matar, con tres cortes:
 *
 * - Una conversión a la vez en todo el proceso (D-13). Quien no entra en `OFFICE_QUEUE_WAIT_MS`
 *   (hueco y reserva de la compuerta juntos) recibe `ContextUnavailableError('capacity_wait_timeout')`
 *   sin que se arranque nada.
 * - Memoria: antes de arrancar aparta `OFFICE_CONVERSION_RESERVE_BYTES` más el tamaño de `bytes` (la copia que viaja por
 *   `workerData`, que C-07 no midió) en el `CapacityGate`
 *   (`admit(signal, bytes, key)`, la misma compuerta que el hilo de documentos) y la suelta con
 *   `done()` en todos los caminos: bien, mal, plazo o cancelación. Lo que protege el contenedor
 *   son esa reserva y `OFFICE_ZIP_LIMITS`, que el convertidor pasa a `readSafeZip`.
 *   `resourceLimits.maxOldGenerationSizeMb` acota solo el montón de JS del hilo: NO limita los
 *   `ArrayBuffer` ni `Uint8Array` donde `fflate` descomprime, y no es garantía de esa memoria.
 * - Plazo: `budgetMs` es el presupuesto cooperativo del convertidor (`createBudget`); pasado
 *   `OFFICE_HARD_CUT_GRACE_MS` más, `Worker.terminate()` lo corta en seco.
 *
 * Los errores son siempre `ConversionError` (contrato de importación) con un código cerrado;
 * nunca viaja el texto de un error del hilo, que podría repetir contenido del documento.
 */
import { Worker } from 'node:worker_threads';
import { ContextUnavailableError, type AdmissionTicket, type CapacityGate } from '../accounts/capacity';
import { realClock, type Clock } from '../accounts/lifecycle';
import { OFFICE_CONVERSION_RESERVE_BYTES, OFFICE_FILE_ID_MAX_BYTES } from '../server/tools/office-limits';
import {
  ConversionError,
  type ConversionFailureCode,
  type ConversionPreview,
  type ConversionResult,
  type OfficeFormat
} from '../../vendor/hebra/src/lib/office-import/types';

/** Presupuestos de cálculo por defecto: los de `ANALYZE_BUDGET_MS` y `CONVERT_BUDGET_MS` (D-11). */
export const OFFICE_ANALYZE_BUDGET_MS = 20_000;
export const OFFICE_CONVERT_BUDGET_MS = 60_000;
/** Lo que se añade al presupuesto antes del corte duro con `terminate()`. */
export const OFFICE_HARD_CUT_GRACE_MS = 5_000;
/** Espera de hueco y reserva juntos antes de `capacity_wait_timeout`. */
export const OFFICE_QUEUE_WAIT_MS = 20_000;
/** Montón de JS del hilo. No acota la memoria de los `ArrayBuffer` (ver arriba). */
export const OFFICE_WORKER_HEAP_MB = 128;

export type OfficeJobKind = 'analyze' | 'convert';

/** Lo que recibe el hilo como `workerData`. La señal no viaja: abortar mata el hilo. */
export interface OfficeJobData {
  kind: OfficeJobKind;
  input: { bytes: Uint8Array; fileName: string; format: OfficeFormat; budgetMs: number };
}

export interface OfficeConversionInput {
  bytes: Uint8Array;
  fileName: string;
  format: OfficeFormat;
  /** Presupuesto del convertidor; por defecto el de `kind`. */
  budgetMs?: number;
}

/** Fichero del hilo junto al empaquetado (`dist/office-worker.mjs`, C-38). */
export const OFFICE_WORKER_FILE = new URL('./office-worker.mjs', import.meta.url);

/** Arranca el hilo de un trabajo. Los tests pasan uno propio. */
export type OfficeWorkerFactory = (data: OfficeJobData, heapMb: number) => Worker;

const defaultWorkerFactory: OfficeWorkerFactory = (data, heapMb) =>
  new Worker(OFFICE_WORKER_FILE, {
    workerData: data,
    resourceLimits: { maxOldGenerationSizeMb: heapMb },
    stdout: true,
    stderr: true
  });

export interface OfficeConversionContext {
  /** La compuerta de capacidad de la cuenta. */
  gate: Pick<CapacityGate, 'admit'>;
  /** La cuenta que pide, para el turno rotatorio de la compuerta. */
  key: string;
  /** Cancela el trabajo: sale de la cola o mata el hilo. Rechaza con `ConversionError('cancelled')`. */
  signal?: AbortSignal;
}

export interface OfficeRunnerOptions {
  clock?: Clock;
  createWorker?: OfficeWorkerFactory;
  queueWaitMs?: number;
  reserveBytes?: number;
}

const CODES: readonly ConversionFailureCode[] = [
  'encrypted',
  'corrupt',
  'too_large',
  'unsupported_version',
  'cancelled',
  'internal'
];
const USER_MESSAGE_MAX_CHARS = 200;

const cancelled = (): ConversionError => new ConversionError('cancelled', 'La conversión se canceló.');
const internal = (): ConversionError => new ConversionError('internal', 'No se pudo convertir el documento.');

/** Convierte la respuesta de fallo del hilo en un `ConversionError` de código cerrado. */
function failureOf(reply: { code?: unknown; userMessage?: unknown }): ConversionError {
  const code = CODES.find((known) => known === reply.code);
  if (!code) return internal();
  const text = typeof reply.userMessage === 'string' ? reply.userMessage : '';
  return new ConversionError(code, text.length > 0 && text.length <= USER_MESSAGE_MAX_CHARS ? text : internal().userMessage);
}

/** Semáforo de UN hueco, con salida por aborto; los huecos van por orden de llegada. */
class SingleSlot {
  private busy = false;
  private readonly waiters: Array<() => void> = [];

  get active(): number {
    return this.busy ? 1 : 0;
  }

  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (!this.busy) {
      this.busy = true;
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

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.busy = false;
  }
}

/** Crea un ejecutor con su propia cola. `runOfficeConversion` usa el del proceso. */
export function createOfficeRunner(options: OfficeRunnerOptions = {}) {
  const clock = options.clock ?? realClock;
  const queueWaitMs = options.queueWaitMs ?? OFFICE_QUEUE_WAIT_MS;
  const reserveBytes = options.reserveBytes ?? OFFICE_CONVERSION_RESERVE_BYTES;
  const createWorker = options.createWorker ?? defaultWorkerFactory;
  const slot = new SingleSlot();

  /** Espera hueco y reserva dentro de `queueWaitMs`; devuelve lo que hay que soltar. */
  async function enter(context: OfficeConversionContext, bytes: number): Promise<() => void> {
    const queue = new AbortController();
    const cancelTimer = clock.setTimer(
      () => queue.abort(new ContextUnavailableError('capacity_wait_timeout', Math.max(1, Math.ceil(queueWaitMs / 1000)))),
      queueWaitMs
    );
    const onOuterAbort = (): void => queue.abort(cancelled());
    if (context.signal?.aborted) onOuterAbort();
    context.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const detach = (): void => {
      cancelTimer();
      context.signal?.removeEventListener('abort', onOuterAbort);
    };
    try {
      await slot.acquire(queue.signal);
    } catch (error) {
      detach();
      throw error;
    }
    let ticket: AdmissionTicket;
    try {
      ticket = await context.gate.admit(queue.signal, bytes, context.key);
    } catch (error) {
      detach();
      slot.release();
      throw error;
    }
    detach();
    return () => {
      ticket.done();
      slot.release();
    };
  }

  /** Corre el hilo hasta su respuesta, el corte o la cancelación. Siempre lo deja terminado. */
  function runInWorker(data: OfficeJobData, cutMs: number, signal: AbortSignal | undefined): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const worker = createWorker(data, OFFICE_WORKER_HEAP_MB);
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
      const onAbort = (): void => finish(() => reject(cancelled()));
      const cancelTimer = clock.setTimer(
        () => finish(() => reject(new ConversionError('too_large', 'El documento es demasiado grande para convertirlo.'))),
        cutMs
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.once('message', (reply: { ok?: boolean; result?: unknown; code?: unknown; userMessage?: unknown }) =>
        finish(() => (reply?.ok === true ? resolve(reply.result) : reject(failureOf(reply ?? {}))))
      );
      // Sin oyente, un `error` del hilo (sin memoria, por ejemplo) tumbaría el proceso.
      worker.once('error', () => finish(() => reject(internal())));
      worker.once('exit', () => finish(() => reject(internal())));
      if (signal?.aborted) onAbort();
    });
  }

  async function run(kind: 'analyze', input: OfficeConversionInput, context: OfficeConversionContext): Promise<ConversionPreview>;
  async function run(kind: 'convert', input: OfficeConversionInput, context: OfficeConversionContext): Promise<ConversionResult>;
  async function run(
    kind: OfficeJobKind,
    input: OfficeConversionInput,
    context: OfficeConversionContext
  ): Promise<ConversionPreview | ConversionResult> {
    if (input.bytes.byteLength > OFFICE_FILE_ID_MAX_BYTES) {
      throw new ConversionError('too_large', 'El documento es demasiado grande para convertirlo.');
    }
    // La copia de `bytes` por `workerData` no entra en los 118 MiB medidos en C-07: se suma.
    const release = await enter(context, reserveBytes + input.bytes.byteLength);
    try {
      const budgetMs = input.budgetMs ?? (kind === 'analyze' ? OFFICE_ANALYZE_BUDGET_MS : OFFICE_CONVERT_BUDGET_MS);
      const data: OfficeJobData = {
        kind,
        input: { bytes: input.bytes, fileName: input.fileName, format: input.format, budgetMs }
      };
      return (await runInWorker(data, budgetMs + OFFICE_HARD_CUT_GRACE_MS, context.signal)) as
        | ConversionPreview
        | ConversionResult;
    } finally {
      release();
    }
  }

  return {
    /** Conversiones con hueco ahora (diagnóstico y pruebas). */
    get active(): number {
      return slot.active;
    },
    run
  };
}

const processRunner = createOfficeRunner();

/**
 * Analiza o convierte un Office en el hilo, de una en una y con la reserva apartada en la
 * compuerta. Rechaza con `ConversionError` (código cerrado) o `ContextUnavailableError`
 * (`capacity_wait_timeout`, sin arrancar nada).
 */
export function runOfficeConversion(
  kind: 'analyze',
  input: OfficeConversionInput,
  context: OfficeConversionContext
): Promise<ConversionPreview>;
export function runOfficeConversion(
  kind: 'convert',
  input: OfficeConversionInput,
  context: OfficeConversionContext
): Promise<ConversionResult>;
export function runOfficeConversion(
  kind: OfficeJobKind,
  input: OfficeConversionInput,
  context: OfficeConversionContext
): Promise<ConversionPreview | ConversionResult> {
  return kind === 'analyze'
    ? processRunner.run('analyze', input, context)
    : processRunner.run('convert', input, context);
}
