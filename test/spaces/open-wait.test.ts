/**
 * El plazo de espera de una apertura de espacio sigue a `HEBRA_MCP_OPEN_WAIT_MS` (llega por
 * `configure`) y no al valor por defecto (D22, SPEC.md §12.10). Reloj falso: sin esperas reales.
 */
import { describe, expect, it } from 'vitest';
import { ContextUnavailableError, DEFAULT_OPEN_WAIT_MS } from '../../src/accounts/capacity';
import { WAIT_BACKSTOP_MARGIN_MS, type Clock } from '../../src/accounts/lifecycle';
import { AgentSpaceManager } from '../../src/spaces/manager';

class FakeClock implements Clock {
  time = 0;
  private timers: { at: number; run: () => void }[] = [];
  now(): number {
    return this.time;
  }
  setTimer(run: () => void, ms: number): () => void {
    const timer = { at: this.time + ms, run };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((entry) => entry !== timer);
    };
  }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((entry) => entry !== due);
      this.time = Math.max(this.time, due.at);
      due.run();
      await flush();
    }
    this.time = end;
    await flush();
  }
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const SPACE = '11111111-1111-4111-8111-111111111111';

/** Un manager cuya admisión nunca contesta: la apertura del espacio queda colgada. */
function hungManager(clock: Clock, openWaitMs?: number): AgentSpaceManager {
  const manager = new AgentSpaceManager({ paired: { connection: { apiOrigin: 'https://relay.test' } } } as never, '/nunca');
  const access = {
    spaceId: SPACE,
    syncVaultId: 'aa'.repeat(16),
    grant: {
      v: 1, spaceId: SPACE, syncVaultId: 'aa'.repeat(16), accountId: 'a', credentialId: 'c', deviceId: 'd', keyId: 'k',
      ephemeralPublicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, salt: 's', iv: 'i', ciphertext: 'c'
    }
  };
  (manager as unknown as { readCatalogue(): Promise<unknown[]> }).readCatalogue = async () => [access];
  manager.lifecycle.configure({
    idleMs: 60_000,
    ...(openWaitMs === undefined ? {} : { openWaitMs }),
    clock,
    admit: () => new Promise<never>(() => undefined),
    onClosed: () => undefined
  });
  return manager;
}

async function waitFor(openWaitMs: number | undefined, expectedMs: number) {
  const clock = new FakeClock();
  const manager = hungManager(clock, openWaitMs);
  const outcome = manager.lifecycle.acquire(SPACE).then(() => null, (error: unknown) => error);
  let settledAt: number | null = null;
  void outcome.then(() => {
    settledAt = clock.time;
  });
  await flush();
  await clock.advance(expectedMs - 1);
  expect(settledAt).toBeNull();
  await clock.advance(1);
  const error = await outcome;
  expect(settledAt).toBe(expectedMs);
  expect(error).toBeInstanceOf(ContextUnavailableError);
  return error;
}

describe('plazo de apertura de un espacio', () => {
  it('con openWaitMs propio termina en ese plazo más el margen y el Retry-After lo refleja', async () => {
    const openWaitMs = 7_000;
    expect(openWaitMs).not.toBe(DEFAULT_OPEN_WAIT_MS);
    const error = await waitFor(openWaitMs, openWaitMs + WAIT_BACKSTOP_MARGIN_MS);
    expect(error).toMatchObject({ reason: 'open_failed', retryAfterSeconds: 7 });
  });

  it('sin openWaitMs (stdio) sigue el valor por defecto', async () => {
    const error = await waitFor(undefined, DEFAULT_OPEN_WAIT_MS + WAIT_BACKSTOP_MARGIN_MS);
    expect(error).toMatchObject({ reason: 'open_failed', retryAfterSeconds: Math.ceil(DEFAULT_OPEN_WAIT_MS / 1000) });
  });
});
