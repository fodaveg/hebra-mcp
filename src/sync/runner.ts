/**
 * Bucle de sync de hebra-mcp (SPEC.md §8, L3) sobre el motor de Hebra SIN cambios
 * (`LibrarySyncEngine`, por `node.ts` de Hebra) y la vista `SyncStorePort` del
 * almacén (`src/store/sync-port.ts`).
 *
 * Ritmo (§8):
 * - Una ronda al arrancar (`start`); las lecturas pueden esperarla con `whenReady`, que
 *   nunca tarda más de 10 s por defecto y nunca rechaza.
 * - Una ronda cada 30 s mientras el proceso vive.
 * - Una ronda justo después de cada escritura (`requestRound`).
 * Nunca hay dos rondas solapadas: si se pide una con otra en vuelo, se encadena UNA
 * detrás (todas las peticiones de mientras comparten esa), porque la que está en vuelo
 * puede haber subido ya y no llevarse la escritura recién hecha.
 *
 * Revocación (§6.2): un 401/403 del relé deja `revoked: true` y el bucle se para hasta
 * que el proceso se reinicie (un token revocado no vuelve a valer; reintentar solo
 * haría ruido en el relé).
 *
 * Logs (§6.4): solo los eventos cerrados del motor (`sync.round`, `sync.lease_lost`,
 * `sync.record_error`, `sync.conflict_copy`, `sync.blob_unreadable`), con ids opacos, códigos y recuentos, por
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

export const SYNC_INTERVAL_MS = 30_000;
export const STARTUP_READ_WAIT_MS = 10_000;

/**
 * Descargas de adjuntos (`readBlob`) a la vez, como mucho; el resto espera en cola, por
 * orden de llegada (tarea de Lumbre 342a931c). El 5 oct 2026 mcp.hebra.pro lanzó unos 253
 * GET de Blob V2 en paralelo en 20 s y el relé respondió 429 a casi todos. La subida ya
 * tenía su tope en el motor (`BLOB_UPLOAD_CONCURRENCY = 3`, `sync-engine.ts` de Hebra).
 */
export const BLOB_DOWNLOAD_CONCURRENCY = 4;
/** Reintentos de una descarga que recibe 429, después del primer intento. */
export const BLOB_DOWNLOAD_RETRIES = 3;
/** Espera antes de cada reintento si el 429 no trae `Retry-After`. */
export const BLOB_DOWNLOAD_BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000];
/** Tope de la espera que pide un `Retry-After`. */
export const BLOB_RETRY_AFTER_MAX_MS = 30_000;

/** Semáforo con cola FIFO: `acquire` resuelve con la función que libera la plaza. */
class FifoSemaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.waiting.shift()?.();
        });
      };
      if (this.active < this.limit) grant();
      else this.waiting.push(grant);
    });
  }
}

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
  // La credencial de emparejado está revocada (SPEC.md §12.9): una vez, al primer 401/403.
  | 'pairing.revoked';

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
  /** Cada cuánto hay ronda periódica; `null` la desactiva (tests). */
  intervalMs?: number | null;
  now?: () => number;
  /**
   * Antes de cada ronda, con el almacén aún como lo dejó la anterior. El escritor anota aquí
   * a qué carpetas resuelven las rutas privadas (A3 del audit de privacidad, 10 oct 2026:
   * `privacyWithMemory`), para que una ronda que trae la carpeta privada movida y otra con
   * su nombre no la destape aunque nadie haya llamado a una herramienta entre medias. Un
   * fallo aquí no para la ronda.
   */
  beforeRound?: () => Promise<void>;
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
  }
}

export class SyncRunner implements SyncStatusSource {
  private current: Promise<SyncRoundResult | null> | null = null;
  private queued: Promise<SyncRoundResult | null> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private revokedFlag = false;
  private lastRound: { at: number; result: LibrarySyncResultCode } | null = null;
  private readonly firstRound: Promise<void>;
  private resolveFirstRound!: () => void;
  private readonly conflictListeners = new Set<(copy: SyncConflictCopy) => void>();
  private readonly downloads = new FifoSemaphore(BLOB_DOWNLOAD_CONCURRENCY);

  private constructor(
    private readonly engine: LibrarySyncEngine,
    private readonly options: SyncRunnerOptions
  ) {
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

  /** Formato incompatible visto por la última ronda: se puede bajar, nunca subir. */
  clientOutdated(): ReturnType<LibrarySyncEngine['clientOutdated']> {
    return this.engine.clientOutdated();
  }

  /** Ronda de arranque y ronda periódica. Idempotente. */
  start(): void {
    if (this.stopped || this.timer || this.revokedFlag) return;
    void this.requestRound();
    const interval =
      this.options.intervalMs === undefined ? SYNC_INTERVAL_MS : this.options.intervalMs;
    if (interval !== null) {
      this.timer = setInterval(() => void this.requestRound(), interval);
      // El intervalo no mantiene vivo el proceso: lo mantiene el transporte MCP.
      this.timer.unref?.();
    }
  }

  /**
   * Resuelve cuando termina la primera ronda o pasados `maxWaitMs`, lo que ocurra antes.
   * Nunca rechaza: las lecturas sirven lo que haya en local si el relé no responde.
   */
  whenReady(maxWaitMs = STARTUP_READ_WAIT_MS): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const limit = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, maxWaitMs);
      timeout.unref?.();
    });
    return Promise.race([this.firstRound, limit]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  /**
   * Pide una ronda. Sin ninguna en vuelo, empieza ya; con una en vuelo, encadena una
   * (compartida) detrás. `null` si el runner está parado o revocado.
   */
  requestRound(): Promise<SyncRoundResult | null> {
    if (this.stopped || this.revokedFlag) return Promise.resolve(null);
    if (!this.current) {
      const round = this.execute();
      this.current = round;
      void round.finally(() => {
        if (this.current === round) this.current = null;
      });
      return round;
    }
    if (!this.queued) {
      const queued = this.current.then(
        () => {
          this.queued = null;
          return this.requestRound();
        },
        () => {
          this.queued = null;
          return this.requestRound();
        }
      );
      this.queued = queued;
    }
    return this.queued;
  }

  private async execute(): Promise<SyncRoundResult | null> {
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
    if (isRevocation(result)) {
      if (!this.revokedFlag) this.options.emit?.('pairing.revoked', { source: 'relay' });
      this.revokedFlag = true;
      this.stopTimer();
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
   * `error`, como cualquier otro fallo. La descarga que espera CONSERVA su plaza: un 429 es
   * del relé, no de ese objeto, y las de la cola recibirían otro; si la soltara, la cola
   * entera pasaría por el relé mientras rechaza y gastaría sus reintentos, que es lo que
   * pasó el 5 oct. Así, mientras dura la espera, nadie más baja nada.
   */
  async readBlob(sha256: string): Promise<boolean> {
    let outcome: 'ok' | 'missing' | 'error' | 'revoked' = 'revoked';
    const release = await this.downloads.acquire();
    try {
      for (let retry = 0; ; retry += 1) {
        if (this.stopped || this.revokedFlag) {
          outcome = 'revoked';
          return false;
        }
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
          await sleep(
            limited.retryAfterMs !== undefined
              ? Math.min(Math.max(limited.retryAfterMs, 0), BLOB_RETRY_AFTER_MAX_MS)
              : BLOB_DOWNLOAD_BACKOFF_MS[retry]!
          );
        }
      }
    } finally {
      release();
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

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
    this.stopTimer();
    this.resolveFirstRound();
    this.engine.stop();
    await (this.queued ?? this.current)?.catch(() => null);
    await this.current?.catch(() => null);
  }
}
