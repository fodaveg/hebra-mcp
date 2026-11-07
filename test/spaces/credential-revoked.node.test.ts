/**
 * D24 (7 nov 2026): con la credencial revocada o el agente desactivado en Hebra, hebra-mcp deja de
 * servir los espacios compartidos (`space_access_denied` sin red ni caché, ningún `granted: true`),
 * sigue sirviendo la biblioteca personal desde su SQLite y lo explica en `hebra_status`. Al
 * reactivar el agente, la MISMA credencial vuelve a valer y todo vuelve solo, sin reiniciar ni
 * emparejar. En multiusuario es por cuenta, y una cuenta que se cierra y se reabre no sirve
 * espacios hasta saber que la credencial vale (D22).
 *
 * Lumbre y relé locales (`FakeLumbre`), SQLite y sobres cifrados reales; el reintento se dispara a
 * mano (`ManualScheduler`): sin medir milisegundos.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../../src/server/build-server';
import { openServeContext, type ServeContext } from '../../src/server/serve';
import { bindPairingRevocation } from '../../src/http/serve-http';
import { MemorySecretStore, writePairedSecrets, type PairedSecrets } from '../../src/secrets';
import { encodeRecoveryCode } from '../../src/hebra';
import { AGENT_REVOKED_REASON, PairingRevocation } from '../../src/status/pairing-revocation';
import { sealAgentSpaceGrant } from '../../vendor/hebra/src/lib/spaces/agent-space-grant';
import { validatePublicJwk } from '../../vendor/hebra/src/lib/spaces/account-key';
import { deriveRecordKey, encodeRecordEnvelope } from '../../vendor/hebra/src/lib/library/envelope';
import { FakeLumbre, LUMBRE } from '../pair/fake-lumbre';
import { ManualScheduler } from '../fixtures/manual-scheduler';
import { deferred } from '../fixtures/deferred';

const SPACE = '351f12d0-dd49-48a6-b84c-301e16c9d64a';
const SHARED_VAULT = '22'.repeat(16);
const SHARED = new Uint8Array(32).fill(22);
const NOTE = 'shared-note';
const SECRET_BODY = '# Equipo\n\nTexto compartido reservado al permiso.';

let fake: FakeLumbre;
const cleanup: Array<() => Promise<void>> = [];

async function seed(vault: string, key: Uint8Array, id: string, body: string, shared: boolean) {
  const recordKey = await deriveRecordKey({ vaultKey: key, syncVaultId: vault, keyEpoch: 1 });
  const encoded = await encodeRecordEnvelope({
    recordKey,
    syncVaultId: vault,
    recordId: id,
    fields: {
      kind: 'note', folderId: 'root', body, favorite: false, createdAt: 1, updatedAt: 1,
      trashedAt: null, conflictOf: null, conflictAt: null, conflictDevice: null
    },
    ...(shared ? { authorship: { authorId: 'aa'.repeat(32), minClient: 2 } } : {})
  });
  await fake.relayFor(vault).postRecords(vault, [
    { id, baseRev: null, deleted: false, envelope: encoded.envelope, objectIds: [] }
  ]);
}

/** Una cuenta con su emparejado, su biblioteca personal y su conexión MCP. */
interface Account {
  user: string;
  credentialId: string;
  personalVault: string;
  directory: string;
  secrets: MemorySecretStore;
  paired: PairedSecrets;
  scheduler: ManualScheduler;
  served: ServeContext;
  client: Client;
}

type Fetcher = typeof fake.fetcher;

