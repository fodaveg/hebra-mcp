/**
 * Credencial de emparejado revocada (SPEC.md §12.9) con el interruptor en `lumbre`, y
 * `oauth-tokens.json` v2 → v3. La página de revocado sale solo con el `410 pairing_revoked` de
 * Lumbre o con el `revoked` del relé; un 400 sigue siendo «no disponible».
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeRecoveryCode } from '../../src/hebra';
import { CLAUDE_CALLBACK, DCR_CLIENT_ID, loadOAuthHttpAuth, OAUTH_TOKENS_FILE } from '../../src/oauth';
import { TokenStore } from '../../src/oauth/token-store';
import { runStatus } from '../../src/server/tools/status';
import { MemorySecretStore, writePairedSecrets } from '../../src/secrets';
import { PAIRING_REVOKED_REASON, PairingRevocation, PairingStatusSource } from '../../src/status/pairing-revocation';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { startTestHttpApp, type TestHttpApp } from '../fixtures/http-app';

const SECRET = '0123456789abcdef0123456789abcdef';
const PAIR_ID = '11111111-1111-4111-8111-111111111111';
const VAULT = 'ab'.repeat(16);
const DEVICE = 'cd'.repeat(16);

const json = (value: object, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

let context: TestContext;
let app: TestHttpApp | undefined;
let store: MemorySecretStore;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let requestBodies: Array<Record<string, unknown>>;
let requestsResponse: () => Promise<Response>;

async function broker(input: string | URL, init?: RequestInit): Promise<Response> {
  const path = new URL(String(input)).pathname.split('/').at(-1);
  if (path !== 'requests') throw new Error('unexpected route');
  requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
  return requestsResponse();
}

async function start(pairing: PairingRevocation): Promise<TestHttpApp> {
  app = await startTestHttpApp(context.serverContext, async (config) => {
    const auth = await loadOAuthHttpAuth(context.dataDir, config, store,
      { backchannelFetch: broker, pairing, env: { HEBRA_MCP_BACKCHANNEL_SECRET: SECRET } });
    return auth!;
  });
  return app;
}

function authorize(origin: string, resource: string): Promise<Response> {
  const url = new URL(`${origin}/authorize`);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: DCR_CLIENT_ID, redirect_uri: CLAUDE_CALLBACK,
    code_challenge_method: 'S256', code_challenge: randomBytes(32).toString('base64url'), scope: 'hebra:mcp', resource,
    state: 'estado' })) url.searchParams.set(key, value);
  return fetch(url, { redirect: 'manual' });
}

function revokedEvents(): number {
  const text = (stderrSpy.mock.calls as unknown as [string][]).map(([line]) => String(line)).join('');
  return (text.match(/"event":"pairing.revoked"/g) ?? []).length;
}

beforeEach(async () => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  context = await buildTestContext();
  store = new MemorySecretStore();
  await writePairedSecrets(store, {
    connection: { credentialId: PAIR_ID, readToken: 'read', writeToken: 'write', apiOrigin: 'https://app.lumbre.pro', connectedAt: new Date().toISOString() },
    recoveryCode: await encodeRecoveryCode({ relayOrigin: 'https://app.lumbre.pro', syncVaultId: VAULT, keyEpoch: 1, vaultKey: randomBytes(32) }),
    device: { opaqueDeviceId: DEVICE, lumbreDeviceId: '33333333-3333-4333-8333-333333333333' }
  });
  requestBodies = [];
  requestsResponse = async () => json({ requestId: crypto.randomUUID(), authorizationUrl: '', expiresAt: new Date(Date.now() + 600_000).toISOString() });
});

afterEach(async () => {
  await app?.close(); app = undefined; await context?.close(); vi.restoreAllMocks();
});

describe('emparejado revocado en /authorize', () => {
  it('410 pairing_revoked de Lumbre: página HTML para reemparejar, revoked y un solo pairing.revoked', async () => {
    const pairing = new PairingRevocation();
    requestsResponse = async () => json({ error: 'pairing_revoked' }, 410);
    const { origin, config } = await start(pairing);
    const first = await authorize(origin, config.resourceUrl);
    expect(first.status).toBe(503);
    expect(first.headers.get('content-type')).toMatch(/^text\/html/);
    expect(first.headers.get('content-security-policy')).toBe("default-src 'none'; form-action 'self'; style-src 'unsafe-inline'");
    expect(await first.text()).toContain('hebra-mcp pair');
    expect(pairing.isRevoked(PAIR_ID)).toBe(true);
    // La siguiente ya no pregunta a Lumbre.
    const second = await authorize(origin, config.resourceUrl);
    expect(second.status).toBe(503);
    expect(await second.text()).toContain('credential_renewed');
    expect(requestBodies).toHaveLength(1);
    expect(revokedEvents()).toBe(1);
    // En modo `lumbre`, `/requests` no cambia.
    expect(requestBodies[0]).not.toHaveProperty('identityProvider');
    expect(requestBodies[0]).not.toHaveProperty('sumegoNonceSha256');
  });

  it('el revoked del relé: página HTML sin llamar a Lumbre; /healthz sigue en 204', async () => {
    const { origin, config } = await start(new PairingRevocation(() => true));
    const res = await authorize(origin, config.resourceUrl);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('hebra-mcp pair');
    expect(requestBodies).toHaveLength(0);
    expect((await fetch(`${origin}/healthz`)).status).toBe(204);
  });

  it('un 400 de Lumbre no es una revocación: 503 JSON de siempre', async () => {
    const pairing = new PairingRevocation();
    requestsResponse = async () => json({ error: 'invalid_request' }, 400);
    const { origin, config } = await start(pairing);
    const res = await authorize(origin, config.resourceUrl);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(pairing.isRevoked()).toBe(false);
    expect(revokedEvents()).toBe(0);
  });

  it('con el interruptor en lumbre y sin cliente, las rutas de Sumego no existen', async () => {
    const { origin } = await start(new PairingRevocation());
    expect((await fetch(`${origin}/oauth/sumego/callback?state=x&code=y`)).status).toBe(404);
    expect((await fetch(`${origin}/oauth/sumego/backchannel-logout`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'logout_token=x' })).status).toBe(404);
  });

  it('una marca de Lumbre sobre otra credencial se olvida al reemparejar', () => {
    const pairing = new PairingRevocation();
    pairing.markRevoked(PAIR_ID);
    expect(pairing.isRevoked(PAIR_ID)).toBe(true);
    expect(pairing.isRevoked('99999999-9999-4999-8999-999999999999')).toBe(false);
    expect(pairing.isRevoked()).toBe(false);
  });
});

describe('hebra_status', () => {
  it('con el emparejado revocado: revoked y el motivo; sin revocar, sin motivo', async () => {
    const pairing = new PairingRevocation();
    const ctx = { ...context.ctx, status: new PairingStatusSource(context.ctx.status, pairing) };
    const before = await runStatus(ctx);
    expect(before).not.toHaveProperty('revokedReason');
    pairing.markRevoked(PAIR_ID);
    const after = await runStatus(ctx);
    expect(after.revoked).toBe(true);
    expect(after.revokedReason).toBe(PAIRING_REVOKED_REASON);
  });
});

describe('oauth-tokens.json v2 → v3', () => {
  it('carga un v2 con sub/sid a null y escribe v3; el logout por sub no lo toca', async () => {
    const family = { id: 'A'.repeat(22), clientId: DCR_CLIENT_ID, scope: 'hebra:mcp', resource: 'https://mcp.hebra.pro/mcp',
      createdAt: Date.now() - 1000, expiresAt: Date.now() + 86400_000, refreshHash: 'ab'.repeat(32), access: [],
      grant: { credentialId: '22222222-2222-4222-8222-222222222222', clientId: DCR_CLIENT_ID, resource: 'https://mcp.hebra.pro/mcp',
        scope: 'hebra:mcp', accountId: '34'.repeat(32), pairedCredentialId: PAIR_ID, syncVaultId: VAULT, opaqueDeviceId: DEVICE,
        expiresAt: new Date(Date.now() + 86400_000).toISOString(), active: true } };
    const file = join(context.dataDir, OAUTH_TOKENS_FILE);
    await writeFile(file, JSON.stringify({ version: 2, families: [family] }));
    const tokens = await TokenStore.open(context.dataDir);
    expect(tokens.liveFamilyCount(0)).toBe(1);
    expect(await tokens.dropFamiliesByLogout({ sub: 'alguien' })).toEqual([]);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { version: number; families: Array<Record<string, unknown>> };
    expect(saved.version).toBe(3);
    expect(saved.families).toEqual([{ ...family, sub: null, sid: null, sumegoRefresh: null, sumegoRenewedAt: null }]);
    const reopened = await TokenStore.open(context.dataDir);
    expect(reopened.liveFamilyCount(0)).toBe(1);
    // Un v3 de antes de guardar el refresh de Sumego (sin esos dos campos) también carga.
    await writeFile(file, JSON.stringify({ version: 3, families: [{ ...family, sub: 'alguien', sid: 's' }] }));
    const older = await TokenStore.open(context.dataDir);
    expect(older.liveFamilyCount(0)).toBe(1);
    expect(older.sumegoRefreshOf(family.id)).toBeNull();
  });
});
