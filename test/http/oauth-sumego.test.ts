/**
 * Login con Sumego (D20, SPEC.md §12.9) sobre el OAuth público real: discovery, JWKS y
 * `token_endpoint` de Sumego simulados con una clave ES256 generada aquí, y Lumbre con el
 * broker cerrado de siempre. Sin red.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, UnsecuredJWT, type CryptoKey, type JWK } from 'jose';
import { encodeRecoveryCode } from '../../src/hebra';
import { HttpConfigError } from '../../src/http/config';
import { CLAUDE_CALLBACK, DCR_CLIENT_ID, loadOAuthHttpAuth, OAUTH_TOKENS_FILE } from '../../src/oauth';
import { LOGOUT_JTIS_FILE } from '../../src/oauth/logout-jtis';
import type { HebraOAuthProvider } from '../../src/oauth/provider';
import { TokenStore } from '../../src/oauth/token-store';
import type { OidcClientConfig } from '../../src/oauth/login-config';
import { BACKCHANNEL_LOGOUT_EVENT, DISCOVERY_FAILURE_TTL_MS, JWKS_TTL_MS, SumegoOidc } from '../../src/oauth/sumego';
import { MemorySecretStore, writePairedSecrets } from '../../src/secrets';
import { PairingRevocation } from '../../src/status/pairing-revocation';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { startTestHttpApp, type TestHttpApp } from '../fixtures/http-app';

const SECRET = '0123456789abcdef0123456789abcdef';
const CLIENT_SECRET = 'secreto-del-cliente-de-sumego-0123456789';
const LUMBRE_ISSUER = 'https://id.lumbre.pro';
const SUMEGO_ISSUER = 'https://id.sumego.es';
/** Issuer configurado (y el que firma los tokens simulados); cada prueba empieza en el defecto. */
let issuer: string;
const OIDC_CLIENT_ID = 'hebra-mcp';
const PAIR_ID = '11111111-1111-4111-8111-111111111111';
const GRANT_ID = '22222222-2222-4222-8222-222222222222';
const VAULT = 'ab'.repeat(16);
const DEVICE = 'cd'.repeat(16);
const ACCOUNT = '34'.repeat(32);
const UPSTREAM = '56'.repeat(32);
const SUB = 'usuario-sumego-1';
const EMAIL = 'david@example.test';
const KID = 'clave-1';

