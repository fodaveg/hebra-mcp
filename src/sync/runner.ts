/**
 * Bucle de sync de hebra-mcp (SPEC.md §8, L3) sobre el motor de Hebra SIN cambios
 * (`LibrarySyncEngine`, por `node.ts` de Hebra) y la vista `SyncStorePort` del
 * almacén (`src/store/sync-port.ts`).
 *
 * Ritmo (§8):
 * - Una ronda al arrancar (`start`); las lecturas pueden esperarla con `whenReady`, que
 *   nunca tarda más de 10 s por defecto y nunca rechaza.
 * - Una ronda cada 30 s mientras el runner vive: el proceso en `serve`, y en `serve-http` lo
 *   que dure abierto su contexto (D22, §12.10).
 * - Una ronda justo después de cada escritura (`requestRound`).
 * - Al cerrar, una ronda más si quedan subidas pendientes (`finalRound`, D22).
 * Nunca hay dos rondas solapadas: si se pide una con otra en vuelo, se encadena UNA
 * detrás (todas las peticiones de mientras comparten esa), porque la que está en vuelo
 * puede haber subido ya y no llevarse la escritura recién hecha.
 *
 * Revocación (§6.2, D24): un 401/403 del relé (o el 401 al registrar la clave de agente, que
 * avisa con `markRevoked`) deja `revoked: true` y para el bucle de 30 s. Desactivar el agente en
 * Ajustes de Hebra y volver a activarlo hace que la MISMA credencial vuelva a valer, así que el
 * runner no se queda parado: reintenta una ronda con espera creciente (`REVOKED_RETRY_FIRST_MS`,
 * el doble en cada intento fallido, tope `REVOKED_RETRY_MAX_MS`). Mientras tanto ninguna
 * escritura pide ronda al relé (`requestRound` da `null`), para no hacer ruido. En cuanto una
 * ronda vuelve a ir bien, `revoked` pasa a `false`, sale `pairing.restored`, vuelve el bucle de
 * 30 s y avisa a quien escuche (`onRevocationChange`), que reabre el sync de los espacios. Esa
 * misma ronda sube lo pendiente. Sin reiniciar ni volver a emparejar.
 *
 * Logs (§6.4): solo los eventos cerrados del motor (`sync.round`, `sync.lease_lost`,
 * `sync.record_error`, `sync.conflict_copy`, `sync.blob_unreadable`) y los dos de la credencial
 * (`pairing.revoked`, `pairing.restored`), con ids opacos, códigos y recuentos, por
 * una función `emit` que inyecta quien crea el runner (el logger es de L1).
 *
 * Credenciales, clave de biblioteca e identidad llegan por parámetro: el emparejado y el
 * llavero son L2.
 */
import {
  BlobRelayV2Error,
  HttpBlobRelayV2,
  HttpLibraryTransport,
  LibrarySyncEngine,
  ReadBlobStageError,
  type BlobRelayConnectionProviderV2,
  type LibraryBlobTransport,
  type LibrarySyncEvent,
  type LibrarySyncResultCode,
  type LibraryTransport,
  type SyncEngineIdentity,
  type SyncRoundResult
} from '../hebra';
import type { SyncStorePort } from '../store/sync-port';
import {
  BLOB_DOWNLOAD_CONCURRENCY,
  DEFAULT_ACCOUNT_KEY,
  processSyncGates,
  type SyncGates
} from './gates';

export const SYNC_INTERVAL_MS = 30_000;
export const STARTUP_READ_WAIT_MS = 10_000;
/** Primera espera del reintento tras una revocación (D24): 1 min. */
export const REVOKED_RETRY_FIRST_MS = 60_000;
/** Tope de esa espera, que se dobla en cada intento fallido (D24): 15 min. */
export const REVOKED_RETRY_MAX_MS = 15 * 60_000;

/** Espera antes del siguiente reintento con la credencial revocada, tras `failedRetries`
 *  intentos fallidos seguidos: 1, 2, 4, 8 y luego 15 min para siempre. */
export function revokedRetryDelayMs(failedRetries: number): number {
  return Math.min(REVOKED_RETRY_FIRST_MS * 2 ** Math.max(0, failedRetries), REVOKED_RETRY_MAX_MS);
}

