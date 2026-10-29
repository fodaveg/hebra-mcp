/** Consumidor H-L7 real: HTTP local, MCP, SQLite y sobres cifrados. Sin cuentas reales. */
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../../src/server/build-server';
import { openServeContext, type ServeContext } from '../../src/server/serve';
import { MemorySecretStore, writePairedSecrets, type PairedSecrets } from '../../src/secrets';
import { encodeRecoveryCode } from '../../src/hebra';
import { sealAgentSpaceGrant } from '../../vendor/hebra/src/lib/spaces/agent-space-grant';
import { validatePublicJwk } from '../../vendor/hebra/src/lib/spaces/account-key';
import {
  deriveRecordKey,
  encodeRecordEnvelope,
  decodeRecordEnvelope
} from '../../vendor/hebra/src/lib/library/envelope';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { openWorkdirLibrary } from '../../src/workdir/library';
import { FakeLumbre, LUMBRE } from '../pair/fake-lumbre';
import { NoteWriter } from '../../src/store/writes';
import { StoreError } from '../../src/store/errors';
import { NO_PRIVATE } from '../fixtures/no-private';
import type { AgentSpaceAccess } from '../../src/spaces/protocol';

const SPACE = '351f12d0-dd49-48a6-b84c-301e16c9d64a';
const SHARED_VAULT = '22'.repeat(16);
const PERSONAL_VAULT = '11'.repeat(16);
const PERSONAL = new Uint8Array(32).fill(11);
const SHARED = new Uint8Array(32).fill(22);
const NOTE = 'shared-note';
const SECRET_BODY = '# Equipo\n\nTexto compartido reservado al permiso.';
let fake: FakeLumbre;
let directory: string;
let secrets: MemorySecretStore;
let paired: PairedSecrets;
let served: ServeContext;
let client: Client;
let server: ReturnType<typeof buildMcpServer>;
let extras: string[];

