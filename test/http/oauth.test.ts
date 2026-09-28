/** Consentimiento Lumbre sobre el OAuth público real, con broker cerrado simulado. */
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { encodeRecoveryCode } from '../../src/hebra';
import { CLAUDE_CALLBACK, DCR_CLIENT_ID, loadOAuthHttpAuth, OAUTH_TOKENS_FILE, revokeAllTokens } from '../../src/oauth';
import type { HebraOAuthProvider } from '../../src/oauth/provider';
import { MemorySecretStore, writePairedSecrets } from '../../src/secrets';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { startTestHttpApp, textOf, type TestHttpApp } from '../fixtures/http-app';
import { TOOL_NAMES } from '../fixtures/tool-names';

const SECRET = '0123456789abcdef0123456789abcdef';
const PAIR_ID = '11111111-1111-4111-8111-111111111111';
const GRANT_ID = '22222222-2222-4222-8222-222222222222';
const VAULT = 'ab'.repeat(16);
const DEVICE = 'cd'.repeat(16);
const OTHER_DEVICE = 'ef'.repeat(16);
const ACCOUNT = '34'.repeat(32);
const UPSTREAM = '56'.repeat(32);
const CIMD_CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

let context: TestContext;
let app: TestHttpApp;
let provider: HebraOAuthProvider;
let store: MemorySecretStore;
let requestId: string;
let transactionId: string;
let clientId: string;
let resource: string;
let approved: boolean;
let deviceActive: boolean;
let available: boolean;
let requestCount: number;
let exchangeCount: number;
let grantExpiresAt: string;
let brokerDevice: string;
let brokerVault: string;
let brokerPair: string;
let clockOffset: number;
let cimdFetch: ReturnType<typeof vi.fn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
const clients: Client[] = [];