/**
 * Los temporizadores del runner: el bucle de 30 s (`every`) y el reintento tras una revocación
 * (`after`). Cada uno devuelve la función que lo cancela. `run` devuelve la ronda que pide, para
 * que un test que lo dispara a mano pueda esperarla. Por defecto, `setInterval` y `setTimeout`
 * que no mantienen vivo el proceso; los tests inyectan uno que se dispara a mano.
 */
export interface SyncScheduler {
  every(ms: number, run: () => Promise<unknown>): () => void;
  after(ms: number, run: () => Promise<unknown>): () => void;
}

/** Un disparo del temporizador real: la ronda nunca rechaza, pero un fallo no queda suelto. */
const fire = (run: () => Promise<unknown>) => () => void run().catch(() => undefined);

const REAL_SCHEDULER: SyncScheduler = {
  every(ms, run) {
    const timer = setInterval(fire(run), ms);
    // El intervalo no mantiene vivo el proceso: lo mantiene el transporte MCP.
    timer.unref?.();
    return () => clearInterval(timer);
  },
  after(ms, run) {
    const timer = setTimeout(fire(run), ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  }
};
/**
 * Cuánto espera el cierre de un contexto a su ronda final (D22, §12.10). Lo que no suba en ese
 * plazo ya está anotado en la lista durable (`src/accounts/pending-sweep.ts`) y lo reintenta el
 * barrido. Corto porque va dentro del apagado del contenedor: `HTTP_DRAIN_TIMEOUT_MS` (12 s), este
 * plazo y lo que le quede a una ronda en vuelo tienen que caber en sus 50 s de `stop_grace_period`.
 * Con el relé colgado en el peor momento puede pasarse unos segundos; un SIGKILL ahí no pierde
 * nada, porque la escritura ya está en la SQLite y la lista ya la nombra.
 */
export const CLOSE_ROUND_WAIT_MS = 10_000;
/**
 * La misma espera cuando el proceso se apaga: 12 s de drenaje HTTP + 5 + 30 de `stop()` = 47 s
 * caben en los 50 s de `stop_grace_period`. Lo que no suba queda en la SQLite y en la lista
 * durable, y el barrido lo recoge al arrancar.
 */
export const SHUTDOWN_ROUND_WAIT_MS = 5_000;

/**
 * Subidas que un reintento aún puede sacar adelante: las pendientes menos los registros que el
 * motor ya apartó con su error (`record_too_large`…), que no cambian por repetir la ronda. Sin
 * esto, un solo registro imposible haría que el barrido abriera esa cuenta cada minuto para
 * siempre. `blob_too_large` no se resta: esos adjuntos ya no cuentan en `pendingUpload`.
 */
export function retryableUploads(status: {
  pendingUpload: number | null;
  errorsByCode: Record<string, number> | null;
}): number {
  let parked = 0;
  for (const [code, count] of Object.entries(status.errorsByCode ?? {})) {
    if (code !== 'blob_too_large') parked += count;
  }
  return Math.max(0, (status.pendingUpload ?? 0) - parked);
}

/**
 * ¿Repetir la ronda no va a arreglar esto? Credencial revocada, o una bóveda que no es la de esta
 * biblioteca: hace falta que alguien cambie algo. El barrido no abre esa cuenta cada minuto para
 * oír lo mismo (`UploadLedgerState`). Lo demás (relé caído, 429, cuota) se reintenta.
 */
export function retryIsUseless(status: {
  revoked: boolean | null;
  lastSyncOutcome: string | null;
}): boolean {
  return (
    status.revoked === true ||
    status.lastSyncOutcome === 'library_binding_mismatch' ||
    status.lastSyncOutcome === 'library_merge_refused'
  );
}

export { BLOB_DOWNLOAD_CONCURRENCY };
/** Reintentos de una descarga que recibe 429, después del primer intento. */
export const BLOB_DOWNLOAD_RETRIES = 3;
/** Espera antes de cada reintento si el 429 no trae `Retry-After`. */
export const BLOB_DOWNLOAD_BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000];
/** Tope de la espera que pide un `Retry-After`. */
export const BLOB_RETRY_AFTER_MAX_MS = 30_000;

