import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeServeResources } from '../../src/server/serve';

/**
 * El cierre de un contexto cabe en el presupuesto del apagado (D22, `shutdown-budget.ts`): con el
 * proceso apagándose, espacios y biblioteca personal cierran a la vez, no uno detrás de otro
 * (12 + 35 + 35 s no caben en los 47 s del presupuesto ni en los 50 de `stop_grace_period`).
 */
function closing(ms: number, log: string[], name: string) {
  return vi.fn(async () => {
    log.push(`${name}:empieza`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    log.push(`${name}:acaba`);
  });
}

describe('closeServeResources', () => {
  afterEach(() => vi.useRealTimers());

  it('apagando, espacios y personal cierran en paralelo: dura lo del más lento', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const done = vi.fn();
    const promise = closeServeResources({
      shuttingDown: true,
      spaces: { close: closing(35_000, log, 'espacios') },
      instance: { close: closing(35_000, log, 'personal') }
    }).then(done);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['espacios:empieza', 'personal:empieza']);
    await vi.advanceTimersByTimeAsync(35_000);
    await promise;
    expect(done).toHaveBeenCalled();
  });

  it('un cierre normal conserva el orden: ledger, espacios y luego personal', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const promise = closeServeResources({
      shuttingDown: false,
      settle: closing(1_000, log, 'ledger'),
      spaces: { close: closing(1_000, log, 'espacios') },
      instance: { close: closing(1_000, log, 'personal') }
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await promise;
    expect(log).toEqual(['ledger:empieza', 'ledger:acaba', 'espacios:empieza', 'espacios:acaba', 'personal:empieza', 'personal:acaba']);
  });

  it('apagando, si uno falla el otro termina igualmente y el error sale', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const promise = closeServeResources({
      shuttingDown: true,
      spaces: { close: async () => { throw new Error('espacios'); } },
      instance: { close: closing(5_000, log, 'personal') }
    });
    const caught = promise.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await caught).toBe('espacios');
    expect(log).toEqual(['personal:empieza', 'personal:acaba']);
  });
});
