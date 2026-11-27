/**
 * Un espacio con concesión (`granted: true`) que no se puede abrir no es una denegación
 * (tarea de Lumbre 48e8e6f6, fallo 3, 27 nov 2026). Con la biblioteca de David, el catálogo
 * daba el espacio y su clave abría, pero el alta del agente en la bóveda del espacio (`POST
 * …/blob-v2/vaults/{id}/devices`) recibía 507 `quota_exceeded` del relé (el tope de
 * dispositivos activos del miembro en un espacio) y la lectura respondía `space_access_denied`.
 * Ahora cada causa tiene su código, `hebra_list_spaces` la repite en `openError` y nada se
 * queda recordado como decisión: el intento siguiente vuelve a probar entero.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { deriveRecordKey, encodeRecordEnvelope } from '../../vendor/hebra/src/lib/library/envelope';
import { FakeLumbre, LUMBRE } from '../pair/fake-lumbre';
import * as Sentry from '@sentry/node';
import { configureErrorReports, flushErrorReports, resetErrorReports } from '../../src/log/error-reports';

type Fetcher = NonNullable<OpenServeOptions['fetcher']>;

const SPACE = '351f12d0-dd49-48a6-b84c-301e16c9d64a';
const SHARED_VAULT = '22'.repeat(16);
const PERSONAL_VAULT = '11'.repeat(16);
const PERSONAL = new Uint8Array(32).fill(11);
const SHARED = new Uint8Array(32).fill(22);
const NOTE = 'shared-note';
const SPACE_DEVICES = `${LUMBRE}/api/integrations/hebra/blob-v2/vaults/${SHARED_VAULT}/devices`;

let fake: FakeLumbre;
let directory: string;
let secrets: MemorySecretStore;
let paired: PairedSecrets;
let served: ServeContext;
let client: Client;
let server: ReturnType<typeof buildMcpServer>;
/** Lo que responde el relé al alta del agente en la bóveda del espacio; `null`, el fake. */
let deviceReply: (() => Response) | null;

const fetcher: Fetcher = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (deviceReply && url.toString() === SPACE_DEVICES && init?.method === 'POST') {
    fake.requested.push(url.toString());
    return Promise.resolve(deviceReply());
  }
  return fake.fetcher(input, init);
};

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
    .postRecords(vault, [{ id, baseRev: null, deleted: false, envelope: encoded.envelope, objectIds: [] }]);
}

async function call(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[content.length - 1]!.text);
}

/** La concesión del espacio, sellada para la pública registrada del agente. Con `broken`, el
 *  sobre no abre (un byte del cifrado cambiado) aunque los bindings sean los de este agente. */
async function grant(broken = false): Promise<void> {
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
  if (broken) {
    const bytes = Buffer.from(envelope.ciphertext, 'base64url');
    bytes[0] = bytes[0]! ^ 0xff;
    envelope.ciphertext = bytes.toString('base64url');
  }
  fake.agentSpaces.set(paired.connection.credentialId, [
    { spaceId: SPACE, syncVaultId: SHARED_VAULT, grant: envelope }
  ]);
}

const spaceRow = async () =>
  (payload(await call('hebra_list_spaces')).spaces as Array<Record<string, unknown>>).find(
    (space) => space.spaceId === SPACE
  );

