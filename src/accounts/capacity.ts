/**
 * La capacidad de `serve-http` se regula por memoria real y por espera, nunca por un
 * recuento de personas (SPEC.md §12.10, "Memoria real, no recuento"). Antes de abrir una
 * biblioteca o un espacio, y antes de que una petición llegue a sus herramientas, se mira
 * la memoria en uso del contenedor frente a `HEBRA_MCP_MEMORY_HIGH_WATER`. Por encima, se
 * cierran antes los contextos sin peticiones en curso; si no basta, la apertura o la
 * petición espera en orden de llegada hasta `HEBRA_MCP_OPEN_WAIT_MS`, y al agotarla la
 * petición recibe 503 con `Retry-After`.
 */
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { HttpConfigError } from '../http/config';
import { DEFAULT_SYNC_CONCURRENCY } from '../sync/gates';
import type { Clock } from './lifecycle';

export const DEFAULT_CONTEXT_IDLE_MS = 120_000;
export const DEFAULT_OPEN_WAIT_MS = 20_000;
export const DEFAULT_HIGH_WATER: HighWater = { ratio: 0.8 };

/** Cada cuánto se vuelve a medir mientras hay aperturas esperando. */
const POLL_MS = 500;
const MIB = 1024 * 1024;

/**
 * Lo que se aparta por cada apertura en curso. La lectura del cgroup aún no ve lo que está
 * abriendo: sin esto, una ráfaga de aperturas con la memoria baja pasaría entera y acabaría
 * en el OOM que D22 descarta. Son bytes, no un número de contextos: cuántas aperturas caben
 * a la vez sale de la memoria medida. El pico medido al abrir un contexto es de unos 6 MiB
 * (6 nov 2026); 8 MiB le dejan margen.
 */
export const OPENING_RESERVE_BYTES = 8 * MIB;

/** Lo que cuesta en memoria una petición por cada nota de la biblioteca que toca (unos 3,5 KB,
 *  medido el 6 nov 2026: de 78 a 104 MiB con 30 000 notas). */
export const REQUEST_BYTES_PER_NOTE = 3_584;
/** Lo mínimo que aparta una petición, también sobre una biblioteca vacía o sin recuento. */
export const MIN_REQUEST_RESERVE_BYTES = 4 * MIB;

/**
 * Lo que aparta una llamada de herramienta mientras corre, según cuántas notas tiene la
 * biblioteca o el espacio al que va (`null`: no se pudo contar). Hoy una petición cuesta en
 * proporción a las notas de la biblioteca entera, no a las que toca.
 *
 * Es la única regla del tamaño de la reserva y se sustituye aquí sin tocar nada más: cuando
 * el coste por petición pase a ser O(notas tocadas), será una constante de unos 8 MiB y el
 * recuento de notas dejará de hacer falta.
 */
export function requestReserveBytes(notes: number | null): number {
  if (notes === null || !Number.isFinite(notes) || notes <= 0) return MIN_REQUEST_RESERVE_BYTES;
  return Math.max(MIN_REQUEST_RESERVE_BYTES, Math.ceil(notes) * REQUEST_BYTES_PER_NOTE);
}

/** Por encima de esto, un límite de cgroup v1 significa "sin límite". */
const UNLIMITED_CGROUP_BYTES = 2 ** 60;

/** Motivos del 503 de `/mcp`, un conjunto cerrado que va tal cual al log. */
export type UnavailableReason = 'capacity_wait_timeout' | 'open_failed' | 'lock_held';

export class ContextUnavailableError extends Error {
  constructor(
    readonly reason: UnavailableReason,
    readonly retryAfterSeconds: number
  ) {
    super(reason);
    this.name = 'ContextUnavailableError';
  }
}

export interface MemoryReading {
  usedBytes: number;
  limitBytes: number;
}

export type MemoryReader = () => MemoryReading;

/** Una proporción del límite medido o un valor absoluto. */
export type HighWater = { ratio: number } | { bytes: number };

export interface CapacityConfig {
  idleMs: number;
  openWaitMs: number;
  highWater: HighWater;
  /** Rondas de sync simultáneas de todo el proceso (`HEBRA_MCP_SYNC_CONCURRENCY`). */
  syncConcurrency: number;
}

function parseMs(env: NodeJS.ProcessEnv, variable: string, fallback: number): number {
  const raw = env[variable];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,10}$/.test(raw)) throw new HttpConfigError(variable);
  return Number(raw);
}

