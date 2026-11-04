/**
 * D22: el apagado cabe en el `stop_grace_period` del contenedor. Reloj falso: ningún plazo de aquí
 * depende de que pase tiempo real.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HTTP_DRAIN_TIMEOUT_MS } from '../../src/http/serve-http';
import { drainWithin, RUNNER_STOP_BUDGET_MS, shutdownBudgetMs, STOP_GRACE_PERIOD_MS } from '../../src/http/shutdown-budget';
import { CLOSE_ROUND_WAIT_MS, SHUTDOWN_ROUND_WAIT_MS } from '../../src/sync/runner';
import { deferred } from '../fixtures/deferred';

class FakeTimers {
  private now = 0;
  private timers: Array<{ at: number; run: () => void }> = [];
  readonly set = (run: () => void, ms: number): (() => void) => {
    const timer = { at: this.now + ms, run };
    this.timers.push(timer);
    return () => { this.timers = this.timers.filter((entry) => entry !== timer); };
  };
  get pending(): number { return this.timers.length; }
  async advance(ms: number): Promise<void> {
    this.now += ms;
    for (const timer of this.timers.filter((entry) => entry.at <= this.now)) {
      this.timers = this.timers.filter((entry) => entry !== timer);
      timer.run();
    }
    for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('presupuesto de apagado', () => {
  it('drenaje HTTP + ronda final del apagado + runner.stop() caben en el stop_grace_period', async () => {
    expect(HTTP_DRAIN_TIMEOUT_MS).toBe(12_000);
    expect(SHUTDOWN_ROUND_WAIT_MS).toBe(5_000);
    expect(SHUTDOWN_ROUND_WAIT_MS).toBeLessThan(CLOSE_ROUND_WAIT_MS);
    expect(shutdownBudgetMs(HTTP_DRAIN_TIMEOUT_MS)).toBe(12_000 + 5_000 + RUNNER_STOP_BUDGET_MS);
    expect(shutdownBudgetMs(HTTP_DRAIN_TIMEOUT_MS)).toBeLessThanOrEqual(STOP_GRACE_PERIOD_MS);
    const compose = await readFile(join(__dirname, '../../deploy/compose.yml'), 'utf8');
    expect(compose).toContain(`stop_grace_period: ${STOP_GRACE_PERIOD_MS / 1000}s`);
    expect(compose).toContain('12 + 5 + 30 = 47');
  });

  it('una retirada colgada no retiene el apagado más allá del plazo, y su temporizador no queda vivo', async () => {
    const timers = new FakeTimers();
    const hung = deferred();
    const jobs = new Set<Promise<unknown>>([hung.promise]);
    let result: boolean | null = null;
    void drainWithin(() => jobs, HTTP_DRAIN_TIMEOUT_MS, timers.set).then((done) => { result = done; });
    await timers.advance(HTTP_DRAIN_TIMEOUT_MS - 1);
    expect(result).toBeNull();
    await timers.advance(1);
    expect(result).toBe(false);
    expect(timers.pending).toBe(0);
  });

  it('si las retiradas acaban antes, no espera al plazo, y recoge las que aparecen mientras drena', async () => {
    const timers = new FakeTimers();
    const first = deferred();
    const second = deferred();
    const jobs = new Set<Promise<unknown>>([first.promise]);
    let result: boolean | null = null;
    void drainWithin(() => jobs, HTTP_DRAIN_TIMEOUT_MS, timers.set).then((done) => { result = done; });
    await timers.advance(1_000);
    jobs.add(second.promise);
    first.resolve();
    await timers.advance(1_000);
    expect(result).toBeNull();
    jobs.clear();
    second.resolve();
    await timers.advance(1);
    expect(result).toBe(true);
    expect(timers.pending).toBe(0);
  });
});
