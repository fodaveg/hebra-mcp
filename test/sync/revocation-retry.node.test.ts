import { describe, expect, it } from 'vitest';
import { InMemoryLibraryRelay, IDENTITY, VAULT_KEY, appDevice } from './devices';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { NoteWriter } from '../../src/store/writes';
import {
  REVOKED_RETRY_FIRST_MS,
  REVOKED_RETRY_MAX_MS,
  SYNC_INTERVAL_MS,
  SyncRunner,
  revokedRetryDelayMs
} from '../../src/sync/runner';
import { NO_PRIVATE } from '../fixtures/no-private';
import { ManualScheduler } from '../fixtures/manual-scheduler';

/**
 * D24 (7 nov 2026): tras un 401/403 del relé el runner no se queda parado hasta reiniciar.
 * Reintenta con espera creciente (1 min, el doble, tope 15 min) y, en cuanto una ronda vuelve a
 * ir bien, recupera el bucle de 30 s y sube lo pendiente. Relé en memoria que da 401 y luego 200,
 * y temporizadores que el test dispara a mano: sin medir milisegundos.
 */

async function revocableRunner() {
  const relay = new InMemoryLibraryRelay();
  const port = await openNodeLibraryPort({ sqlitePath: ':memory:', deviceLabel: 'Claude' });
  const scheduler = new ManualScheduler();
  const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const changes: boolean[] = [];
  const runner = await SyncRunner.create({
    port: port.syncStorePort(),
    transport: relay,
    blobTransport: null,
    identity: IDENTITY,
    vaultKey: VAULT_KEY,
    scheduler,
    emit: (event, fields) => logged.push({ event, fields }),
    onRevocationChange: (revoked) => changes.push(revoked)
  });
  const writer = new NoteWriter(port, { onWritten: () => void runner.requestRound() });
  runner.start();
  await runner.whenReady();
  return { relay, port, scheduler, logged, changes, runner, writer };
}

/** El bucle de 30 s da una vuelta y el relé responde 401. */
async function revokeByRelay(device: Awaited<ReturnType<typeof revocableRunner>>) {
  device.relay.httpErrorNextChanges = { status: 401 };
  await device.scheduler.fireInterval();
  expect(device.runner.revoked).toBe(true);
}

