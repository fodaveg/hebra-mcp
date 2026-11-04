/**
 * D22, §12.10, con un espacio de verdad (gestor, sobres cifrados y relé HTTP local):
 * - un espacio que no cierra hace rechazar a `spaces.close()`, y no se cierra la biblioteca
 *   personal ni se da la cuenta por cerrada hasta que el reintento lo consigue;
 * - el `writer.lock` de un espacio no lo suelta la señal del proceso: lo suelta su cierre, al
 *   terminar la ronda final.
 * Los relojes son falsos: el reintento del cierre lo dispara el test.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../../src/accounts/lifecycle';
import { encodeRecoveryCode } from '../../src/hebra';
import { WRITER_LOCK_FILE } from '../../src/lock/writer-lock';
import { MemorySecretStore, writePairedSecrets, type PairedSecrets } from '../../src/secrets';
import { buildMcpServer } from '../../src/server/build-server';
import { openServeContext, type ServeContext } from '../../src/server/serve';
import { LibraryInstance } from '../../src/sync/library-instance';
import { validatePublicJwk } from '../../vendor/hebra/src/lib/spaces/account-key';
import { sealAgentSpaceGrant } from '../../vendor/hebra/src/lib/spaces/agent-space-grant';
import { FakeLumbre, LUMBRE } from '../pair/fake-lumbre';

const SPACE = '351f12d0-dd49-48a6-b84c-301e16c9d64a';
const SHARED_VAULT = '22'.repeat(16);
const PERSONAL_VAULT = '11'.repeat(16);

let fake: FakeLumbre;
let directory: string;
let secrets: MemorySecretStore;
let paired: PairedSecrets;
let uploadsBlocked: boolean;
let uploadsAccepted: number;
let stderr: ReturnType<typeof vi.spyOn>;
/** Las instancias de espacio que abrió el gestor, en orden. */
let spaceInstances: LibraryInstance[];
/** Los temporizadores que pide el ciclo de vida de los espacios; no corren solos. */
let timers: Array<() => void>;

const clock: Clock = {
  now: () => 0,
  setTimer(run) {
    timers.push(run);
    return () => undefined;
  }
};

const fetcher: typeof fetch = async (input, init) => {
  const url = String(input);
  const upload = init?.method === 'POST' && url.includes(SHARED_VAULT) && url.endsWith('/records');
  if (upload && uploadsBlocked) return new Response('{"error":"unavailable"}', { status: 503 });
  const response = await fake.fetcher(input, init);
  if (upload && response.ok) uploadsAccepted += 1;
  return response;
};

async function open(): Promise<ServeContext> {
  const served = await openServeContext({
    dataDir: directory,
    secrets,
    fetcher,
    syncIntervalMs: null,
    writerOnly: true,
    instance: { checkIntervalMs: null, lock: { releaseOnExit: false } }
  });
  served.ctx.spaces!.lifecycle!.configure({
    idleMs: 3_600_000,
    clock,
    admit: async () => ({ done() {} }) as never,
    onClosed() {}
  });
  return served;
}

