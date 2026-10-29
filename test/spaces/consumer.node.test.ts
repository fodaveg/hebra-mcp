/** Consumidor H-L7 real: HTTP local, MCP, SQLite y sobres cifrados. Sin cuentas reales. */
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../../src/server/build-server';
import { openServeContext, type OpenServeOptions, type ServeContext } from '../../src/server/serve';
import { MemorySecretStore, writePairedSecrets, type PairedSecrets } from '../../src/secrets';
import { encodeRecoveryCode } from '../../src/hebra';
import { sealAgentSpaceGrant } from '../../vendor/hebra/src/lib/spaces/agent-space-grant';
import { validatePublicJwk } from '../../vendor/hebra/src/lib/spaces/account-key';
import {
  deriveRecordKey,
  encodeRecordEnvelope,
  decodeRecordEnvelope,
  envelopeAad
} from '../../vendor/hebra/src/lib/library/envelope';
import { aesGcmDecrypt } from '../../vendor/hebra/src/lib/vault/blob-v2/crypto';
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
  // El registro de la pública del agente es perezoso (solo en el camino compartido): un
  // agente lo dispara al listar sus espacios, como aquí, antes de que el miembro conceda.
  if (!fake.agentKeys.has(paired.connection.credentialId)) await call('hebra_list_spaces');
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
type Fetcher = NonNullable<OpenServeOptions['fetcher']>;
async function restart(fetcher: Fetcher = fake.fetcher) {
  await client.close();
  await server.close();
  await served.close();
  served = await openServeContext({
    dataDir: directory,
    secrets,
    fetcher,
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
    // El sync personal del arranque no esperó al registro del agente; el catálogo sí.
    const register = fake.requested.findIndex((url) => url.endsWith('agent-device-key'));
    expect(fake.requested.findIndex((url) => url.includes('/changes'))).toBeLessThan(register);
    expect(register).toBeLessThan(
      fake.requested.findIndex((url) => url.endsWith('/spaces/agent-access'))
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
        },
        // Dentro del turno: lo ya sabido en local, sin red (la revocación ya vista).
        assertActive: () => {
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

  // Regresión del 29 oct: el registro del agente se exigía también en la biblioteca
  // personal, así que sin red una lectura sin `space` esperaba al relé y fallaba.
  for (const [caso, agentResponse] of [
    ['sin red', () => Promise.reject(new TypeError('fetch failed'))],
    ['relé sin la API de H-L7', () => Promise.resolve(new Response(null, { status: 404 }))]
  ] as const) {
    it(`${caso}: la biblioteca personal lee y escribe sin el registro del agente; un space UUID falla cerrado`, async () => {
      await grant();
      const agentCalls: string[] = [];
      const fetcher: Fetcher = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const agent = url.includes('/agent-device-key') || url.includes('/spaces/agent-access');
        if (agent) agentCalls.push(url);
        if (caso === 'sin red' || agent) return agentResponse();
        return fake.fetcher(input, init);
      };
      // Proceso nuevo: no hereda el registro en memoria del anterior.
      await restart(fetcher);
      const read = await call('hebra_read_note', { id: 'personal-note' });
      expect(read.isError).not.toBe(true);
      expect(text(read)).toContain('Personal');
      const created = await call('hebra_create_note', { body: '# Escrita sin el relé del agente' });
      expect(created.isError).not.toBe(true);
      const listed = text(await call('hebra_list_notes'));
      expect(listed).toContain('Escrita sin el relé del agente');
      expect(listed).not.toContain('Equipo');
      expect(agentCalls).toEqual([]);

      const shared = await call('hebra_read_note', { space: SPACE, id: NOTE });
      expect(shared.isError).toBe(true);
      expect(text(shared)).toContain('space_access_denied');
      expect(text(shared)).not.toContain('Equipo');
      expect(agentCalls.length).toBeGreaterThan(0);
    });
  }

  it('apagado, inexistente, malformado y en mayúsculas responden exactamente igual', async () => {
    const answers: Array<{ caso: string; result: unknown }> = [];
    const ask = async (caso: string, space: string) =>
      answers.push({ caso, result: await call('hebra_read_note', { space, id: NOTE }) });
    // Apagado por defecto: la bóveda compartida existe y tiene contenido.
    await ask('apagado', SPACE);
    await grant();
    expect(text(await call('hebra_read_note', { space: SPACE, id: NOTE }))).toContain('Equipo');
    // Con el grant encendido, solo su UUID exacto lo abre.
    await ask('inexistente', randomUUID());
    await ask('malformado', 'no-es-un-uuid');
    await ask('mayúsculas', SPACE.toUpperCase());
    // Solo el literal exacto `personal` elige la biblioteca personal.
    await ask('PERSONAL', 'PERSONAL');
    // Encendido y apagado después: la entrada ya abierta tampoco se distingue.
    fake.agentSpaces.set(paired.connection.credentialId, []);
    await ask('apagado tras abrir', SPACE);
    const [first] = answers;
    expect(first.result).toEqual({
      content: [{ type: 'text', text: expect.stringContaining('space_access_denied') }],
      isError: true
    });
    for (const answer of answers) expect(answer.result, answer.caso).toEqual(first.result);
  });

  it('space "personal" explícito es la biblioteca personal, igual que omitirlo', async () => {
    await grant();
    for (const [name, args] of [
      ['hebra_read_note', { id: 'personal-note' }],
      ['hebra_list_notes', {}]
    ] as const) {
      const omitted = await call(name, args);
      const explicit = await call(name, { ...args, space: 'personal' });
      expect(explicit.isError, name).not.toBe(true);
      expect(explicit, name).toEqual(omitted);
      expect(text(explicit), name).not.toContain(SPACE);
      expect(text(explicit), name).not.toContain('Equipo');
    }
  });

  it('una invocación compartida consulta el catálogo dos veces, sin reutilizarlo en la siguiente', async () => {
    await grant();
    await served.ctx.spaces!.resolve(SPACE);
    const catalogues = () => fake.requested.filter((url) => url.endsWith('/spaces/agent-access')).length;
    for (let round = 0; round < 2; round += 1) {
      const before = catalogues();
      expect(text(await call('hebra_read_note', { space: SPACE, id: NOTE }))).toContain('Equipo');
      expect(catalogues() - before).toBe(2);
    }
    const before = catalogues();
    await call('hebra_list_notes');
    expect(catalogues()).toBe(before);
  });

  it('con el relé colgado, la cola de escritura del espacio no lo espera; la herramienta sí', async () => {
    await grant();
    const ctx = await served.ctx.spaces!.resolve(SPACE);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fake.agentAccessHold = {
      entered: () => entered(),
      released: new Promise<void>((resolve) => {
        release = resolve;
      })
    };
    let answered = false;
    const pending = call('hebra_read_note', { space: SPACE, id: NOTE }).then((result) => {
      answered = true;
      return result;
    });
    await held;
    // Mientras la herramienta espera al catálogo, una escritura de la misma base (contexto
    // de escritura y cola FIFO) termina sin preguntar al relé.
    const written = await ctx.write!.createNote({
      body: '# Con el relé colgado',
      privacy: NO_PRIVATE
    });
    expect(written.id).toBeTruthy();
    expect(answered).toBe(false);
    fake.agentAccessHold = null;
    release();
    expect(text(await pending)).toContain('Equipo');
  });

  it('tras una revocación ya vista, los registros propios del MCP tampoco se leen ni se escriben', async () => {
    let allowed = true;
    const port = await openNodeLibraryPort({
      sqlitePath: ':memory:',
      spaceAccess: {
        spaceId: SPACE,
        scope: 'records-fixture',
        authorize: async () => {},
        assertActive: () => {
          if (!allowed) throw new StoreError('space_access_denied');
        }
      }
    });
    try {
      await port.syncStorePort().libraryConnect({
        binding: { relayOrigin: LUMBRE, syncVaultId: SHARED_VAULT, libraryInstance: 'fixture' },
        relayHasRecords: true
      });
      const outcomes = await port.writeExclusive(async (store) => {
        const attempts = [
          () => store.operations.lookup('op-fixture'),
          () => store.replacePlans.plan('plan-fixture'),
          () => store.jdPlans.get('plan-fixture'),
          () => store.looseFilePrevious.lookup('op-fixture', Date.now())
        ];
        const run = () =>
          attempts.map((attempt) => {
            try {
              return attempt();
            } catch (error) {
              return (error as StoreError).code;
            }
          });
        const open = run();
        allowed = false;
        return { open, revoked: run() };
      });
      expect(outcomes.open).toEqual([null, null, null, null]);
      expect(outcomes.revoked).toEqual(Array(4).fill('space_access_denied'));
    } finally {
      await port.closeWhenIdle();
    }
  });

  it('el sobre que escribe el agente no lleva el tipo de actor (lo sella el servidor fuera del cifrado)', async () => {
    await grant();
    const created = await call('hebra_create_note', { space: SPACE, body: '# Sobre del agente' });
    expect(created.isError).not.toBe(true);
    const sharedCtx = await served.ctx.spaces!.resolve(SPACE);
    expect(await sharedCtx.write!.awaitRound(10_000)).toEqual({ kind: 'done', result: 'ok' });
    const records = (await fake.relayFor(SHARED_VAULT).getChanges(SHARED_VAULT, 0)).records;
    const written = records.filter((row) => row.id !== NOTE);
    expect(written.length).toBeGreaterThan(0);
    const recordKey = await deriveRecordKey({ vaultKey: SHARED, syncVaultId: SHARED_VAULT, keyEpoch: 1 });
    for (const record of written) {
      const envelope = record.envelope!;
      // El texto en claro entero, no lo que deja pasar el decodificador de campos.
      const plaintext = await aesGcmDecrypt({
        key: recordKey,
        nonce: envelope.slice(0, 12),
        aad: envelopeAad(SHARED_VAULT, record.id),
        ciphertext: envelope.slice(12, -16),
        tag: envelope.slice(-16)
      });
      const json = new TextDecoder().decode(plaintext);
      const keys = new Set<string>();
      JSON.parse(json, (key, value: unknown) => {
        keys.add(key);
        return value;
      });
      expect(keys.has('body') || keys.has('name'), record.id).toBe(true);
      expect(keys.has('authorActorKind'), record.id).toBe(false);
      expect(keys.has('actorKind'), record.id).toBe(false);
      expect(json).not.toMatch(/actorkind/i);
    }
  });
});
