import { describe, expect, it } from 'vitest';
import { IDENTITY, InMemoryLibraryRelay, VAULT_KEY, mcpDevice } from './devices';
import { createSyncGates, FifoSemaphore, type SyncGates } from '../../src/sync/gates';
import { SyncRunner } from '../../src/sync/runner';

/**
 * Topes de sync de proceso (SPEC.md §12.10): como mucho N rondas a la vez entre TODOS los
 * runners, en orden de llegada. Sin tiempos reales: la ronda se detiene en `beforeRound`, que
 * corre dentro del turno, hasta que el test la suelta.
 */

interface Probe {
  started: number[];
  active: Set<number>;
  maxActive: number;
  release(index: number): void;
  beforeRound(index: number): () => Promise<void>;
}

function probe(): Probe {
  const pending = new Map<number, () => void>();
  const p: Probe = {
    started: [],
    active: new Set(),
    maxActive: 0,
    release: (index) => {
      pending.get(index)?.();
      pending.delete(index);
    },
    beforeRound: (index) => async () => {
      p.started.push(index);
      p.active.add(index);
      p.maxActive = Math.max(p.maxActive, p.active.size);
      await new Promise<void>((resolve) => pending.set(index, resolve));
      p.active.delete(index);
    }
  };
  return p;
}

/** Deja correr las microtareas y los I/O pendientes (no hay temporizadores de por medio). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function devices(count: number, p: Probe, gates: SyncGates) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(await mcpDevice(new InMemoryLibraryRelay(), { gates, beforeRound: p.beforeRound(i) }));
  }
  return out;
}

/** Un runner cuyo plazo de espera (`waitTimer`) lo vence el test con `expire()`. */
async function runnerWithManualTimer(gates: SyncGates) {
  const dev = await mcpDevice(new InMemoryLibraryRelay(), { gates });
  let expire!: () => void;
  const runner = await SyncRunner.create({
    port: dev.port.syncStorePort(),
    transport: new InMemoryLibraryRelay(),
    identity: IDENTITY,
    vaultKey: VAULT_KEY,
    intervalMs: null,
    gates,
    waitTimer: () => new Promise<void>((resolve) => (expire = resolve))
  });
  return { runner, expire: () => expire() };
}

describe('FifoSemaphore', () => {
  it('un abort en cola sale sin coger plaza y respeta el orden de los demás', async () => {
    const sem = new FifoSemaphore(1);
    const first = (await sem.acquire())!;
    const abort = new AbortController();
    const waitingAborted = sem.acquire(abort.signal);
    const waitingNext = sem.acquire();
    abort.abort();
    expect(await waitingAborted).toBeNull();
    expect(sem.queued).toBe(1);
    first();
    const next = await waitingNext;
    expect(next).not.toBeNull();
    expect(sem.inUse).toBe(1);
    next!();
    next!();
    expect(sem.inUse).toBe(0);
  });
});

describe('FifoSemaphore: turno rotatorio por cuenta', () => {
  function asker(sem: FifoSemaphore) {
    const order: string[] = [];
    const held: Array<() => void> = [];
    return {
      order,
      held,
      ask(label: string, key?: string): void {
        void sem.acquire(undefined, key).then((release) => {
          order.push(label);
          held.push(release!);
        });
      }
    };
  }

  it('con A pidiendo 5 y B 1 después, B entra en el siguiente turno libre', async () => {
    const sem = new FifoSemaphore(1);
    const { order, held, ask } = asker(sem);
    for (let i = 1; i <= 5; i += 1) ask(`A${i}`, 'A');
    ask('B1', 'B');
    await settle();
    expect(order).toEqual(['A1']);
    held.shift()!();
    await settle();
    expect(order).toEqual(['A1', 'B1']);
    for (let i = 0; i < 5; i += 1) {
      held.shift()!();
      await settle();
    }
    expect(order).toEqual(['A1', 'B1', 'A2', 'A3', 'A4', 'A5']);
  });

  it('con tres cuentas rota entre ellas y la cuenta única es FIFO', async () => {
    const sem = new FifoSemaphore(1);
    const { order, held, ask } = asker(sem);
    for (const [label, key] of [['A1', 'A'], ['A2', 'A'], ['A3', 'A'], ['B1', 'B'], ['B2', 'B'], ['C1', 'C']]) {
      ask(label!, key);
    }
    for (let i = 0; i < 6; i += 1) {
      await settle();
      held.shift()?.();
    }
    await settle();
    expect(order).toEqual(['A1', 'B1', 'C1', 'A2', 'B2', 'A3']);

    const single = new FifoSemaphore(1);
    const one = asker(single);
    for (let i = 0; i < 4; i += 1) one.ask(String(i));
    for (let i = 0; i < 4; i += 1) {
      await settle();
      one.held.shift()?.();
    }
    expect(one.order).toEqual(['0', '1', '2', '3']);
  });

  it('un abort de la cuenta que espera no deja plaza ni estado colgado', async () => {
    const sem = new FifoSemaphore(1);
    const first = (await sem.acquire(undefined, 'A'))!;
    const abort = new AbortController();
    const waiting = sem.acquire(abort.signal, 'B');
    abort.abort();
    expect(await waiting).toBeNull();
    expect(sem.queued).toBe(0);
    first();
    expect(sem.inUse).toBe(0);
    const again = await sem.acquire(undefined, 'B');
    expect(again).not.toBeNull();
    again!();
    expect(sem.inUse).toBe(0);
  });
});