/** Entero >= 1; otra cosa impide arrancar. */
export function parseSyncConcurrency(env: NodeJS.ProcessEnv): number {
  const raw = env.HEBRA_MCP_SYNC_CONCURRENCY;
  if (raw === undefined || raw === '') return DEFAULT_SYNC_CONCURRENCY;
  if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1) throw new HttpConfigError('HEBRA_MCP_SYNC_CONCURRENCY');
  return Number(raw);
}

function parseHighWater(raw: string | undefined): HighWater {
  if (raw === undefined || raw === '') return DEFAULT_HIGH_WATER;
  const invalid = new HttpConfigError('HEBRA_MCP_MEMORY_HIGH_WATER');
  const percent = /^(\d{1,3}(?:\.\d+)?)%$/.exec(raw);
  if (percent) {
    const ratio = Number(percent[1]) / 100;
    if (ratio <= 0 || ratio > 1) throw invalid;
    return { ratio };
  }
  if (/^(?:0?\.\d+|1(?:\.0+)?)$/.test(raw)) {
    const ratio = Number(raw);
    if (ratio <= 0) throw invalid;
    return { ratio };
  }
  if (/^\d{1,16}$/.test(raw) && Number(raw) > 0) return { bytes: Number(raw) };
  throw invalid;
}

/** `HEBRA_MCP_MEMORY_HIGH_WATER` admite una proporción (`0.8`), un porcentaje (`80%`) o bytes. */
export function readCapacityConfig(env: NodeJS.ProcessEnv = process.env): CapacityConfig {
  return {
    idleMs: parseMs(env, 'HEBRA_MCP_CONTEXT_IDLE_MS', DEFAULT_CONTEXT_IDLE_MS),
    openWaitMs: parseMs(env, 'HEBRA_MCP_OPEN_WAIT_MS', DEFAULT_OPEN_WAIT_MS),
    highWater: parseHighWater(env.HEBRA_MCP_MEMORY_HIGH_WATER),
    syncConcurrency: parseSyncConcurrency(env)
  };
}

type ReadText = (path: string) => string | null;

const readText: ReadText = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

function statValue(stat: string | null, key: string): number {
  const match = stat === null ? null : new RegExp(`^${key} (\\d+)$`, 'm').exec(stat);
  return match ? Number(match[1]) : 0;
}

function processLimitBytes(): number {
  const constrained = process.constrainedMemory();
  return constrained > 0 && constrained < UNLIMITED_CGROUP_BYTES ? constrained : totalmem();
}

/**
 * La memoria en uso del contenedor: la del cgroup (v2 o v1) y, sin cgroup, el RSS del
 * proceso. Descuenta `inactive_file`, igual que `docker stats`: es caché de disco que el
 * núcleo recupera bajo presión. Contarla dejaría el servidor por encima del límite en cuanto
 * SQLite hubiera leído bibliotecas, sin que cerrar nada lo arreglara.
 */
export function readMemoryUsage(
  read: ReadText = readText,
  rss: () => number = () => process.memoryUsage().rss,
  root = '/sys/fs/cgroup'
): MemoryReading {
  const current = read(`${root}/memory.current`);
  if (current !== null) {
    const max = read(`${root}/memory.max`)?.trim();
    const limit = Number(max);
    return {
      usedBytes: Math.max(0, Number(current) - statValue(read(`${root}/memory.stat`), 'inactive_file')),
      limitBytes: max && max !== 'max' && Number.isFinite(limit) ? limit : processLimitBytes()
    };
  }
  const usage = read(`${root}/memory/memory.usage_in_bytes`);
  if (usage !== null) {
    const limit = Number(read(`${root}/memory/memory.limit_in_bytes`));
    return {
      usedBytes: Math.max(0, Number(usage) - statValue(read(`${root}/memory/memory.stat`), 'total_inactive_file')),
      limitBytes: limit > 0 && limit < UNLIMITED_CGROUP_BYTES ? limit : processLimitBytes()
    };
  }
  return { usedBytes: rss(), limitBytes: processLimitBytes() };
}

export interface AdmissionTicket {
  /** La apertura o la petición terminó, bien o mal: suelta lo apartado. Idempotente. */
  done(): void;
}

export interface CapacityGateOptions {
  readMemory: MemoryReader;
  highWater: HighWater;
  waitMs: number;
  clock: Clock;
  /** Cierra antes lo que no tenga peticiones en curso. */
  reclaim(): Promise<void>;
  pollMs?: number;
  /** Lo que aparta `admit` sin tamaño propio (una apertura); por defecto, `OPENING_RESERVE_BYTES`. */
  reserveBytes?: number;
}

interface Waiter {
  bytes: number;
  resolve(ticket: AdmissionTicket): void;
  reject(error: unknown): void;
  /** Quita su plazo y su oyente de aborto. */
  detach(): void;
}

