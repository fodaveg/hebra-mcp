/**
 * Reconectar tras una revocación, de punta a punta (D22, SPEC.md §12.10): `/authorize` con el login
 * de Sumego, el OAuth público real y el emparejado remoto real, con Sumego, Lumbre y el relé
 * simulados. Una persona activa cuya credencial está revocada o rechazada llega a la renovación
 * y no a la página de "conexión cortada".
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { accountDataDir, openRemotePairing, type RemotePairingRuntime } from '../../src/accounts';
import type { AccountRecord } from '../../src/accounts';
import { encodeRecoveryCode } from '../../src/hebra';
import { CLAUDE_CALLBACK, DCR_CLIENT_ID, loadOAuthHttpAuth } from '../../src/oauth';
import type { ActiveGrant } from '../../src/oauth/backchannel';
import type { OAuthHttpAuth } from '../../src/oauth/http-auth';
import { MemorySecretStore, openFileSecretStore, writePairedSecrets } from '../../src/secrets';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { startTestHttpApp, type TestHttpApp } from '../fixtures/http-app';

const SECRET = '0123456789abcdef0123456789abcdef';
const CLIENT_SECRET = 'secreto-del-cliente-de-sumego-0123456789';
const ISSUER = 'https://id.lumbre.pro';
const KID = 'clave-1';
const API = 'https://app.lumbre.pro';
const SUB = 'sumego|ana';

const json = (value: object, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const s256 = (value: string) => createHash('sha256').update(value).digest('base64url');

let context: TestContext;
let app: TestHttpApp;
let auth: OAuthHttpAuth;
let runtime: RemotePairingRuntime;
let account: AccountRecord;
let root: string;
let privateKey: CryptoKey;
let publicJwk: JWK;
/** Respuesta de Lumbre a `requests` y a `sumego/exchange`; `null` es la normal. */
let requestsReply: (() => Response) | null;
let exchangeReply: (() => Response) | null;
/** Estado que devuelve el relé al GET de lectura que sondea la credencial guardada. */
let relayStatus: number;
let requestsCalls: number;
let relayCalls: number;
const sumegoCodes = new Map<string, { sub: string; nonce: string }>();
const gone = () => json({ error: 'pairing_revoked' }, 410);

