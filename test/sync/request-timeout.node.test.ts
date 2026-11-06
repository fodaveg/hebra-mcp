import { afterEach, describe, expect, it, vi } from 'vitest';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { createSyncGates } from '../../src/sync/gates';
import { SyncRunner } from '../../src/sync/runner';
import { IDENTITY, InMemoryLibraryRelay, VAULT_KEY, mcpDevice } from './devices';

/**
 * Un relé que acepta la petición y no contesta no puede tener una plaza de ronda para siempre
 * (SPEC.md §12.10). El plazo lo pone el transporte HTTP del motor (`HttpLibraryTransport`: 30 s
 * sin recibir nada, 15 min en total); aquí se comprueba, con `setTimeout` falso, que al vencer
 * la ronda acaba y el runner suelta su plaza, de modo que otra cuenta puede sincronizar.
 */

const SILENCE_MS = 30_000;

/** Un `fetch` que no contesta jamás, pero respeta el `signal` como el real. */
const hangingFetch = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  });

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('relé que no contesta', () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const close of closers.splice(0)) close();
  });

  it('suelta la plaza de ronda al vencer el plazo y otra cuenta sincroniza', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const gates = createSyncGates(1);
    const port = await openNodeLibraryPort({ sqlitePath: ':memory:', deviceLabel: 'Claude' });
    closers.push(() => port.close());
    const hung = await SyncRunner.create({
      port: port.syncStorePort(),
      connection: async () => ({ apiOrigin: 'https://relay.test', readToken: 'r', writeToken: 'w' }),
      fetcher: hangingFetch,
      identity: IDENTITY,
      vaultKey: VAULT_KEY,
      intervalMs: null,
      gates,
      accountKey: 'A'
    });
    const round = hung.requestRound();
    await settle();
    expect(gates.rounds.inUse).toBe(1);

    const other = await mcpDevice(new InMemoryLibraryRelay(), { gates });
    closers.push(() => other.port.close());
    let otherDone = false;
    void other.runner.requestRound().then(() => (otherDone = true));
    await settle();
    expect(otherDone).toBe(false);
    expect(gates.rounds.queued).toBe(1);

    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1);
    await settle();
    expect(gates.rounds.inUse).toBe(1);
    expect(otherDone).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await round;
    await vi.waitFor(() => expect(otherDone).toBe(true));
    expect(gates.rounds.inUse).toBe(0);
    expect(gates.rounds.queued).toBe(0);
  });
});
