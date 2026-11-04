import { logEvent } from '../log/logger';

/**
 * El ciclo de vida de lo que se abre por uso en `serve-http` (SPEC.md §12.10, "Capacidad sin
 * recuento"): una biblioteca de cuenta o un espacio. Un solo estado a la vez, `cerrado`,
 * `abriendo`, `abierto` o `cerrando`, y una sola instancia por recurso: el bloqueo entre
 * procesos no cubre este caso, porque comparte PID (`src/lock/writer-lock.ts`).
 *
 * - Las peticiones de un recurso en `abriendo` comparten esa apertura.
 * - Una petición en `cerrando` espera a que termine el cierre y abre de nuevo.
 * - `abierto` se cierra tras `idleMs` sin peticiones en curso, nunca con una en curso.
 * - `retire` impide adquirirlo otra vez y lo cierra al terminar lo que tenga en curso.
 *
 * Un cierre que falla no vuelve a `cerrado`: sin saber si la instancia soltó el directorio,
 * abrir otra podría dejar dos. Se queda en `cerrando` y se reintenta solo, con espera creciente
 * (1 s, 2 s, 4 s... hasta 30 s) y sin límite de intentos. Mientras tanto, quien pide ese recurso
 * recibe el error del último intento (503 `open_failed` con `Retry-After`) y vuelve a probar; en
 * cuanto un intento cierra, la siguiente petición abre de nuevo, sin reiniciar nada ni afectar a
 * otras cuentas. Un cierre que no se recupera no se da por bueno ni se abandona. Eventos de log,
 * todos con `resource` (`account` | `space`): `contexts.close_failed` en cada intento fallido
 * (con `attempt`), `contexts.close_recovered` cuando un reintento cierra, y
 * `contexts.close_stuck` al llegar al intento 10 (unos 3 minutos) y cada 10 después.
 *
 * Solo `contexts.close_stuck` repetido sin `close_recovered` pide mirar al operador, y el
 * arreglo es quitar la causa (disco lleno o solo lectura, directorio desmontado), que el
 * siguiente reintento recoge. Reiniciar el proceso solo hace falta si el cierre falla porque
 * el recurso quedó a medias de un modo que no se repara desde dentro; el reinicio libera el
 * directorio igual (el `writer.lock` obsoleto de un arranque anterior se limpia al abrir).
 */
export type LifecycleState = 'cerrado' | 'abriendo' | 'abierto' | 'cerrando';

/** El reloj se inyecta para probar las esperas sin esperar de verdad. */
export interface Clock {
  now(): number;
  /** Programa `run` dentro de `ms`; devuelve cómo cancelarlo. */
  setTimer(run: () => void, ms: number): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer(run, ms) {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  }
};

export interface ResourceLease<V> {
  value: V;
  /** Idempotente. */
  release(): void;
}

export interface ResourceLifecycleOptions<V> {
  /** `signal` se aborta si el recurso se retira mientras abre. */
  open(signal: AbortSignal): Promise<V>;
  close(value: V): Promise<void>;
  clock: Clock;
  /** `null`: sin cierre por inactividad. */
  idleMs(): number | null;
  /** Lo que recibe quien adquiere un recurso ya retirado. */
  retiredError(): Error;
  /** ¿Se cierra en cuanto termine lo que tiene en curso, sin esperar `idleMs`? */
  closeAfterUse?(value: V): boolean;
  /** Pasó a `cerrado` y nadie va a reabrir este objeto: quien lo guarda ya puede soltarlo. */
  onDisposable?(): void;
  /** Para el log de los cierres fallidos y recuperados. */
  resource: 'account' | 'space';
  /**
   * Plazo de quien espera una apertura o un cierre en curso (SPEC.md §12.10): al cumplirse,
   * `acquire` rechaza con `waitTimeoutError()` y el trabajo de fondo sigue. Cuenta desde la
   * primera espera de esa petición y es un tope de seguridad, no el plazo normal: las esperas
   * con plazo propio (memoria, `writer.lock`) terminan antes y dan su motivo preciso. Sin él,
   * un cierre o una apertura colgados dejarían la petición HTTP colgada, sin 503.
   */
  waitMs: number;
  waitTimeoutError(): Error;
  /** Primera espera entre reintentos de un cierre fallido (se duplica hasta `closeRetryMaxMs`). */
  closeRetryBaseMs?: number;
  closeRetryMaxMs?: number;
}

