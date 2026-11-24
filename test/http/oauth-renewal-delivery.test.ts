import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountRegistry } from '../../src/accounts';
import { LumbreBackchannel, type ActiveGrant } from '../../src/oauth/backchannel';
import { OAUTH_TOKENS_FILE } from '../../src/oauth/files';
import { GrantSecrets } from '../../src/oauth/grants';
import { RevocationFile } from '../../src/oauth/owner';
import { HebraOAuthProvider } from '../../src/oauth/provider';
import { RefreshSealer } from '../../src/oauth/sumego-refresh';
import { SumegoOidc } from '../../src/oauth/sumego';
import { TokenStore } from '../../src/oauth/token-store';
import { FileSecretStore } from '../../src/secrets';

const origin = 'https://hebra.example.test';
const issuer = 'https://mcp.example.test';
const resource = `${issuer}/mcp`;
const secret = 'synthetic-backchannel-secret'.repeat(2);
const bearer = 'b1'.repeat(32);
const initialSumego = 'synthetic-sumego-refresh-1';
const nextSumego = 'synthetic-sumego-refresh-2';
const now = Date.parse('2026-11-24T12:00:00.000Z');
const hour = 60 * 60_000;
const identity = { sub: 'sumego|test', sid: null };
const client = { client_id: 'hebra-mcp-codex-127', redirect_uris: ['http://127.0.0.1:7001/callback'] };
const grant: ActiveGrant = {
  active: true, resource, clientId: client.client_id, scope: 'hebra:mcp', accountId: 'b2'.repeat(32),
  credentialId: 'aa000000-0000-4000-8000-000000000001', pairedCredentialId: 'aa000000-0000-4000-8000-000000000002',
  syncVaultId: 'b3'.repeat(16), opaqueDeviceId: 'b4'.repeat(16), expiresAt: new Date(now + 2 * hour).toISOString()
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function harness(withSumego = false) {
  const dir = await mkdtemp(join(tmpdir(), 'hebra-renewal-delivery-'));
  dirs.push(dir);
  const data = () => readFile(join(dir, OAUTH_TOKENS_FILE), 'utf8');
  const upstream = {
    capability: 200,
    responsesLost: 0,
    inactive: false,
    inactiveOnRenew: false,
    expiresAt: grant.expiresAt,
    legacyFailure: false
  };
  const renewals: Array<{ accessToken: string; renewalId?: string }> = [];
  const receipts = new Map<string, string>();
  const sumegoCalls: string[] = [];
  const calls: string[] = [];
  const backchannel = new LumbreBackchannel(secret, resource, origin, async (input, init) => {
    const path = new URL(input).pathname.replace('/api/integrations/hebra-mcp/', '');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
    calls.push(path);
    if (path === 'exchange/capabilities') {
      return upstream.capability === 200 ? json({ deliveryId: true }) : json({ error: 'unavailable' }, upstream.capability);
    }
    const body = JSON.parse(String(init?.body)) as { accessToken: string; renewalId?: string };
    expect(body.accessToken).toBe(bearer);
    if (path === 'introspect') return json(upstream.inactive ? { active: false } : { ...grant, expiresAt: upstream.expiresAt });
    if (path === 'revoke') return json({ revoked: true });
    if (path !== 'renew') throw new Error('ruta inesperada');
    renewals.push(body);
    if (upstream.inactiveOnRenew || upstream.inactive) return json({ active: false });
    if (upstream.legacyFailure) throw new Error('respuesta perdida');
    if (body.renewalId) {
      const saved = await data();
      expect(saved).toContain(body.renewalId);
      expect(saved).not.toContain(bearer);
      if (!receipts.has(body.renewalId)) {
        upstream.expiresAt = new Date(now + (3 + receipts.size) * hour).toISOString();
        receipts.set(body.renewalId, upstream.expiresAt);
      }
    }
    if (upstream.responsesLost > 0) {
      upstream.responsesLost -= 1;
      throw new Error('respuesta perdida después de confirmar');
    }
    return json({ active: true, expiresAt: body.renewalId ? receipts.get(body.renewalId) : upstream.expiresAt });
  });

  const sumegoIssuer = 'https://id.sumego.es';
  const sumego = withSumego ? new SumegoOidc({
    issuer: sumegoIssuer, clientId: 'hebra-mcp', clientSecret: secret
  }, issuer, async (input, init) => {
    const path = new URL(input).pathname;
    if (path === '/.well-known/openid-configuration') return json({
      issuer: sumegoIssuer, authorization_endpoint: `${sumegoIssuer}/authorize`, token_endpoint: `${sumegoIssuer}/token`,
      jwks_uri: `${sumegoIssuer}/jwks`, id_token_signing_alg_values_supported: ['ES256']
    });
    const presented = new URLSearchParams(String(init?.body)).get('refresh_token')!;
    sumegoCalls.push(presented);
    return presented === initialSumego && sumegoCalls.length === 1
      ? json({ refresh_token: nextSumego })
      : json({ error: 'invalid_grant' }, 400);
  }, () => now) : null;

  async function open() {
    const secrets = new FileSecretStore(join(dir, 'control', 'secrets.json'));
    const tokens = await TokenStore.open(dir, () => now);
    const grants = await GrantSecrets.open(secrets, tokens.familyIds());
    const accounts = await AccountRegistry.open(dir);
    const sealer = withSumego ? await RefreshSealer.open(secrets) : null;
    const provider = new HebraOAuthProvider({ issuer, resource, backchannel, secrets, tokens, grants, accounts,
      revocations: new RevocationFile(dir), now: () => now, multiuser: true, sumego, sealer });
    return { provider, tokens, grants, accounts, sealer };
  }
  const first = await open();
  await first.accounts.commitAccount({ sub: identity.sub, grant });
  const issued = await first.tokens.issueFamily({
    clientId: client.client_id, scope: grant.scope, resource, grant: { ...grant }, authorizedAt: now - hour, identity,
    sumego: first.sealer ? { sealedRefresh: first.sealer.seal(initialSumego), renewedAt: now - hour } : null
  }, 0, (id, ids) => first.grants.set(id, bearer, ids));
  return { first, issued, open, upstream, renewals, receipts, calls, sumegoCalls, data };
}

describe('entrega recuperable de la renovación MCP', () => {
  it('repite el mismo UUID tras una respuesta perdida y el siguiente refresh acuña otro', async () => {
    const h = await harness();
    h.upstream.responsesLost = 1;
    const second = await h.first.provider.exchangeRefreshToken(client, h.issued.refreshToken);
    const firstId = h.renewals[0]?.renewalId;
    expect(firstId).toMatch(/^[\da-f-]{36}$/);
    expect(h.renewals).toEqual([{ accessToken: bearer, renewalId: firstId }, { accessToken: bearer, renewalId: firstId }]);
    expect(h.receipts.size).toBe(1);
    expect(await h.data()).not.toContain(firstId);
    await expect(h.first.provider.exchangeRefreshToken(client, h.issued.refreshToken))
      .rejects.toMatchObject({ errorCode: 'invalid_grant' });
    expect(h.renewals).toHaveLength(2);
    await h.first.provider.exchangeRefreshToken(client, second.refresh_token!);
    expect(h.renewals).toHaveLength(3);
    expect(h.renewals[2]?.renewalId).not.toBe(firstId);
    expect(h.receipts.size).toBe(2);
  });

  it('preserva el recibo y el refresh sellado de Sumego al reiniciar mientras el destino confirma o recupera capacidad', async () => {
    const h = await harness(true);
    h.upstream.responsesLost = 2;
    await expect(h.first.provider.exchangeRefreshToken(client, h.issued.refreshToken))
      .rejects.toMatchObject({ errorCode: 'server_error' });
    const id = h.renewals[0]?.renewalId;
    const saved = await h.data();
    expect(saved).toContain(id);
    expect(saved).not.toContain(h.issued.refreshToken);
    expect(saved).not.toContain(initialSumego);
    expect(saved).not.toContain(nextSumego);
    expect(h.sumegoCalls).toEqual([initialSumego]);
    expect(h.receipts.size).toBe(1);
    await expect(h.first.provider.verifyAccessToken(h.issued.accessToken)).rejects.toMatchObject({ kind: 'unavailable' });

    const reopened = await h.open();
    await expect(reopened.provider.verifyAccessToken(h.issued.accessToken)).rejects.toMatchObject({ kind: 'unavailable' });
    h.upstream.capability = 404;
    await expect(reopened.provider.exchangeRefreshToken(client, h.issued.refreshToken))
      .rejects.toMatchObject({ errorCode: 'server_error' });
    expect(h.renewals).toHaveLength(2);
    expect(await h.data()).toBe(saved);
    h.upstream.capability = 200;
    const second = await reopened.provider.exchangeRefreshToken(client, h.issued.refreshToken);
    expect(h.renewals.map((entry) => entry.renewalId)).toEqual([id, id, id]);
    expect(h.sumegoCalls).toEqual([initialSumego]);
    expect(h.receipts.size).toBe(1);
    expect(await h.data()).not.toContain(id);
    await expect(reopened.provider.verifyAccessToken(second.access_token)).resolves.toMatchObject({ clientId: client.client_id });
  });

  it('un recibo previo no revive una concesión revocada entre introspección y /renew', async () => {
    const h = await harness();
    h.upstream.responsesLost = 2;
    await expect(h.first.provider.exchangeRefreshToken(client, h.issued.refreshToken)).rejects.toBeDefined();
    const id = h.renewals[0]?.renewalId;
    expect(h.receipts.size).toBe(1);
    h.upstream.inactiveOnRenew = true;
    const reopened = await h.open();
    await expect(reopened.provider.exchangeRefreshToken(client, h.issued.refreshToken))
      .rejects.toMatchObject({ errorCode: 'invalid_grant' });
    expect(h.renewals.at(-1)?.renewalId).toBe(id);
    expect(h.calls.at(-1)).toBe('revoke');
    expect(JSON.parse(await h.data()).families).toEqual([]);
    await expect(reopened.provider.verifyAccessToken(h.issued.accessToken)).rejects.toMatchObject({ errorCode: 'invalid_token' });
  });

  it('separa un legado sin ruta de un fallo temporal de la negociación', async () => {
    const h = await harness();
    h.upstream.capability = 503;
    const saved = await h.data();
    await expect(h.first.provider.exchangeRefreshToken(client, h.issued.refreshToken)).rejects.toBeDefined();
    expect(h.renewals).toEqual([]);
    expect(await h.data()).toBe(saved);

    h.upstream.capability = 404;
    h.upstream.legacyFailure = true;
    await expect(h.first.provider.exchangeRefreshToken(client, h.issued.refreshToken)).rejects.toBeDefined();
    expect(h.renewals).toEqual([{ accessToken: bearer }]);
    expect(await h.data()).toBe(saved);
    h.upstream.legacyFailure = false;
    await expect(h.first.provider.exchangeRefreshToken(client, h.issued.refreshToken)).resolves.toHaveProperty('refresh_token');
    expect(h.renewals).toEqual([{ accessToken: bearer }, { accessToken: bearer }]);
  });
});