/** Pasos de `serve-http` multiusuario por cuenta: abrir con la marca y atarla (`bindPairingRevocation`). */
async function open(account: Omit<Account, 'served' | 'client' | 'scheduler'>, options: {
  pairing?: PairingRevocation;
  fetcher?: Fetcher;
} = {}): Promise<Account> {
  const scheduler = new ManualScheduler();
  const { pairing } = options;
  let served = await openServeContext({
    dataDir: account.directory,
    secrets: account.secrets,
    fetcher: options.fetcher ?? fake.fetcher,
    syncIntervalMs: null,
    syncScheduler: scheduler,
    instance: { checkIntervalMs: null, lock: { releaseOnExit: false } },
    ...(pairing ? { credentialRevoked: () => pairing.isRevoked(account.credentialId) } : {})
  });
  if (pairing) served = bindPairingRevocation(served, pairing, account.credentialId);
  const server = buildMcpServer(served.ctx, 'test');
  const client = new Client({ name: 'credential-revoked-tests', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const opened: Account = { ...account, scheduler, served, client };
  cleanup.push(async () => {
    await client.close();
    await server.close();
    await opened.served.close();
  });
  return opened;
}

async function newAccount(user: string, personalVault: string, personalKey: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), 'hebra-credential-revoked-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const secrets = new MemorySecretStore();
  const deviceId = randomUUID();
  const connection = fake.addAgent(user, deviceId);
  fake.addLibraryVault(user, personalVault);
  const paired: PairedSecrets = {
    connection,
    device: { lumbreDeviceId: deviceId, opaqueDeviceId: randomBytes(16).toString('hex') },
    recoveryCode: await encodeRecoveryCode({
      relayOrigin: LUMBRE, syncVaultId: personalVault, keyEpoch: 1, vaultKey: personalKey
    })
  };
  await writePairedSecrets(secrets, paired);
  return { user, credentialId: connection.credentialId, personalVault, directory, secrets, paired };
}

/** Registra la clave de agente (perezosa) y concede el espacio a esta credencial. */
async function grant(account: Account): Promise<void> {
  await account.served.ctx.spaces!.list();
  const r = fake.agentKeys.get(account.credentialId)!;
  const envelope = await sealAgentSpaceGrant({
    binding: {
      spaceId: SPACE, syncVaultId: SHARED_VAULT, accountId: r.accountId,
      credentialId: account.credentialId, deviceId: r.deviceId, keyId: r.keyId
    },
    publicKey: validatePublicJwk(r.publicKey),
    spaceKey: SHARED
  });
  fake.agentSpaces.set(account.credentialId, [{ spaceId: SPACE, syncVaultId: SHARED_VAULT, grant: envelope }]);
}

async function call(account: Account, name: string, args: Record<string, unknown> = {}) {
  return account.client.callTool({ name, arguments: args });
}
const text = (result: unknown) => JSON.stringify(result);
function payload(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);
}
const readShared = (account: Account) => call(account, 'hebra_read_note', { space: SPACE, id: NOTE });
/** Peticiones a Lumbre que leen o tocan espacios compartidos (catálogo o bóveda compartida). */
const spaceTraffic = (from: number) =>
  fake.requested.slice(from).filter((url) => url.includes('/spaces/agent-access') || url.includes(SHARED_VAULT));

beforeEach(async () => {
  fake = await FakeLumbre.start();
  await seed(SHARED_VAULT, SHARED, NOTE, SECRET_BODY, true);
});

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
  await fake?.close();
});

describe('credencial revocada o agente desactivado (D24)', () => {
  it('los espacios responden space_access_denied sin red ni caché y la personal sigue, con el motivo nuevo', async () => {
    const key = new Uint8Array(32).fill(11);
    const base = await newAccount('alice', '11'.repeat(16), key);
    await seed(base.personalVault, key, 'personal-note', '# Personal de Alice', false);
    const alice = await open(base);
    await alice.served.instance.whenReady();
    await grant(alice);
    expect(text(await readShared(alice))).toContain('Texto compartido');

    fake.disable(alice.credentialId);
    expect((await alice.served.instance.syncRunner!.requestRound())?.result).toBe('http_401');
    const from = fake.requested.length;

    const denied = await readShared(alice);
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('space_access_denied');
    expect(text(denied)).not.toContain('Texto compartido');
    const listed = payload(await call(alice, 'hebra_list_spaces'));
    expect(listed).toEqual({ spaces: [], organizationsAvailable: false });
    const organizations = await call(alice, 'hebra_list_organizations');
    expect(text(organizations)).toContain('credential_revoked');
    // Ni catálogo ni bóveda compartida: no se pregunta al relé ni se usa lo descargado.
    expect(spaceTraffic(from)).toEqual([]);

    expect(text(await call(alice, 'hebra_read_note', { id: 'personal-note' }))).toContain('Personal de Alice');
    const status = payload(await call(alice, 'hebra_status'));
    expect(status).toMatchObject({ revoked: true, revokedReason: AGENT_REVOKED_REASON });
    expect(status.revokedReason).not.toContain('hebra-mcp pair');
    expect(alice.scheduler.liveTimeouts()).toEqual([60_000]);
  });

  it('al reactivar el agente, el reintento lo nota: revoked a false y el espacio se sirve otra vez', async () => {
    const key = new Uint8Array(32).fill(11);
    const alice = await open(await newAccount('alice', '11'.repeat(16), key));
    await alice.served.instance.whenReady();
    await grant(alice);
    expect(text(await readShared(alice))).toContain('Texto compartido');
    fake.disable(alice.credentialId);
    expect((await alice.served.instance.syncRunner!.requestRound())?.result).toBe('http_401');
    expect(text(await readShared(alice))).toContain('space_access_denied');

    // Sigue desactivado: el reintento recibe otro 401 y espera el doble.
    await alice.scheduler.fireTimeout();
    expect(alice.served.instance.syncRunner!.revoked).toBe(true);
    expect(alice.scheduler.liveTimeouts()).toEqual([120_000]);

    fake.enable(alice.credentialId);
    await alice.scheduler.fireTimeout();
    expect(alice.served.instance.syncRunner!.revoked).toBe(false);
    expect(alice.scheduler.liveTimeouts()).toEqual([]);
    expect(text(await readShared(alice))).toContain('Texto compartido');
    expect(payload(await call(alice, 'hebra_list_spaces')).spaces).toEqual([
      expect.objectContaining({ spaceId: SPACE, granted: true })
    ]);
    const status = payload(await call(alice, 'hebra_status'));
    expect(status.revoked).toBe(false);
    expect(status).not.toHaveProperty('revokedReason');
  });

  it('un 401 al registrar la clave de agente también bloquea los espacios y se recupera solo', async () => {
    const key = new Uint8Array(32).fill(11);
    const alice = await open(await newAccount('alice', '11'.repeat(16), key));
    await alice.served.instance.whenReady();
    fake.disable(alice.credentialId);
    // El primer uso de un espacio registra la clave de agente y recibe el 401.
    expect(text(await call(alice, 'hebra_list_spaces'))).toContain('space_access_denied');
    expect(alice.served.instance.syncRunner!.revoked).toBe(true);
    expect(payload(await call(alice, 'hebra_status')).revokedReason).toBe(AGENT_REVOKED_REASON);
    fake.enable(alice.credentialId);
    await alice.scheduler.fireTimeout();
    expect(alice.served.instance.syncRunner!.revoked).toBe(false);
    await grant(alice);
    expect(text(await readShared(alice))).toContain('Texto compartido');
  });
});