/** Lo que `waitMs` suma a `HEBRA_MCP_OPEN_WAIT_MS`: para que gane el motivo preciso de las esperas
 *  que tienen plazo propio (memoria, `writer.lock`) y este quede de tope de seguridad. */
export const WAIT_BACKSTOP_MARGIN_MS = 5_000;
const DEFAULT_CLOSE_RETRY_BASE_MS = 1_000;
const DEFAULT_CLOSE_RETRY_MAX_MS = 30_000;
/** Cada cuántos intentos fallidos seguidos se dice `contexts.close_stuck`. */
const CLOSE_STUCK_EVERY = 10;

export class ResourceLifecycle<V> {
  private phase: LifecycleState = 'cerrado';
  private value: V | null = null;
  private uses = 0;
  /** Quienes están dentro de `acquire`: cuentan como uso para no cerrar bajo sus pies. */
  private pending = 0;
  private retired = false;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private openAbort: AbortController | null = null;
  private cancelIdle: (() => void) | null = null;
  private closeFailure: { error: unknown } | null = null;
  private closeAttempts = 0;
  private readonly closedWaiters: Array<() => void> = [];

  constructor(private readonly options: ResourceLifecycleOptions<V>) {}

  get state(): LifecycleState {
    return this.phase;
  }

  /** Abierto y sin peticiones en curso. */
  get idle(): boolean {
    return this.phase === 'abierto' && this.uses === 0 && this.pending === 0;
  }

  /** El recurso abierto, sin adquirirlo: solo para mirarlo. */
  peek(): V | null {
    return this.phase === 'abierto' ? this.value : null;
  }

  async acquire(): Promise<ResourceLease<V>> {
    this.pending += 1;
    this.stopIdle();
    // El plazo de las esperas de esta petición: un solo temporizador, creado en la primera.
    let limit: { expired: Promise<never>; cancel(): void } | null = null;
    const bounded = (work: Promise<unknown> | null): Promise<unknown> => {
      limit ??= this.startWaitLimit();
      return Promise.race([work, limit.expired]);
    };
    try {
      for (;;) {
        if (this.retired) throw this.options.retiredError();
        if (this.state === 'cerrado') this.startOpening();
        if (this.state === 'abriendo') {
          await bounded(this.opening);
        } else if (this.state === 'cerrando') {
          await bounded(this.closing);
          if (this.closeFailure) throw this.closeFailure.error;
        } else {
          return this.lease(this.value as V);
        }
      }
    } catch (error) {
      if (this.retired) throw this.options.retiredError();
      throw error;
    } finally {
      (limit as { cancel(): void } | null)?.cancel();
      this.pending -= 1;
      this.settle();
    }
  }

  private startWaitLimit(): { expired: Promise<never>; cancel(): void } {
    let cancel = (): void => undefined;
    const expired = new Promise<never>((_, reject) => {
      cancel = this.options.clock.setTimer(() => reject(this.options.waitTimeoutError()), this.options.waitMs);
    });
    // Se compite siempre con ella, pero si la petición acaba antes no debe quedar un rechazo suelto.
    expired.catch(() => undefined);
    return { expired, cancel };
  }

  /** Deja de admitir peticiones y resuelve cuando el recurso está cerrado. */
  retire(): Promise<void> {
    this.retired = true;
    this.openAbort?.abort(this.options.retiredError());
    this.stopIdle();
    this.settle();
    return this.whenClosed();
  }

  /** Acorta la espera de inactividad. No hace nada si hay peticiones en curso. */
  closeIfIdle(): Promise<void> {
    return this.idle ? this.beginClosing() : Promise.resolve();
  }

