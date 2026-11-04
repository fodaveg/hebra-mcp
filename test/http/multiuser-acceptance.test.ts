/**
 * SPEC §12.10/14: HTTP + OAuth verifier + lazy production contexts + real SQLite/writers.
 * Only remote Lumbre is synthetic; identities/families are seeded after an assumed approval.
 * This is not acceptance of David/Mikel's production accounts or their shared resources.
 */
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRegistry, accountDataDir, type AccountRecord } from '../../src/accounts';
import { encodeRecoveryCode, type LumbreConnection } from '../../src/hebra';
import { httpConfigFor } from '../../src/http/config';
import { startServeHttp, type ServeHttpHandle, type StartServeHttpOptions } from '../../src/http/serve-http';
import { loadOAuthHttpAuth, DCR_CLIENT_ID } from '../../src/oauth';
import type { ActiveGrant } from '../../src/oauth/backchannel';
import { GrantSecrets } from '../../src/oauth/grants';
import { TokenStore, type IssuedTokens } from '../../src/oauth/token-store';
import { MemorySecretStore, openFileSecretStore, writePairedSecrets } from '../../src/secrets';
import { connectHttpClient, textOf } from '../fixtures/http-app';
import { startJd, type JdHarness } from '../fixtures/jd-library';
import { writePrivacyConfigFile } from '../fixtures/test-context';
import { BAIT_TAG } from '../fixtures/test-library';
import { FakeLumbre, LUMBRE } from '../pair/fake-lumbre';
import { sealAgentSpaceGrant } from '../../vendor/hebra/src/lib/spaces/agent-space-grant';
import { validatePublicJwk } from '../../vendor/hebra/src/lib/spaces/account-key';
import { deriveRecordKey, encodeRecordEnvelope } from '../../vendor/hebra/src/lib/library/envelope';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (body: object, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});
const RESOURCE = 'http://127.0.0.1/mcp';
const SHARED_SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type Principal = 'david' | 'mikel';
type Value = Record<string, any>;
let root: string;
let relay: FakeLumbre | undefined;
let relayOnline = false;
let connections: Record<Principal, LumbreConnection>;
let handle: ServeHttpHandle | undefined;
let serveOptions: StartServeHttpOptions;
let beforeRenew: (() => Promise<void>) | undefined;
let seed: JdHarness | undefined;
let records: Record<Principal, AccountRecord>;
let tokens: Record<Principal, IssuedTokens>;
let clients: Record<Principal, Client>;
let granted: Map<string, ActiveGrant>;
let offlineRemoval = false;
let removedCredentials: string[];
let measured = false;
let stderr: ReturnType<typeof vi.spyOn>;

async function call(who: Principal, name: string, args: Value = {}) {
  const result = await clients[who].callTool({ name, arguments: args }) as CallToolResult;
  const textBlocks = result.content.filter((block) => block.type === 'text');
  const first = textBlocks.length > 1 && name !== 'hebra_read_attachment' ? textBlocks[1] : textBlocks[0];
  if (!first || first.type !== 'text') throw new Error('missing_tool_response');
  return { isError: result.isError === true, value: JSON.parse(first.text) as Value, text: textOf(result) };
}