const response = (value: object, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** Verifica que el cliente envía exclusivamente el backchannel autorizado. */
async function broker(input: string | URL, init?: RequestInit): Promise<Response> {
  expect(String(input).startsWith('https://app.lumbre.pro/api/integrations/hebra-mcp/')).toBe(true);
  expect(init?.headers).toMatchObject({ authorization: `Bearer ${SECRET}` });
  expect(init?.redirect).toBe('manual');
  if (!available) throw new Error('offline');
  const body = JSON.parse(String(init?.body)) as Record<string, string>;
  const path = new URL(String(input)).pathname.split('/').at(-1);
  if (path === 'requests') {
    requestCount += 1;
    expect(body.opaqueDeviceId).toBe(DEVICE);
    expect(body.pairedCredentialId).toBe(PAIR_ID);
    expect(body.syncVaultId).toBe(VAULT);
    requestId = crypto.randomUUID();
    transactionId = body.transactionId!;
    clientId = body.clientId!;
    resource = body.resource!;
    return response({ requestId, authorizationUrl: `https://app.lumbre.pro/integrations/hebra-mcp?request=${requestId}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString() });
  }
  if (path === 'exchange') {
    exchangeCount += 1;
    if (!approved || !deviceActive || body.requestId !== requestId || body.transactionId !== transactionId) return response({ error: 'invalid_grant' }, 400);
    return response({ credentialId: GRANT_ID, accessToken: UPSTREAM, tokenType: 'Bearer', clientId, resource, scope: 'hebra:mcp',
      accountId: ACCOUNT, pairedCredentialId: brokerPair, syncVaultId: brokerVault, opaqueDeviceId: brokerDevice, expiresAt: grantExpiresAt });
  }
  if (path === 'introspect') {
    if (!deviceActive || body.accessToken !== UPSTREAM) return response({ active: false });
    return response({ active: true, credentialId: GRANT_ID, clientId, resource, scope: 'hebra:mcp', accountId: ACCOUNT,
      pairedCredentialId: brokerPair, syncVaultId: brokerVault, opaqueDeviceId: brokerDevice, expiresAt: grantExpiresAt });
  }
  if (path === 'revoke') { approved = false; return response({ revoked: true }); }
  throw new Error('unexpected route');
}

beforeEach(async () => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  cimdFetch = vi.fn(async (input: string | URL) => new Response(JSON.stringify({
    client_id: CIMD_CLIENT_ID, client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code']
  }), { status: String(input) === CIMD_CLIENT_ID ? 200 : 404, headers: { 'content-type': 'application/json' } }));
  context = await buildTestContext();
  store = new MemorySecretStore();
  await writePairedSecrets(store, {
    connection: { credentialId: PAIR_ID, readToken: 'read', writeToken: 'write', apiOrigin: 'https://app.lumbre.pro', connectedAt: new Date().toISOString() },
    recoveryCode: await encodeRecoveryCode({ relayOrigin: 'https://app.lumbre.pro', syncVaultId: VAULT, keyEpoch: 1, vaultKey: randomBytes(32) }),
    device: { opaqueDeviceId: DEVICE, lumbreDeviceId: '33333333-3333-4333-8333-333333333333' }
  });
  approved = false; deviceActive = true; available = true; requestCount = 0; exchangeCount = 0;
  clockOffset = 0;
  brokerPair = PAIR_ID; brokerVault = VAULT; brokerDevice = DEVICE;
  grantExpiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();
  app = await startTestHttpApp(context.serverContext, async (config) => {
    const auth = await loadOAuthHttpAuth(context.dataDir, config, store,
      { backchannelFetch: broker, fetch: cimdFetch as never, now: () => Date.now() + clockOffset,
        env: { HEBRA_MCP_BACKCHANNEL_SECRET: SECRET } });
    if (!auth) throw new Error('auth absent');
    provider = auth.provider;
    return auth;
  });
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await app?.close(); await context?.close(); vi.restoreAllMocks();
});

/** Proveedor cliente en memoria: el SDK maneja DCR/CIMD, state, PKCE y refresh. */
class MemoryOAuthClient implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authorizationUrl: URL | undefined;
  constructor(readonly clientMetadataUrl?: string) {}
  get redirectUrl(): string { return CLAUDE_CALLBACK; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
  }
  state(): string { return 'estado-de-prueba'; }
  clientInformation() { return this.info; }
  saveClientInformation(info: OAuthClientInformationMixed): void { this.info = info; }
  tokens() { return this.saved; }
  saveTokens(tokens: OAuthTokens): void { this.saved = tokens; }
  redirectToAuthorization(url: URL): void { this.authorizationUrl = url; }
  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }
  codeVerifier(): string { return this.verifier; }
}

/** Flujo completo con el cliente SDK, hasta una herramienta MCP sobre SQLite local. */
async function sdkFlow(auth: MemoryOAuthClient): Promise<Client> {
  const mcpUrl = new URL(`${app.origin}/mcp`);
  const first = new StreamableHTTPClientTransport(mcpUrl, { authProvider: auth });
  const initial = new Client({ name: 'claude-de-prueba', version: '0.0.0' });
  await expect(initial.connect(first)).rejects.toThrow();
  expect(auth.authorizationUrl).toBeDefined();
  const navigation = await fetch(auth.authorizationUrl!, { redirect: 'manual' });
  expect(navigation.status).toBe(302);
  expect(navigation.headers.get('location')).toBe(`https://app.lumbre.pro/integrations/hebra-mcp?request=${requestId}`);
  approved = true;
  const returned = await callback('approved');
  expect(returned.status).toBe(302);
  const code = new URL(returned.headers.get('location')!).searchParams.get('code')!;
  await first.finishAuth(code);
  expect(auth.saved?.access_token).toMatch(/^hmcp_at_/);
  const client = new Client({ name: 'claude-de-prueba', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: auth }));
  clients.push(client);
  return client;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function authorize(challenge: string, ip?: string, oauthClientId = DCR_CLIENT_ID): Promise<Response> {
  const url = new URL(`${app.origin}/authorize`);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: oauthClientId, redirect_uri: CLAUDE_CALLBACK,
    code_challenge_method: 'S256', code_challenge: challenge, scope: 'hebra:mcp', resource: app.config.resourceUrl,
    state: 'estado' })) url.searchParams.set(key, value);
  return fetch(url, { redirect: 'manual', ...(ip ? { headers: { 'x-forwarded-for': ip } } : {}) });
}

function callback(decision: string, id = requestId): Promise<Response> {
  return fetch(`${app.origin}/oauth/lumbre/callback?request=${id}&decision=${decision}`, { redirect: 'manual' });
}

async function token(body: Record<string, string>): Promise<Response> {
  return fetch(`${app.origin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: DCR_CLIENT_ID, ...body }) });
}

function mcpCall(accessToken: string): Promise<Response> {
  return fetch(`${app.origin}/mcp`, { method: 'POST', headers: {
    authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
}

async function approvedCode(): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const start = await authorize(challenge);
  expect(start.status).toBe(302);
  expect(start.headers.get('location')).toBe(`https://app.lumbre.pro/integrations/hebra-mcp?request=${requestId}`);
  approved = true;
  const end = await callback('approved');
  expect(end.status).toBe(302);
  const target = new URL(end.headers.get('location')!);
  expect(`${target.origin}${target.pathname}`).toBe(CLAUDE_CALLBACK);
  expect(target.searchParams.get('state')).toBe('estado');
  expect(target.searchParams.get('iss')).toBe(app.origin);
  return { code: target.searchParams.get('code')!, verifier };
}

async function issuedTokens(): Promise<{ access_token: string; refresh_token: string }> {
  const { code, verifier } = await approvedCode();
  const result = await token({ grant_type: 'authorization_code', code, code_verifier: verifier,
    redirect_uri: CLAUDE_CALLBACK, resource: app.config.resourceUrl });
  expect(result.status).toBe(200);
  return await result.json() as { access_token: string; refresh_token: string };
}

describe('consentimiento y vínculo exacto', () => {
  it('metadata PRM/AS conserva issuer, resource, PKCE, CIMD y DCR', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      expect(await (await fetch(`${app.origin}${path}`)).json()).toMatchObject({
        resource: app.config.resourceUrl, authorization_servers: [app.origin], scopes_supported: ['hebra:mcp']
      });
    }
    expect(await (await fetch(`${app.origin}/.well-known/oauth-authorization-server`)).json()).toMatchObject({
      issuer: app.origin, authorization_endpoint: `${app.origin}/authorize`,
      registration_endpoint: `${app.origin}/register`, code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true
    });
  });

  it('cliente SDK por DCR completa OAuth y accede a una herramienta', async () => {
    const auth = new MemoryOAuthClient();
    const client = await sdkFlow(auth);
    expect(auth.info?.client_id).toBe(DCR_CLIENT_ID);
    const result = await client.callTool({ name: 'hebra_status', arguments: {} }) as CallToolResult;
    expect(JSON.parse(textOf(result))).toMatchObject({ linked: false });
  });

  it('cliente SDK por CIMD descarga documento admitido y lista herramientas', async () => {
    const auth = new MemoryOAuthClient(CIMD_CLIENT_ID);
    const client = await sdkFlow(auth);
    expect(auth.info?.client_id).toBe(CIMD_CLIENT_ID);
    expect(cimdFetch).toHaveBeenCalledWith(CIMD_CLIENT_ID, expect.objectContaining({ redirect: 'manual' }));
    expect((await client.listTools()).tools).toHaveLength(TOOL_NAMES.length);
  });

  it('un cliente, callback o metadata CIMD ajenos no inicia solicitud; logs sin secretos', async () => {
    const challenge = pkce().challenge;
    const evil = new URL(`${app.origin}/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: DCR_CLIENT_ID,
      redirect_uri: 'https://evil.example/callback', code_challenge_method: 'S256', code_challenge: challenge,
      resource: app.config.resourceUrl })) evil.searchParams.set(key, value);
    expect((await fetch(evil, { redirect: 'manual' })).status).toBe(400);
    for (const candidate of ['https://evil.example/client.json', 'https://claude.ai/', 'otro-cliente']) {
      expect((await authorize(challenge, undefined, candidate)).status).toBe(400);
    }
    cimdFetch.mockImplementation(async () => response({ client_id: CIMD_CLIENT_ID,
      redirect_uris: ['https://claude.ai/otro'], token_endpoint_auth_method: 'none' }));
    expect((await authorize(challenge, undefined, CIMD_CLIENT_ID)).status).toBe(400);
    const auth = new MemoryOAuthClient();
    await sdkFlow(auth);
    const logged = (stderrSpy.mock.calls as unknown as [string][]).map(([line]) => String(line)).join('');
    for (const secret of [SECRET, UPSTREAM, transactionId, auth.saved!.access_token, auth.saved!.refresh_token!,
      'estado-de-prueba']) expect(logged).not.toContain(secret);
  });

  it('conecta con PKCE, código de un uso y bearer guardado fuera de metadata', async () => {
    const { code, verifier } = await approvedCode();
    const first = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK });
    expect(first.status).toBe(200);
    expect((await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK })).status).toBe(400);
    const issued = await first.json() as { access_token: string; refresh_token: string };
    await expect(provider.verifyAccessToken(issued.access_token)).resolves.toMatchObject({ clientId: DCR_CLIENT_ID });
    const metadata = await readFile(join(context.dataDir, OAUTH_TOKENS_FILE), 'utf8');
    expect(metadata).not.toContain(UPSTREAM);
    expect(metadata).not.toContain(issued.access_token);
    expect(metadata).not.toContain(issued.refresh_token);
    expect(metadata).toContain('"version":2');
  });

  it('denied falsificado, callback manipulado y transacción equivocada no conceden acceso', async () => {
    const { verifier, challenge } = pkce();
    await authorize(challenge);
    expect((await callback('denied')).status).toBe(400);
    expect((await callback('approved', crypto.randomUUID())).status).toBe(400);
    expect((await fetch(`${app.origin}/oauth/lumbre/callback?request=${requestId}&decision=approved&extra=1`)).status).toBe(400);
    approved = true;
    transactionId = 'otro';
    expect((await callback('approved')).status).toBe(400);
    expect(exchangeCount).toBe(1);
    expect((await token({ grant_type: 'authorization_code', code: 'wrong', code_verifier: verifier })).status).toBe(400);
  });

  it('revocar solo el dispositivo Blob V2 corta access y refresh aunque la credencial siga', async () => {
    const issued = await issuedTokens();
    expect((await mcpCall(issued.access_token)).status).toBe(200);
    deviceActive = false;
    await expect(provider.verifyAccessToken(issued.access_token)).rejects.toThrow();
    expect((await mcpCall(issued.access_token)).status).toBe(401);
    const refresh = await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token });
    expect(refresh.status).toBe(400);
  });

  it('otro dispositivo activo o emparejado sustituido no hereda la familia', async () => {
    const issued = await issuedTokens();
    await store.set('device-identity', JSON.stringify({ opaqueDeviceId: OTHER_DEVICE,
      lumbreDeviceId: '33333333-3333-4333-8333-333333333333' }));
    await expect(provider.verifyAccessToken(issued.access_token)).rejects.toThrow();
    expect((await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token })).status).toBe(400);
  });

  it('un canje con biblioteca, credencial o dispositivo diferente no emite código', async () => {
    for (const change of [
      () => { brokerDevice = OTHER_DEVICE; },
      () => { brokerVault = OTHER_DEVICE; },
      () => { brokerPair = '44444444-4444-4444-8444-444444444444'; }
    ]) {
      await authorize(pkce().challenge);
      approved = true;
      change();
      expect((await callback('approved')).status).toBe(400);
      brokerDevice = DEVICE; brokerVault = VAULT; brokerPair = PAIR_ID;
    }
  });

  it('revocación entre solicitud y canje no emite código', async () => {
    await authorize(pkce().challenge);
    approved = true;
    deviceActive = false;
    expect((await callback('approved')).status).toBe(400);
  });

  it('PKCE erróneo consume código y revoca la concesión upstream', async () => {
    const { code } = await approvedCode();
    const wrong = await token({ grant_type: 'authorization_code', code,
      code_verifier: randomBytes(32).toString('base64url'), redirect_uri: CLAUDE_CALLBACK });
    expect(wrong.status).toBe(400);
    expect(approved).toBe(false);
    expect((await readFile(join(context.dataDir, OAUTH_TOKENS_FILE), 'utf8').catch(() => ''))).not.toContain(UPSTREAM);
  });

  it('refresh rotatorio, replay y revoke local cortan la familia', async () => {
    const issued = await issuedTokens();
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json() as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(issued.refresh_token);
    await provider.revokeToken({ client_id: DCR_CLIENT_ID } as never, { token: next.access_token } as never);
    await expect(provider.verifyAccessToken(issued.access_token)).rejects.toThrow();
    expect(approved).toBe(false);
  });

  it('reinicio conserva familia v2 válida e ignora un fichero v1 antiguo', async () => {
    const issued = await issuedTokens();
    const reopened = await loadOAuthHttpAuth(context.dataDir, app.config, store,
      { backchannelFetch: broker, env: { HEBRA_MCP_BACKCHANNEL_SECRET: SECRET } });
    await expect(reopened!.provider.verifyAccessToken(issued.access_token)).resolves.toMatchObject({ clientId: DCR_CLIENT_ID });
    await writeFile(join(context.dataDir, OAUTH_TOKENS_FILE), JSON.stringify({ version: 1, families: [] }));
    const legacy = await loadOAuthHttpAuth(context.dataDir, app.config, store,
      { backchannelFetch: broker, env: { HEBRA_MCP_BACKCHANNEL_SECRET: SECRET } });
    await expect(legacy!.provider.verifyAccessToken(issued.access_token)).rejects.toThrow();
    expect(await store.get('recovery-code')).toMatch(/^hebra-recovery-v2:/);
  });

  it('reiniciar con un código aún no canjeado revoca su concesión pendiente', async () => {
    await approvedCode();
    expect(approved).toBe(true);
    const reopened = await loadOAuthHttpAuth(context.dataDir, app.config, store,
      { backchannelFetch: broker, env: { HEBRA_MCP_BACKCHANNEL_SECRET: SECRET } });
    expect(reopened).not.toBeNull();
    expect(approved).toBe(false);
    expect(await store.get('hebra-mcp-oauth-pending')).toBe('{}');
  });

  it('fallo de persistencia no entrega tokens y revoca la concesión canjeada', async () => {
    const { code, verifier } = await approvedCode();
    const set = store.set.bind(store);
    vi.spyOn(store, 'set').mockImplementation((key, value) =>
      key === 'hebra-mcp-oauth-grants' ? Promise.reject(new Error('disk full')) : set(key, value));
    const result = await token({ grant_type: 'authorization_code', code, code_verifier: verifier,
      redirect_uri: CLAUDE_CALLBACK });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(approved).toBe(false);
    expect((await readFile(join(context.dataDir, OAUTH_TOKENS_FILE), 'utf8').catch(() => ''))).not.toContain(GRANT_ID);
  });

  it('fallo temporal de introspección rechaza acceso sin revocar la familia', async () => {
    const issued = await issuedTokens();
    available = false;
    await expect(provider.verifyAccessToken(issued.access_token)).rejects.toThrow();
    const outage = await mcpCall(issued.access_token);
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(outage.headers.get('www-authenticate')).toBeNull();
    available = true;
    await expect(provider.verifyAccessToken(issued.access_token)).resolves.toMatchObject({ clientId: DCR_CLIENT_ID });
    expect((await mcpCall(issued.access_token)).status).toBe(200);
  });

  it('dos refresh simultáneos conservan la familia; un replay pasado el margen la corta', async () => {
    const issued = await issuedTokens();
    const [a, b] = await Promise.all([
      token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token }),
      token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token })
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const winner = await (a.status === 200 ? a : b).json() as { access_token: string };
    await expect(provider.verifyAccessToken(winner.access_token)).resolves.toMatchObject({ clientId: DCR_CLIENT_ID });
    clockOffset = 31_000;
    expect((await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token })).status).toBe(400);
    await expect(provider.verifyAccessToken(winner.access_token)).rejects.toThrow();
  });

  it('una IP no desplaza las solicitudes de otra y Origin:null ya no es excepción', async () => {
    for (let index = 0; index < 4; index += 1) expect((await authorize(pkce().challenge, '10.0.0.1')).status).toBe(302);
    expect((await authorize(pkce().challenge, '10.0.0.1')).status).toBe(429);
    expect((await authorize(pkce().challenge, '10.0.0.2')).status).toBe(302);
    expect(requestCount).toBe(5);
    const oldForm = await fetch(`${app.origin}/oauth/consent`, { method: 'POST', headers: { origin: 'null' } });
    expect(oldForm.status).toBe(403);
    expect((await fetch(`${app.origin}/oauth/lumbre/callback?request=${requestId}&decision=approved`,
      { headers: { origin: 'null' } })).status).toBe(403);
  });

  it('revocación global y reinicio rechazan familias anteriores; el emparejado se conserva', async () => {
    const issued = await issuedTokens();
    await revokeAllTokens(context.dataDir, Date.now() + 1);
    await expect(provider.verifyAccessToken(issued.access_token)).rejects.toThrow();
    expect(await store.get('recovery-code')).toMatch(/^hebra-recovery-v2:/);
    const reopened = await loadOAuthHttpAuth(context.dataDir, app.config, store,
      { backchannelFetch: broker, env: { HEBRA_MCP_BACKCHANNEL_SECRET: SECRET } });
    await expect(reopened!.provider.verifyAccessToken(issued.access_token)).rejects.toThrow();
  });

  it('revocar globalmente entre solicitud, código y canje no fabrica una familia nueva', async () => {
    await authorize(pkce().challenge);
    await revokeAllTokens(context.dataDir, Date.now() + 1);
    approved = true;
    expect((await callback('approved')).status).toBe(400);
    expect(exchangeCount).toBe(0);

    const { code, verifier } = await approvedCode();
    await revokeAllTokens(context.dataDir, Date.now() + 2);
    expect((await token({ grant_type: 'authorization_code', code, code_verifier: verifier,
      redirect_uri: CLAUDE_CALLBACK })).status).toBe(400);
    expect((await readFile(join(context.dataDir, OAUTH_TOKENS_FILE), 'utf8').catch(() => ''))).not.toContain(GRANT_ID);
  });

  it('fallo de configuración no permite arrancar el OAuth', async () => {
    expect(await loadOAuthHttpAuth(context.dataDir, app.config, store, { env: {} })).toBeNull();
    expect(await loadOAuthHttpAuth(context.dataDir, app.config, null,
      { env: { HEBRA_MCP_BACKCHANNEL_SECRET: SECRET } })).toBeNull();
  });

  it('un bearer upstream o de otra integración no abre /mcp', async () => {
    const issued = await issuedTokens();
    expect((await mcpCall(UPSTREAM)).status).toBe(401);
    expect((await mcpCall('lmcp_at_' + randomBytes(32).toString('base64url'))).status).toBe(401);
    expect((await mcpCall(issued.access_token)).status).toBe(200);
  });
});