describe('multiusuario: por cuenta (D24, D22)', () => {
  it('revocar una cuenta no toca a la otra, y la recuperación tampoco', async () => {
    const pairing = new PairingRevocation();
    const aliceKey = new Uint8Array(32).fill(11);
    const bobKey = new Uint8Array(32).fill(33);
    const alice = await open(await newAccount('alice', '11'.repeat(16), aliceKey), { pairing });
    const bob = await open(await newAccount('bob', '33'.repeat(16), bobKey), { pairing });
    await alice.served.instance.whenReady();
    await bob.served.instance.whenReady();
    await grant(alice);
    await grant(bob);
    expect(text(await readShared(alice))).toContain('Texto compartido');
    expect(text(await readShared(bob))).toContain('Texto compartido');

    fake.disable(alice.credentialId);
    expect((await alice.served.instance.syncRunner!.requestRound())?.result).toBe('http_401');
    expect(text(await readShared(alice))).toContain('space_access_denied');
    expect(text(await readShared(bob))).toContain('Texto compartido');
    expect(pairing.isRevoked(alice.credentialId)).toBe(true);
    expect(pairing.isRevoked(bob.credentialId)).toBe(false);
    expect(payload(await call(alice, 'hebra_status')).revoked).toBe(true);
    expect(payload(await call(bob, 'hebra_status')).revoked).toBe(false);
    expect(bob.served.instance.syncRunner!.revoked).toBe(false);
    expect(bob.scheduler.liveTimeouts()).toEqual([]);

    fake.enable(alice.credentialId);
    await alice.scheduler.fireTimeout();
    expect(pairing.isRevoked(alice.credentialId)).toBe(false);
    expect(text(await readShared(alice))).toContain('Texto compartido');
    expect(text(await readShared(bob))).toContain('Texto compartido');
    expect(bob.scheduler.timeouts).toEqual([]);
  });

  it('una cuenta revocada que se cierra y se reabre no sirve espacios hasta que una ronda pruebe la credencial', async () => {
    const pairing = new PairingRevocation();
    const key = new Uint8Array(32).fill(11);
    const base = await newAccount('alice', '11'.repeat(16), key);
    const first = await open(base, { pairing });
    await first.served.instance.whenReady();
    await grant(first);
    fake.disable(base.credentialId);
    expect((await first.served.instance.syncRunner!.requestRound())?.result).toBe('http_401');
    // Cierre por inactividad: la marca de la credencial sobrevive al runner (D22).
    await cleanup.pop()!();
    expect(pairing.isRevoked(base.credentialId)).toBe(true);

    // Reactivado mientras estaba cerrada. La primera ronda del contexto nuevo se retiene.
    fake.enable(base.credentialId);
    const hold = deferred();
    let held = false;
    const fetcher: Fetcher = async (input, init) => {
      const url = String(input);
      if (!held && url.includes(base.personalVault) && url.includes('/changes')) {
        held = true;
        await hold.promise;
      }
      return fake.fetcher(input, init);
    };
    const reopened = await open(base, { pairing, fetcher });
    const from = fake.requested.length;
    // Aún no se sabe si vale: ningún espacio, sin preguntar al relé.
    await expect(reopened.served.ctx.spaces!.resolve(SPACE)).rejects.toMatchObject({ code: 'space_access_denied' });
    expect(await reopened.served.ctx.spaces!.list()).toEqual([]);
    expect(spaceTraffic(from)).toEqual([]);
    expect((await reopened.served.ctx.status.getStatus()).revoked).toBe(true);

    hold.resolve();
    await reopened.served.instance.whenReady();
    // No se queda revocada para siempre: la ronda correcta levanta la marca.
    expect(pairing.isRevoked(base.credentialId)).toBe(false);
    expect((await reopened.served.ctx.status.getStatus()).revoked).toBe(false);
    expect(text(await readShared(reopened))).toContain('Texto compartido');
  });
});