beforeEach(async () => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  root = await mkdtemp(join(tmpdir(), 'hmcp-multi-'));
  seed = await startJd();
  relay = await FakeLumbre.start();
  relayOnline = false;
  connections = {} as typeof connections;
  const registry = await AccountRegistry.open(root);
  const secretStore = new MemorySecretStore();
  const tokenStore = await TokenStore.open(root);
  const grantSecrets = await GrantSecrets.open(secretStore, []);
  records = {} as typeof records;
  tokens = {} as typeof tokens;
  clients = {} as typeof clients;
  granted = new Map();
  removedCredentials = [];
  offlineRemoval = false;
  beforeRenew = undefined;
  for (const [index, who] of (['david', 'mikel'] as const).entries()) {
    const suffix = String(index + 1).padStart(12, '0');
    connections[who] = relay.addAgent(who, `30000000-0000-4000-8000-${suffix}`);
    const grant: ActiveGrant = {
      active: true, credentialId: `20000000-0000-4000-8000-${suffix}`,
      clientId: DCR_CLIENT_ID, resource: RESOURCE, scope: 'hebra:mcp',
      accountId: hash(`hebra-account:${who}`), pairedCredentialId: connections[who].credentialId,
      syncVaultId: hash(`vault-${who}`).slice(0, 32), opaqueDeviceId: hash(`device-${who}`).slice(0, 32),
      expiresAt: new Date(Date.now() + 86400_000).toISOString()
    };
    relay.addLibraryVault(who, grant.syncVaultId);
    records[who] = await registry.commitAccount({ sub: who, grant });
    const dataDir = accountDataDir(root, records[who]);
    await mkdir(dataDir, { recursive: true });
    // SQLite produces a consistent snapshot, including the source WAL. Every note/folder UUID
    // deliberately collides across accounts; each account still has a different authority.
    const source = new DatabaseSync(seed.test.sqlitePath);
    try { source.exec(`VACUUM INTO '${join(dataDir, 'library.sqlite').replaceAll("'", "''")}'`); }
    finally { source.close(); }
    await cp(join(seed.test.dataDir, 'blobs'), join(dataDir, 'blobs'), { recursive: true });
    await writePrivacyConfigFile(dataDir, { privateFolders: [['diario']],
      privateTags: who === 'david' ? ['secreto'] : [] });
    await writePairedSecrets(openFileSecretStore(dataDir), {
      connection: connections[who],
      recoveryCode: await encodeRecoveryCode({ relayOrigin: LUMBRE,
        syncVaultId: grant.syncVaultId, keyEpoch: 1, vaultKey: randomBytes(32) }),
      device: { opaqueDeviceId: grant.opaqueDeviceId, lumbreDeviceId: `30000000-0000-4000-8000-${suffix}` }
    });
    const bearer = hash(`upstream-${who}`);
    granted.set(bearer, grant);
    tokens[who] = await tokenStore.issueFamily({ clientId: grant.clientId, scope: grant.scope,
      resource: RESOURCE, grant, authorizedAt: Date.now(), identity: { sub: who, sid: `sid-${who}` } },
    0, (id, live) => grantSecrets.set(id, bearer, live));
  }
  serveOptions = { dataDir: root, secrets: secretStore, multiuser: true,
    config: httpConfigFor('http://127.0.0.1', 0), version: '0.0.0-acceptance',
    authConfigured: () => true, syncIntervalMs: null,
    instance: { checkIntervalMs: null, lock: { releaseOnExit: false } },
    // Real library sync transport sees an offline relay; personal local operations must survive.
    fetcher: async (input, init) => {
      if (new URL(String(input)).pathname === '/api/integrations/hebra/credential' && init?.method === 'DELETE') {
        if (offlineRemoval) return json({ error: 'unavailable' }, 503);
        removedCredentials.push(new Headers(init.headers).get('authorization') ?? '');
        return json({ ok: true });
      }
      if (relayOnline) return relay!.fetcher(input, init);
      return json({ error: 'unavailable' }, 503);
    },
    loadAuth: (dataDir, config, secrets) => loadOAuthHttpAuth(dataDir, config, secrets, {
      multiuser: true, env: { HEBRA_MCP_BACKCHANNEL_SECRET: 'acceptance-only-0123456789abcdef0123456789' },
      backchannelFetch: async (input, init) => {
        const body = JSON.parse(String(init?.body));
        const grant = granted.get(body.accessToken);
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/introspect')) return json(grant ?? { active: false });
        if (path.endsWith('/renew')) { await beforeRenew?.(); return json({ active: true, expiresAt: grant!.expiresAt }); }
        if (path.endsWith('/revoke')) return json({ revoked: true });
        throw new Error('unexpected_backchannel_route');
      }
    })
  };
  handle = await startServeHttp(serveOptions);
  // Two first acquisitions race through production AccountContexts and openServeContext.
  const firstClients = await Promise.all((['david', 'david', 'mikel'] as const).map(
    (who) => connectHttpClient(`http://127.0.0.1:${handle!.port}`, tokens[who].accessToken)
  ));
  clients.david = firstClients[0]; clients.mikel = firstClients[2];
  await firstClients[1].close();
  if (!measured) {
    measured = true;
    const databases = await Promise.all((['david', 'mikel'] as const).map(async (who) => ({
      principal: who, sqliteBytes: (await stat(join(accountDataDir(root, records[who]), 'library.sqlite'))).size,
      writerOpen: existsSync(join(accountDataDir(root, records[who]), 'writer.lock'))
    })));
    process.stdout.write(`acceptance_fixture_capacity ${JSON.stringify({ accounts: 2,
      seedLiveNotesPerAccount: seed.rawNotes().length, rssBytes: process.memoryUsage().rss,
      databases, platform: process.platform, node: process.version,
      limit: 'synthetic small libraries; Vitest process RSS includes seed and runner, not container capacity' })}\n`);
  }
});