describe('reintento tras una revocación (D24)', () => {
  it('la espera empieza en 1 min, se dobla y se queda en 15 min', () => {
    expect(REVOKED_RETRY_FIRST_MS).toBe(60_000);
    expect(REVOKED_RETRY_MAX_MS).toBe(900_000);
    expect([0, 1, 2, 3, 4, 5, 50].map(revokedRetryDelayMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000
    ]);
  });

  it('tras un 401 para el bucle de 30 s y reintenta con espera creciente y tope, sin rondas por escrituras', async () => {
    const device = await revocableRunner();
    const { relay, scheduler, runner, writer, logged } = device;
    expect(scheduler.liveIntervals()).toEqual([SYNC_INTERVAL_MS]);
    await revokeByRelay(device);
    expect(scheduler.liveIntervals()).toEqual([]);
    expect(scheduler.liveTimeouts()).toEqual([60_000]);
    expect(logged.filter((entry) => entry.event === 'pairing.revoked')).toEqual([
      { event: 'pairing.revoked', fields: { source: 'relay' } }
    ]);

    // Una escritura durante la revocación no llama al relé.
    const calls = relay.changesCalls;
    await writer.createNote({ body: '# Durante la revocación', privacy: NO_PRIVATE });
    expect(await runner.requestRound()).toBeNull();
    expect(relay.changesCalls).toBe(calls);

    // Cada reintento que vuelve a recibir 401 es UNA ronda y alarga la espera hasta el tope.
    for (const next of [120_000, 240_000, 480_000, 900_000, 900_000]) {
      relay.httpErrorNextChanges = { status: 401 };
      const before = relay.changesCalls;
      await scheduler.fireTimeout();
      expect(relay.changesCalls).toBe(before + 1);
      expect(runner.revoked).toBe(true);
      expect(scheduler.liveTimeouts()).toEqual([next]);
      expect(scheduler.liveIntervals()).toEqual([]);
    }
    expect(logged.filter((entry) => entry.event === 'pairing.revoked')).toHaveLength(1);
    expect(logged.filter((entry) => entry.event === 'pairing.restored')).toEqual([]);
    await runner.stop();
    expect(scheduler.liveTimeouts()).toEqual([]);
  });

  it('cuando el relé vuelve a aceptar: revoked a false, vuelve el bucle de 30 s y sube lo pendiente', async () => {
    const device = await revocableRunner();
    const { relay, scheduler, runner, writer, logged, changes } = device;
    await revokeByRelay(device);
    relay.httpErrorNextChanges = { status: 401 };
    await scheduler.fireTimeout();
    const pending = await writer.createNote({ body: '# Escrita sin credencial', privacy: NO_PRIVATE });
    expect((await runner.syncStatus()).pendingUpload).toBeGreaterThan(0);

    // El relé acepta de nuevo la MISMA credencial (agente reactivado en Hebra).
    await scheduler.fireTimeout();
    expect(runner.revoked).toBe(false);
    expect(scheduler.liveTimeouts()).toEqual([]);
    expect(scheduler.liveIntervals()).toEqual([SYNC_INTERVAL_MS]);
    expect(changes).toEqual([true, false]);
    expect(logged.filter((entry) => entry.event === 'pairing.restored')).toEqual([
      { event: 'pairing.restored', fields: { source: 'relay', failedRetries: 1 } }
    ]);
    const status = await runner.syncStatus();
    expect(status).toMatchObject({ revoked: false, lastSyncOutcome: 'ok', pendingUpload: 0 });
    // Lo escrito durante la revocación llegó al relé.
    const app = await appDevice(relay);
    await app.sync.runRound();
    expect((await app.port.noteRead(pending.id))?.body).toBe('# Escrita sin credencial');

    // El bucle de 30 s vuelve a hacer rondas, y las escrituras vuelven a pedirlas.
    const calls = relay.changesCalls;
    await scheduler.fireInterval();
    expect(relay.changesCalls).toBe(calls + 1);
    expect(await runner.requestRound()).not.toBeNull();
    await runner.stop();
  });

  it('un 401 al registrar la clave de agente (markRevoked) revoca y se recupera igual', async () => {
    const device = await revocableRunner();
    const { scheduler, runner, logged } = device;
    runner.markRevoked('agent_key');
    runner.markRevoked('agent_key');
    expect(runner.revoked).toBe(true);
    expect(scheduler.liveIntervals()).toEqual([]);
    expect(scheduler.liveTimeouts()).toEqual([60_000]);
    expect(logged.filter((entry) => entry.event === 'pairing.revoked')).toEqual([
      { event: 'pairing.revoked', fields: { source: 'agent_key' } }
    ]);
    await scheduler.fireTimeout();
    expect(runner.revoked).toBe(false);
    expect(scheduler.liveIntervals()).toEqual([SYNC_INTERVAL_MS]);
    await runner.stop();
  });

  it('retryNow reintenta ya, sin esperar el plazo; sin revocación no hace nada', async () => {
    const device = await revocableRunner();
    const { relay, scheduler, runner } = device;
    expect(await runner.retryNow()).toBeNull();
    await revokeByRelay(device);
    const calls = relay.changesCalls;
    const round = await runner.retryNow();
    expect(round?.result).toBe('ok');
    expect(relay.changesCalls).toBe(calls + 1);
    expect(runner.revoked).toBe(false);
    expect(scheduler.liveTimeouts()).toEqual([]);
    await runner.stop();
  });

  it('sin planificador y con intervalMs null (tests que mueven las rondas) no programa reintentos', async () => {
    const relay = new InMemoryLibraryRelay();
    const port = await openNodeLibraryPort({ sqlitePath: ':memory:' });
    const runner = await SyncRunner.create({
      port: port.syncStorePort(), transport: relay, blobTransport: null,
      identity: IDENTITY, vaultKey: VAULT_KEY, intervalMs: null
    });
    relay.httpErrorNextChanges = { status: 401 };
    expect((await runner.requestRound())?.result).toBe('http_401');
    expect(runner.revoked).toBe(true);
    // Lo recupera un reintento pedido a mano.
    expect((await runner.retryNow())?.result).toBe('ok');
    expect(runner.revoked).toBe(false);
    await runner.stop();
  });
});
