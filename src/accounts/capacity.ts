/**
 * La capacidad de `serve-http` se regula por memoria real y por espera, nunca por un
 * recuento de personas (SPEC.md §12.10, "Memoria real, no recuento"). Antes de abrir una
 * biblioteca o un espacio, y antes de que cada llamada de herramienta empiece a ejecutarse,
 * se mira la memoria en uso del contenedor frente a `HEBRA_MCP_MEMORY_HIGH_WATER`. Por
 * encima, se cierran antes los contextos sin peticiones en curso; si no basta, la apertura o
 * la llamada espera su turno (rotatorio por cuenta, en orden de llegada dentro de cada una)
 * hasta `HEBRA_MCP_OPEN_WAIT_MS`, y al agotarla la petición recibe 503 con `Retry-After`.
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

/**
 * Lo que aparta cada llamada de herramienta mientras corre, la misma para todas y sea cual sea
 * su destino. Antes eran unos 3,5 KB por nota de la biblioteca o del espacio (medido el 6 nov
 * 2026: de 78 a 104 MiB por petición con 30 000 notas), con un `COUNT(*)` por destino, porque
 * cada llamada cargaba en el filtro de privados la visibilidad de la biblioteca entera. Desde
 * A9b del plan de memoria cada herramienta carga solo las notas que decide
 * (`privacyLoad: 'lazy'`, SPEC.md §6.3): su coste ya depende de las notas que toca, no de la
 * biblioteca, y basta una cantidad fija.
 *
 * Límite de la transición: las tres `hebra_jd_*` aún cargan la biblioteca entera hasta que su
 * pieza las pase a `'lazy'`, y apartan lo mismo que las demás.
 */
export const REQUEST_RESERVE_BYTES = 8 * MIB;

/** Lo que aparta una llamada de herramienta: `REQUEST_RESERVE_BYTES`, sin recuento de notas. Es
 *  la única regla del tamaño de la reserva de una llamada (`AccountContexts`, al empezar cada
 *  herramienta). */
export function requestReserveBytes(): number {
  return REQUEST_RESERVE_BYTES;
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
  /** La cuenta en cuyo turno espera. */
  key: string;
  resolve(ticket: AdmissionTicket): void;
  reject(error: unknown): void;
  /** Quita su plazo y su oyente de aborto. */
  detach(): void;
}

/** La cuenta de `admit` cuando no dice ninguna (pruebas de la compuerta sola). */
export const ANONYMOUS_TURN = '';

/**
 * El turno de una cuenta: sus esperas en orden de llegada y cuándo entró por última vez. Vive
 * mientras la cuenta tenga esperas o algo apartado; sin ninguna de las dos se olvida, y si
 * vuelve empieza como recién llegada.
 */
interface Turn {
  readonly waiters: Waiter[];
  /** Reservas suyas ya dentro y aún sin soltar. */
  active: number;
  /** Secuencia de su última entrada; 0 si aún no entró desde que existe el turno. */
  lastServed: number;
  /** Secuencia de su llegada, para desempatar entre las que no han entrado. */
  readonly since: number;
}

/**
 * Quien pide abrir, y cada llamada de herramienta antes de ejecutarse, pasa por aquí. Cada uno
 * aparta sus bytes mientras dura y entra solo si lo apartado más lo medido, con lo suyo, no
 * pasa del límite. La excepción es una reserva de una sola unidad (una llamada o una apertura)
 * que llega con nada apartado: entra si la lectura está por debajo del límite, para que no
 * espere para siempre con el margen agotado por lo medido. Nunca deja entrar más de una unidad.
 *
 * El turno rota por cuenta (`key`): el siguiente es el de la cuenta que lleva más sin entrar, y
 * dentro de cada cuenta, en orden de llegada. Una cuenta con muchas esperas no retrasa a otra
 * más de una plaza. No hay tope por cuenta (D22): solo el orden en que se reparte lo que cabe.
 * Nadie adelanta a quien tiene el turno: si su reserva no cabe, esperan todos.
 */
export class CapacityGate {
  private readonly turns = new Map<string, Turn>();
  private waiting = 0;
  private sequence = 0;
  private reserved = 0;
  private reclaiming = false;
  private closed = false;
  private cancelPoll: (() => void) | null = null;

  constructor(private readonly options: CapacityGateOptions) {}

  /** Lo apartado ahora por aperturas y peticiones en curso (diagnóstico y pruebas). */
  get reservedBytes(): number {
    return this.reserved;
  }

