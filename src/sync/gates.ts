/**
 * Topes de sync de TODO el proceso (SPEC.md §12.10, "Sync al abrir"). En `serve-http` cada
 * biblioteca o espacio abierto tiene su `SyncRunner`; si cada uno llevara sus propios
 * semáforos, la memoria del sync crecería con el número de contextos abiertos (medido el
 * 6 nov 2026: una primera descarga de 5 000 notas sube +38 MiB, cinco a la vez +152 MiB).
 * Aquí viven los dos topes que lo evitan: rondas simultáneas y descargas de adjuntos
 * simultáneas, ambos con turno rotatorio por cuenta (FIFO dentro de cada cuenta).
 */
import { createHash } from 'node:crypto';

/** Rondas de sync simultáneas de todo el proceso, por defecto. */
export const DEFAULT_SYNC_CONCURRENCY = 2;
/**
 * Descargas de adjuntos (`readBlob`) a la vez en TODO el proceso; el resto espera en cola, por
 * orden de llegada (tarea de Lumbre 342a931c). El 5 oct 2026 mcp.hebra.pro lanzó unos 253 GET de
 * Blob V2 en paralelo en 20 s y el relé respondió 429 a casi todos.
 */
export const BLOB_DOWNLOAD_CONCURRENCY = 4;

/** Clave de cuenta por defecto: stdio, tests y todo runner al que nadie le dio otra. */
export const DEFAULT_ACCOUNT_KEY = 'default';

/**
 * La clave OPACA de una cuenta de `serve-http` para el turno rotatorio de los topes de sync: un
 * hash del id interno de la cuenta del registro (nunca el `sub` ni el email). La calcula quien
 * conoce la cuenta (`serve-http`, al abrir su contexto) y la reciben su biblioteca personal y
 * todos sus espacios, sea cual sea el directorio en que vivan.
 */
export function accountTurnKey(accountId: string): string {
  return createHash('sha256').update(`hebra-mcp:turn:${accountId}`).digest('hex').slice(0, 16);
}

/**
 * La última entrada de las cuentas cuyo turno se borró, para que una cuenta secuencial (un
 * cliente MCP normal: espera la respuesta antes de mandar la siguiente llamada, así que entre
 * dos llamadas no tiene nada en curso) no vuelva como recién llegada con `lastServed` 0 y gane
 * siempre a las que esperan (revisión de seguridad del 6 nov 2026: dos cuentas secuenciales se
 * llevaban 2 652 plazas frente a 6 de una con cinco llamadas en paralelo, que agotaba esperas).
 * Lo usan `FifoSemaphore` y `CapacityGate` (`src/accounts/capacity.ts`).
 *
 * Poda: al guardar, se quitan las entradas por debajo del menor `lastServed` de los turnos vivos
 * (con esperas o con algo dentro), y todas si no queda ninguno. Una cuenta así lleva más sin
 * entrar que todas las que siguen ahí, y con su entrada o con 0 les gana igual: podarla no cambia
 * el orden frente a nadie que esté. Frente a una recién llegada que aún no entró, empatan a 0 y
 * decide el orden de llegada. Queda como mucho una entrada por cuenta, y solo las posteriores a la
 * entrada más antigua de un turno vivo: sin turnos vivos, ninguna; en el peor caso (un turno vivo
 * con una llamada muy larga), las cuentas distintas que entraron mientras.
 */
export class TurnHistory {
  private readonly lastServed = new Map<string, number>();

  /** Lo que recupera una cuenta al volver: su última entrada guardada (y se borra), o 0. */
  take(key: string): number {
    const value = this.lastServed.get(key) ?? 0;
    this.lastServed.delete(key);
    return value;
  }

  /** Guarda la última entrada de `key`, cuyo turno se acaba de borrar, y poda frente a los
   *  `lastServed` de los turnos vivos que quedan (`live`). */
  remember(key: string, served: number, live: Iterable<number>): void {
    if (served > 0) this.lastServed.set(key, served);
    let floor = Infinity;
    for (const value of live) if (value < floor) floor = value;
    if (floor === Infinity) {
      this.lastServed.clear();
      return;
    }
    for (const [account, value] of this.lastServed) {
      if (value < floor) this.lastServed.delete(account);
    }
  }

