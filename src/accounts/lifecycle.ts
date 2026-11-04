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
 * abrir otra podría dejar dos. Se queda en `cerrando`, y las peticiones reciben el error de
 * ese cierre hasta que un reinicio del proceso lo resuelva.
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
  onCloseFailed?(error: unknown): void;
}

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
    try {
      for (;;) {
        if (this.retired) throw this.options.retiredError();
        if (this.state === 'cerrado') this.startOpening();
        if (this.state === 'abriendo') {
          await this.opening;
        } else if (this.state === 'cerrando') {
          await this.closing;
          if (this.closeFailure) throw this.closeFailure.error;
        } else {
          return this.lease(this.value as V);
        }
      }
    } catch (error) {
      if (this.retired) throw this.options.retiredError();
      throw error;
    } finally {
      this.pending -= 1;
      this.settle();
    }
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
    const value = this.value as V;
    this.phase = 'cerrando';
    this.closing = (async () => {
      try {
        await this.options.close(value);
        this.value = null;
        this.phase = 'cerrado';
      } catch (error) {
        this.closeFailure = { error };
        this.options.onCloseFailed?.(error);
      }
      this.wakeClosed();
      this.settle();
    })();
    return this.closing;
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