/**
 * Quien pide abrir, y cada petición antes de llegar a sus herramientas, pasa por aquí en una
 * sola cola, en orden de llegada. Cada uno aparta sus bytes mientras dura y entra solo si lo
 * apartado más lo medido, con lo suyo, no pasa del límite. La excepción es quien llega con
 * nada apartado: entra si la lectura está por debajo del límite, para que una petición sola
 * más grande que el margen no espere para siempre.
 */
export class CapacityGate {
  private readonly queue: Waiter[] = [];
  private reserved = 0;
  private reclaiming = false;
  private closed = false;
  private cancelPoll: (() => void) | null = null;

  constructor(private readonly options: CapacityGateOptions) {}

  /** Lo apartado ahora por aperturas y peticiones en curso (diagnóstico y pruebas). */
  get reservedBytes(): number {
    return this.reserved;
  }

  /**
   * Espera turno y aparta `bytes` hasta `done()`. Sin `bytes`, lo de una apertura. Al agotar
   * la espera, `ContextUnavailableError('capacity_wait_timeout')`; si `signal` aborta, sale de
   * la cola sin apartar nada.
   */
  admit(signal?: AbortSignal, bytes?: number): Promise<AdmissionTicket> {
    if (this.closed) return Promise.reject(new Error('contexts_closed'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const size = Math.max(0, bytes ?? this.options.reserveBytes ?? OPENING_RESERVE_BYTES);
    return new Promise<AdmissionTicket>((resolve, reject) => {
      const onAbort = (): void => {
        this.remove(waiter);
        waiter.detach();
        reject(signal?.reason);
      };
      const cancelDeadline = this.options.clock.setTimer(() => {
        this.remove(waiter);
        waiter.detach();
        reject(new ContextUnavailableError('capacity_wait_timeout', this.retryAfterSeconds));
      }, this.options.waitMs);
      const waiter: Waiter = {
        bytes: size,
        resolve,
        reject,
        detach: () => {
          cancelDeadline();
          signal?.removeEventListener('abort', onAbort);
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
      this.pump();
    });
  }

  /** Algo se cerró o se liberó: vuelve a mirar sin esperar a la siguiente medición. */
  recheck(): void {
    this.admitWhileRoom();
    this.syncPoll();
  }

  /** El apagado: nadie sigue esperando. */
  shutdown(): void {
    this.closed = true;
    for (const waiter of this.queue.splice(0)) {
      waiter.detach();
      waiter.reject(new Error('contexts_closed'));
    }
    this.syncPoll();
  }

  get retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(this.options.waitMs / 1000));
  }

  private pump(): void {
    this.admitWhileRoom();
    if (this.queue.length > 0) this.startReclaim();
    this.syncPoll();
  }

  /** Deja entrar en orden mientras quepa el primero de la cola: nadie adelanta a quien espera. */
  private admitWhileRoom(): void {
    while (this.queue.length > 0 && this.hasRoom(this.queue[0]!.bytes)) {
      const waiter = this.queue.shift()!;
      waiter.detach();
      const { bytes } = waiter;
      this.reserved += bytes;
      let done = false;
      waiter.resolve({
        done: () => {
          if (done) return;
          done = true;
          this.reserved -= bytes;
          this.recheck();
        }
      });
    }
  }

  private hasRoom(bytes: number): boolean {
    let reading: MemoryReading;
    try {
      reading = this.options.readMemory();
    } catch {
      // Un medidor roto no es falta de memoria: no niega el acceso a nadie.
      return true;
    }
    const { highWater } = this.options;
    const water = 'bytes' in highWater ? highWater.bytes : reading.limitBytes * highWater.ratio;
    if (this.reserved === 0) return reading.usedBytes < water;
    return reading.usedBytes + this.reserved + bytes <= water;
  }

  private startReclaim(): void {
    if (this.reclaiming) return;
    this.reclaiming = true;
    void this.options
      .reclaim()
      .catch(() => undefined)
      .finally(() => {
        this.reclaiming = false;
        this.recheck();
      });
  }

  private remove(waiter: Waiter): void {
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
    this.syncPoll();
  }

  /** Solo se mide mientras alguien espera: sin esperas, ningún temporizador. */
  private syncPoll(): void {
    if (this.queue.length === 0) {
      this.cancelPoll?.();
      this.cancelPoll = null;
      return;
    }
    if (this.cancelPoll) return;
    this.cancelPoll = this.options.clock.setTimer(() => {
      this.cancelPoll = null;
      this.pump();
    }, this.options.pollMs ?? POLL_MS);
  }
}