/** ¿El relé respondió 429 al bajar el objeto? El motor envuelve el fallo de `getObject`
 *  en `ReadBlobStageError` y el transporte lo da como `BlobRelayV2Error` con el estado HTTP
 *  y, si vino, el `Retry-After` ya en ms. */
function rateLimitOf(error: unknown): { retryAfterMs: number | undefined } | null {
  if (!(error instanceof ReadBlobStageError) || error.stage !== 'getObject') return null;
  const cause = error.cause;
  if (!(cause instanceof BlobRelayV2Error)) return null;
  if (cause.httpStatus !== 429 && cause.code !== 'rate_limited') return null;
  return { retryAfterMs: cause.retryAfterMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Una espera no mantiene vivo el proceso.
    timer.unref?.();
  });
}

/** Los eventos del catálogo cerrado de §6.4. `sync.blob_unreadable` llegó con el
 *  submódulo en `59b5d403`: un adjunto pendiente sin bytes válidos, solo su tamaño. */
export type SyncLogEventName =
  | 'sync.round'
  | 'sync.lease_lost'
  | 'sync.record_error'
  | 'sync.records_without_rev'
  | 'sync.conflict_copy'
  | 'sync.blob_unreadable'
  // §27.4 (RT-2c de Hebra): una nota de espacio no se pudo combinar y salió la copia; solo el
  // motivo cerrado. Va junto a `sync.conflict_copy`.
  | 'sync.space_merge_copy'
  // §27.3 punto 3: el `ydoc` de una nota de espacio recibida no se leyó o se ignoró; solo el motivo.
  | 'sync.ydoc_unreadable'
  // La credencial de emparejado está revocada (SPEC.md §12.9): una vez, al primer 401/403.
  | 'pairing.revoked'
  // La credencial vuelve a valer (D24): una vez, en la primera ronda correcta tras revocarse.
  | 'pairing.restored';

/** Campos de un evento: escalares, sin contenido de notas. */
export type SyncLogFields = Record<string, string | number | boolean | null>;

export type SyncEmit = (event: SyncLogEventName, fields: SyncLogFields) => void;

/**
 * Estado de sync para `hebra_status` (SPEC.md §5). `linked` y `writer` no son del
 * runner (emparejado, L2; bloqueo, `src/lock/`): los añade quien compone la respuesta.
 * L1 tiene su propio `StatusSource`; los nombres se alinean al fusionar.
 */
export interface SyncStatusSnapshot {
  /** Fin de la última ronda terminada (ISO 8601), o `null` si aún no hubo ninguna. */
  lastSyncAt: string | null;
  /** Resultado cerrado de esa ronda (`ok`, `offline`, `http_401`…). */
  lastSyncOutcome: LibrarySyncResultCode | null;
  /** Registros sucios + adjuntos por subir, medidos en el almacén ahora. */
  pendingUpload: number;
  /** Registros con error en el almacén, por código (`record_too_large`…). */
  errorsByCode: Record<string, number>;
  revoked: boolean;
}

export interface SyncStatusSource {
  syncStatus(): Promise<SyncStatusSnapshot>;
}

export interface SyncConflictCopy {
  recordId: string;
  copyId: string;
}

