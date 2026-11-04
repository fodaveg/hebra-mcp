/**
 * D22, §12.10 "Sync", con un espacio de verdad: gestor, sobres cifrados y relé HTTP local. Lo que
 * hay que demostrar es que la ronda final de un espacio llega a salir, porque `spaces.close()`
 * corta las guardias con las que el espacio habla con el relé, y que lo que no suba se retoma con
 * un contexto nuevo por el mismo selector.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingSweep, PendingUploadList, type WithAccountContext } from '../../src/accounts/pending-sweep';
import type { AccountRef } from '../../src/accounts/types';
import { encodeRecoveryCode } from '../../src/hebra';
import { MemorySecretStore, writePairedSecrets, type PairedSecrets } from '../../src/secrets';
import { buildMcpServer } from '../../src/server/build-server';
import { openServeContext, type ServeContext } from '../../src/server/serve';
import { validatePublicJwk } from '../../vendor/hebra/src/lib/spaces/account-key';
import { sealAgentSpaceGrant } from '../../vendor/hebra/src/lib/spaces/agent-space-grant';
import { FakeLumbre, LUMBRE } from '../pair/fake-lumbre';

const SPACE = '351f12d0-dd49-48a6-b84c-301e16c9d64a';
const SHARED_VAULT = '22'.repeat(16);
const PERSONAL_VAULT = '11'.repeat(16);
const ACCOUNT: AccountRef = { id: randomUUID(), generation: 1 };

let fake: FakeLumbre;
let directory: string;
let secrets: MemorySecretStore;
let paired: PairedSecrets;
let list: PendingUploadList;
let uploadsBlocked: boolean;
let uploadsAccepted: number;
let stderr: ReturnType<typeof vi.spyOn>;

/** El relé acepta todo menos subir registros al espacio, si `uploadsBlocked`. */
const fetcher: typeof fetch = async (input, init) => {
  const url = String(input);
  const upload = init?.method === 'POST' && url.includes(SHARED_VAULT) && url.endsWith('/records');
  if (upload && uploadsBlocked) return new Response('{"error":"unavailable"}', { status: 503 });
  const response = await fake.fetcher(input, init);
  if (upload && response.ok) uploadsAccepted += 1;
  return response;
};

function open(): Promise<ServeContext> {
  return openServeContext({
    dataDir: directory,
    secrets,
    fetcher,
    syncIntervalMs: null,
    writerOnly: true,
    instance: { checkIntervalMs: null, lock: { releaseOnExit: false } },
    uploadLedger: list.ledger(ACCOUNT)
  });
}

async function connect(served: ServeContext): Promise<{ client: Client; close(): Promise<void> }> {
  const server = buildMcpServer(served.ctx, 'test');
  const client = new Client({ name: 'pending-uploads-tests', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

/** Concede el espacio al agente, como hace un miembro, y escribe una nota en él. */
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

beforeEach(async () => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  uploadsBlocked = false;
  uploadsAccepted = 0;
  fake = await FakeLumbre.start();
  directory = await mkdtemp(join(tmpdir(), 'hebra-space-pending-'));
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
  list = await PendingUploadList.open(join(directory, 'control'));
});

afterEach(async () => {
  stderr.mockRestore();
  await fake.close();
  await rm(directory, { recursive: true, force: true });
});

describe('subidas pendientes de un espacio', () => {
  it('la ronda final de cerrar el contexto sube lo del espacio, antes de cortar sus guardias', async () => {
    const served = await open();
    const { client, close } = await connect(served);
    uploadsBlocked = true;
    await writeInSpace(client);
    expect(uploadsAccepted).toBe(0);
    expect(list.entries().map((entry) => entry.space)).toEqual([SPACE]);
    await close();
    uploadsBlocked = false;
    await served.close();
    expect(uploadsAccepted).toBe(1);
    expect(list.entries()).toEqual([]);
  });

  it('si no sube, queda por cuenta y espacio, y el barrido la retoma tras reiniciar', async () => {
    const served = await open();
    const { client, close } = await connect(served);
    uploadsBlocked = true;
    await writeInSpace(client);
    await close();
    await served.close();
    expect(uploadsAccepted).toBe(0);
    expect(list.entries()).toEqual([{ account: ACCOUNT.id, generation: 1, space: SPACE, blocked: false }]);

    list = await PendingUploadList.open(join(directory, 'control'));
    expect(list.entries()).toHaveLength(1);
    uploadsBlocked = false;
    const withAccountContext: WithAccountContext = async (_ref, fn) => {
      const reopened = await open();
      try {
        return await fn(reopened.ctx);
      } finally {
        await reopened.close();
      }
    };
    const sweep = new PendingSweep({ list, withAccountContext, accountActive: () => true,
      resumeRemovals: async () => undefined, expireJournals: async () => ({ expired: 0, failed: 0 }) });
    expect(await sweep.runOnce()).toMatchObject({ uploaded: 1, kept: 0 });
    // El motor puede repartirlo en más de un POST al retomar un envío a medias.
    expect(uploadsAccepted).toBeGreaterThan(0);
    expect(list.entries()).toEqual([]);
    const calm = await sweep.runOnce();
    expect(calm).toMatchObject({ uploaded: 0, kept: 0, skipped: 0 });
  });

  it('un espacio denegado que ya no sale en el catálogo se olvida; su escritura sigue en local', async () => {
    const served = await open();
    const { client, close } = await connect(served);
    uploadsBlocked = true;
    await writeInSpace(client);
    await close();
    await served.close();
    fake.agentSpaces.set(paired.connection.credentialId, []);

    const withAccountContext: WithAccountContext = async (_ref, fn) => {
      const reopened = await open();
      try {
        return await fn(reopened.ctx);
      } finally {
        await reopened.close();
      }
    };
    const sweep = new PendingSweep({ list, withAccountContext, accountActive: () => true,
      resumeRemovals: async () => undefined, expireJournals: async () => ({ expired: 0, failed: 0 }) });
    expect(await sweep.runOnce()).toMatchObject({ dropped: 1 });
    expect(list.entries()).toEqual([]);
  });
});
