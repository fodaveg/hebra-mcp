import type { SyncScheduler } from '../../src/sync/runner';

/** Un temporizador pedido al planificador: su plazo, si sigue armado y qué ronda dispara. */
export interface ManualTimer {
  ms: number;
  live: boolean;
  run: () => Promise<unknown>;
}

/**
 * Los temporizadores del `SyncRunner` (D24) sin reloj: cada `every` y `after` queda apuntado con
 * su plazo, y el test lo dispara a mano y espera la ronda que pide. Así se comprueba la espera
 * creciente y la vuelta del bucle de 30 s sin medir milisegundos.
 */
export class ManualScheduler implements SyncScheduler {
  readonly intervals: ManualTimer[] = [];
  readonly timeouts: ManualTimer[] = [];

  every(ms: number, run: () => Promise<unknown>): () => void {
    return this.arm(this.intervals, ms, run);
  }

  after(ms: number, run: () => Promise<unknown>): () => void {
    return this.arm(this.timeouts, ms, run);
  }

  private arm(list: ManualTimer[], ms: number, run: () => Promise<unknown>): () => void {
    const timer: ManualTimer = { ms, live: true, run };
    list.push(timer);
    return () => {
      timer.live = false;
    };
  }

  /** Plazos de los bucles armados ahora. */
  liveIntervals(): number[] {
    return this.intervals.filter((timer) => timer.live).map((timer) => timer.ms);
  }

  /** Plazos de los reintentos armados ahora. */
  liveTimeouts(): number[] {
    return this.timeouts.filter((timer) => timer.live).map((timer) => timer.ms);
  }

  /** Dispara el único reintento armado, como si hubiera vencido, y espera su ronda. */
  async fireTimeout(): Promise<unknown> {
    const live = this.timeouts.filter((timer) => timer.live);
    if (live.length !== 1) throw new Error(`se esperaba un reintento armado y hay ${live.length}`);
    live[0]!.live = false;
    return live[0]!.run();
  }

  /** Dispara una vuelta del único bucle armado y espera su ronda. */
  async fireInterval(): Promise<unknown> {
    const live = this.intervals.filter((timer) => timer.live);
    if (live.length !== 1) throw new Error(`se esperaba un bucle armado y hay ${live.length}`);
    return live[0]!.run();
  }
}