export interface SyncRunnerOptions {
  /** La vista de sync del almacén (`NodeLibraryPort.syncStorePort()`). */
  port: SyncStorePort;
  identity: SyncEngineIdentity;
  /** Clave de biblioteca (32 bytes), del código de recuperación (L2). */
  vaultKey: Uint8Array;
  /** `keyEpoch` está fijo a 1 en todo Hebra (SPEC.md §6.2). */
  keyEpoch?: number;
  /** H-L7: cuenta del miembro, dentro del sobre de espacio. El relé sella al agente. */
  spaceEnvelope?: { authorId: string } | null;
  /** Transporte inyectado (tests: `InMemoryLibraryRelay` de Hebra). Si falta, se usa
   *  `HttpLibraryTransport` con `connection`. */
  transport?: LibraryTransport;
  /** Credencial del relé (`apiOrigin`, `readToken`, `writeToken`), para el transporte
   *  HTTP por defecto. */
  connection?: BlobRelayConnectionProviderV2;
  /** `fetch` del transporte HTTP por defecto (tests). */
  fetcher?: typeof globalThis.fetch;
  /** Objetos de Blob V2, para bajar adjuntos bajo demanda (`readBlob`, adjuntos en solo
   *  lectura, 30 sep 2026). Si falta y hay `connection`, `HttpBlobRelayV2` sobre ella,
   *  como Hebra (`LibraryApp.svelte`); `null` lo desactiva (solo texto). */
  blobTransport?: LibraryBlobTransport | null;
  emit?: SyncEmit;
  /** Resultado cerrado de cada `readBlob` (log `attachment.fetch`; tests). */
  emitAttachment?: (outcome: 'ok' | 'missing' | 'error' | 'revoked') => void;
  /** Cada cuánto hay ronda periódica; `null` la desactiva (tests). Con `null` y sin `scheduler`
   *  tampoco hay reintento solo tras una revocación: el test mueve las rondas a mano. */
  intervalMs?: number | null;
  /** Temporizadores del bucle y del reintento (D24). Por defecto, los reales. */
  scheduler?: SyncScheduler;
  /**
   * Cada vez que la credencial pasa a revocada (`true`) o vuelve a valer (`false`), después de
   * cambiar `revoked`. `serve` lo usa para reabrir el sync de los espacios al recuperarla. Un
   * oyente que lanza no para el sync.
   */
  onRevocationChange?: (revoked: boolean) => void;
  now?: () => number;
  /**
   * Antes de cada ronda, con el almacén aún como lo dejó la anterior. El escritor anota aquí
   * a qué carpetas resuelven las rutas privadas (A3 del audit de privacidad, 10 oct 2026:
   * `privacyWithMemory`), para que una ronda que trae la carpeta privada movida y otra con
   * su nombre no la destape aunque nadie haya llamado a una herramienta entre medias. Un
   * fallo aquí no para la ronda.
   */
  beforeRound?: () => Promise<void>;
  /** Plazo de `whenReady` y `finalRound`. Por defecto, un `setTimeout`; los tests lo sustituyen
   *  para comprobar la espera sin esperarla. */
  waitTimer?: (ms: number) => Promise<void>;
  /**
   * Topes de proceso (rondas y descargas simultáneas; `./gates`). Por defecto, los del proceso,
   * que comparten todos los runners de `serve-http`; los tests inyectan los suyos.
   */
  gates?: SyncGates;
  /**
   * Clave OPACA de la cuenta de este runner, para el turno rotatorio de los topes de proceso
   * (B4): ni el `sub` ni el email. Por defecto, una sola cuenta (stdio y tests).
   */
  accountKey?: string;
}

function isRevocation(result: LibrarySyncResultCode): boolean {
  return result === 'http_401' || result === 'http_403';
}

/** Traduce un evento del motor a nombre + campos planos, sin nada de contenido. */
function logFieldsOf(event: LibrarySyncEvent): SyncLogFields {
  switch (event.event) {
    case 'sync.round': {
      const { event: _event, failure, ...counters } = event;
      const fields: SyncLogFields = { ...counters };
      if (failure) {
        fields.failureOp = failure.op;
        fields.failurePhase = failure.phase;
        fields.failureErrorName = failure.errorName;
        fields.failureFetchKind = failure.fetchKind;
        fields.failureHttpStatus = failure.httpStatus;
        fields.failureHost = failure.host;
      }
      return fields;
    }
    case 'sync.lease_lost': {
      const { event: _event, ...counters } = event;
      return { ...counters };
    }
    case 'sync.record_error':
      return { recordId: event.recordId, code: event.code };
    case 'sync.records_without_rev':
      return { count: event.count };
    case 'sync.conflict_copy':
      return { recordId: event.recordId, copyId: event.copyId, row: event.row };
    case 'sync.blob_unreadable':
      // Solo el tamaño: el motor no da nombre, ruta ni hash, y aquí tampoco se añaden.
      return { byteLength: event.byteLength };
    case 'sync.space_merge_copy':
      return { recordId: event.recordId, copyId: event.copyId, reason: event.reason };
    case 'sync.ydoc_unreadable':
      return { recordId: event.recordId, reason: event.reason };
  }
}