async function seed(vault: string, key: Uint8Array, id: string, body: string) {
  const recordKey = await deriveRecordKey({ vaultKey: key, syncVaultId: vault, keyEpoch: 1 });
  const encoded = await encodeRecordEnvelope({
    recordKey,
    syncVaultId: vault,
    recordId: id,
    fields: {
      kind: 'note',
      folderId: 'root',
      body,
      favorite: false,
      createdAt: 1,
      updatedAt: 1,
      trashedAt: null,
      conflictOf: null,
      conflictAt: null,
      conflictDevice: null
    },
    ...(vault === SHARED_VAULT ? { authorship: { authorId: 'aa'.repeat(32), minClient: 2 } } : {})
  });
  await fake
    .relayFor(vault)
    .postRecords(vault, [
      { id, baseRev: null, deleted: false, envelope: encoded.envelope, objectIds: [] }
    ]);
}
async function grant(): Promise<AgentSpaceAccess> {
  const r = fake.agentKeys.get(paired.connection.credentialId)!;
  const envelope = await sealAgentSpaceGrant({
    binding: {
      spaceId: SPACE,
      syncVaultId: SHARED_VAULT,
      accountId: r.accountId,
      credentialId: paired.connection.credentialId,
      deviceId: r.deviceId,
      keyId: r.keyId
    },
    publicKey: validatePublicJwk(r.publicKey),
    spaceKey: SHARED
  });
  const entry = { spaceId: SPACE, syncVaultId: SHARED_VAULT, grant: envelope };
  fake.agentSpaces.set(paired.connection.credentialId, [entry]);
  return entry;
}
async function connect() {
  server = buildMcpServer(served.ctx, 'test');
  client = new Client({ name: 'agent-space-tests', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
}
async function call(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}
function text(result: unknown) {
  return JSON.stringify(result);
}
async function restart() {
  await client.close();
  await server.close();
  await served.close();
  served = await openServeContext({
    dataDir: directory,
    secrets,
    fetcher: fake.fetcher,
    syncIntervalMs: null,
    instance: { checkIntervalMs: null, lock: { releaseOnExit: false } }
  });
  await connect();
}
beforeEach(async () => {
  extras = [];
  fake = await FakeLumbre.start();
  directory = await mkdtemp(join(tmpdir(), 'hebra-space-consumer-'));
  secrets = new MemorySecretStore();
  const deviceId = randomUUID();
  const connection = fake.addAgent('alice', deviceId);
  fake.addLibraryVault('alice', PERSONAL_VAULT);
  paired = {
    connection,
    device: { lumbreDeviceId: deviceId, opaqueDeviceId: randomBytes(16).toString('hex') },
    recoveryCode: await encodeRecoveryCode({
      relayOrigin: LUMBRE,
      syncVaultId: PERSONAL_VAULT,
      keyEpoch: 1,
      vaultKey: PERSONAL
    })
  };
  await writePairedSecrets(secrets, paired);
  await seed(PERSONAL_VAULT, PERSONAL, 'personal-note', '# Personal');
  await seed(SHARED_VAULT, SHARED, NOTE, SECRET_BODY);
  served = await openServeContext({
    dataDir: directory,
    secrets,
    fetcher: fake.fetcher,
    syncIntervalMs: null,
    instance: { checkIntervalMs: null, lock: { releaseOnExit: false } }
  });
  await served.instance.whenReady();
  await connect();
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  await served?.close();
  await fake?.close();
  await rm(directory, { recursive: true, force: true });
  for (const d of extras) await rm(d, { recursive: true, force: true });
});

describe('herramientas MCP por espacio', () => {
  it('todas las herramientas de contenido anuncian selector y conservan la puerta común', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(40);
    for (const tool of tools) {
      if (tool.name !== 'hebra_list_spaces')
        expect(tool.inputSchema.properties, tool.name).toHaveProperty('space');
    }
  });

  it('apagado por defecto: ni catálogo, ni contenido, ni petición a la bóveda compartida', async () => {
    expect(text(await call('hebra_list_spaces'))).toContain('spaces');
    const denied = await call('hebra_read_note', { space: SPACE, id: NOTE });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('space_access_denied');
    expect(text(denied)).not.toContain('Equipo');
    expect(fake.requested.some((url) => url.includes(SHARED_VAULT))).toBe(false);
    expect(fake.requested.findIndex((url) => url.endsWith('agent-device-key'))).toBeLessThan(
      fake.requested.findIndex((url) => url.includes('/changes'))
    );
  });

  it('selector omitido sigue personal; shared explícito lee y escribe authorId/minClient correctos', async () => {
    await grant();
    const personal = text(await call('hebra_list_notes'));
    expect(personal).toContain('Personal');
    expect(personal).not.toContain('Equipo');
    const shared = await call('hebra_read_note', { space: SPACE, id: NOTE });
    expect(shared.isError).not.toBe(true);
    expect(text(shared)).toContain('Equipo');
    expect(text(shared)).toContain(SPACE);
    expect(text(await call('hebra_search', { space: SPACE, query: 'Equipo' }))).toContain('Equipo');
    const created = await call('hebra_create_note', { space: SPACE, body: '# Del agente' });
    expect(created.isError).not.toBe(true);
    const sharedCtx = await served.ctx.spaces!.resolve(SPACE);
    expect(await sharedCtx.write!.awaitRound(10_000)).toEqual({ kind: 'done', result: 'ok' });
    const records = (await fake.relayFor(SHARED_VAULT).getChanges(SHARED_VAULT, 0)).records;
    const key = await deriveRecordKey({ vaultKey: SHARED, syncVaultId: SHARED_VAULT, keyEpoch: 1 });
    const record = records.find((row) => row.id !== NOTE)!;
    const decoded = await decodeRecordEnvelope({
      recordKey: key,
      syncVaultId: SHARED_VAULT,
      recordId: record.id,
      envelope: record.envelope!
    });
    expect(decoded).toMatchObject({
      authorId: fake.agentKeys.get(paired.connection.credentialId)!.accountId,
      minClient: 2
    });
  });

  it('apagar invalida caché, escritura directa y reenvío; mismo grant no revive tras reiniciar', async () => {
    const original = await grant();
    const ctx = await served.ctx.spaces!.resolve(SPACE);
    expect(text(await call('hebra_read_note', { space: SPACE, id: NOTE }))).toContain('Equipo');
    fake.agentSpaces.set(paired.connection.credentialId, []);
    const denied = await call('hebra_read_note', { space: SPACE, id: NOTE });
    expect(text(denied)).toContain('space_access_denied');
    expect(text(denied)).not.toContain('Equipo');
    await expect(
      ctx.write!.createNote({ body: '# Denegada', privacy: NO_PRIVATE })
    ).rejects.toMatchObject({ code: 'space_access_denied' });
    fake.agentSpaces.set(paired.connection.credentialId, [original]);
    await restart();
    expect(text(await call('hebra_read_note', { space: SPACE, id: NOTE }))).toContain(
      'space_access_denied'
    );
    await grant(); // consentimiento nuevo, nueva efímera/salt y base; no reenvía la cola antigua.
    expect(text(await call('hebra_read_note', { space: SPACE, id: NOTE }))).toContain('Equipo');
  });

  it('reordenar JSON no cambia la clave estable ni crea otra caché de espacio', async () => {
    const original = await grant();
    await served.ctx.spaces!.resolve(SPACE);
    const before = await readdir(join(directory, 'spaces'));
    const key = fake.agentKeys.get(paired.connection.credentialId)!.keyId;
    fake.agentSpaces.set(paired.connection.credentialId, [
      {
        ...original,
        grant: Object.fromEntries(Object.entries(original.grant).reverse()) as typeof original.grant
      }
    ]);
    await restart();
    expect(text(await call('hebra_read_note', { space: SPACE, id: NOTE }))).toContain('Equipo');
    expect(fake.agentKeys.get(paired.connection.credentialId)!.keyId).toBe(key);
    expect(await readdir(join(directory, 'spaces'))).toEqual(before);
  });

  it('revocar mientras se lee impide devolver el resultado ya calculado', async () => {
    await grant();
    const ctx = await served.ctx.spaces!.resolve(SPACE);
    const read = ctx.port.noteRead.bind(ctx.port);
    ctx.port.noteRead = async (id) => {
      const result = await read(id);
      fake.agentSpaces.set(paired.connection.credentialId, []);
      return result;
    };
    const result = await call('hebra_read_note', { space: SPACE, id: NOTE });
    expect(text(result)).toContain('space_access_denied');
    expect(text(result)).not.toContain('Equipo');
  });

  it('JDex rechaza shared y una copia de SQLite no abre en workdir ni como biblioteca personal', async () => {
    await grant();
    await served.ctx.spaces!.resolve(SPACE);
    expect(text(await call('hebra_jd_audit', { space: SPACE }))).toContain('space_not_supported');
    const [entry] = await readdir(join(directory, 'spaces'));
    const copy = await mkdtemp(join(tmpdir(), 'hebra-space-copy-'));
    extras.push(copy);
    await cp(join(directory, 'spaces', entry), copy, { recursive: true });
    await expect(
      openNodeLibraryPort({ sqlitePath: join(copy, 'library.sqlite'), dataDir: copy })
    ).rejects.toMatchObject({ code: 'space_access_denied' });
    await expect(
      openWorkdirLibrary({
        dataDir: copy,
        secrets: null,
        instance: { checkIntervalMs: null, lock: { releaseOnExit: false } }
      })
    ).rejects.toMatchObject({ code: 'space_access_denied' });
  });

  it('el lector reenvía por IPC al escritor, que rechaza tras apagar y nunca permite JDex', async () => {
    await grant();
    await served.ctx.spaces!.resolve(SPACE);
    const reader = await openServeContext({
      dataDir: directory,
      secrets,
      fetcher: fake.fetcher,
      syncIntervalMs: null,
      instance: {
        checkIntervalMs: null,
        lock: { pid: process.pid + 10_000, isAlive: () => true, releaseOnExit: false }
      }
    });
    try {
      const ctx = await reader.ctx.spaces!.resolve(SPACE);
      expect((await ctx.status.getStatus()).writer).toBe('other_instance');
      const created = await ctx.write!.createNote({
        body: '# Desde lector IPC',
        privacy: NO_PRIVATE
      });
      expect(created.id).toBeTruthy();
      await expect(
        ctx.write!.jdMove!({
          mode: 'simulate',
          source: { kind: 'note', id: NOTE },
          toId: '21.01',
          privacy: NO_PRIVATE
        })
      ).rejects.toMatchObject({ code: 'space_access_denied' });
      fake.agentSpaces.set(paired.connection.credentialId, []);
      await expect(
        ctx.write!.createNote({ body: '# No debe escribirse por IPC', privacy: NO_PRIVATE })
      ).rejects.toMatchObject({ code: 'space_access_denied' });
    } finally {
      await reader.close();
    }
  });

  it('un adjunto ya guardado en caché tampoco sale tras apagar', async () => {
    await grant();
    const added = await call('hebra_add_attachment', {
      space: SPACE,
      id: NOTE,
      name: 'cache.txt',
      dataBase64: Buffer.from('bytes de fixture privados').toString('base64'),
      mimeType: 'text/plain',
      operationId: 'add-cache'
    });
    expect(added.isError).not.toBe(true);
    const ctx = await served.ctx.spaces!.resolve(SPACE);
    const refs = await ctx.port.noteAttachments(NOTE);
    expect(refs.length).toBe(1);
    const attachmentId = refs[0].sha256;
    const visible = await call('hebra_read_attachment', { space: SPACE, id: NOTE, attachmentId });
    expect(text(visible)).toContain('bytes de fixture privados');
    fake.agentSpaces.set(paired.connection.credentialId, []);
    const denied = await call('hebra_read_attachment', { space: SPACE, id: NOTE, attachmentId });
    expect(text(denied)).toContain('space_access_denied');
    expect(text(denied)).not.toContain('bytes de fixture privados');
  });

  it('la cola FIFO vuelve a consultar autoridad después de esperar, sin dejar dirty', async () => {
    let allowed = true;
    const port = await openNodeLibraryPort({
      sqlitePath: ':memory:',
      spaceAccess: {
        spaceId: SPACE,
        scope: 'fifo-fixture',
        authorize: async () => {
          if (!allowed) throw new StoreError('space_access_denied');
        }
      }
    });
    try {
      await port.syncStorePort().libraryConnect({
        binding: { relayOrigin: LUMBRE, syncVaultId: SHARED_VAULT, libraryInstance: 'fixture' },
        relayHasRecords: true
      });
      let release!: () => void;
      let entered!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const first = port.writeExclusive(async () => {
        entered();
        await hold;
      });
      await started;
      const queued = new NoteWriter(port).createNote({
        body: '# Nunca guardada',
        privacy: NO_PRIVATE
      });
      allowed = false;
      release();
      await first;
      await expect(queued).rejects.toMatchObject({ code: 'space_access_denied' });
      expect((await port.libraryOpen()).notesCount).toBe(0);
      expect(await port.syncStorePort().syncDirtyBatch(50)).toEqual([]);
    } finally {
      await port.closeWhenIdle();
    }
  });

  it('grant de otro miembro o cambio de cuenta nunca abre la base anterior', async () => {
    const original = await grant();
    fake.agentSpaces.set(paired.connection.credentialId, [
      { ...original, grant: { ...original.grant, accountId: 'ff'.repeat(32) } }
    ]);
    expect(text(await call('hebra_list_spaces'))).toContain('space_access_denied');
    fake.agentSpaces.set(paired.connection.credentialId, [original]);
    expect(text(await call('hebra_read_note', { space: SPACE, id: NOTE }))).toContain('Equipo');
    await secrets.set(
      'lumbre-connection',
      JSON.stringify({ ...paired.connection, readToken: 'changed-account' })
    );
    const result = await call('hebra_read_note', { space: SPACE, id: NOTE });
    expect(text(result)).toContain('space_access_denied');
    expect(text(result)).not.toContain('Equipo');
  });
});