  private lease(value: V): ResourceLease<V> {
    this.uses += 1;
    let released = false;
    return {
      value,
      release: () => {
        if (released) return;
        released = true;
        this.uses -= 1;
        this.settle();
      }
    };
  }

  private startOpening(): void {
    this.phase = 'abriendo';
    const abort = new AbortController();
    this.openAbort = abort;
    this.opening = this.options.open(abort.signal).then(
      (value) => {
        this.value = value;
        this.phase = 'abierto';
        this.openAbort = null;
      },
      (error: unknown) => {
        this.phase = 'cerrado';
        this.openAbort = null;
        this.wakeClosed();
        throw error;
      }
    );
    // Lo reciben quienes esperan en `acquire`; aquí solo se evita el aviso de rechazo suelto.
    this.opening.catch(() => undefined);
  }

  private beginClosing(): Promise<void> {
    this.stopIdle();
    this.phase = 'cerrando';
    this.closeAttempts = 0;
    return this.attemptClose();
  }

  /** Un intento de cierre. Si falla, programa el siguiente y deja el error para quien espere. */
  private attemptClose(): Promise<void> {
    const value = this.value as V;
    this.closeFailure = null;
    this.closing = (async () => {
      try {
        await this.options.close(value);
        this.value = null;
        this.phase = 'cerrado';
        if (this.closeAttempts > 0) {
          logEvent({ event: 'contexts.close_recovered', resource: this.options.resource,
            attempts: this.closeAttempts });
        }
        this.closeAttempts = 0;
      } catch (error) {
        this.closeFailure = { error };
        this.closeAttempts += 1;
        logEvent({ event: 'contexts.close_failed', resource: this.options.resource,
          attempt: this.closeAttempts, error: error instanceof Error ? error.name : 'unknown' });
        if (this.closeAttempts % CLOSE_STUCK_EVERY === 0) {
          logEvent({ event: 'contexts.close_stuck', resource: this.options.resource,
            attempts: this.closeAttempts });
        }
        this.scheduleCloseRetry();
      }
      this.wakeClosed();
      this.settle();
    })();
    return this.closing;
  }

  private scheduleCloseRetry(): void {
    const base = this.options.closeRetryBaseMs ?? DEFAULT_CLOSE_RETRY_BASE_MS;
    const max = this.options.closeRetryMaxMs ?? DEFAULT_CLOSE_RETRY_MAX_MS;
    const wait = Math.min(max, base * 2 ** Math.min(this.closeAttempts - 1, 20));
    this.options.clock.setTimer(() => {
      void this.attemptClose();
    }, wait);
  }

  /** Lo que toca después de cada cambio de uso o de estado. */
  private settle(): void {
    if (this.idle) {
      const value = this.value as V;
      if (this.retired || this.options.closeAfterUse?.(value)) void this.beginClosing();
      else this.armIdle();
    } else if (this.phase === 'cerrado' && (this.pending === 0 || this.retired)) {
      // Con `pending > 0` y sin retirar, alguien va a reabrir ESTE objeto: soltarlo dejaría
      // que otra petición creara otro para el mismo directorio.
      this.options.onDisposable?.();
    }
  }

  private armIdle(): void {
    this.stopIdle();
    const ms = this.options.idleMs();
    if (ms === null) return;
    this.cancelIdle = this.options.clock.setTimer(() => {
      this.cancelIdle = null;
      if (this.idle) void this.beginClosing();
    }, ms);
  }

  private stopIdle(): void {
    this.cancelIdle?.();
    this.cancelIdle = null;
  }

  private wakeClosed(): void {
    for (const wake of this.closedWaiters.splice(0)) wake();
  }

  private async whenClosed(): Promise<void> {
    if (this.phase !== 'cerrado' && !this.closeFailure) {
      await new Promise<void>((resolve) => this.closedWaiters.push(resolve));
    }
    if (this.closeFailure) throw this.closeFailure.error;
  }
}