/** Quién vio que la credencial no vale: el relé (401/403 en una ronda) o Lumbre al registrar la
 *  clave de agente de los espacios (401 `credential_revoked`, `src/spaces/device.ts`). */
export type RevocationSource = 'relay' | 'agent_key';

export class SyncRunner implements SyncStatusSource {
  private current: Promise<SyncRoundResult | null> | null = null;
  private queued: Promise<SyncRoundResult | null> | null = null;
  /** La ronda encadenada la pidió un reintento con la credencial revocada (D24). */
  private queuedRetry = false;
  /** Cancela el bucle de 30 s, si está en marcha. */
  private cancelInterval: (() => void) | null = null;
  /** Cancela el reintento programado tras una revocación, si lo hay. */
  private cancelRetry: (() => void) | null = null;
  /** Reintentos seguidos que no recuperaron la credencial: dan la espera del siguiente. */
  private failedRetries = 0;
  private stopped = false;
  private revokedFlag = false;
  private okRoundCount = 0;
  private lastRound: { at: number; result: LibrarySyncResultCode } | null = null;
  private readonly firstRound: Promise<void>;
  private resolveFirstRound!: () => void;
  private readonly conflictListeners = new Set<(copy: SyncConflictCopy) => void>();
  private readonly gates: SyncGates;
  private readonly accountKey: string;
  /** Se aborta en `stop()`: una ronda en cola de turno sale sin ejecutarse. */
  private readonly closing = new AbortController();

  private constructor(
    private readonly engine: LibrarySyncEngine,
    private readonly options: SyncRunnerOptions
  ) {
    this.gates = options.gates ?? processSyncGates();
    this.accountKey = options.accountKey ?? DEFAULT_ACCOUNT_KEY;
    this.firstRound = new Promise((resolve) => {
      this.resolveFirstRound = resolve;
    });
  }