  clear(): void {
    this.lastServed.clear();
  }

  /** Cuántas cuentas recuerda ahora (diagnóstico y pruebas). */
  get size(): number {
    return this.lastServed.size;
  }
}

interface Waiter {
  grant: () => void;
}

interface AccountState {
  /** Plazas que esta cuenta tiene cogidas ahora. */
  active: number;
  /** Número de orden de su último turno concedido, también el de antes de olvidarla
   *  (`TurnHistory`); 0 si nunca, o si el historial lo podó. */
  lastServed: number;
  /** Peticiones de esta cuenta esperando, FIFO. */
  queue: Waiter[];
}

/**
 * Semáforo con turno rotatorio por cuenta (B4 de la revisión de seguridad del 6 nov 2026):
 * cuando se libera una plaza, la recibe la cuenta con peticiones en espera cuyo último turno
 * fue hace más tiempo (una cuenta que nunca entró va primero); dentro de cada cuenta, orden de
 * llegada. Una cuenta con muchas peticiones no retrasa a las demás más de un turno, y una que
 * pide de una en una conserva su último turno entre petición y petición (`TurnHistory`). Con una
 * sola cuenta es un FIFO normal. `acquire` resuelve con la función que libera la plaza.
 */
export class FifoSemaphore {
  private active = 0;
  private served = 0;
  private waitingCount = 0;
  private readonly accounts = new Map<string, AccountState>();
  private readonly history = new TurnHistory();

  constructor(private readonly limit: number) {}

  /**
   * Espera turno. Con `signal`, si se aborta mientras espera, sale de la cola SIN cogerlo y
   * resuelve `null` (quien llama no ejecuta nada ni tiene que liberar). Un `signal` ya
   * abortado resuelve `null` al momento. Liberar es idempotente. `accountKey` es opaco.
   */
  acquire(signal?: AbortSignal, accountKey: string = DEFAULT_ACCOUNT_KEY): Promise<(() => void) | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const state = this.stateOf(accountKey);
      const entry: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          this.active += 1;
          state.active += 1;
          this.served += 1;
          state.lastServed = this.served;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active -= 1;
            state.active -= 1;
            this.forget(accountKey, state);
            this.grantNext();
          });
        }
      };
      const onAbort = (): void => {
        const index = state.queue.indexOf(entry);
        if (index >= 0) {
          state.queue.splice(index, 1);
          this.waitingCount -= 1;
        }
        this.forget(accountKey, state);
        resolve(null);
      };
      if (this.active < this.limit && this.waitingCount === 0) {
        entry.grant();
      } else {
        state.queue.push(entry);
        this.waitingCount += 1;
        signal?.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private stateOf(key: string): AccountState {
    let state = this.accounts.get(key);
    if (!state) {
      state = { active: 0, lastServed: this.history.take(key), queue: [] };
      this.accounts.set(key, state);
    }
    return state;
  }

  /** Olvida a la cuenta cuando no tiene plazas ni peticiones (el mapa no crece con las cuentas
   *  vistas), pero su último turno pasa al historial, que se poda. */
  private forget(key: string, state: AccountState): void {
    if (state.active === 0 && state.queue.length === 0 && this.accounts.get(key) === state) {
      this.accounts.delete(key);
      this.history.remember(key, state.lastServed, [...this.accounts.values()].map((live) => live.lastServed));
    }
  }

  private grantNext(): void {
    while (this.active < this.limit && this.waitingCount > 0) {
      let next: AccountState | null = null;
      for (const state of this.accounts.values()) {
        if (state.queue.length === 0) continue;
        if (next === null || state.lastServed < next.lastServed) next = state;
      }
      if (!next) return;
      this.waitingCount -= 1;
      next.queue.shift()!.grant();
    }
  }

  /** Plazas cogidas ahora (tests y diagnóstico). */
  get inUse(): number {
    return this.active;
  }

  /** Peticiones esperando turno ahora. */
  get queued(): number {
    return this.waitingCount;
  }

  /** Cuentas sin nada en curso cuyo último turno se recuerda ahora (tests y diagnóstico). */
  get remembered(): number {
    return this.history.size;
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