describe('rondas de sync de proceso', () => {
  it('con 5 contextos pidiendo ronda solo corren 2 a la vez, en orden de llegada', async () => {
    const p = probe();
    const ds = await devices(5, p, createSyncGates(2));
    const rounds = ds.map((d) => d.runner.requestRound());
    await settle();
    expect(p.started).toEqual([0, 1]);
    p.release(0);
    await settle();
    expect(p.started).toEqual([0, 1, 2]);
    p.release(1);
    await settle();
    expect(p.started).toEqual([0, 1, 2, 3]);
    p.release(2);
    p.release(3);
    await settle();
    expect(p.started).toEqual([0, 1, 2, 3, 4]);
    p.release(4);
    await Promise.all(rounds);
    expect(p.maxActive).toBe(2);
  });

  it('una ronda que lanza o que falla suelta su turno', async () => {
    const gates = createSyncGates(1);
    const throwing = await mcpDevice(new InMemoryLibraryRelay(), {
      gates,
      beforeRound: async () => {
        throw new Error('boom');
      }
    });
    await throwing.runner.requestRound();
    expect(gates.rounds.inUse).toBe(0);

    const dev = await mcpDevice(new InMemoryLibraryRelay(), { gates });
    const failing = await SyncRunner.create({
      port: dev.port.syncStorePort(),
      transport: new Proxy(new InMemoryLibraryRelay(), {
        get: (target, key) =>
          key === 'then' || typeof (target as never)[key] !== 'function'
            ? (target as never)[key]
            : () => Promise.reject(new Error('sin red'))
      }),
      identity: IDENTITY,
      vaultKey: VAULT_KEY,
      intervalMs: null,
      gates
    });
    await failing.requestRound().catch(() => undefined);
    expect(gates.rounds.inUse).toBe(0);

    const ok = await mcpDevice(new InMemoryLibraryRelay(), { gates });
    expect((await ok.runner.requestRound())?.result).toBe('ok');
    expect(gates.rounds.inUse).toBe(0);
  });

  it('cerrar un contexto en cola no lo ejecuta, no deja el turno cogido y no bloquea a los demás', async () => {
    const p = probe();
    const gates = createSyncGates(1);
    const ds = await devices(3, p, gates);
    const r0 = ds[0]!.runner.requestRound();
    const r1 = ds[1]!.runner.requestRound();
    const r2 = ds[2]!.runner.requestRound();
    await settle();
    expect(p.started).toEqual([0]);
    expect(gates.rounds.queued).toBe(2);
    await ds[1]!.runner.stop();
    expect(await r1).toBeNull();
    expect(gates.rounds.queued).toBe(1);
    p.release(0);
    await settle();
    expect(p.started).toEqual([0, 2]);
    p.release(2);
    await Promise.all([r0, r2]);
    expect(p.started).not.toContain(1);
    expect(gates.rounds.inUse).toBe(0);
    expect(gates.rounds.queued).toBe(0);
  });

  it('whenReady vence por su plazo si la ronda sigue esperando turno, sin datos de sync', async () => {
    const gates = createSyncGates(1);
    const held = (await gates.rounds.acquire())!;
    const { runner, expire } = await runnerWithManualTimer(gates);
    void runner.requestRound();
    const ready = runner.whenReady();
    expire();
    await ready;
    expect((await runner.syncStatus()).lastSyncAt).toBeNull();
    held();
    await runner.stop();
    expect(gates.rounds.inUse).toBe(0);
  });

  it('la ronda final al cerrar pasa por el semáforo', async () => {
    const gates = createSyncGates(1);
    const held = (await gates.rounds.acquire())!;
    const { runner, expire } = await runnerWithManualTimer(gates);
    const final = runner.finalRound();
    await settle();
    expect(gates.rounds.queued).toBe(1);
    expire();
    expect(await final).toBe('timeout');
    held();
    await runner.stop();
    expect(gates.rounds.inUse).toBe(0);
  });
});