async function sumegoFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname === '/.well-known/openid-configuration') {
    return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`, id_token_signing_alg_values_supported: ['ES256'] });
  }
  if (url.pathname === '/jwks') return json({ keys: [publicJwk] });
  const form = new URLSearchParams(String(init?.body));
  const issued = sumegoCodes.get(form.get('code') ?? '');
  if (!issued) return json({ error: 'invalid_grant' }, 400);
  const iat = Math.floor(Date.now() / 1000);
  const idToken = await new SignJWT({ iss: ISSUER, aud: 'hebra-mcp', sub: issued.sub, sid: 'sesion-1',
    email: 'ana@example.test', nonce: issued.nonce, iat, exp: iat + 300 })
    .setProtectedHeader({ alg: 'ES256', kid: KID }).sign(privateKey);
  return json({ access_token: 'a', token_type: 'Bearer', refresh_token: `rt-${randomUUID()}`, id_token: idToken });
}

async function broker(input: string | URL, _init?: RequestInit): Promise<Response> {
  const path = new URL(String(input)).pathname.replace('/api/integrations/hebra-mcp/', '');
  if (path === 'requests') {
    requestsCalls += 1;
    return requestsReply ? requestsReply() : json({ requestId: randomUUID(), expiresAt: new Date(Date.now() + 600_000).toISOString() });
  }
  if (path === 'sumego/exchange') return exchangeReply ? exchangeReply() : json({ error: 'unexpected' }, 500);
  if (path === 'revoke') return json({ revoked: true });
  throw new Error(`unexpected route ${path}`);
}

/** El relé al que pregunta `credentialRejected` con los tokens guardados de la cuenta. */
const relay = async (): Promise<Response> => { relayCalls += 1; return new Response('{}', { status: relayStatus }); };

beforeEach(async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const keys = await generateKeyPair('ES256');
  privateKey = keys.privateKey;
  publicJwk = { ...(await exportJWK(keys.publicKey)), kid: KID, use: 'sig', alg: 'ES256' };
  requestsReply = null; exchangeReply = null; relayStatus = 200; requestsCalls = 0; relayCalls = 0;
  sumegoCodes.clear();
  context = await buildTestContext();
  root = await mkdtemp(join(tmpdir(), 'hebra-reconnect-'));
  app = await startTestHttpApp(context.serverContext, async (config) => {
    auth = (await loadOAuthHttpAuth(context.dataDir, config, new MemorySecretStore(), {
      backchannelFetch: broker, sumegoFetch, multiuser: true,
      env: { HEBRA_MCP_BACKCHANNEL_SECRET: SECRET, HEBRA_MCP_LOGIN_PROVIDER: 'sumego', HEBRA_MCP_OIDC_ISSUER: ISSUER,
        HEBRA_MCP_OIDC_CLIENT_ID: 'hebra-mcp', HEBRA_MCP_OIDC_CLIENT_SECRET: CLIENT_SECRET } }))!;
    runtime = await openRemotePairing({ dataDir: context.dataDir, registry: auth.accounts, provider: auth.provider,
      lumbreOrigin: API, fetcher: relay as never });
    return { ...auth, install(express) { auth.install(express); express.use(runtime.router); } };
  });
  // Ana ya tiene su cuenta activa, con sus tokens guardados.
  const seed = hash(SUB);
  const grant: ActiveGrant = { active: true, credentialId: randomUUID(), clientId: DCR_CLIENT_ID, resource: app.config.resourceUrl,
    scope: 'hebra:mcp', accountId: seed, pairedCredentialId: randomUUID(), syncVaultId: seed.slice(0, 32),
    opaqueDeviceId: seed.slice(32), expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() };
  account = await auth.accounts.commitAccount({ sub: SUB, grant });
  const directory = accountDataDir(context.dataDir, account);
  await mkdir(directory, { recursive: true });
  await writePairedSecrets(openFileSecretStore(directory), {
    connection: { credentialId: grant.pairedCredentialId, readToken: 'read-vieja', writeToken: 'write-vieja', apiOrigin: API,
      connectedAt: '2026-11-04T08:00:00.000Z' },
    recoveryCode: await encodeRecoveryCode({ relayOrigin: API, syncVaultId: grant.syncVaultId, keyEpoch: 1, vaultKey: new Uint8Array(32).fill(3) }),
    device: { opaqueDeviceId: grant.opaqueDeviceId, lumbreDeviceId: '55555555-5555-4555-8555-555555555555' } });
});

afterEach(async () => {
  await app?.close(); await context?.close(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks();
});

interface Login { state: string; nonce: string; cookie: string; verifier: string }

async function startLogin(): Promise<Login> {
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL(`${app.origin}/authorize`);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: DCR_CLIENT_ID, redirect_uri: CLAUDE_CALLBACK,
    code_challenge_method: 'S256', code_challenge: s256(verifier), scope: 'hebra:mcp', resource: app.config.resourceUrl,
    state: 'estado' })) url.searchParams.set(key, value);
  const res = await fetch(url, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location')!);
  return { state: location.searchParams.get('state')!, nonce: location.searchParams.get('nonce')!,
    cookie: /^([^;]+)/.exec(res.headers.get('set-cookie')!)![1]!, verifier };
}

function callback(login: Login): Promise<Response> {
  const code = randomBytes(24).toString('base64url');
  sumegoCodes.set(code, { sub: SUB, nonce: login.nonce });
  const url = new URL(`${app.origin}/oauth/sumego/callback`);
  url.searchParams.set('code', code);
  url.searchParams.set('state', login.state);
  url.searchParams.set('iss', ISSUER);
  return fetch(url, { redirect: 'manual', headers: { cookie: login.cookie } });
}

/** La renovación empieza: 303 al aviso previo con la cookie del emparejado, y el aviso es el de renovar. */
async function expectRenewalNotice(res: Response): Promise<void> {
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe('/lumbre/pairing/start');
  const cookie = /^(__Host-hebra_mcp_pair=[^;]+)/m.exec(res.headers.getSetCookie().join('\n'))?.[1];
  expect(cookie).toBeDefined();
  const notice = await fetch(`${app.origin}/lumbre/pairing/start`, { headers: { cookie: cookie! } });
  expect(notice.status).toBe(200);
  const html = await notice.text();
  expect(html).toContain('Renueva la conexión');
  expect(html).toContain('ana@example.test');
  expect(html).not.toContain('Conexión con la biblioteca cortada');
}

describe('persona activa con la credencial revocada que entra por /authorize', () => {
  beforeEach(() => runtime.attachAccountServices({ contexts: { drainAndClose: async () => undefined },
    removal: { remove: async () => undefined }, legacySecrets: new MemorySecretStore() }));

  it('Lumbre responde 410 en /requests: llega a la renovación, no a la página de revocado', async () => {
    requestsReply = gone;
    await expectRenewalNotice(await callback(await startLogin()));
    expect(requestsCalls).toBe(1);
    expect(relayCalls).toBe(1);
  });

  it('Lumbre responde 410 en sumego/exchange al pulsar Permitir: llega a la renovación', async () => {
    const login = await startLogin();
    const page = await callback(login);
    expect(page.status).toBe(200);
    const formToken = /name="form_token" value="([A-Za-z0-9_-]{43})"/.exec(await page.text())![1]!;
    exchangeReply = () => json({ error: 'pairing_revoked', code: 'pairing_revoked' }, 410);
    const res = await fetch(`${app.origin}/oauth/sumego/consent`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: login.cookie },
      body: new URLSearchParams({ form_token: formToken }) });
    await expectRenewalNotice(res);
  });

  it.each([401, 403])('el relé rechaza con %i los tokens guardados (token de agente rechazado): renueva sin molestar a Lumbre', async (status) => {
    relayStatus = status;
    await expectRenewalNotice(await callback(await startLogin()));
    expect(requestsCalls).toBe(0);
  });

  it('con Lumbre y el relé bien, sigue la página de consentimiento de siempre', async () => {
    const page = await callback(await startLogin());
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Permitir');
  });

  it('un 410 que no es pairing_revoked no es una revocación: no abre una renovación', async () => {
    requestsReply = () => json({ error: 'otra_cosa' }, 410);
    const res = await callback(await startLogin());
    expect(res.status).not.toBe(303);
    expect(await res.text()).not.toContain('Renueva la conexión');
  });
});

describe('sin los servicios de la cuenta enganchados', () => {
  it('solo se avisa: la página de revocado dice cómo volver', async () => {
    requestsReply = gone;
    const res = await callback(await startLogin());
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Conexión con la biblioteca cortada');
  });
});