async function connect(served: ServeContext): Promise<{ client: Client; close(): Promise<void> }> {
  const server = buildMcpServer(served.ctx, 'test');
  const client = new Client({ name: 'shutdown-locks-tests', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

async function writeInSpace(client: Client): Promise<void> {
  await client.callTool({ name: 'hebra_list_spaces', arguments: {} });
  const registered = fake.agentKeys.get(paired.connection.credentialId)!;
  const grant = await sealAgentSpaceGrant({
    binding: { spaceId: SPACE, syncVaultId: SHARED_VAULT, accountId: registered.accountId,
      credentialId: paired.connection.credentialId, deviceId: registered.deviceId, keyId: registered.keyId },
    publicKey: validatePublicJwk(registered.publicKey),
    spaceKey: new Uint8Array(32).fill(22)
  });
  fake.agentSpaces.set(paired.connection.credentialId, [{ spaceId: SPACE, syncVaultId: SHARED_VAULT, grant }]);
  const created = await client.callTool({ name: 'hebra_create_note', arguments: { body: '# En el espacio', space: SPACE } }) as CallToolResult;
  expect(created.isError).not.toBe(true);
}

const lockOf = (instance: LibraryInstance) =>
  (instance as unknown as { lock: { handleSignal(): { outcome: string } } }).lock;
const spaceLockPath = (instance: LibraryInstance) =>
  join((instance as unknown as { options: { dataDir: string } }).options.dataDir, WRITER_LOCK_FILE);

beforeEach(async () => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  uploadsBlocked = false;
  uploadsAccepted = 0;
  spaceInstances = [];
  timers = [];
  const realOpen = LibraryInstance.open.bind(LibraryInstance);
  vi.spyOn(LibraryInstance, 'open').mockImplementation(async (options) => {
    const instance = await realOpen(options);
    if (options.spaceAccess) spaceInstances.push(instance);
    return instance;
  });
  fake = await FakeLumbre.start();
  directory = await mkdtemp(join(tmpdir(), 'hebra-space-shutdown-'));
  secrets = new MemorySecretStore();
  const deviceId = randomUUID();
  const connection = fake.addAgent('alice', deviceId);
  fake.addLibraryVault('alice', PERSONAL_VAULT);
  paired = {
    connection,
    device: { lumbreDeviceId: deviceId, opaqueDeviceId: randomBytes(16).toString('hex') },
    recoveryCode: await encodeRecoveryCode({ relayOrigin: LUMBRE, syncVaultId: PERSONAL_VAULT, keyEpoch: 1,
      vaultKey: new Uint8Array(32).fill(11) })
  };
  await writePairedSecrets(secrets, paired);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fake.close();
  await rm(directory, { recursive: true, force: true });
});

describe('cierre de espacios', () => {
  it('un espacio que no cierra hace rechazar a close(); la cuenta no se da por cerrada hasta el reintento', async () => {
    const served = await open();
    const { client, close } = await connect(served);
    await writeInSpace(client);
    await close();
    expect(spaceInstances).toHaveLength(1);
    const space = spaceInstances[0];
    const personalLock = join(directory, WRITER_LOCK_FILE);
    expect(existsSync(personalLock)).toBe(true);

    const realClose = space.close.bind(space);
    const attempts = vi.fn();
    let failing = true;
    vi.spyOn(space, 'close').mockImplementation(async () => {
      attempts();
      if (failing) throw new Error('cierre del espacio fallido');
      await realClose();
    });

    await expect(served.close()).rejects.toThrow('cierre del espacio fallido');
    // La personal sigue abierta y el espacio conserva su bloqueo.
    expect(existsSync(personalLock)).toBe(true);
    expect(existsSync(spaceLockPath(space))).toBe(true);
    // Mientras el espacio siga fallando, reintentar la cuenta sigue rechazando.
    await expect(served.close()).rejects.toThrow('cierre del espacio fallido');
    expect(existsSync(personalLock)).toBe(true);

    // El reintento propio del espacio (el reloj lo dispara el test) lo cierra de verdad.
    failing = false;
    expect(timers.length).toBeGreaterThan(0);
    for (const run of timers.splice(0)) run();
    await vi.waitFor(() => expect(existsSync(spaceLockPath(space))).toBe(false));
    const closedAttempts = attempts.mock.calls.length;

    await served.close();
    expect(existsSync(personalLock)).toBe(false);
    // Lo ya cerrado no se cierra otra vez.
    expect(attempts.mock.calls.length).toBe(closedAttempts);
  });
});

describe('bloqueo de un espacio y señal del proceso', () => {
  it('la primera señal no suelta el bloqueo del espacio; la ronda final sube y el cierre lo suelta', async () => {
    const served = await open();
    const { client, close } = await connect(served);
    uploadsBlocked = true;
    await writeInSpace(client);
    await close();
    expect(uploadsAccepted).toBe(0);
    const space = spaceInstances[0];

    // SIGTERM llega mientras el apagado propio aún no empezó a cerrar el espacio.
    expect(lockOf(space).handleSignal().outcome).toBe('deferred');
    expect(existsSync(spaceLockPath(space))).toBe(true);

    uploadsBlocked = false;
    await served.close();
    expect(uploadsAccepted).toBe(1);
    expect(existsSync(spaceLockPath(space))).toBe(false);
  });
});