afterEach(async () => {
  for (const client of Object.values(clients ?? {})) await client.close();
  await handle?.close(); handle = undefined;
  await seed?.close(); seed = undefined;
  await relay?.close(); relay = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  stderr?.mockRestore();
});

describe('acceptance multiusuario por HTTP, con bibliotecas reales y relé sintético offline', () => {
  it('el mismo UUID y operationId escribe y repite solo en su cuenta; buscar y listar no mezcla datos', async () => {
    const id = seed!.test.library.publicNote2Id;
    for (const who of ['david', 'mikel'] as const) {
      const args = { id, text: `MARCADOR_${who.toUpperCase()}`, operationId: 'same-operation' };
      expect((await call(who, 'hebra_append_to_note', args)).value.outcome).toBe('saved');
      expect((await call(who, 'hebra_append_to_note', args)).value.replayed).toBe(true);
    }
    for (const [who, other] of [['david', 'mikel'], ['mikel', 'david']] as const) {
      const read = await call(who, 'hebra_read_note', { id, account: records[other].id, sub: other });
      expect(read.value.body).toContain(`MARCADOR_${who.toUpperCase()}`);
      expect(read.value.body).not.toContain(`MARCADOR_${other.toUpperCase()}`);
      expect(String(read.value.body).split(`MARCADOR_${who.toUpperCase()}`)).toHaveLength(2);
      expect(JSON.stringify((await call(who, 'hebra_search', { query: `MARCADOR_${who.toUpperCase()}` })).value)).toContain(id);
      const search = await call(who, 'hebra_search', { query: `MARCADOR_${other.toUpperCase()}` });
      expect(search.value).toMatchObject({ results: [] });
      expect(JSON.stringify((await call(who, 'hebra_list_notes', { limit: 100 })).value))
        .not.toContain(`MARCADOR_${other.toUpperCase()}`);
    }
    expect((await call('mikel', 'hebra_status')).value).toMatchObject({ linked: true });
  });

  it('una nota solo de David no se enumera, busca, lee ni modifica desde Mikel; error igual a inexistente', async () => {
    const created = await call('david', 'hebra_create_note', { body: '# TITULO_EXCLUSIVO_DAVID\nSECRETO_PERSONAL_DAVID', operationId: 'only-david' });
    expect(created.isError).toBe(false);
    const id = created.value.id;
    const missing = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    for (const [name, args] of [
      ['hebra_read_note', {}], ['hebra_append_to_note', { text: 'intrusion' }],
      ['hebra_list_attachments', {}], ['hebra_list_versions', {}]
    ] as const) {
      const forbidden = await call('mikel', name, { ...args, id });
      const absent = await call('mikel', name, { ...args, id: missing });
      expect(forbidden).toEqual(absent);
      expect(forbidden.isError).toBe(true);
    }
    expect((await call('mikel', 'hebra_search', { query: 'SECRETO_PERSONAL_DAVID' })).value)
      .toMatchObject({ results: [] });
    expect(JSON.stringify((await call('mikel', 'hebra_list_notes', { limit: 100 })).value)).not.toContain(id);
    expect((await call('david', 'hebra_read_note', { id })).value.body).not.toContain('intrusion');
  });

  it('configuración privada, errores y versiones se resuelven en la biblioteca autenticada', async () => {
    const id = seed!.test.library.privateTagNoteId;
    const missing = await call('david', 'hebra_read_note', { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    expect(await call('david', 'hebra_read_note', { id })).toEqual(missing);
    expect((await call('mikel', 'hebra_read_note', { id })).value.body).toContain(BAIT_TAG);
    expect(JSON.stringify((await call('david', 'hebra_search', { query: BAIT_TAG })).value)).not.toContain(id);
    expect(JSON.stringify((await call('mikel', 'hebra_search', { query: BAIT_TAG })).value)).toContain(id);
    const publicId = seed!.test.library.publicNote2Id;
    for (const who of ['david', 'mikel'] as const) {
      expect((await call(who, 'hebra_append_to_note', { id: publicId, text: `VERSION_${who}`, operationId: 'same-version-op' })).isError).toBe(false);
    }
    const versions = await call('david', 'hebra_list_versions', { id: publicId });
    expect(versions.isError).toBe(false);
    expect(JSON.stringify(versions.value)).not.toContain('VERSION_mikel');
    const known = seed!.test.library;
    expect((await call('david', 'hebra_read_version', { id: known.formerlyPrivateNoteId, versionId: known.formerlyPrivateVersionId })).isError).toBe(true);
    expect((await call('mikel', 'hebra_read_version', { id: known.formerlyPrivateNoteId, versionId: known.formerlyPrivateVersionId })).isError).toBe(false);
  });

  it('adjuntos con el mismo operationId guardan bytes propios y un hash ajeno no es legible', async () => {
    const id = seed!.test.library.publicNote2Id;
    for (const who of ['david', 'mikel'] as const) {
      const bytes = `ADJUNTO_PERSONAL_${who}`;
      const result = await call(who, 'hebra_add_attachment', { id, name: `${who}.txt`,
        dataBase64: Buffer.from(bytes).toString('base64'), operationId: 'same-attachment-op' });
      expect(result.isError).toBe(false);
      expect((await call(who, 'hebra_read_attachment', { id, attachmentId: hash(bytes) })).text).toContain(bytes);
    }
    const foreign = await call('mikel', 'hebra_read_attachment', { id, attachmentId: hash('ADJUNTO_PERSONAL_david') });
    expect(foreign).toEqual(await call('mikel', 'hebra_read_attachment', { id, attachmentId: 'f'.repeat(64) }));
    expect(foreign.isError).toBe(true);
  });

  it('planes de reemplazo y JDex no cruzan cuentas; el mismo operationId no comparte resultados', async () => {
    const id = seed!.test.library.publicNote2Id;
    const plan = await call('david', 'hebra_replace_in_notes', { mode: 'simulate', ids: [id], pattern: 'Texto normal', replacement: 'SOLO_PLAN_DAVID' });
    expect(plan.isError).toBe(false);
    expect(typeof plan.value.planId).toBe('string');
    const stolen = await call('mikel', 'hebra_replace_in_notes', { mode: 'apply', planId: plan.value.planId, operationId: 'same-plan-op' });
    expect(stolen).toMatchObject({ isError: true, value: { error: 'plan_not_found' } });
    expect((await call('david', 'hebra_replace_in_notes', { mode: 'apply', planId: plan.value.planId, operationId: 'same-plan-op' })).isError).toBe(false);
    expect((await call('mikel', 'hebra_read_note', { id })).value.body).not.toContain('SOLO_PLAN_DAVID');
    const jd = await call('david', 'hebra_jd_new_id', { mode: 'simulate', category: '21', title: 'JD exclusivo David' });
    expect(jd.isError).toBe(false);
    expect((await call('mikel', 'hebra_jd_new_id', { mode: 'apply', planId: jd.value.planId, operationId: 'same-jd-op' })).isError).toBe(true);
    expect((await call('david', 'hebra_jd_new_id', { mode: 'apply', planId: jd.value.planId, operationId: 'same-jd-op' })).isError).toBe(false);
    const own = await call('mikel', 'hebra_jd_new_id', { mode: 'simulate', category: '21', title: 'JD exclusivo Mikel' });
    expect(own.value.id).toBe(jd.value.id);
    expect((await call('mikel', 'hebra_jd_new_id', { mode: 'apply', planId: own.value.planId, operationId: 'same-jd-op' })).isError).toBe(false);
    expect(JSON.stringify((await call('mikel', 'hebra_list_notes', { limit: 100 })).value)).not.toContain('JD exclusivo David');
  });

  it('compartir un spaceId no habilita contenido: permiso ausente falla igual y el personal sigue abierto', async () => {
    const id = seed!.test.library.publicNote2Id;
    for (const who of ['david', 'mikel'] as const) {
      const denied = await call(who, 'hebra_read_note', { id, space: SHARED_SPACE });
      expect(denied).toEqual(await call(who, 'hebra_read_note', { id, space: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
      expect(denied).toMatchObject({ isError: true, value: { error: 'space_access_denied' } });
      expect(await call(who, 'hebra_read_note', { id, space: 'personal' })).toEqual(await call(who, 'hebra_read_note', { id }));
    }
  });

  it('el mismo espacio autorizado abre sus sobres para A y B; apagar B corta solo ese acceso y no abre el personal de A', async () => {
    relayOnline = true;
    const sharedVault = '22'.repeat(16);
    const sharedKey = new Uint8Array(32).fill(22);
    const id = seed!.test.library.publicNote2Id;
    const recordKey = await deriveRecordKey({ vaultKey: sharedKey, syncVaultId: sharedVault, keyEpoch: 1 });
    const encoded = await encodeRecordEnvelope({ recordKey, syncVaultId: sharedVault, recordId: id,
      fields: { kind: 'note', folderId: 'root', body: '# COMPARTIDO_PERMITIDO\nSOLO_ESPACIO',
        favorite: false, createdAt: 1, updatedAt: 1, trashedAt: null,
        conflictOf: null, conflictAt: null, conflictDevice: null },
      authorship: { authorId: hash('hebra-account:david'), minClient: 2 } });
    await relay!.relayFor(sharedVault).postRecords(sharedVault, [{ id, baseRev: null,
      deleted: false, envelope: encoded.envelope, objectIds: [] }]);
    for (const who of ['david', 'mikel'] as const) {
      expect((await call(who, 'hebra_list_spaces')).isError).toBe(false);
      const registered = relay!.agentKeys.get(connections[who].credentialId)!;
      const grant = await sealAgentSpaceGrant({ binding: { spaceId: SHARED_SPACE, syncVaultId: sharedVault,
        accountId: registered.accountId, credentialId: connections[who].credentialId,
        deviceId: registered.deviceId, keyId: registered.keyId },
        publicKey: validatePublicJwk(registered.publicKey), spaceKey: sharedKey });
      relay!.agentSpaces.set(connections[who].credentialId,
        [{ spaceId: SHARED_SPACE, syncVaultId: sharedVault, grant }]);
      const shared = await call(who, 'hebra_read_note', { id, space: SHARED_SPACE });
      expect(shared.isError).toBe(false);
      expect(shared.value.body).toContain('COMPARTIDO_PERMITIDO');
      expect((await call(who, 'hebra_read_note', { id })).value.body).not.toContain('COMPARTIDO_PERMITIDO');
    }
    const exclusive = await call('david', 'hebra_create_note', { body: '# EXCLUSIVO_A_AUN_COMPARTIENDO', operationId: 'shared-membership-not-personal' });
    expect(exclusive.isError).toBe(false);
    expect((await call('mikel', 'hebra_read_note', { id: exclusive.value.id })).isError).toBe(true);
    expect((await call('mikel', 'hebra_search', { query: 'EXCLUSIVO_A_AUN_COMPARTIENDO' })).value).toMatchObject({ results: [] });
    expect((await call('mikel', 'hebra_append_to_note', { id: exclusive.value.id, text: 'intrusion' })).isError).toBe(true);
    expect(JSON.stringify((await call('mikel', 'hebra_list_notes', { limit: 100 })).value)).not.toContain(exclusive.value.id);
    relay!.agentSpaces.set(connections.mikel.credentialId, []);
    const denied = await call('mikel', 'hebra_read_note', { id, space: SHARED_SPACE });
    expect(denied).toMatchObject({ isError: true, value: { error: 'space_access_denied' } });
    expect(denied.text).not.toContain('COMPARTIDO_PERMITIDO');
    expect((await call('david', 'hebra_read_note', { id, space: SHARED_SPACE })).value.body).toContain('COMPARTIDO_PERMITIDO');
    expect((await call('mikel', 'hebra_read_note', { id })).isError).toBe(false);
  });

  it('refresh de A mientras B escribe: al retirar A durante renew no se emite otro token ni se corta B', async () => {
    const refresh = (refreshToken: string) => fetch(`http://127.0.0.1:${handle!.port}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: DCR_CLIENT_ID,
        refresh_token: refreshToken, resource: RESOURCE })
    });
    const first = await refresh(tokens.david.refreshToken);
    expect(first.status).toBe(200);
    const renewed = await first.json() as { access_token: string; refresh_token: string };
    expect(renewed.access_token).not.toBe(tokens.david.accessToken);
    const refreshedClient = await connectHttpClient(`http://127.0.0.1:${handle!.port}`, renewed.access_token);
    await refreshedClient.close();
    let arrived!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { arrived = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    beforeRenew = async () => { arrived(); await waiting; };
    const pending = refresh(renewed.refresh_token);
    try {
      await entered;
      const id = seed!.test.library.publicNote2Id;
      expect((await call('mikel', 'hebra_append_to_note', { id, text: 'B_DURANTE_REFRESH', operationId: 'during-refresh' })).isError).toBe(false);
      await handle!.removeAccount(records.david.id);
      release();
      const rejected = await pending;
      expect(rejected.ok).toBe(false);
      expect(await rejected.json()).not.toHaveProperty('access_token');
      expect((await call('mikel', 'hebra_read_note', { id })).value.body).toContain('B_DURANTE_REFRESH');
    } finally { release(); await pending; }
  });

  it('sin peticiones no queda ninguna biblioteca abierta, y la siguiente llamada reabre la misma (D22)', async () => {
    await clients.david.close(); await clients.mikel.close();
    await handle!.close();
    vi.stubEnv('HEBRA_MCP_CONTEXT_IDLE_MS', '1');
    try {
      handle = await startServeHttp(serveOptions);
      const url = `http://127.0.0.1:${handle.port}`;
      clients.david = await connectHttpClient(url, tokens.david.accessToken);
      clients.mikel = await connectHttpClient(url, tokens.mikel.accessToken);
      const writers = () => (['david', 'mikel'] as const).filter(
        (who) => existsSync(join(accountDataDir(root, records[who]), 'writer.lock')));
      const id = seed!.test.library.publicNote2Id;
      expect((await call('david', 'hebra_append_to_note', { id, text: 'ANTES_DE_CERRAR', operationId: 'idle-1' })).isError).toBe(false);
      await vi.waitFor(() => expect(writers()).toEqual([]));
      expect((await call('david', 'hebra_read_note', { id })).value.body).toContain('ANTES_DE_CERRAR');
      expect((await call('david', 'hebra_append_to_note', { id, text: 'ANTES_DE_CERRAR', operationId: 'idle-1' })).value.replayed).toBe(true);
      expect((await call('mikel', 'hebra_read_note', { id })).value.body).not.toContain('ANTES_DE_CERRAR');
      await vi.waitFor(() => expect(writers()).toEqual([]));
    } finally { vi.unstubAllEnvs(); }
  });

  it('retirar A con relé caído la bloquea; reintentar borra solo A y conserva OAuth y datos de B', async () => {
    const id = seed!.test.library.publicNote2Id;
    expect((await call('mikel', 'hebra_append_to_note', { id, text: 'B_SOBREVIVE', operationId: 'removal-b' })).isError).toBe(false);
    offlineRemoval = true;
    await expect(handle!.removeAccount(records.david.id)).rejects.toThrow('pairing_revoke_failed');
    expect(existsSync(accountDataDir(root, records.david))).toBe(true);
    await expect(call('david', 'hebra_read_note', { id })).rejects.toThrow();
    expect((await call('mikel', 'hebra_read_note', { id })).value.body).toContain('B_SOBREVIVE');
    offlineRemoval = false;
    await handle!.removeAccount(records.david.id);
    await handle!.removeAccount(records.david.id);
    expect(existsSync(accountDataDir(root, records.david))).toBe(false);
    expect(existsSync(accountDataDir(root, records.mikel))).toBe(true);
    expect(removedCredentials).toEqual([`Bearer ${connections.david.writeToken}`]);
    expect((await call('mikel', 'hebra_append_to_note', { id, text: 'B_DESPUES', operationId: 'after-removal' })).isError).toBe(false);
    expect((await call('mikel', 'hebra_read_note', { id })).value.body).toContain('B_DESPUES');
    await clients.david.close(); await clients.mikel.close();
    await handle!.close();
    handle = await startServeHttp(serveOptions);
    clients.mikel = await connectHttpClient(`http://127.0.0.1:${handle.port}`, tokens.mikel.accessToken);
    expect((await call('mikel', 'hebra_read_note', { id })).value.body).toContain('B_DESPUES');
    await expect(connectHttpClient(`http://127.0.0.1:${handle.port}`, tokens.david.accessToken)).rejects.toThrow();
    const registry = await AccountRegistry.open(root);
    expect(registry.findById(records.david.id)).toMatchObject({ state: 'removed', generation: 2 });
    expect(registry.findById(records.mikel.id)).toMatchObject({ state: 'active', generation: 1 });
  });
});