const json = (value: object, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

let context: TestContext;
let app: TestHttpApp;
let provider: HebraOAuthProvider;
let store: MemorySecretStore;
let pairing: PairingRevocation;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let privateKey: CryptoKey;
let publicJwk: JWK;

// Sumego simulado.
let discoveryCount: number;
let jwksCount: number;
let tokenCalls: Array<{ authorization: string | null; form: URLSearchParams }>;
let sumegoUp: boolean;
let nextIdToken: (() => Promise<string>) | null;
let currentNonce: string;
let currentChallenge: string;
let currentSid: string;
let currentSub: string;
let issuedCodes: Set<string>;
let liveRefresh: Set<string>;
let omitCodeRefresh: boolean;
let refreshCalls: string[];
let refreshResponse: (() => Promise<Response>) | null;
let discoveryResponse: (() => Response) | null;
let jwksResponse: (() => Response) | null;
let codeResponse: (() => Response) | null;
let jwksUp: boolean;
/** Reloj de la app (y de los tokens firmados aquí): `Date.now()` más esto. */
let clockOffset: number;

// Lumbre simulado.
let requestBodies: Array<Record<string, unknown>>;
let exchangeBodies: Array<Record<string, unknown>>;
let requestsResponse: (() => Promise<Response>) | null;
let exchangeResponse: (() => Promise<Response>) | null;
let renewResponse: (() => Promise<Response>) | null;
let renewCount: number;
let grantExpiresAt: string;
let revokeCount: number;
let requestId: string;
let transactionId: string;

function s256(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function nowS(): number { return Math.floor((Date.now() + clockOffset) / 1000); }

function newRefresh(): string {
  const token = `rt-sumego-${randomBytes(18).toString('base64url')}`;
  liveRefresh.add(token);
  return token;
}

async function sumegoFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  expect(url.origin).toBe(issuer);
  expect(init?.redirect).toBe('manual');
  if (!sumegoUp) throw new Error('offline');
  if (url.pathname === '/.well-known/openid-configuration') {
    discoveryCount += 1;
    if (discoveryResponse) return discoveryResponse();
    return json({ issuer: issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`, id_token_signing_alg_values_supported: ['ES256'] });
  }
  if (url.pathname === '/jwks') {
    jwksCount += 1;
    if (!jwksUp) return json({ error: 'down' }, 503);
    if (jwksResponse) return jwksResponse();
    return json({ keys: [publicJwk] });
  }
  if (url.pathname === '/token') {
    const form = new URLSearchParams(String(init?.body));
    const headers = new Headers(init?.headers);
    tokenCalls.push({ authorization: headers.get('authorization'), form });
    if (form.get('grant_type') === 'refresh_token') {
      const presented = form.get('refresh_token')!;
      refreshCalls.push(presented);
      if (refreshResponse) return refreshResponse();
      if (!liveRefresh.delete(presented)) return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'acceso-de-sumego', token_type: 'Bearer', refresh_token: newRefresh(), id_token: 'no-se-usa' });
    }
    if (codeResponse) return codeResponse();
    const code = form.get('code')!;
    if (!issuedCodes.has(code) || s256(form.get('code_verifier')!) !== currentChallenge) return json({ error: 'invalid_grant' }, 400);
    issuedCodes.delete(code);
    return json({ access_token: 'acceso-de-sumego', token_type: 'Bearer', ...(omitCodeRefresh ? {} : { refresh_token: newRefresh() }),
      id_token: await (nextIdToken ?? (() => idToken()))() });
  }
  throw new Error('unexpected sumego route');
}

/** ID token firmado con la clave del JWKS; `undefined` en un claim lo quita. */
async function idToken(overrides: Record<string, unknown> = {}, alg: 'ES256' | 'HS256' | 'none' = 'ES256', kid = KID,
  hsSecret: Uint8Array = new TextEncoder().encode('x'.repeat(32))): Promise<string> {
  const now = nowS();
  const payload: Record<string, unknown> = { iss: issuer, aud: OIDC_CLIENT_ID, sub: currentSub, sid: currentSid, email: EMAIL,
    nonce: currentNonce, iat: now, exp: now + 300, ...overrides };
  for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
  if (alg === 'none') return new UnsecuredJWT(payload).encode();
  if (alg === 'HS256') return new SignJWT(payload).setProtectedHeader({ alg: 'HS256', kid }).sign(hsSecret);
  return new SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid }).sign(privateKey);
}

async function logoutToken(overrides: Record<string, unknown> = {}, alg: 'ES256' | 'HS256' | 'none' = 'ES256', kid = KID,
  hsSecret: Uint8Array = new TextEncoder().encode('x'.repeat(32))): Promise<string> {
  const now = nowS();
  const payload: Record<string, unknown> = { iss: issuer, aud: OIDC_CLIENT_ID, iat: now, exp: now + 120, jti: randomUUID(),
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} }, sid: currentSid, ...overrides };
  for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
  if (alg === 'none') return new UnsecuredJWT(payload).encode();
  if (alg === 'HS256') return new SignJWT(payload).setProtectedHeader({ alg: 'HS256', kid }).sign(hsSecret);
  return new SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid }).sign(privateKey);
}

async function broker(input: string | URL, init?: RequestInit): Promise<Response> {
  expect(String(input).startsWith('https://app.lumbre.pro/api/integrations/hebra-mcp/')).toBe(true);
  expect(init?.headers).toMatchObject({ authorization: `Bearer ${SECRET}` });
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  const path = new URL(String(input)).pathname.replace('/api/integrations/hebra-mcp/', '');
  if (path === 'requests') {
    requestBodies.push(body);
    if (requestsResponse) return requestsResponse();
    requestId = randomUUID();
    transactionId = String(body.transactionId);
    return json({ requestId, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  }
  if (path === 'sumego/exchange') {
    exchangeBodies.push(body);
    if (exchangeResponse) return exchangeResponse();
    expect(Object.keys(body).sort()).toEqual(['clientId', 'idToken', 'requestId', 'resource', 'scope', 'transactionId']);
    if (body.requestId !== requestId || body.transactionId !== transactionId) return json({ code: 'transaction_not_found' }, 404);
    return json({ credentialId: GRANT_ID, accessToken: UPSTREAM, tokenType: 'Bearer', clientId: body.clientId, resource: body.resource,
      scope: 'hebra:mcp', accountId: ACCOUNT, pairedCredentialId: PAIR_ID, syncVaultId: VAULT, opaqueDeviceId: DEVICE,
      expiresAt: grantExpiresAt });
  }
  if (path === 'introspect') {
    return json({ active: true, credentialId: GRANT_ID, clientId: DCR_CLIENT_ID, resource: app.config.resourceUrl, scope: 'hebra:mcp',
      accountId: ACCOUNT, pairedCredentialId: PAIR_ID, syncVaultId: VAULT, opaqueDeviceId: DEVICE, expiresAt: grantExpiresAt });
  }
  if (path === 'renew') {
    renewCount += 1;
    if (renewResponse) return renewResponse();
    grantExpiresAt = new Date(Date.now() + clockOffset + 30 * 86400_000).toISOString();
    return json({ active: true, expiresAt: grantExpiresAt });
  }
  if (path === 'revoke') { revokeCount += 1; return json({ revoked: true }); }
  throw new Error(`unexpected route ${path}`);
}

function sumegoEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { HEBRA_MCP_BACKCHANNEL_SECRET: SECRET, HEBRA_MCP_LOGIN_PROVIDER: 'sumego', HEBRA_MCP_OIDC_ISSUER: issuer,
    HEBRA_MCP_OIDC_CLIENT_ID: OIDC_CLIENT_ID, HEBRA_MCP_OIDC_CLIENT_SECRET: CLIENT_SECRET, ...extra };
}

async function startApp(env: NodeJS.ProcessEnv = sumegoEnv()): Promise<void> {
  app = await startTestHttpApp(context.serverContext, async (config) => {
    const auth = await loadOAuthHttpAuth(context.dataDir, config, store, { backchannelFetch: broker, sumegoFetch, env, pairing,
      now: () => Date.now() + clockOffset });
    if (!auth) throw new Error('auth absent');
    provider = auth.provider;
    return auth;
  });
}

beforeEach(async () => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const keys = await generateKeyPair('ES256');
  privateKey = keys.privateKey;
  publicJwk = { ...(await exportJWK(keys.publicKey)), kid: KID, use: 'sig', alg: 'ES256' };
  context = await buildTestContext();
  store = new MemorySecretStore();
  await writePairedSecrets(store, {
    connection: { credentialId: PAIR_ID, readToken: 'read', writeToken: 'write', apiOrigin: 'https://app.lumbre.pro', connectedAt: new Date().toISOString() },
    recoveryCode: await encodeRecoveryCode({ relayOrigin: 'https://app.lumbre.pro', syncVaultId: VAULT, keyEpoch: 1, vaultKey: randomBytes(32) }),
    device: { opaqueDeviceId: DEVICE, lumbreDeviceId: '33333333-3333-4333-8333-333333333333' }
  });
  pairing = new PairingRevocation();
  discoveryCount = 0; jwksCount = 0; tokenCalls = []; sumegoUp = true; nextIdToken = null;
  currentNonce = ''; currentChallenge = ''; currentSid = 'sesion-a'; currentSub = SUB; issuedCodes = new Set();
  liveRefresh = new Set(); omitCodeRefresh = false; refreshCalls = []; refreshResponse = null; discoveryResponse = null; jwksUp = true; clockOffset = 0;
  jwksResponse = null; codeResponse = null; issuer = LUMBRE_ISSUER;
  requestBodies = []; exchangeBodies = []; requestsResponse = null; exchangeResponse = null; revokeCount = 0;
  renewResponse = null; renewCount = 0; grantExpiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();
  await startApp();
});

afterEach(async () => {
  await app?.close(); await context?.close(); vi.restoreAllMocks();
});

function logged(): string {
  return (stderrSpy.mock.calls as unknown as [string][]).map(([line]) => String(line)).join('');
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: s256(verifier) };
}

async function authorize(challenge: string): Promise<Response> {
  const url = new URL(`${app.origin}/authorize`);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: DCR_CLIENT_ID, redirect_uri: CLAUDE_CALLBACK,
    code_challenge_method: 'S256', code_challenge: challenge, scope: 'hebra:mcp', resource: app.config.resourceUrl,
    state: 'estado' })) url.searchParams.set(key, value);
  return fetch(url, { redirect: 'manual' });
}

interface Login { state: string; cookie: string; code: string; verifier: string }

/** `/authorize` hasta Sumego: el 302, la cookie y un código de Sumego listo para el callback. */
async function startLogin(): Promise<Login> {
  const { verifier, challenge } = pkce();
  const res = await authorize(challenge);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location')!);
  expect(`${location.origin}${location.pathname}`).toBe(`${issuer}/authorize`);
  expect(location.searchParams.get('client_id')).toBe(OIDC_CLIENT_ID);
  expect(location.searchParams.get('redirect_uri')).toBe(`${app.origin}/oauth/sumego/callback`);
  expect(location.searchParams.get('scope')).toBe('openid email');
  expect(location.searchParams.get('code_challenge_method')).toBe('S256');
  const cookieHeader = res.headers.get('set-cookie')!;
  expect(cookieHeader).toMatch(/^__Host-hebra_mcp_login=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  currentNonce = location.searchParams.get('nonce')!;
  currentChallenge = location.searchParams.get('code_challenge')!;
  const last = requestBodies.at(-1)!;
  expect(last.identityProvider).toBe('sumego');
  expect(last.sumegoNonceSha256).toBe(s256(currentNonce));
  const code = randomBytes(24).toString('base64url');
  issuedCodes.add(code);
  return { state: location.searchParams.get('state')!, cookie: `__Host-hebra_mcp_login=${/=([^;]+)/.exec(cookieHeader)![1]}`, code, verifier };
}

function callback(params: Record<string, string>, cookie?: string): Promise<Response> {
  const url = new URL(`${app.origin}/oauth/sumego/callback`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
}

function consent(formToken: string, cookie?: string, origin?: string): Promise<Response> {
  return fetch(`${app.origin}/oauth/sumego/consent`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
    body: new URLSearchParams({ form_token: formToken }) });
}

function formTokenOf(html: string): string {
  return /name="form_token" value="([A-Za-z0-9_-]{43})"/.exec(html)![1]!;
}

/** Hasta la página de consentimiento. */
async function toConsent(login?: Login): Promise<{ login: Login; formToken: string; page: Response; html: string }> {
  const started = login ?? await startLogin();
  const page = await callback({ code: started.code, state: started.state, iss: issuer }, started.cookie);
  const html = await page.text();
  expect(page.status).toBe(200);
  return { login: started, formToken: formTokenOf(html), page, html };
}

/** Recorrido completo hasta los tokens de Hebra. */
async function fullLogin(): Promise<{ access_token: string; refresh_token: string }> {
  const { login, formToken } = await toConsent();
  const approved = await consent(formToken, login.cookie);
  expect(approved.status).toBe(302);
  const target = new URL(approved.headers.get('location')!);
  expect(`${target.origin}${target.pathname}`).toBe(CLAUDE_CALLBACK);
  expect(target.searchParams.get('state')).toBe('estado');
  expect(target.searchParams.get('iss')).toBe(app.origin);
  const result = await fetch(`${app.origin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: DCR_CLIENT_ID, grant_type: 'authorization_code', code: target.searchParams.get('code')!,
      code_verifier: login.verifier, redirect_uri: CLAUDE_CALLBACK, resource: app.config.resourceUrl }) });
  expect(result.status).toBe(200);
  return await result.json() as { access_token: string; refresh_token: string };
}

async function families(): Promise<Array<{ sub: string | null; sid: string | null }>> {
  const saved = JSON.parse(await readFile(join(context.dataDir, OAUTH_TOKENS_FILE), 'utf8')) as { version: number; families: Array<{ sub: string | null; sid: string | null }> };
  expect(saved.version).toBe(3);
  return saved.families;
}

function logout(token: string): Promise<Response> {
  return fetch(`${app.origin}/oauth/sumego/backchannel-logout`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ logout_token: token }) });
}

