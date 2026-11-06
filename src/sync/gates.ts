/**
 * Topes de sync de TODO el proceso (SPEC.md §12.10, "Sync al abrir"). En `serve-http` cada
 * biblioteca o espacio abierto tiene su `SyncRunner`; si cada uno llevara sus propios
 * semáforos, la memoria del sync crecería con el número de contextos abiertos (medido el
 * 6 nov 2026: una primera descarga de 5 000 notas sube +38 MiB, cinco a la vez +152 MiB).
 * Aquí viven los dos topes que lo evitan: rondas simultáneas y descargas de adjuntos
 * simultáneas, ambos con cola FIFO.
 */

/** Rondas de sync simultáneas de todo el proceso, por defecto. */
export const DEFAULT_SYNC_CONCURRENCY = 2;
/**
 * Descargas de adjuntos (`readBlob`) a la vez en TODO el proceso; el resto espera en cola, por
 * orden de llegada (tarea de Lumbre 342a931c). El 5 oct 2026 mcp.hebra.pro lanzó unos 253 GET de
 * Blob V2 en paralelo en 20 s y el relé respondió 429 a casi todos.
 */
export const BLOB_DOWNLOAD_CONCURRENCY = 4;

/** Semáforo con cola FIFO: `acquire` resuelve con la función que libera la plaza. */
export class FifoSemaphore {
  private active = 0;
  private readonly waiting: Array<{ grant: () => void }> = [];

  constructor(private readonly limit: number) {}

  /**
   * Espera turno. Con `signal`, si se aborta mientras espera, sale de la cola SIN cogerlo y
   * resuelve `null` (quien llama no ejecuta nada ni tiene que liberar). Un `signal` ya
   * abortado resuelve `null` al momento. Liberar es idempotente.
   */
  acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const entry = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          this.active += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active -= 1;
            this.waiting.shift()?.grant();
          });
        }
      };
      const onAbort = (): void => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        resolve(null);
      };
      if (this.active < this.limit) {
        entry.grant();
      } else {
        this.waiting.push(entry);
        signal?.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /** Plazas cogidas ahora (tests y diagnóstico). */
  get inUse(): number {
    return this.active;
  }

  /** Peticiones esperando turno ahora. */
  get queued(): number {
    return this.waiting.length;
  }
}

export interface SyncGates {
  /** Rondas de sync (`SyncRunner.execute`) simultáneas. */
  rounds: FifoSemaphore;
  /** Descargas de adjuntos (`SyncRunner.readBlob`) simultáneas. */
  downloads: FifoSemaphore;
}

export function createSyncGates(
  rounds: number = DEFAULT_SYNC_CONCURRENCY,
  downloads: number = BLOB_DOWNLOAD_CONCURRENCY
): SyncGates {
  return { rounds: new FifoSemaphore(rounds), downloads: new FifoSemaphore(downloads) };
}

let processGates: SyncGates = createSyncGates();

/** Los topes del proceso, que comparten todos los runners que no reciban otros. */
export function processSyncGates(): SyncGates {
  return processGates;
}

/**
 * Fija el tope de rondas del proceso. Se llama una vez al arrancar `serve-http`, antes de abrir
 * ningún contexto; los runners que ya existan conservan los topes con los que nacieron.
 */
export function configureProcessSyncGates(rounds: number): void {
  processGates = createSyncGates(rounds);
}