  static async create(options: SyncRunnerOptions): Promise<SyncRunner> {
    const transport =
      options.transport ??
      (() => {
        if (!options.connection) {
          throw new Error('SyncRunner: hace falta `transport` o `connection`');
        }
        return new HttpLibraryTransport(
          options.connection,
          options.fetcher ?? globalThis.fetch.bind(globalThis)
        );
      })();
    // El runner necesita a sí mismo en `onEvent`, que se fija al crear el motor.
    let runner: SyncRunner | null = null;
    const engine = await LibrarySyncEngine.create({
      port: options.port,
      transport,
      identity: options.identity,
      vaultKey: options.vaultKey,
      keyEpoch: options.keyEpoch ?? 1,
      spaceEnvelope: options.spaceEnvelope,
      blobTransport:
        options.blobTransport !== undefined
          ? options.blobTransport
          : options.connection
            ? new HttpBlobRelayV2(
                options.connection,
                options.fetcher ?? globalThis.fetch.bind(globalThis)
              )
            : null,
      now: options.now,
      onEvent: (event) => runner?.handleEngineEvent(event)
    });
    runner = new SyncRunner(engine, options);
    return runner;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get scheduler(): SyncScheduler {
    return this.options.scheduler ?? REAL_SCHEDULER;
  }

  /** Un logger que lanza no para el sync. */
  private safeEmit(event: SyncLogEventName, fields: SyncLogFields): void {
    try {
      this.options.emit?.(event, fields);
    } catch {
      // Igual que en `handleEngineEvent`.
    }
  }

  private handleEngineEvent(event: LibrarySyncEvent): void {
    try {
      this.options.emit?.(event.event, logFieldsOf(event));
    } catch {
      // Un logger que lanza no para el sync.
    }
    if (event.event === 'sync.conflict_copy') {
      for (const listener of this.conflictListeners) {
        try {
          listener({ recordId: event.recordId, copyId: event.copyId });
        } catch {
          // Igual que arriba.
        }
      }
    }
  }

  /** Avisa de cada copia de conflicto que produzca una ronda (L3b la usa para
   *  `hebra_append_to_note`). Devuelve la función para darse de baja. */
  onConflictCopy(listener: (copy: SyncConflictCopy) => void): () => void {
    this.conflictListeners.add(listener);
    return () => this.conflictListeners.delete(listener);
  }

  get revoked(): boolean {
    return this.revokedFlag;
  }

  /** Rondas correctas de ESTE runner hasta ahora: un contador, no un reloj. */
  get okRounds(): number {
    return this.okRoundCount;
  }

  /** Formato incompatible visto por la última ronda: se puede bajar, nunca subir. */
  clientOutdated(): ReturnType<LibrarySyncEngine['clientOutdated']> {
    return this.engine.clientOutdated();
  }

  /** Ronda de arranque y ronda periódica. Idempotente. Con la credencial ya revocada
   *  (`markRevoked` antes de arrancar), solo el reintento. */
  start(): void {
    if (this.stopped || this.cancelInterval) return;
    if (this.revokedFlag) {
      if (!this.cancelRetry) this.scheduleRetry();
      return;
    }
    void this.requestRound();
    this.startInterval();
  }

  private startInterval(): void {
    if (this.stopped || this.cancelInterval) return;
    const interval =
      this.options.intervalMs === undefined ? SYNC_INTERVAL_MS : this.options.intervalMs;
    if (interval !== null) {
      this.cancelInterval = this.scheduler.every(interval, () => this.requestRound());
    }
  }

  /** ¿Hay reintento solo tras una revocación? No en los tests que mueven las rondas a mano. */
  private get retriesEnabled(): boolean {
    return this.options.scheduler !== undefined || this.options.intervalMs !== null;
  }

  /** Programa el siguiente reintento con la espera que toca (`revokedRetryDelayMs`). */
  private scheduleRetry(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
    if (this.stopped || !this.revokedFlag || !this.retriesEnabled) return;
    this.cancelRetry = this.scheduler.after(revokedRetryDelayMs(this.failedRetries), () => {
      this.cancelRetry = null;
      return this.enqueue(true);
    });
  }

  /**
   * Lumbre rechazó la credencial fuera de una ronda (401 al registrar la clave de agente, D24):
   * el runner pasa a revocado como con un 401 del relé y empieza a reintentar. Sin efecto si ya
   * lo estaba o está parado.
   */
  markRevoked(source: RevocationSource = 'agent_key'): void {
    if (this.stopped) return;
    this.enterRevoked(source);
  }

  /**
   * Con la credencial revocada, reintenta ya en vez de esperar al siguiente plazo (lo usa el
   * gestor de espacios al recuperar la credencial de la cuenta, y el login cuando un GET de
   * lectura sale bien). `null` si no está revocada o está parado.
   */
  retryNow(): Promise<SyncRoundResult | null> {
    if (this.stopped || !this.revokedFlag) return Promise.resolve(null);
    this.cancelRetry?.();
    this.cancelRetry = null;
    return this.enqueue(true);
  }

  private notifyRevocation(revoked: boolean): void {
    try {
      this.options.onRevocationChange?.(revoked);
    } catch {
      // Un oyente que lanza no para el sync.
    }
  }

  private enterRevoked(source: RevocationSource): void {
    if (this.revokedFlag) return;
    this.revokedFlag = true;
    this.failedRetries = 0;
    this.safeEmit('pairing.revoked', { source });
    this.stopInterval();
    this.scheduleRetry();
    this.notifyRevocation(true);
  }

  /** La primera ronda correcta tras la revocación: vuelta al ritmo normal. */
  private restore(): void {
    const retries = this.failedRetries;
    this.revokedFlag = false;
    this.failedRetries = 0;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.safeEmit('pairing.restored', { source: 'relay', failedRetries: retries });
    this.startInterval();
    this.notifyRevocation(false);
  }

  /**
   * Resuelve cuando termina la primera ronda o pasados `maxWaitMs`, lo que ocurra antes.
   * Nunca rechaza: las lecturas sirven lo que haya en local si el relé no responde.
   */
  whenReady(maxWaitMs = STARTUP_READ_WAIT_MS): Promise<void> {
    return this.bounded(this.firstRound, maxWaitMs).then(() => undefined);
  }

  /**
   * La ronda de antes de cerrar (D22, §12.10): pide una y espera como mucho `maxWaitMs`.
   * Resuelve con su resultado, `null` si el runner ya no hace rondas (parado o revocado) y
   * `'timeout'` si se acabó el plazo; esa ronda la acaba `stop()`. Nunca rechaza.
   */
  finalRound(maxWaitMs = CLOSE_ROUND_WAIT_MS): Promise<SyncRoundResult | null | 'timeout'> {
    return this.bounded(this.requestRound(), maxWaitMs);
  }

  /** `work` o, si tarda más de `maxWaitMs`, `'timeout'`. El plazo no mantiene vivo el proceso. */
  private bounded<T>(work: Promise<T>, maxWaitMs: number): Promise<T | 'timeout'> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const limit = this.options.waitTimer
      ? this.options.waitTimer(maxWaitMs)
      : new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, maxWaitMs);
          timeout.unref?.();
        });
    return Promise.race([work, limit.then(() => 'timeout' as const)]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  /**
   * Pide una ronda. Sin ninguna en vuelo, empieza ya; con una en vuelo, encadena una
   * (compartida) detrás. `null` si el runner está parado o revocado: con la credencial revocada,
   * una escritura no llama al relé (D24); solo lo hace el reintento.
   */
  requestRound(): Promise<SyncRoundResult | null> {
    return this.enqueue(false);
  }

  /** `retry`: la pide el reintento con la credencial revocada, que sí llama al relé. */
  private enqueue(retry: boolean): Promise<SyncRoundResult | null> {
    if (this.stopped || (this.revokedFlag && !retry)) return Promise.resolve(null);
    if (!this.current) {
      const round = this.execute(retry);
      this.current = round;
      void round.finally(() => {
        if (this.current === round) this.current = null;
      });
      return round;
    }
    if (retry) this.queuedRetry = true;
    if (!this.queued) {
      const next = () => {
        this.queued = null;
        const asRetry = this.queuedRetry;
        this.queuedRetry = false;
        return this.enqueue(asRetry);
      };
      this.queued = this.current.then(next, next);
    }
    return this.queued;
  }

  /**
   * Una ronda, tras esperar turno en el semáforo de proceso (FIFO). Si el runner se para
   * mientras espera, sale sin ejecutar nada ni coger plaza. El turno se suelta pase lo que pase.
   */
  private async execute(retry: boolean): Promise<SyncRoundResult | null> {
    const release = await this.gates.rounds.acquire(this.closing.signal, this.accountKey);
    if (!release) {
      this.resolveFirstRound();
      return null;
    }
    try {
      return await this.executeRound(retry);
    } finally {
      release();
    }
  }

  private async executeRound(retry: boolean): Promise<SyncRoundResult | null> {
    let round: SyncRoundResult | null = null;
    try {
      await this.options.beforeRound?.();
    } catch {
      // Anotar es para después de la ronda; sin ello, la ronda sigue (cerrado ante la duda
      // lo hace el filtro con lo que ya hubiera anotado).
    }
    try {
      round = await this.engine.runRound();
    } catch {
      // `runRound` ya convierte los fallos de red y de almacén en `result`; lo que llegue
      // aquí (el permiso de sync del almacén lanzó) cuenta como ronda `unknown`.
      round = null;
    }
    const result: LibrarySyncResultCode = round?.result ?? 'unknown';
    this.lastRound = { at: this.now(), result };
    if (result === 'ok') this.okRoundCount += 1;
    // También con el runner ya parado: la ronda final de un cierre puede recibir el 401, y
    // `bindPairingRevocation` lee `revoked` después (los temporizadores ya no se arman).
    if (!this.revokedFlag) {
      if (isRevocation(result)) this.enterRevoked('relay');
    } else if (result === 'ok') {
      // Cualquier ronda correcta prueba que la credencial vuelve a valer.
      this.restore();
    } else if (retry) {
      // Un reintento que no la recupera (otro 401, o sin red: no se sabe) alarga la espera. Una
      // ronda que ya estaba en vuelo al revocarse no cuenta como intento.
      this.failedRetries += 1;
      this.scheduleRetry();
    }
    this.resolveFirstRound();
    return round;
  }

  /**
   * Bytes de un adjunto aquí, bajándolos del relé si hace falta (`readBlob` del motor:
   * Blob V2, descifrado, hash verificado y guardado en su almacén de adjuntos). `true` si
   * quedaron en el disco. Nunca lanza: sin transporte de blobs, revocado, sin red o si el
   * relé no lo tiene, `false`. Log cerrado `attachment.fetch` con el resultado, sin hash
   * ni nombre.
   *
   * Como mucho `BLOB_DOWNLOAD_CONCURRENCY` a la vez; las demás esperan su turno en cola
   * FIFO. Un 429 del relé se reintenta hasta `BLOB_DOWNLOAD_RETRIES` veces, tras esperar el
   * `Retry-After` (con tope `BLOB_RETRY_AFTER_MAX_MS`) o, sin él, 2, 4 y 8 s; agotados,
   * `error`, como cualquier otro fallo. La descarga que espera tras un 429 SUELTA su plaza
   * mientras duerme y vuelve a pedirla (turno rotatorio por cuenta) al reintentar (B4, 6 nov
   * 2026): conservarla hasta 3 x 30 s dejaba a las demás cuentas sin descargas. El reintento
   * sigue sometido al tope de 4, así que nunca hay más en vuelo.
   */
  async readBlob(sha256: string): Promise<boolean> {
    let outcome: 'ok' | 'missing' | 'error' | 'revoked' = 'revoked';
    let release: (() => void) | null = null;
    try {
      for (let retry = 0; ; retry += 1) {
        release = (await this.gates.downloads.acquire(undefined, this.accountKey))!;
        if (this.stopped || this.revokedFlag) {
          outcome = 'revoked';
          return false;
        }
        let waitMs: number;
        try {
          const bytes = await this.engine.readBlob(sha256);
          outcome = bytes ? 'ok' : 'missing';
          return bytes !== null;
        } catch (error) {
          const limited = rateLimitOf(error);
          if (!limited || retry >= BLOB_DOWNLOAD_RETRIES) {
            outcome = 'error';
            return false;
          }
          waitMs =
            limited.retryAfterMs !== undefined
              ? Math.min(Math.max(limited.retryAfterMs, 0), BLOB_RETRY_AFTER_MAX_MS)
              : BLOB_DOWNLOAD_BACKOFF_MS[retry]!;
        }
        // Retroceso por 429: la plaza se suelta antes de dormir.
        release();
        release = null;
        await sleep(waitMs);
      }
    } finally {
      release?.();
      try {
        this.options.emitAttachment?.(outcome);
      } catch {
        // Un logger que lanza no cambia el resultado.
      }
    }
  }

  async syncStatus(): Promise<SyncStatusSnapshot> {
    const counts = await this.options.port.syncStatus();
    const errorsByCode: Record<string, number> = {};
    for (const entry of counts.errors) {
      errorsByCode[entry.code] = (errorsByCode[entry.code] ?? 0) + entry.count;
    }
    return {
      lastSyncAt: this.lastRound ? new Date(this.lastRound.at).toISOString() : null,
      lastSyncOutcome: this.lastRound?.result ?? null,
      pendingUpload: counts.dirty + counts.blobsPending,
      errorsByCode,
      revoked: this.revokedFlag
    };
  }

  private stopInterval(): void {
    this.cancelInterval?.();
    this.cancelInterval = null;
  }

  /**
   * Para el bucle y espera a que termine la ronda en vuelo (y la encadenada). Para también
   * el motor (`LibrarySyncEngine.stop`): corta las subidas de adjuntos en vuelo, que si no
   * se esperaban hasta su plazo (hasta 15 min; M1 del audit de robustez, 10 oct 2026). Los
   * adjuntos cortados siguen pendientes para el motor siguiente. La bajada y la subida de
   * registros no se cortan: tienen su propio plazo en el transporte.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.closing.abort();
    this.stopInterval();
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.resolveFirstRound();
    this.engine.stop();
    await (this.queued ?? this.current)?.catch(() => null);
    await this.current?.catch(() => null);
  }
}