  /** Cuántos esperan turno ahora (diagnóstico y pruebas). */
  get waitingCount(): number {
    return this.waiting;
  }

  /**
   * Espera el turno de `key` y aparta `bytes` hasta `done()`. Sin `bytes`, lo de una apertura.
   * Al agotar la espera, `ContextUnavailableError('capacity_wait_timeout')`; si `signal`
   * aborta, sale de la cola sin apartar nada.
   */
  admit(signal?: AbortSignal, bytes?: number, key: string = ANONYMOUS_TURN): Promise<AdmissionTicket> {
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
        key,
        resolve,
        reject,
        detach: () => {
          cancelDeadline();
          signal?.removeEventListener('abort', onAbort);
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.turnOf(key).waiters.push(waiter);
      this.waiting += 1;
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
    for (const [key, turn] of [...this.turns]) {
      for (const waiter of turn.waiters.splice(0)) {
        this.waiting -= 1;
        waiter.detach();
        waiter.reject(new Error('contexts_closed'));
      }
      this.forgetIfIdle(key, turn);
    }
    this.syncPoll();
  }

  get retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(this.options.waitMs / 1000));
  }

  private pump(): void {
    this.admitWhileRoom();
    if (this.waiting > 0) this.startReclaim();
    this.syncPoll();
  }

  /**
   * Deja entrar mientras quepa la primera espera de la cuenta que tiene el turno: nadie adelanta
   * a quien lo tiene. Al entrar, esa cuenta pasa detrás de las demás que esperan.
   */
  private admitWhileRoom(): void {
    for (;;) {
      const next = this.nextTurn();
      if (!next || !this.hasRoom(next.turn.waiters[0]!.bytes)) return;
      const { key, turn } = next;
      const waiter = turn.waiters.shift()!;
      this.waiting -= 1;
      waiter.detach();
      const { bytes } = waiter;
      this.reserved += bytes;
      turn.active += 1;
      this.sequence += 1;
      turn.lastServed = this.sequence;
      let done = false;
      waiter.resolve({
        done: () => {
          if (done) return;
          done = true;
          this.reserved -= bytes;
          turn.active -= 1;
          this.forgetIfIdle(key, turn);
          this.recheck();
        }
      });
    }
  }

  /** La cuenta con esperas que lleva más sin entrar; entre las que no han entrado, la primera
   *  en llegar. */
  private nextTurn(): { key: string; turn: Turn } | null {
    let best: { key: string; turn: Turn } | null = null;
    for (const [key, turn] of this.turns) {
      if (turn.waiters.length === 0) continue;
      if (
        !best ||
        turn.lastServed < best.turn.lastServed ||
        (turn.lastServed === best.turn.lastServed && turn.since < best.turn.since)
      ) {
        best = { key, turn };
      }
    }
    return best;
  }

  private turnOf(key: string): Turn {
    let turn = this.turns.get(key);
    if (!turn) {
      this.sequence += 1;
      turn = { waiters: [], active: 0, lastServed: 0, since: this.sequence };
      this.turns.set(key, turn);
    }
    return turn;
  }

  /** Sin esperas ni nada apartado, la cuenta se olvida: el mapa no crece con las que pasaron. */
  private forgetIfIdle(key: string, turn: Turn): void {
    if (turn.waiters.length === 0 && turn.active === 0 && this.turns.get(key) === turn) {
      this.turns.delete(key);
    }
  }

  /** Una reserva de una sola unidad: una llamada (`REQUEST_RESERVE_BYTES`) o una apertura. */
  private isSingleUnit(bytes: number): boolean {
    return bytes <= Math.max(REQUEST_RESERVE_BYTES, this.options.reserveBytes ?? OPENING_RESERVE_BYTES);
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
    // La excepción, solo para una unidad: con nada apartado, una llamada o una apertura entra
    // si lo medido está por debajo. Más que eso tiene que caber entero.
    if (this.reserved === 0 && this.isSingleUnit(bytes)) return reading.usedBytes < water;
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
    const turn = this.turns.get(waiter.key);
    const index = turn ? turn.waiters.indexOf(waiter) : -1;
    if (turn && index >= 0) {
      turn.waiters.splice(index, 1);
      this.waiting -= 1;
      this.forgetIfIdle(waiter.key, turn);
    }
    // Quien se fue pudo ser la cabeza de su cuenta y tapar a otra que ya cabe.
    this.admitWhileRoom();
    this.syncPoll();
  }

  /** Solo se mide mientras alguien espera: sin esperas, ningún temporizador. */
  private syncPoll(): void {
    if (this.waiting === 0) {
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
