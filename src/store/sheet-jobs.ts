/**
 * Cola de los trabajos de hojas de cálculo del MCP (H-95b): lo que aplica los topes medidos en
 * `./sheet-limits.ts` a las tres herramientas que abren un `.ods` entero (`hebra_read_sheet`,
 * `hebra_render_sheet` en su fase de lectura y `hebra_edit_sheet`).
 *
 * - Cola: como mucho `SHEET_JOBS_MAX` (uno) trabajos de hojas vivos en todo el proceso, sean de
 *   la herramienta que sean y de la cuenta que sean. Dos a la vez en los topes no caben en
 *   512 MiB (punto 3 de la cabecera de `./sheet-limits.ts`). Quien no entra en
 *   `DOCUMENT_QUEUE_WAIT_MS` recibe `DocumentJobError('document_busy')`.
 * - Memoria: `admitSheetJob` aparta además `sheetJobReserveBytes` en el `CapacityGate` de la
 *   cuenta, con la misma espera. `hebra_read_sheet` solo pide el hueco (`sheetJobSlot`): su
 *   reserva la aparta el hilo de documentos (`runDocumentJob` con `reserveBytes`).
 *
 * Lo que se suelta (`done`, o la función que devuelve `slot`) se puede llamar más de una vez: solo
 * cuenta la primera.
 */
import { ContextUnavailableError, type AdmissionTicket, type CapacityGate } from '../accounts/capacity';
import { realClock, type Clock } from '../accounts/lifecycle';
import { DocumentJobError, SlotQueue } from './document-jobs';
import { DOCUMENT_QUEUE_WAIT_MS } from './document-limits';
import { SHEET_JOBS_MAX, sheetJobReserveBytes } from './sheet-limits';

/** La compuerta de la cuenta y la cuenta, para su turno (la misma de `DocumentJobContext`). */
export interface SheetJobCapacity {
  gate: Pick<CapacityGate, 'admit'>;
  key: string;
}

export interface SheetJobQueueOptions {
  maxJobs?: number;
  queueWaitMs?: number;
  clock?: Clock;
}

/** Una función que solo hace algo la primera vez. */
function once(run: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    run();
  };
}

/** Crea una cola de hojas propia. La del proceso es `processSheetJobs`; los tests crean la suya. */
export function createSheetJobQueue(options: SheetJobQueueOptions = {}) {
  const clock = options.clock ?? realClock;
  const queueWaitMs = options.queueWaitMs ?? DOCUMENT_QUEUE_WAIT_MS;
  const slots = new SlotQueue(options.maxJobs ?? SHEET_JOBS_MAX);

  /**
   * Una espera acotada: aborta con `document_busy` al vencer `queueWaitMs` o con la razón de
   * `signal`. `detach` quita el plazo y el oyente cuando ya no se espera.
   */
  function waiting(signal: AbortSignal | undefined): { signal: AbortSignal; detach(): void } {
    const queue = new AbortController();
    const cancelTimer = clock.setTimer(() => queue.abort(new DocumentJobError('document_busy')), queueWaitMs);
    const onOuterAbort = (): void => queue.abort(signal?.reason);
    if (signal?.aborted) onOuterAbort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    return {
      signal: queue.signal,
      detach: () => {
        cancelTimer();
        signal?.removeEventListener('abort', onOuterAbort);
      }
    };
  }

  return {
    /** Trabajos de hojas con hueco ahora (diagnóstico y pruebas). */
    get active(): number {
      return slots.active;
    },

    /** Espera un hueco de la cola; devuelve con qué soltarlo. */
    async slot(signal?: AbortSignal): Promise<() => void> {
      const wait = waiting(signal);
      try {
        await slots.acquire(wait.signal);
      } finally {
        wait.detach();
      }
      return once(() => slots.release());
    },

    /**
     * Espera un hueco y aparta la reserva de un trabajo de hojas sobre un `.ods` de
     * `documentBytes`, las dos dentro de la misma espera. Por encima de `SHEET_DOCUMENT_MAX_BYTES`
     * lanza `RangeError` sin esperar: quien llama tiene que haber dado `file_too_large` antes.
     */
    async admit(capacity: SheetJobCapacity, documentBytes: number, signal?: AbortSignal): Promise<{ done(): void }> {
      const bytes = sheetJobReserveBytes(documentBytes);
      const wait = waiting(signal);
      let ticket: AdmissionTicket;
      try {
        await slots.acquire(wait.signal);
        try {
          ticket = await capacity.gate.admit(wait.signal, bytes, capacity.key);
        } catch (error) {
          slots.release();
          // La compuerta tiene su propia espera: agotarla es lo mismo que agotar la cola.
          throw error instanceof ContextUnavailableError ? new DocumentJobError('document_busy') : error;
        }
      } finally {
        wait.detach();
      }
      return {
        done: once(() => {
          ticket.done();
          slots.release();
        })
      };
    }
  };
}

const processSheetJobs = createSheetJobQueue();

/** Un hueco de la cola de hojas del proceso, sin reserva (la aparta quien corre el trabajo). */
export function sheetJobSlot(signal?: AbortSignal): Promise<() => void> {
  return processSheetJobs.slot(signal);
}

/** Un hueco de la cola de hojas del proceso y la reserva del trabajo en la compuerta de la cuenta. */
export function admitSheetJob(capacity: SheetJobCapacity, documentBytes: number, signal?: AbortSignal): Promise<{ done(): void }> {
  return processSheetJobs.admit(capacity, documentBytes, signal);
}
