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
 * Logs (§6.4): solo los cuatro eventos cerrados del motor (`sync.round`,
 * `sync.lease_lost`, `sync.record_error`, `sync.conflict_copy`), con ids opacos, códigos y recuentos, por
 * una función `emit` que inyecta quien crea el runner (el logger es de L1).
 *
 * Credenciales, clave de biblioteca e identidad llegan por parámetro: el emparejado y el
 * llavero son L2.
 */
import {
  HttpBlobRelayV2,
  HttpLibraryTransport,
  LibrarySyncEngine,
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

/** Los tres eventos del catálogo cerrado de §6.4. */
export type SyncLogEventName =
  | 'sync.round'
  | 'sync.lease_lost'
  | 'sync.record_error'
  | 'sync.conflict_copy';

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
    case 'sync.conflict_copy':
      return { recordId: event.recordId, copyId: event.copyId, row: event.row };
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
      round = await this.engine.runRound();
    } catch {
      // `runRound` ya convierte los fallos de red y de almacén en `result`; lo que llegue
      // aquí (el permiso de sync del almacén lanzó) cuenta como ronda `unknown`.
      round = null;
    }
    const result: LibrarySyncResultCode = round?.result ?? 'unknown';
    this.lastRound = { at: this.now(), result };
    if (isRevocation(result)) {
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
   */
  async readBlob(sha256: string): Promise<boolean> {
    let outcome: 'ok' | 'missing' | 'error' | 'revoked' = 'revoked';
    try {
      if (this.stopped || this.revokedFlag) return false;
      const bytes = await this.engine.readBlob(sha256);
      outcome = bytes ? 'ok' : 'missing';
      return bytes !== null;
    } catch {
      outcome = 'error';
      return false;
    } finally {
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

  /** Para el bucle y espera a que termine la ronda en vuelo (y la encadenada). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopTimer();
    this.resolveFirstRound();
    await (this.queued ?? this.current)?.catch(() => null);
    await this.current?.catch(() => null);
  }
}