describe('recorrido con Sumego', () => {
  it('authorize → Sumego → consentimiento → código OAuth → familia con sub y sid', async () => {
    const { login, formToken, page, html } = await toConsent();
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('content-security-policy')).toBe(`default-src 'none'; form-action 'self' ${CLAUDE_CALLBACK}; style-src 'unsafe-inline'`);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    expect(html).toContain('<meta name="referrer" content="same-origin">');
    expect(html).toContain(EMAIL);
    expect(html).toContain('hebra:mcp');
    expect(html).toContain('>Permitir<');
    const call = tokenCalls.at(-1)!;
    expect(call.authorization).toBe(`Basic ${Buffer.from(`${OIDC_CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
    expect(call.form.get('grant_type')).toBe('authorization_code');
    expect(call.form.get('redirect_uri')).toBe(`${app.origin}/oauth/sumego/callback`);
    expect(s256(call.form.get('code_verifier')!)).toBe(currentChallenge);

    const approved = await consent(formToken, login.cookie);
    expect(approved.status).toBe(302);
    expect(approved.headers.get('set-cookie')).toContain('Max-Age=0');
    const exchange = exchangeBodies.at(-1)!;
    expect(exchange).toMatchObject({ requestId, transactionId, clientId: DCR_CLIENT_ID, resource: app.config.resourceUrl, scope: 'hebra:mcp' });
    expect(typeof exchange.idToken).toBe('string');
    const target = new URL(approved.headers.get('location')!);
    const result = await fetch(`${app.origin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DCR_CLIENT_ID, grant_type: 'authorization_code', code: target.searchParams.get('code')!,
        code_verifier: login.verifier, redirect_uri: CLAUDE_CALLBACK, resource: app.config.resourceUrl }) });
    expect(result.status).toBe(200);
    expect(await families()).toEqual([expect.objectContaining({ sub: SUB, sid: 'sesion-a' })]);
    // La discovery se reutiliza de la caché.
    expect(discoveryCount).toBe(1);
  });

  it('410 pairing_revoked en /requests: página de reemparejar, sin cookie ni redirección', async () => {
    requestsResponse = async () => json({ error: 'pairing_revoked' }, 410);
    const res = await authorize(pkce().challenge);
    expect(res.status).toBe(503);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('hebra-mcp pair');
    expect(pairing.isRevoked(PAIR_ID)).toBe(true);
  });

  it('400 en /requests no es una revocación: 503 JSON', async () => {
    requestsResponse = async () => json({ error: 'invalid_request' }, 400);
    const res = await authorize(pkce().challenge);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(pairing.isRevoked()).toBe(false);
  });

  it('/requests con authorizationUrl de más: fuera de contrato, 503', async () => {
    requestsResponse = async () => json({ requestId: randomUUID(), authorizationUrl: 'https://app.lumbre.pro/x',
      expiresAt: new Date(Date.now() + 600_000).toISOString() });
    expect((await authorize(pkce().challenge)).status).toBe(503);
  });

  it('el callback de Lumbre no cierra una solicitud de Sumego', async () => {
    await startLogin();
    const res = await fetch(`${app.origin}/oauth/lumbre/callback?request=${requestId}&decision=approved`, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(exchangeBodies).toHaveLength(0);
  });
});

describe('ID token', () => {
  const cases: Array<[string, () => Promise<string>]> = [
    ['aud malo', () => idToken({ aud: 'otro-cliente' })],
    ['iss malo', () => idToken({ iss: 'https://otro.example.test' })],
    ['nonce malo', () => idToken({ nonce: 'otro-nonce' })],
    ['sin nonce', () => idToken({ nonce: undefined })],
    ['exp pasado', () => idToken({ exp: Math.floor(Date.now() / 1000) - 120 })],
    ['iat de hace más de 6 min', () => idToken({ iat: Math.floor(Date.now() / 1000) - 400, exp: Math.floor(Date.now() / 1000) + 300 })],
    ['sin sub', () => idToken({ sub: undefined })],
    ['sin sid', () => idToken({ sid: undefined })],
    ['HS256 firmado con la JWK pública como secreto', () => idToken({}, 'HS256', KID, new TextEncoder().encode(JSON.stringify(publicJwk)))],
    ['azp de otro cliente', () => idToken({ azp: 'otro-cliente' })],
    ['firma HS256', () => idToken({}, 'HS256')],
    ['alg none', () => idToken({}, 'none')],
    ['kid que no está en el JWKS', () => idToken({}, 'ES256', 'otra-clave')]
  ];
  for (const [name, make] of cases) {
    it(`${name}: 400 sin consentimiento ni canje en Lumbre`, async () => {
      nextIdToken = make;
      const login = await startLogin();
      const res = await callback({ code: login.code, state: login.state, iss: issuer }, login.cookie);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('Acceso denegado');
      expect(res.headers.get('location')).toBeNull();
      expect(exchangeBodies).toHaveLength(0);
      // La solicitud se descartó: el mismo state ya no vale.
      expect((await callback({ code: login.code, state: login.state, iss: issuer }, login.cookie)).status).toBe(400);
    });
  }

  it('Sumego caído al canjear: «no disponible»', async () => {
    const login = await startLogin();
    sumegoUp = false;
    const res = await callback({ code: login.code, state: login.state, iss: issuer }, login.cookie);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('No disponible');
  });
});

describe('state, cookie e iss', () => {
  it('sin cookie: 400 y la solicitud sigue viva para su navegador', async () => {
    const login = await startLogin();
    expect((await callback({ code: login.code, state: login.state, iss: issuer })).status).toBe(400);
    expect(tokenCalls).toHaveLength(0);
    await toConsent(login);
  });

  it('con la cookie de otra solicitud: 400', async () => {
    const first = await startLogin();
    const second = await startLogin();
    expect((await callback({ code: first.code, state: first.state, iss: issuer }, second.cookie)).status).toBe(400);
    expect(tokenCalls).toHaveLength(0);
  });

  it('iss ausente o distinto: 400 y la solicitud se descarta', async () => {
    const first = await startLogin();
    expect((await callback({ code: first.code, state: first.state }, first.cookie)).status).toBe(400);
    expect((await callback({ code: first.code, state: first.state, iss: issuer }, first.cookie)).status).toBe(400);
    const second = await startLogin();
    expect((await callback({ code: second.code, state: second.state, iss: `${issuer}/` }, second.cookie)).status).toBe(400);
    expect(tokenCalls).toHaveLength(0);
  });

  it('reutilizar el state: el segundo callback es 400', async () => {
    const { login } = await toConsent();
    issuedCodes.add(login.code);
    expect((await callback({ code: login.code, state: login.state, iss: issuer }, login.cookie)).status).toBe(400);
    expect(tokenCalls).toHaveLength(1);
  });

  it('error= de Sumego: 400 sin redirigir y la solicitud se descarta', async () => {
    const login = await startLogin();
    const res = await callback({ error: 'access_denied', state: login.state, iss: issuer }, login.cookie);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect((await callback({ code: login.code, state: login.state, iss: issuer }, login.cookie)).status).toBe(400);
  });
});

describe('consentimiento', () => {
  it('el token de formulario es de un uso y exige la cookie', async () => {
    const { login, formToken } = await toConsent();
    expect((await consent(formToken)).status).toBe(400);
    expect((await consent(randomBytes(32).toString('base64url'), login.cookie)).status).toBe(400);
    expect(exchangeBodies).toHaveLength(0);
    expect((await consent(formToken, login.cookie)).status).toBe(302);
    expect((await consent(formToken, login.cookie)).status).toBe(400);
    expect(exchangeBodies).toHaveLength(1);
  });

  const denied: Array<[number, object]> = [
    [400, { code: 'invalid_token' }], [400, { code: 'unknown_account' }], [400, { error: 'invalid_request' }],
    [403, { code: 'account_pending' }], [403, { code: 'account_suspended' }], [403, { error: 'account_rejected' }],
    [404, { code: 'transaction_not_found' }], [409, { code: 'token_reused' }]
  ];
  for (const [status, body] of denied) {
    it(`Lumbre ${status} ${JSON.stringify(body)}: «acceso denegado», sin código`, async () => {
      exchangeResponse = async () => json(body, status);
      const { login, formToken } = await toConsent();
      const res = await consent(formToken, login.cookie);
      expect(res.status).toBe(403);
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).toContain('Acceso denegado');
      expect(pairing.isRevoked()).toBe(false);
    });
  }

  const unavailable: Array<[string, () => Promise<Response>]> = [
    ['401', async () => json({ error: 'unauthorized' }, 401)],
    ['413', async () => json({ error: 'too_large' }, 413)],
    ['503 sumego_unavailable', async () => json({ code: 'sumego_unavailable' }, 503)],
    ['500', async () => json({ error: 'x' }, 500)],
    ['429', async () => json({ error: 'rate_limited' }, 429)],
    ['410 sin pairing_revoked', async () => json({ error: 'gone' }, 410)],
    ['red', async () => { throw new Error('offline'); }],
    ['200 fuera de contrato', async () => json({ credentialId: GRANT_ID })]
  ];
  for (const [name, make] of unavailable) {
    it(`Lumbre ${name}: «no disponible», sin código`, async () => {
      exchangeResponse = make;
      const { login, formToken } = await toConsent();
      const res = await consent(formToken, login.cookie);
      expect(res.status).toBe(503);
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).toContain('No disponible');
      expect(pairing.isRevoked()).toBe(false);
      if (name === '401') expect(logged()).toContain('"event":"oauth.sumego.exchange","result":"unauthorized"');
    });
  }

  it('Lumbre 410 pairing_revoked en el canje: página de reemparejar y revoked', async () => {
    exchangeResponse = async () => json({ error: 'pairing_revoked', code: 'pairing_revoked' }, 410, { 'cache-control': 'no-store' });
    const { login, formToken } = await toConsent();
    const res = await consent(formToken, login.cookie);
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toContain('hebra-mcp pair');
    expect(pairing.isRevoked(PAIR_ID)).toBe(true);
    expect(logged().match(/"event":"pairing.revoked"/g)).toHaveLength(1);
  });
});

describe('back-channel logout', () => {
  it('por sid corta solo esa sesión; por sub, todas las suyas', async () => {
    await fullLogin();
    currentSid = 'sesion-b';
    await fullLogin();
    currentSub = 'otra-persona'; currentSid = 'sesion-c';
    await fullLogin();
    expect((await families()).map((family) => family.sid)).toEqual(['sesion-a', 'sesion-b', 'sesion-c']);

    const bySid = await logout(await logoutToken({ sid: 'sesion-a', sub: SUB }));
    expect(bySid.status).toBe(200);
    expect(await bySid.text()).toBe('');
    expect((await families()).map((family) => family.sid)).toEqual(['sesion-b', 'sesion-c']);
    expect(revokeCount).toBe(1);

    const bySub = await logout(await logoutToken({ sid: undefined, sub: SUB }));
    expect(bySub.status).toBe(200);
    expect((await families()).map((family) => family.sid)).toEqual(['sesion-c']);
    expect(revokeCount).toBe(2);
  });

  it('un sid de otro sub no corta nada', async () => {
    await fullLogin();
    expect((await logout(await logoutToken({ sid: 'sesion-a', sub: 'otra-persona' }))).status).toBe(200);
    expect(await families()).toHaveLength(1);
  });

  const invalid: Array<[string, () => Promise<string>]> = [
    ['con nonce', () => logoutToken({ nonce: 'n' })],
    ['sin events', () => logoutToken({ events: undefined })],
    ['events sin el de logout', () => logoutToken({ events: { 'http://otro': {} } })],
    ['sin sid ni sub', () => logoutToken({ sid: undefined, sub: undefined })],
    ['sin exp', () => logoutToken({ exp: undefined })],
    ['sin jti', () => logoutToken({ jti: undefined })],
    ['iat de hace 12 min', () => logoutToken({ iat: Math.floor(Date.now() / 1000) - 720, exp: Math.floor(Date.now() / 1000) + 60 })],
    ['aud de otro cliente', () => logoutToken({ aud: 'otro-cliente' })],
    ['HS256', () => logoutToken({}, 'HS256')],
    ['alg none', () => logoutToken({}, 'none')]
  ];
  for (const [name, make] of invalid) {
    it(`logout_token ${name}: 400`, async () => {
      await fullLogin();
      const res = await logout(await make());
      expect(res.status).toBe(400);
      expect(await families()).toHaveLength(1);
    });
  }

  it('un jti repetido es 400 y queda en oauth-logout-jtis.json', async () => {
    await fullLogin();
    const token = await logoutToken();
    expect((await logout(token)).status).toBe(200);
    expect((await logout(token)).status).toBe(400);
    const saved = JSON.parse(await readFile(join(context.dataDir, LOGOUT_JTIS_FILE), 'utf8')) as { version: number; jtis: unknown[] };
    expect(saved.version).toBe(1);
    expect(saved.jtis).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain(token);
  });

  it('si el corte local falla, 500 y el jti no se consume: el reintento vale', async () => {
    await fullLogin();
    const spy = vi.spyOn(provider, 'revokeByLogout').mockRejectedValueOnce(new Error('disco'));
    const token = await logoutToken();
    expect((await logout(token)).status).toBe(500);
    expect(await families()).toHaveLength(1);
    spy.mockRestore();
    expect((await logout(token)).status).toBe(200);
    expect(await families()).toHaveLength(0);
  });

  it('más de 60 por minuto desde la misma dirección: 429', async () => {
    const token = 'no-es-un-jwt';
    for (let index = 0; index < 60; index += 1) expect((await logout(token)).status).toBe(400);
    expect((await logout(token)).status).toBe(429);
  });

  it('funciona con el interruptor en lumbre si hay cliente', async () => {
    await app.close();
    await startApp(sumegoEnv({ HEBRA_MCP_LOGIN_PROVIDER: 'lumbre' }));
    expect((await logout(await logoutToken())).status).toBe(200);
    expect((await fetch(`${app.origin}/oauth/sumego/callback?state=x&code=y&iss=${issuer}`)).status).toBe(404);
  });
});

describe('logs sin secretos', () => {
  it('ni code, ni ID token, ni logout_token, ni code_verifier, ni el secreto del cliente', async () => {
    let lastIdToken = '';
    nextIdToken = async () => { lastIdToken = await idToken(); return lastIdToken; };
    const { login, formToken } = await toConsent();
    const approved = await consent(formToken, login.cookie);
    const oauthCode = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const logoutJwt = await logoutToken();
    await logout(logoutJwt);
    const text = logged();
    for (const secret of [login.code, lastIdToken, logoutJwt, login.state, currentNonce, CLIENT_SECRET, SECRET, oauthCode, formToken,
      tokenCalls[0]!.form.get('code_verifier')!, login.cookie.split('=')[1]!, UPSTREAM, ...liveRefresh]) {
      expect(secret.length).toBeGreaterThan(0);
      expect(text).not.toContain(secret);
    }
  });
});

describe('discovery', () => {
  it('un fallo se recuerda 30 s: /authorize da 503 sin volver a pedirla ni registrar en Lumbre', async () => {
    let offset = 0;
    await app.close();
    app = await startTestHttpApp(context.serverContext, async (config) => {
      const auth = await loadOAuthHttpAuth(context.dataDir, config, store, { backchannelFetch: broker, sumegoFetch,
        env: sumegoEnv(), pairing, now: () => Date.now() + offset });
      provider = auth!.provider;
      return auth!;
    });
    sumegoUp = false;
    expect((await authorize(pkce().challenge)).status).toBe(503);
    sumegoUp = true;
    expect((await authorize(pkce().challenge)).status).toBe(503);
    expect(discoveryCount).toBe(0);
    expect(requestBodies).toHaveLength(0);
    offset = DISCOVERY_FAILURE_TTL_MS;
    expect((await authorize(pkce().challenge)).status).toBe(302);
    expect(discoveryCount).toBe(1);
  });
});

describe('configuración', () => {
  const broken: Array<[string, Record<string, string | undefined>]> = [
    ['HEBRA_MCP_OIDC_CLIENT_SECRET', { HEBRA_MCP_OIDC_CLIENT_SECRET: undefined }],
    ['HEBRA_MCP_OIDC_CLIENT_SECRET', { HEBRA_MCP_OIDC_CLIENT_SECRET: 'corto' }],
    ['HEBRA_MCP_OIDC_CLIENT_SECRET', { HEBRA_MCP_OIDC_CLIENT_SECRET: `${CLIENT_SECRET}\n` }],
    ['HEBRA_MCP_OIDC_ISSUER', { HEBRA_MCP_OIDC_ISSUER: 'http://id.example.test' }],
    ['HEBRA_MCP_OIDC_ISSUER', { HEBRA_MCP_OIDC_ISSUER: 'https://id.example.test' }],
    ['HEBRA_MCP_OIDC_ISSUER', { HEBRA_MCP_OIDC_ISSUER: 'https://id.sumego.es/' }],
    ['HEBRA_MCP_OIDC_ISSUER', { HEBRA_MCP_OIDC_ISSUER: 'https://x.id.sumego.es' }],
    ['HEBRA_MCP_OIDC_CLIENT_ID', { HEBRA_MCP_OIDC_CLIENT_ID: 'con espacio' }],
    ['HEBRA_MCP_LOGIN_PROVIDER', { HEBRA_MCP_LOGIN_PROVIDER: 'Sumego' }]
  ];
  for (const [variable, change] of broken) {
    it(`${variable} inválida: no arranca y no vuelve a lumbre`, async () => {
      const env = sumegoEnv();
      for (const [key, value] of Object.entries(change)) { if (value === undefined) delete env[key]; else env[key] = value; }
      const failure = await loadOAuthHttpAuth(context.dataDir, app.config, store, { backchannelFetch: broker, sumegoFetch, env }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(HttpConfigError);
      expect((failure as HttpConfigError).variable).toBe(variable);
      expect(String((failure as Error).message)).not.toContain(CLIENT_SECRET);
    });
  }
});

function refresh(refreshToken: string): Promise<Response> {
  return fetch(`${app.origin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: DCR_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken,
      resource: app.config.resourceUrl }) });
}

async function savedFamilies(): Promise<Array<Record<string, unknown>>> {
  return (JSON.parse(await readFile(join(context.dataDir, OAUTH_TOKENS_FILE), 'utf8')) as { families: Array<Record<string, unknown>> }).families;
}

const HOUR = 60 * 60_000;

describe('renovación horaria con Sumego (M1)', () => {
  it('el refresh de Sumego se guarda cifrado y solo se renueva pasada 1 h; el rotado va con el de Hebra', async () => {
    const first = await fullLogin();
    const loginRefresh = [...liveRefresh][0]!;
    const [family] = await savedFamilies();
    expect(typeof family!.sumegoRefresh).toBe('string');
    expect(JSON.stringify(await savedFamilies())).not.toContain(loginRefresh);
    expect(await store.get('hebra-mcp-sumego-refresh-key')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Antes de 1 h: sin llamar a Sumego.
    clockOffset = 30 * 60_000;
    const early = await refresh(first.refresh_token);
    expect(early.status).toBe(200);
    expect(refreshCalls).toEqual([]);

    // Pasada 1 h desde el login: renueva con el refresh guardado y client_secret_basic.
    clockOffset = HOUR + 60_000;
    const second = await early.json() as { refresh_token: string };
    const renewed = await refresh(second.refresh_token);
    expect(renewed.status).toBe(200);
    expect(refreshCalls).toEqual([loginRefresh]);
    expect(tokenCalls.at(-1)!.authorization).toBe(`Basic ${Buffer.from(`${OIDC_CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
    const rotated = [...liveRefresh][0]!;
    expect(rotated).not.toBe(loginRefresh);
    expect(JSON.stringify(await savedFamilies())).not.toContain(rotated);
    expect((await savedFamilies())[0]!.sumegoRenewedAt).toBeGreaterThan(Date.now() + HOUR);

    // La siguiente renovación usa el rotado.
    clockOffset = 2 * HOUR + 120_000;
    const third = await renewed.json() as { refresh_token: string };
    expect((await refresh(third.refresh_token)).status).toBe(200);
    expect(refreshCalls).toEqual([loginRefresh, rotated]);
  });

  it('un 4xx de Sumego corta la familia como active:false, sin llamar a /renew', async () => {
    const tokens = await fullLogin();
    refreshResponse = async () => json({ error: 'invalid_grant' }, 400);
    clockOffset = HOUR + 1;
    const res = await refresh(tokens.refresh_token);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
    expect(renewCount).toBe(0);
    expect(await savedFamilies()).toHaveLength(0);
    expect(revokeCount).toBe(1);
  });

  for (const [name, make] of [
    ['red', async () => { throw new Error('offline'); }],
    ['503', async () => json({ error: 'x' }, 503)],
    ['429', async () => json({ error: 'slow_down' }, 429)],
    ['308 (no se sigue)', async () => new Response(null, { status: 308, headers: { location: `${SUMEGO_ISSUER}/token` } })]
  ] as Array<[string, () => Promise<Response>]>) {
    it(`Sumego ${name}: error temporal y la familia sigue; el reintento vale`, async () => {
      const tokens = await fullLogin();
      refreshResponse = make;
      clockOffset = HOUR + 1;
      expect((await refresh(tokens.refresh_token)).status).toBe(500);
      expect(renewCount).toBe(0);
      expect(await savedFamilies()).toHaveLength(1);
      refreshResponse = null;
      expect((await refresh(tokens.refresh_token)).status).toBe(200);
    });
  }

  it('Sumego rota pero /renew falla: el reintento usa el refresh nuevo, no el ya gastado', async () => {
    const tokens = await fullLogin();
    const loginRefresh = [...liveRefresh][0]!;
    renewResponse = async () => json({ error: 'x' }, 503);
    clockOffset = HOUR + 1;
    expect((await refresh(tokens.refresh_token)).status).toBe(500);
    const rotated = [...liveRefresh][0]!;
    expect(refreshCalls).toEqual([loginRefresh]);
    renewResponse = null;
    const retry = await refresh(tokens.refresh_token);
    expect(retry.status).toBe(200);
    // No volvió a Sumego (renovado hace nada) y el rotado quedó guardado.
    expect(refreshCalls).toEqual([loginRefresh]);
    clockOffset = 2 * HOUR + 10;
    const next = await retry.json() as { refresh_token: string };
    expect((await refresh(next.refresh_token)).status).toBe(200);
    expect(refreshCalls).toEqual([loginRefresh, rotated]);
  });

  it('sin refresh de Sumego en el canje del código: login denegado', async () => {
    omitCodeRefresh = true;
    const login = await startLogin();
    const res = await callback({ code: login.code, state: login.state, iss: issuer }, login.cookie);
    expect(res.status).toBe(400);
    expect(exchangeBodies).toHaveLength(0);
  });
});

describe('consentimiento y vida del ID token (M2)', () => {
  it('pasado iat + 5 min − 30 s, el «Permitir» da «no disponible» y no canjea', async () => {
    const { login, formToken } = await toConsent();
    clockOffset = 271_000;
    const res = await consent(formToken, login.cookie);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('No disponible');
    expect(html).toContain('Vuelve a conectar');
    expect(exchangeBodies).toHaveLength(0);
  });

  it('un ID token que ya no llega a tiempo da «no disponible» en el callback', async () => {
    nextIdToken = () => idToken({ iat: nowS() - 280 });
    const login = await startLogin();
    const res = await callback({ code: login.code, state: login.state, iss: issuer }, login.cookie);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Vuelve a conectar');
  });
});

describe('logout con conexiones en vuelo', () => {
  it('durante el consentimiento: el «Permitir» se rechaza y no canjea', async () => {
    const { login, formToken } = await toConsent();
    expect((await logout(await logoutToken({ sid: undefined, sub: SUB }))).status).toBe(200);
    expect((await consent(formToken, login.cookie)).status).toBe(400);
    expect(exchangeBodies).toHaveLength(0);
  });

  it('con el código emitido sin canjear: invalid_grant y la concesión se revoca', async () => {
    const { login, formToken } = await toConsent();
    const approved = await consent(formToken, login.cookie);
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    expect((await logout(await logoutToken({ sid: 'sesion-a' }))).status).toBe(200);
    expect(revokeCount).toBe(1);
    const res = await fetch(`${app.origin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DCR_CLIENT_ID, grant_type: 'authorization_code', code, code_verifier: login.verifier,
        redirect_uri: CLAUDE_CALLBACK, resource: app.config.resourceUrl }) });
    expect(res.status).toBe(400);
    expect(await families()).toHaveLength(0);
  });

  it('issueFamily rechaza una identidad cerrada dentro de su escritura (logout entre el canje y la familia)', async () => {
    const tokens = await TokenStore.open(context.dataDir);
    const grant = { credentialId: GRANT_ID, clientId: DCR_CLIENT_ID, resource: 'https://mcp.hebra.pro/mcp', scope: 'hebra:mcp',
      accountId: ACCOUNT, pairedCredentialId: PAIR_ID, syncVaultId: VAULT, opaqueDeviceId: DEVICE,
      expiresAt: new Date(Date.now() + 86400_000).toISOString(), active: true as const };
    let closed = false;
    // Una escritura ocupa la cola; la emisión entra detrás y el logout se apunta mientras espera.
    const busy = tokens.dropFamiliesByLogout({ sub: 'nadie' });
    const issued = tokens.issueFamily({ clientId: DCR_CLIENT_ID, scope: 'hebra:mcp', resource: grant.resource, grant,
      authorizedAt: Date.now(), identity: { sub: SUB, sid: 'sesion-a' }, loggedOut: () => closed }, 0, async () => {});
    closed = true;
    await busy;
    await expect(issued).rejects.toThrow('logged_out');
    expect(tokens.liveFamilyCount(0)).toBe(0);
  });

  it('un login nuevo después de cerrar por sub no queda bloqueado', async () => {
    expect((await logout(await logoutToken({ sid: undefined, sub: SUB, iat: nowS() - 5 }))).status).toBe(200);
    await fullLogin();
    expect(await families()).toHaveLength(1);
  });
});

describe('cookie de login', () => {
  it('sin cookie o con otra no se toca; al quemar la transacción se borra', async () => {
    const login = await startLogin();
    const foreign = await callback({ code: login.code, state: login.state, iss: issuer }, '__Host-hebra_mcp_login=otra');
    expect(foreign.headers.get('set-cookie')).toBeNull();
    const unknown = await callback({ code: login.code, state: 'desconocido', iss: issuer }, login.cookie);
    expect(unknown.headers.get('set-cookie')).toBeNull();
    const burned = await callback({ code: login.code, state: login.state, iss: 'https://otro.example.test' }, login.cookie);
    expect(burned.status).toBe(400);
    expect(burned.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('un «Permitir» sin la cookie no la borra ni quema la transacción', async () => {
    const { login, formToken } = await toConsent();
    const res = await consent(formToken);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await consent(formToken, login.cookie)).status).toBe(302);
  });
});

describe('Origin del «Permitir» (A1)', () => {
  it('con Origin del host público pasa; con Origin: null, 403', async () => {
    const first = await toConsent();
    expect((await consent(first.formToken, first.login.cookie, app.origin)).status).toBe(302);
    const second = await toConsent();
    expect((await consent(second.formToken, second.login.cookie, 'null')).status).toBe(403);
  });
});

describe('JWKS y discovery', () => {
  it('un fallo del JWKS se recuerda 30 s, también para un kid desconocido', async () => {
    await fullLogin();
    const base = jwksCount;
    jwksUp = false;
    clockOffset = 31_000;
    expect((await logout(await logoutToken({}, 'ES256', 'otra-clave'))).status).toBe(503);
    expect(jwksCount).toBe(base + 1);
    jwksUp = true;
    expect((await logout(await logoutToken({}, 'ES256', 'otra-clave'))).status).toBe(503);
    expect(jwksCount).toBe(base + 1);
    clockOffset = 62_000;
    expect((await logout(await logoutToken({}, 'ES256', 'otra-clave'))).status).toBe(400);
    expect(jwksCount).toBe(base + 2);
  });

  it('kid desconocido: una nueva descarga cada 30 s como mucho, y el logout_token es 400', async () => {
    await fullLogin();
    const base = jwksCount;
    clockOffset = 31_000;
    expect((await logout(await logoutToken({}, 'ES256', 'otra-clave'))).status).toBe(400);
    expect((await logout(await logoutToken({}, 'ES256', 'otra-clave'))).status).toBe(400);
    expect(jwksCount).toBe(base + 1);
    clockOffset = 62_000;
    expect((await logout(await logoutToken({}, 'ES256', 'otra-clave'))).status).toBe(400);
    expect(jwksCount).toBe(base + 2);
  });

  it('logout_token HS256 firmado con la JWK pública: 400', async () => {
    await fullLogin();
    const res = await logout(await logoutToken({}, 'HS256', KID, new TextEncoder().encode(JSON.stringify(publicJwk))));
    expect(res.status).toBe(400);
    expect(await families()).toHaveLength(1);
  });

  const broken: Array<[string, () => Response]> = [
    ['endpoints de otro origen', () => json({ issuer: issuer, authorization_endpoint: 'https://evil.example.test/authorize',
      token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` })],
    ['jwks_uri de otro origen', () => json({ issuer: issuer, authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`, jwks_uri: 'https://evil.example.test/jwks' })],
    ['una redirección (no se sigue)', () => new Response(null, { status: 302, headers: { location: 'https://evil.example.test/conf' } })],
    ['más de 64 KiB', () => json({ issuer: issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`, relleno: 'x'.repeat(70_000) })]
  ];
  for (const [name, make] of broken) {
    it(`discovery con ${name}: /authorize 503 sin redirigir`, async () => {
      discoveryResponse = make;
      const res = await authorize(pkce().challenge);
      expect(res.status).toBe(503);
      expect(res.headers.get('location')).toBeNull();
      expect(requestBodies).toHaveLength(0);
    });
  }
});

describe('jti (B1) y entregas simultáneas', () => {
  it('un token aceptado en exp + 30 s no se puede repetir', async () => {
    await fullLogin();
    const token = await logoutToken({ exp: nowS() + 10 });
    clockOffset = 40_000;
    expect((await logout(token)).status).toBe(200);
    clockOffset = 45_000;
    expect((await logout(token)).status).toBe(400);
  });

  it('dos POST simultáneos con el mismo jti: uno 200 y otro 400', async () => {
    await fullLogin();
    const token = await logoutToken();
    const statuses = (await Promise.all([logout(token), logout(token)])).map((res) => res.status).sort();
    expect(statuses).toEqual([200, 400]);
  });

  it('con el cupo de fallos agotado, un logout_token válido sigue pasando', async () => {
    await fullLogin();
    for (let index = 0; index < 60; index += 1) expect((await logout('no-es-un-jwt')).status).toBe(400);
    expect((await logout('no-es-un-jwt')).status).toBe(429);
    expect((await logout(await logoutToken({ sid: undefined, sub: SUB }))).status).toBe(200);
    expect(await families()).toHaveLength(0);
  });
});

/** Cierra la app y la vuelve a abrir con otro issuer, sobre el mismo directorio de datos. */
async function restartWith(next: string): Promise<void> {
  await app.close();
  issuer = next;
  await startApp();
}

// Transición de Sumego (§13.6 de su SPEC): los dos issuers valen como configuración, pero el
// servidor solo acepta el configurado. `sumegoFetch` comprueba además que toda llamada de
// servidor a servidor (discovery, JWKS, token) va a su origen y con `redirect: 'manual'`.
describe.each([
  [LUMBRE_ISSUER, SUMEGO_ISSUER],
  [SUMEGO_ISSUER, LUMBRE_ISSUER]
])('con %s configurado', (configured, other) => {
  beforeEach(async () => { await restartWith(configured); });

  it('recorrido completo: URL de autorización, discovery, callback con iss, ID token y logout_token', async () => {
    await fullLogin();
    expect(discoveryCount).toBe(1);
    expect(jwksCount).toBe(1);
    expect(tokenCalls).toHaveLength(1);
    expect(await families()).toEqual([expect.objectContaining({ sub: SUB, sid: 'sesion-a' })]);
    expect((await logout(await logoutToken())).status).toBe(200);
    expect(await families()).toHaveLength(0);
  });

  it(`callback con iss=${other}: 400 sin canjear y la solicitud se descarta`, async () => {
    const login = await startLogin();
    const res = await callback({ code: login.code, state: login.state, iss: other }, login.cookie);
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await callback({ code: login.code, state: login.state, iss: configured }, login.cookie)).status).toBe(400);
    expect(tokenCalls).toHaveLength(0);
  });

  it(`ID token con iss ${other}: 400 sin consentimiento ni canje en Lumbre`, async () => {
    nextIdToken = () => idToken({ iss: other });
    const login = await startLogin();
    const res = await callback({ code: login.code, state: login.state, iss: configured }, login.cookie);
    expect(res.status).toBe(400);
    expect(exchangeBodies).toHaveLength(0);
  });

  it(`logout_token con iss ${other}: 400 por sid y por sub, y la familia sigue`, async () => {
    await fullLogin();
    expect((await logout(await logoutToken({ iss: other }))).status).toBe(400);
    expect((await logout(await logoutToken({ iss: other, sid: undefined, sub: SUB }))).status).toBe(400);
    expect(await families()).toHaveLength(1);
  });

  it(`discovery que anuncia ${other} como issuer o como origen de los endpoints: /authorize 503`, async () => {
    discoveryResponse = () => json({ issuer: other, authorization_endpoint: `${other}/authorize`, token_endpoint: `${other}/token`,
      jwks_uri: `${other}/jwks` });
    expect((await authorize(pkce().challenge)).status).toBe(503);
    await restartWith(configured);
    discoveryResponse = () => json({ issuer: configured, authorization_endpoint: `${other}/authorize`,
      token_endpoint: `${configured}/token`, jwks_uri: `${configured}/jwks` });
    const res = await authorize(pkce().challenge);
    expect(res.status).toBe(503);
    expect(res.headers.get('location')).toBeNull();
    expect(requestBodies).toHaveLength(0);
  });
});

describe('redirecciones de Sumego (no se siguen)', () => {
  it('discovery con 308 hacia el otro issuer: /authorize 503 sin redirigir', async () => {
    discoveryResponse = () => new Response(null, { status: 308, headers: { location: `${SUMEGO_ISSUER}/.well-known/openid-configuration` } });
    const res = await authorize(pkce().challenge);
    expect(res.status).toBe(503);
    expect(res.headers.get('location')).toBeNull();
    expect(requestBodies).toHaveLength(0);
  });

  it('JWKS con 308: el logout_token es 503 (no disponible) y la familia sigue', async () => {
    await fullLogin();
    jwksResponse = () => new Response(null, { status: 308, headers: { location: `${SUMEGO_ISSUER}/jwks` } });
    clockOffset = JWKS_TTL_MS + 1;
    expect((await logout(await logoutToken())).status).toBe(503);
    expect(await families()).toHaveLength(1);
  });

  it('token_endpoint con 308 al canjear el código: no disponible, sin canje en Lumbre', async () => {
    codeResponse = () => new Response(null, { status: 308, headers: { location: `${SUMEGO_ISSUER}/token` } });
    const login = await startLogin();
    const res = await callback({ code: login.code, state: login.state, iss: issuer }, login.cookie);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('No disponible');
    expect(exchangeBodies).toHaveLength(0);
  });

  it('con el fetch real, un 308 de discovery, token o JWKS no se sigue y es unavailable', async () => {
    let followed = 0;
    let origin = '';
    let discoveryRedirects = false;
    const server = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration' && discoveryRedirects) {
        res.writeHead(308, { location: `${origin}/destino` }).end();
        return;
      }
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
          jwks_uri: `${origin}/jwks` }));
        return;
      }
      if (req.url === '/token' || req.url === '/jwks') {
        res.writeHead(308, { location: `${origin}/destino` }).end();
        return;
      }
      if (req.url === '/destino') followed += 1;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // Fuera de la lista cerrada a propósito: el issuer de loopback solo existe en este test.
      const config = { issuer: origin, clientId: OIDC_CLIENT_ID, clientSecret: CLIENT_SECRET } as unknown as OidcClientConfig;
      const oidc = new SumegoOidc(config, 'https://mcp.hebra.pro');
      const unavailable = { name: 'SumegoError', kind: 'unavailable' };
      await expect(oidc.refresh('rt-x')).rejects.toMatchObject(unavailable);
      await expect(oidc.exchangeCode('codigo', 'verificador')).rejects.toMatchObject(unavailable);
      await expect(oidc.verifyLogoutToken(await logoutToken())).rejects.toMatchObject(unavailable);
      expect(followed).toBe(0);

      discoveryRedirects = true;
      await expect(new SumegoOidc(config, 'https://mcp.hebra.pro').discovery()).rejects.toMatchObject(unavailable);
      expect(followed).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe.each([
  [LUMBRE_ISSUER, SUMEGO_ISSUER],
  [SUMEGO_ISSUER, LUMBRE_ISSUER]
])('de %s a %s: el mismo sub es la misma persona (punto 8 de §13.6 de Sumego)', (before, after) => {
  beforeEach(async () => { await restartWith(before); });

  it('un logout_token del issuer nuevo con el mismo sub corta la familia creada antes del cambio', async () => {
    await fullLogin();
    await restartWith(after);
    expect(await families()).toEqual([expect.objectContaining({ sub: SUB, sid: 'sesion-a' })]);
    expect((await logout(await logoutToken({ sid: undefined, sub: SUB }))).status).toBe(200);
    expect(await families()).toHaveLength(0);
  });

  it('un login tras el cambio no crea otra identidad: un logout por sub alcanza las dos familias', async () => {
    await fullLogin();
    await restartWith(after);
    currentSid = 'sesion-b';
    await fullLogin();
    expect((await families()).map((family) => [family.sub, family.sid])).toEqual([[SUB, 'sesion-a'], [SUB, 'sesion-b']]);
    // oauth-tokens.json no guarda el issuer: nada distingue una familia de la otra salvo el sid.
    const raw = await readFile(join(context.dataDir, OAUTH_TOKENS_FILE), 'utf8');
    expect(raw).not.toContain('id.lumbre.pro');
    expect(raw).not.toContain('id.sumego.es');
    for (const family of await savedFamilies()) {
      expect(Object.keys(family).filter((key) => /iss/i.test(key))).toEqual([]);
    }
    expect((await logout(await logoutToken({ sid: undefined, sub: SUB }))).status).toBe(200);
    expect(await families()).toHaveLength(0);
  });

  it('la renovación horaria de una familia de antes del cambio va al issuer nuevo y la familia sigue', async () => {
    const tokens = await fullLogin();
    const loginRefresh = [...liveRefresh][0]!;
    await restartWith(after);
    clockOffset = HOUR + 1;
    const res = await refresh(tokens.refresh_token);
    expect(res.status).toBe(200);
    expect(refreshCalls).toEqual([loginRefresh]);
    expect(await families()).toEqual([expect.objectContaining({ sub: SUB, sid: 'sesion-a' })]);
  });
});