beforeEach(async () => {
  deviceReply = null;
  fake = await FakeLumbre.start();
  directory = await mkdtemp(join(tmpdir(), 'hebra-space-open-failure-'));
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
  await seed(SHARED_VAULT, SHARED, NOTE, '# Equipo\n\nTexto compartido.');
  served = await openServeContext({
    dataDir: directory,
    secrets,
    fetcher,
    syncIntervalMs: null,
    instance: { checkIntervalMs: null, lock: { releaseOnExit: false } }
  });
  await served.instance.whenReady();
  server = buildMcpServer(served.ctx, 'test');
  client = new Client({ name: 'space-open-failure-tests', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
});

afterEach(async () => {
  resetErrorReports();
  await client?.close();
  await server?.close();
  await served?.close();
  await fake?.close();
  await rm(directory, { recursive: true, force: true });
});

describe('espacio con concesión que no abre', () => {
  it('507 al dar de alta el agente en la bóveda: space_quota_exceeded, openError y se reintenta entero', async () => {
    await grant();
    deviceReply = () =>
      new Response(JSON.stringify({ protocol: 2, code: 'quota_exceeded', retryable: false }), {
        status: 507,
        headers: { 'content-type': 'application/json' }
      });
    expect(await spaceRow()).toMatchObject({ granted: true, openError: null });

    const first = await call('hebra_list_notes', { space: SPACE });
    expect(first.isError).toBe(true);
    expect(payload(first)).toEqual({ error: 'space_quota_exceeded' });
    expect(await spaceRow()).toMatchObject({ granted: true, openError: 'space_quota_exceeded' });
    // hebra_status ya no dice errorsByCode {} con un espacio que no abre.
    expect((payload(await call('hebra_status')).errorsByCode as Record<string, number>).space_quota_exceeded).toBe(1);

    // Ninguna decisión recordada: cada llamada vuelve a pedir el alta al relé.
    const before = fake.requested.filter((url) => url === SPACE_DEVICES).length;
    expect(payload(await call('hebra_read_note', { id: NOTE, space: SPACE }))).toEqual({ error: 'space_quota_exceeded' });
    expect(fake.requested.filter((url) => url === SPACE_DEVICES).length).toBe(before + 1);

    // En cuanto el relé admite el alta, el mismo proceso abre el espacio y openError se borra.
    deviceReply = null;
    const read = await call('hebra_read_note', { id: NOTE, space: SPACE });
    expect(read.isError).toBeFalsy();
    expect(JSON.stringify(read)).toContain('Texto compartido');
    expect(await spaceRow()).toMatchObject({ granted: true, openError: null });
  });

  it('el 507 sale a Bugsink como aviso, con código y herramienta y sin el espacio', async () => {
    const bodies: string[] = [];
    configureErrorReports({ mode: 'stdio', version: 'test' }, {}, {
      load: async () => Sentry,
      transport: (options) =>
        Sentry.createTransport(options, async (request) => {
          bodies.push(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body));
          return { statusCode: 200 };
        })
    });
    await grant();
    deviceReply = () => new Response(JSON.stringify({ code: 'quota_exceeded' }), { status: 507 });
    await call('hebra_list_notes', { space: SPACE });
    await flushErrorReports(1000);
    const text = bodies.join('\n');
    expect(text).toContain('"message":"space_quota_exceeded"');
    expect(text).toContain('"tool":"hebra_list_notes"');
    expect(text).not.toContain(SPACE);
    expect(text).not.toContain(SHARED_VAULT);
    expect(text).not.toContain(directory);
  });

  it('relé caído al dar de alta: space_unavailable con relay_unavailable, sin openError', async () => {
    await grant();
    deviceReply = () => new Response('', { status: 503 });
    const failed = await call('hebra_list_notes', { space: SPACE });
    expect(payload(failed)).toEqual({ error: 'space_unavailable', reason: 'relay_unavailable', retryAfterSeconds: 5 });
    expect(await spaceRow()).toMatchObject({ granted: true, openError: null });
  });

  it('una clave sellada que no abre: space_key_unreadable, y el listado lo dice sin abrir', async () => {
    await grant(true);
    expect(await spaceRow()).toMatchObject({ granted: true, openError: 'space_key_unreadable' });
    const failed = await call('hebra_list_notes', { space: SPACE });
    expect(payload(failed)).toEqual({ error: 'space_key_unreadable' });
    // No se llegó a pedir el alta en la bóveda: falla antes, al abrir la clave.
    expect(fake.requested).not.toContain(SPACE_DEVICES);

    // Resellada bien, el listado lo ve y el espacio abre.
    await grant();
    expect(await spaceRow()).toMatchObject({ granted: true, openError: null });
    expect(JSON.stringify(await call('hebra_read_note', { id: NOTE, space: SPACE }))).toContain('Texto compartido');
  });

  it('sin concesión sigue siendo space_access_denied, con openError null', async () => {
    const denied = await call('hebra_list_notes', { space: SPACE });
    expect(payload(denied)).toEqual({ error: 'space_access_denied' });
    expect(await spaceRow()).toBeUndefined();
  });
});
