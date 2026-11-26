import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response as ExpressResponse } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeRecoveryCode } from '../../src/hebra';
import { readHttpConfig } from '../../src/http/config';
import { CLAUDE_CALLBACK, DCR_CLIENT_ID } from '../../src/oauth/clients';
import { loadOAuthHttpAuth } from '../../src/oauth/http-auth';
import { OAUTH_SCOPE } from '../../src/oauth/provider';
import { MemorySecretStore, writePairedSecrets } from '../../src/secrets';

const SECRET = 's'.repeat(32);
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const PAIRED_ID = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL_ID = '33333333-3333-4333-8333-333333333333';
const VAULT = 'ab'.repeat(16);
const DEVICE = 'cd'.repeat(16);
const BEARER = 'ef'.repeat(32);
const config = readHttpConfig({ HEBRA_MCP_PUBLIC_URL: 'https://mcp.hebra.pro' });
const client = { client_id: DCR_CLIENT_ID, client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK] };
const verifier = 'v'.repeat(43);
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function response() {
  const redirect = vi.fn<(status: number, url: string) => void>();
  const stub = { req: { ip: '127.0.0.1' }, redirect, status: vi.fn().mockReturnThis(), json: vi.fn() };
  return { redirect, res: stub as unknown as ExpressResponse };
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'hebra-oauth-delivery-'));
  dirs.push(dataDir);
  const secrets = new MemorySecretStore();
  await writePairedSecrets(secrets, {
    connection: { credentialId: PAIRED_ID, readToken: 'read', writeToken: 'write', apiOrigin: 'https://app.lumbre.pro', connectedAt: new Date().toISOString() },
    recoveryCode: await encodeRecoveryCode({ relayOrigin: 'https://app.lumbre.pro', syncVaultId: VAULT, keyEpoch: 1, vaultKey: Buffer.alloc(32, 7) }),
    device: { opaqueDeviceId: DEVICE, lumbreDeviceId: CREDENTIAL_ID }
  });
  const grant = {
    credentialId: CREDENTIAL_ID, accessToken: BEARER, tokenType: 'Bearer', accountId: 'ab'.repeat(32),
    clientId: client.client_id, resource: config.resourceUrl, scope: OAUTH_SCOPE,
    pairedCredentialId: PAIRED_ID, syncVaultId: VAULT, opaqueDeviceId: DEVICE,
    expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString()
  };
  const calls: [string, Record<string, unknown>][] = [];
  let recoverUnavailable = false;
  const renewalReceipts = new Map<unknown, string>();
  const backchannelFetch = async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace('/api/integrations/hebra-mcp/', '');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push([path, body]);
    switch (path) {
      case 'requests': return Response.json({ requestId: REQUEST_ID,
        authorizationUrl: `https://app.lumbre.pro/integrations/hebra-mcp?request=${REQUEST_ID}`,
        expiresAt: new Date(Date.now() + 300_000).toISOString() });
      case 'exchange/capabilities': return Response.json({ deliveryId: true });
      case 'exchange':
        expect(JSON.parse((await secrets.get('hebra-mcp-oauth-deliveries'))!)).toEqual([{ ...body, owned: false }]);
        throw new Error('respuesta perdida después de emitir la credencial');
      case 'exchange/recover': return recoverUnavailable ? new Response(null, { status: 503 }) : Response.json(grant);
      case 'exchange/ack': return Response.json({ acknowledged: true });
      case 'revoke': return Response.json({ revoked: true });
      case 'introspect': {
        const { accessToken: _bearer, tokenType: _scheme, ...fields } = grant;
        return Response.json({ active: true, ...fields });
      }
      case 'renew': {
        const receipt = renewalReceipts.get(body.renewalId);
        if (receipt) return Response.json({ active: true, expiresAt: receipt });
        grant.expiresAt = new Date(Date.parse(grant.expiresAt) + 60_000).toISOString();
        renewalReceipts.set(body.renewalId, grant.expiresAt);
        if (renewalReceipts.size === 1) throw new Error('respuesta de renovación perdida');
        return Response.json({ active: true, expiresAt: grant.expiresAt });
      }
      default: throw new Error('ruta inesperada');
    }
  };
  async function open() {
    const auth = await loadOAuthHttpAuth(dataDir, config, secrets, {
      env: { HEBRA_MCP_BACKCHANNEL_SECRET: SECRET }, backchannelFetch
    });
    return auth!.provider;
  }
  async function consent(provider: Awaited<ReturnType<typeof open>>) {
    const start = response();
    await provider.authorize(client, { redirectUri: CLAUDE_CALLBACK, codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      resource: new URL(config.resourceUrl), scopes: [OAUTH_SCOPE] }, start.res);
    expect(start.redirect).toHaveBeenCalledWith(302, expect.stringContaining(REQUEST_ID));
    const finish = response();
    await provider.handleLumbreCallback({ query: { request: REQUEST_ID, decision: 'approved' } } as unknown as Request, finish.res);
    return finish.redirect;
  }
  return { secrets, calls, open, consent, blockRecovery: () => { recoverUnavailable = true; }, allowRecovery: () => { recoverUnavailable = false; } };
}

describe('entrega durable del proveedor OAuth de Hebra', () => {
  it('recupera la respuesta perdida con la misma referencia y renueva con un identificador estable', async () => {
    const f = await fixture();
    const provider = await f.open();
    const redirect = await f.consent(provider);
    const exchange = f.calls.find(([path]) => path === 'exchange')![1];
    expect(exchange.deliveryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.calls.slice(2)).toEqual([['exchange', exchange], ['exchange/recover', exchange], ['exchange/ack', exchange]]);
    expect(await f.secrets.get('hebra-mcp-oauth-deliveries')).toBe('[]');
    const code = new URL(redirect.mock.calls[0]![1]).searchParams.get('code')!;
    const resource = new URL(config.resourceUrl);
    const issued = await provider.exchangeAuthorizationCode(client, code, verifier, CLAUDE_CALLBACK, resource);
    await expect(provider.exchangeRefreshToken(client, issued.refresh_token!, [OAUTH_SCOPE], resource)).rejects.toThrow();
    const restarted = await f.open();
    await expect(restarted.verifyAccessToken(issued.access_token)).rejects.toMatchObject({ kind: 'unavailable' });
    const rotated = await restarted.exchangeRefreshToken(client, issued.refresh_token!, [OAUTH_SCOPE], resource);
    await restarted.exchangeRefreshToken(client, rotated.refresh_token!, [OAUTH_SCOPE], resource);
    const renewals = f.calls.filter(([path]) => path === 'renew').map(([, body]) => body);
    expect(renewals).toHaveLength(3);
    expect(renewals[0]).toEqual({ accessToken: BEARER, renewalId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(renewals[1]).toEqual(renewals[0]);
    expect(renewals[2]?.renewalId).not.toBe(renewals[0]?.renewalId);
  });

  it('tras reiniciar revoca una entrega sin custodia local y luego confirma el acuse', async () => {
    const f = await fixture();
    f.blockRecovery();
    expect(await f.consent(await f.open())).not.toHaveBeenCalled();
    const ref = f.calls.find(([path]) => path === 'exchange')![1];
    expect(JSON.parse((await f.secrets.get('hebra-mcp-oauth-deliveries'))!)).toEqual([{ ...ref, owned: false }]);
    f.allowRecovery();
    await f.open();
    expect(f.calls.slice(-3)).toEqual([['exchange/recover', ref], ['revoke', { accessToken: BEARER }], ['exchange/ack', ref]]);
    expect(await f.secrets.get('hebra-mcp-oauth-deliveries')).toBe('[]');
  });
});
