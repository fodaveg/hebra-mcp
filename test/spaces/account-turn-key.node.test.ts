/**
 * La clave de cuenta del turno de los topes de sync (B4, SPEC.md §12.10) la pasa quien conoce la
 * cuenta (`serve-http`, `accountTurnKey(account.id)`), no se deduce del directorio: la biblioteca
 * personal y sus espacios comparten clave aunque la raíz de la cuenta cuelgue de un directorio
 * llamado `spaces` (una instalación legacy en `/srv/spaces/hebra`), y dos cuentas no la comparten.
 * Con un espacio de verdad: gestor, sobres cifrados y relé HTTP local.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeRecoveryCode } from '../../src/hebra';
import { MemorySecretStore, writePairedSecrets, type PairedSecrets } from '../../src/secrets';
import { buildMcpServer } from '../../src/server/build-server';
import { openServeContext, type ServeContext } from '../../src/server/serve';
import { accountTurnKey, processSyncGates } from '../../src/sync/gates';
import { validatePublicJwk } from '../../vendor/hebra/src/lib/spaces/account-key';
import { sealAgentSpaceGrant } from '../../vendor/hebra/src/lib/spaces/agent-space-grant';
import { FakeLumbre, LUMBRE } from '../pair/fake-lumbre';

const SPACE = '6c1f0e52-5d0b-4f7e-9a51-2b7e3d1c8a40';
const SHARED_VAULT = '33'.repeat(16);

let fake: FakeLumbre;
let root: string;
let opened: ServeContext[];
let keys: string[];
let stderr: ReturnType<typeof vi.spyOn>;

/** Un agente emparejado de la persona `who`, con su biblioteca personal en el relé. */
async function pairedAgent(who: string, vault: string): Promise<{ secrets: MemorySecretStore; paired: PairedSecrets }> {
  const deviceId = randomUUID();
  const connection = fake.addAgent(who, deviceId);
  fake.addLibraryVault(who, vault);
  const paired: PairedSecrets = {
    connection,
    device: { lumbreDeviceId: deviceId, opaqueDeviceId: randomBytes(16).toString('hex') },
    recoveryCode: await encodeRecoveryCode({ relayOrigin: LUMBRE, syncVaultId: vault, keyEpoch: 1,
      vaultKey: new Uint8Array(32).fill(7) })
  };
  const secrets = new MemorySecretStore();
  await writePairedSecrets(secrets, paired);
  return { secrets, paired };
}

async function open(dataDir: string, secrets: MemorySecretStore, accountKey: string): Promise<ServeContext> {
  await mkdir(dataDir, { recursive: true });
  const served = await openServeContext({
    dataDir,
    secrets,
    fetcher: (input, init) => fake.fetcher(input, init),
    syncIntervalMs: null,
    writerOnly: true,
    instance: { checkIntervalMs: null, lock: { releaseOnExit: false } },
    accountKey
  });
  opened.push(served);
  return served;
}

async function connect(served: ServeContext): Promise<Client> {
  const server = buildMcpServer(served.ctx, 'test');
  const client = new Client({ name: 'account-turn-key-tests', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

/** Concede el espacio al agente, como hace un miembro, y escribe una nota en él: el espacio se
 *  abre y su runner hace su primera ronda. */
async function writeInSpace(client: Client, paired: PairedSecrets): Promise<void> {
  await client.callTool({ name: 'hebra_list_spaces', arguments: {} });
  const registered = fake.agentKeys.get(paired.connection.credentialId)!;
  const grant = await sealAgentSpaceGrant({
    binding: { spaceId: SPACE, syncVaultId: SHARED_VAULT, accountId: registered.accountId,
      credentialId: paired.connection.credentialId, deviceId: registered.deviceId, keyId: registered.keyId },
    publicKey: validatePublicJwk(registered.publicKey),
    spaceKey: new Uint8Array(32).fill(33)
  });
  fake.agentSpaces.set(paired.connection.credentialId, [{ spaceId: SPACE, syncVaultId: SHARED_VAULT, grant }]);
  const created = await client.callTool({ name: 'hebra_create_note', arguments: { body: '# En el espacio', space: SPACE } }) as CallToolResult;
  expect(created.isError).not.toBe(true);
}

beforeEach(async () => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  fake = await FakeLumbre.start();
  root = await mkdtemp(join(tmpdir(), 'hebra-turn-key-'));
  opened = [];
  keys = [];
  // Cada ronda de sync pide plaza en el semáforo de proceso con la clave de su cuenta.
  const rounds = processSyncGates().rounds;
  const acquire = rounds.acquire.bind(rounds);
  vi.spyOn(rounds, 'acquire').mockImplementation((signal, accountKey) => {
    keys.push(String(accountKey));
    return acquire(signal, accountKey);
  });
});

afterEach(async () => {
  for (const served of opened) await served.close();
  vi.restoreAllMocks();
  stderr.mockRestore();
  await fake.close();
  await rm(root, { recursive: true, force: true });
});

describe('clave de cuenta del turno de sync', () => {
  it('es opaca y estable: un hash del id de cuenta, distinto por cuenta y sin el id', () => {
    const id = randomUUID();
    expect(accountTurnKey(id)).toBe(accountTurnKey(id));
    expect(accountTurnKey(id)).toMatch(/^[0-9a-f]{16}$/);
    expect(accountTurnKey(id)).not.toContain(id.slice(0, 8));
    expect(accountTurnKey(id)).not.toBe(accountTurnKey(randomUUID()));
  });

  it('la biblioteca personal y sus espacios comparten la clave aunque la raíz cuelgue de un directorio `spaces`', async () => {
    const key = accountTurnKey('cuenta-legacy');
    const { secrets, paired } = await pairedAgent('alice', '44'.repeat(16));
    // Una instalación legacy cuya raíz es `<tmp>/spaces/hebra`: sus espacios viven en
    // `<tmp>/spaces/hebra/spaces/<k>`. Deducir la cuenta de la ruta los separaba.
    const served = await open(join(root, 'spaces', 'hebra'), secrets, key);
    const client = await connect(served);
    await served.ctx.firstRound?.();
    const personal = keys.length;
    expect(personal).toBeGreaterThan(0);
    await writeInSpace(client, paired);
    expect(keys.length).toBeGreaterThan(personal); // la ronda del espacio también pidió plaza
    expect(new Set(keys)).toEqual(new Set([key]));
    await client.close();
  });

  it('dos cuentas no comparten clave', async () => {
    const keyA = accountTurnKey('cuenta-a');
    const keyB = accountTurnKey('cuenta-b');
    const a = await pairedAgent('alice', '55'.repeat(16));
    const b = await pairedAgent('bob', '66'.repeat(16));
    const servedA = await open(join(root, 'accounts', 'a'), a.secrets, keyA);
    await servedA.ctx.firstRound?.();
    const ofA = keys.splice(0);
    const servedB = await open(join(root, 'accounts', 'b'), b.secrets, keyB);
    await servedB.ctx.firstRound?.();
    expect(new Set(ofA)).toEqual(new Set([keyA]));
    expect(new Set(keys)).toEqual(new Set([keyB]));
    expect(keyA).not.toBe(keyB);
  });
});
