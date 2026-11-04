import { SHUTDOWN_ROUND_WAIT_MS } from '../sync/runner';

/**
 * Presupuesto del apagado (D22): todo cabe en el `stop_grace_period` de `deploy/compose.yml`.
 *
 *   drenaje HTTP (12 s, con la retirada de cuentas en paralelo)
 *   + ronda final al cerrar (`SHUTDOWN_ROUND_WAIT_MS`, 5 s)
 *   + `runner.stop()` esperando la ronda en vuelo (hasta ~30 s con el relé colgado)
 *   = 47 s de 50.
 *
 * Lo que no sube queda en la SQLite y en la lista durable, y el barrido lo recoge al arrancar. Una
 * retirada que no acabó se reanuda tras reiniciar (`AccountRemovalService.resumePending`).
 */
export const RUNNER_STOP_BUDGET_MS = 30_000;
export const STOP_GRACE_PERIOD_MS = 50_000;
export function shutdownBudgetMs(httpDrainMs: number): number {
  return httpDrainMs + SHUTDOWN_ROUND_WAIT_MS + RUNNER_STOP_BUDGET_MS;
}

/**
 * Espera a que no quede ninguno de los trabajos (que pueden ir apareciendo) o a que pase `ms`, lo
 * que ocurra antes. Devuelve `true` si acabaron. El plazo no mantiene vivo el proceso y se
 * cancela al terminar.
 */
export async function drainWithin(
  jobs: () => Iterable<Promise<unknown>>,
  ms: number,
  setTimer: (run: () => void, ms: number) => () => void = defaultTimer
): Promise<boolean> {
  let cancel = (): void => undefined;
  const expired = new Promise<false>((resolve) => { cancel = setTimer(() => resolve(false), ms); });
  const settled = new WeakSet<Promise<unknown>>();
  const drained = (async (): Promise<true> => {
    for (;;) {
      const pending = [...jobs()].filter((job) => !settled.has(job));
      if (pending.length === 0) return true;
      await Promise.allSettled(pending.map((job) => job.finally(() => { settled.add(job); })));
    }
  })();
  try {
    return await Promise.race([drained, expired]);
  } finally {
    cancel();
  }
}

function defaultTimer(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}
