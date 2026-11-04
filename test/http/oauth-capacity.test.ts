/**
 * Capacidad sin recuento en el OAuth (D22, SPEC.md §12.10), sobre el OAuth público real con
 * varias cuentas: Sumego simulado con una clave ES256 generada aquí y Lumbre con el broker
 * cerrado. Reloj falso, sin medir milisegundos: las medidas van en `test/perf/oauth-tokens.perf.ts`.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import type { AccountRegistry } from '../../src/accounts';
import { CLAUDE_CALLBACK, DCR_CLIENT_ID, loadOAuthHttpAuth, OAUTH_TOKENS_FILE } from '../../src/oauth';
import type { ActiveGrant } from '../../src/oauth/backchannel';
import { FAILURE_POLICIES } from '../../src/oauth/failure-limit';
import { MAX_INTROSPECTIONS, MAX_PENDING, MAX_PENDING_PER_IP, type HebraOAuthProvider } from '../../src/oauth/provider';
import { FAMILY_RATE_LIMIT, FAMILY_RATE_WINDOW_MS, FamilyRateLimitedError, TokenStore } from '../../src/oauth/token-store';
import { MemorySecretStore } from '../../src/secrets';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { startTestHttpApp, type TestHttpApp } from '../fixtures/http-app';

// Cada prueba recorre decenas de logins completos con su `fsync`: el tope es por trabajo, no un plazo.
vi.setConfig({ testTimeout: 180_000 });

const SECRET = '0123456789abcdef0123456789abcdef';
const CLIENT_SECRET = 'secreto-del-cliente-de-sumego-0123456789';
const ISSUER = 'https://id.lumbre.pro';
const KID = 'clave-1';
const IP_A = '10.0.0.1';
const IP_B = '10.0.0.2';

const json = (value: object, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const s256 = (value: string) => createHash('sha256').update(value).digest('base64url');

let context: TestContext;
let app: TestHttpApp;
let provider: HebraOAuthProvider;
let accounts: AccountRegistry;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let privateKey: CryptoKey;
let publicJwk: JWK;
let clockOffset: number;
let renewResponse: (() => Response) | null;
let introspectCount: number;

/** Códigos de Sumego emitidos: de quién son y con qué `nonce`. */
const sumegoCodes = new Map<string, { sub: string; nonce: string }>();
/** Solicitudes abiertas en Lumbre y concesiones vivas, por bearer. */
const lumbreRequests = new Map<string, Record<string, string>>();
const lumbreGrants = new Map<string, ActiveGrant>();
const grantsBySub = new Map<string, ActiveGrant>();

const nowMs = () => Date.now() + clockOffset;
const grantExpiry = () => new Date(nowMs() + 30 * 86400_000).toISOString();

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
  const iat = Math.floor(nowMs() / 1000);
  const idToken = await new SignJWT({ iss: ISSUER, aud: 'hebra-mcp', sub: issued.sub, sid: `sesion-${issued.sub}`,
    email: 'persona@example.test', nonce: issued.nonce, iat, exp: iat + 300 })
    .setProtectedHeader({ alg: 'ES256', kid: KID }).sign(privateKey);
  return json({ access_token: 'a', token_type: 'Bearer', refresh_token: `rt-${randomUUID()}`, id_token: idToken });
}

async function broker(input: string | URL, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body)) as Record<string, string>;
  const path = new URL(String(input)).pathname.replace('/api/integrations/hebra-mcp/', '');
  if (path === 'requests') {
    const requestId = randomUUID();
    lumbreRequests.set(requestId, body);
    return json({ requestId, expiresAt: new Date(nowMs() + 600_000).toISOString() });
  }
  if (path === 'sumego/exchange') {
    const request = lumbreRequests.get(body.requestId!);
    if (!request) return json({ code: 'transaction_not_found' }, 404);
    const accessToken = randomBytes(32).toString('hex');
    const binding = { pairedCredentialId: request.pairedCredentialId!, syncVaultId: request.syncVaultId!, opaqueDeviceId: request.opaqueDeviceId! };
    const account = [...grantsBySub.values()].find((grant) => grant.pairedCredentialId === binding.pairedCredentialId)!;
    const grant: ActiveGrant = { ...account, credentialId: randomUUID(), clientId: body.clientId!, resource: body.resource!, expiresAt: grantExpiry() };
    lumbreGrants.set(accessToken, grant);
    const { active: _active, ...fields } = grant;
    return json({ ...fields, accessToken, tokenType: 'Bearer' });
  }
  if (path === 'introspect') {
    introspectCount += 1;
    const grant = lumbreGrants.get(body.accessToken!);
    return json(grant ? { ...grant } : { active: false });
  }
  if (path === 'renew') {
    if (renewResponse) return renewResponse();
    const grant = lumbreGrants.get(body.accessToken!);
    if (!grant) return json({ active: false });
    grant.expiresAt = grantExpiry();
    return json({ active: true, expiresAt: grant.expiresAt });
  }
  if (path === 'revoke') { lumbreGrants.delete(body.accessToken!); return json({ revoked: true }); }
  throw new Error(`unexpected route ${path}`);
}

/** Una persona con su cuenta ya activa y su propio vínculo. */
async function person(sub: string): Promise<string> {
  const seed = hash(sub);
  const grant: ActiveGrant = { active: true, credentialId: randomUUID(), clientId: DCR_CLIENT_ID, resource: app.config.resourceUrl,
    scope: 'hebra:mcp', accountId: seed, pairedCredentialId: randomUUID(), syncVaultId: seed.slice(0, 32),
    opaqueDeviceId: seed.slice(32), expiresAt: grantExpiry() };
  grantsBySub.set(sub, grant);
  await accounts.commitAccount({ sub, grant });
  return sub;
}

beforeEach(async () => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const keys = await generateKeyPair('ES256');
  privateKey = keys.privateKey;
  publicJwk = { ...(await exportJWK(keys.publicKey)), kid: KID, use: 'sig', alg: 'ES256' };
  clockOffset = 0; renewResponse = null; introspectCount = 0;
  sumegoCodes.clear(); lumbreRequests.clear(); lumbreGrants.clear(); grantsBySub.clear();
  context = await buildTestContext();
  const store = new MemorySecretStore();
  app = await startTestHttpApp(context.serverContext, async (config) => {
    const auth = await loadOAuthHttpAuth(context.dataDir, config, store, {
      backchannelFetch: broker, sumegoFetch, multiuser: true, now: nowMs,
      env: { HEBRA_MCP_BACKCHANNEL_SECRET: SECRET, HEBRA_MCP_LOGIN_PROVIDER: 'sumego', HEBRA_MCP_OIDC_ISSUER: ISSUER,
        HEBRA_MCP_OIDC_CLIENT_ID: 'hebra-mcp', HEBRA_MCP_OIDC_CLIENT_SECRET: CLIENT_SECRET } });
    if (!auth) throw new Error('auth absent');
    provider = auth.provider;
    accounts = auth.accounts;
    return auth;
  });
});

afterEach(async () => {
  await app?.close(); await context?.close(); vi.restoreAllMocks();
});

const fromIp = (ip: string) => ({ 'x-forwarded-for': ip });

function authorize(ip = IP_A, verifier = randomBytes(32).toString('base64url')): Promise<Response> {
  const url = new URL(`${app.origin}/authorize`);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: DCR_CLIENT_ID, redirect_uri: CLAUDE_CALLBACK,
    code_challenge_method: 'S256', code_challenge: s256(verifier), scope: 'hebra:mcp', resource: app.config.resourceUrl,
    state: 'estado' })) url.searchParams.set(key, value);
  return fetch(url, { redirect: 'manual', headers: fromIp(ip) });
}

interface Login { state: string; nonce: string; cookie: string; verifier: string }

/** `/authorize` hasta la redirección a Sumego. */
async function startLogin(ip = IP_A): Promise<Login> {
  const verifier = randomBytes(32).toString('base64url');
  const res = await authorize(ip, verifier);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location')!);
  const cookie = /^([^;]+)/.exec(res.headers.get('set-cookie')!)![1]!;
  return { state: location.searchParams.get('state')!, nonce: location.searchParams.get('nonce')!, cookie, verifier };
}

/** Vuelta de Sumego: la página de consentimiento, o el rechazo si la solicitud ya no existe. */
function sumegoCallback(login: Login, sub: string): Promise<Response> {
  const code = randomBytes(24).toString('base64url');
  sumegoCodes.set(code, { sub, nonce: login.nonce });
  const url = new URL(`${app.origin}/oauth/sumego/callback`);
  url.searchParams.set('code', code);
  url.searchParams.set('state', login.state);
  url.searchParams.set('iss', ISSUER);
  return fetch(url, { redirect: 'manual', headers: { cookie: login.cookie } });
}

function formTokenOf(html: string): string {
  return /name="form_token" value="([A-Za-z0-9_-]{43})"/.exec(html)![1]!;
}

function consent(formToken: string, cookie: string): Promise<Response> {
  return fetch(`${app.origin}/oauth/sumego/consent`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ form_token: formToken }) });
}

interface ReadyCode { code: string; verifier: string }

/** Login y consentimiento: un código OAuth listo para `/token`. */
async function codeFor(sub: string, ip = IP_A): Promise<ReadyCode> {
  const login = await startLogin(ip);
  const page = await sumegoCallback(login, sub);
  expect(page.status).toBe(200);
  const approved = await consent(formTokenOf(await page.text()), login.cookie);
  expect(approved.status).toBe(302);
  return { code: new URL(approved.headers.get('location')!).searchParams.get('code')!, verifier: login.verifier };
}

function exchange(ready: ReadyCode, ip = IP_A): Promise<Response> {
  return fetch(`${app.origin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...fromIp(ip) },
    body: new URLSearchParams({ client_id: DCR_CLIENT_ID, grant_type: 'authorization_code', code: ready.code,
      code_verifier: ready.verifier, redirect_uri: CLAUDE_CALLBACK, resource: app.config.resourceUrl }) });
}

async function connect(sub: string, ip = IP_A): Promise<{ access_token: string; refresh_token: string }> {
  const issued = await exchange(await codeFor(sub, ip), ip);
  expect(issued.status).toBe(200);
  return await issued.json() as { access_token: string; refresh_token: string };
}

function refresh(token: string, ip = IP_A): Promise<Response> {
  return fetch(`${app.origin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...fromIp(ip) },
    body: new URLSearchParams({ client_id: DCR_CLIENT_ID, grant_type: 'refresh_token', refresh_token: token }) });
}

const pendingMap = () => (provider as unknown as { pending: Map<string, { ip: string }> }).pending;
const liveFamilies = async () => (JSON.parse(await readFile(join(context.dataDir, OAUTH_TOKENS_FILE), 'utf8')) as { families: unknown[] }).families.length;
const fileIdentity = async () => {
  const info = await stat(join(context.dataDir, OAUTH_TOKENS_FILE), { bigint: true });
  return `${info.ino}:${info.mtimeNs}`;
};

describe('familias: sin máximo, con ritmo por persona', () => {
  it('100 familias de cinco personas, sin un solo rechazo', async () => {
    const subs = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((name) => person(`sumego|${name}`)));
    for (const sub of subs) for (let index = 0; index < FAMILY_RATE_LIMIT; index += 1) await connect(sub);
    expect(await liveFamilies()).toBe(100);
  });

  it('la 21.ª de una persona en una hora da 429 con Retry-After y no afecta a otra', async () => {
    const ana = await person('sumego|ana');
    const beto = await person('sumego|beto');
    // El código se pide antes: con el ritmo lleno, el login ya no llega a dar uno (ver abajo).
    const ready = await codeFor(ana);
    for (let index = 0; index < FAMILY_RATE_LIMIT; index += 1) await connect(ana);
    const limited = await exchange(ready);
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(FAMILY_RATE_WINDOW_MS / 1000);
    expect(await limited.json()).toMatchObject({ error: 'too_many_requests' });
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect(await liveFamilies()).toBe(FAMILY_RATE_LIMIT);
    await connect(beto);
    expect(await liveFamilies()).toBe(FAMILY_RATE_LIMIT + 1);
  });

  it('el 429 no quema el código: abierto el hueco, el mismo código sirve', async () => {
    const ana = await person('sumego|ana');
    for (let index = 0; index < FAMILY_RATE_LIMIT - 1; index += 1) await connect(ana);
    const ready = await codeFor(ana);
    // La 20.ª familia, empezada hace casi una hora: sale de la ventana dentro de 30 s.
    const starts = (provider as unknown as { tokens: { familyStarts: Map<string, number[]> } }).tokens.familyStarts;
    starts.get('sub:sumego|ana')!.unshift(nowMs() - FAMILY_RATE_WINDOW_MS + 30_000);
    const limited = await exchange(ready);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(31);
    clockOffset = 31_000;
    expect((await exchange(ready)).status).toBe(200);
  });

  it('pasada la hora vuelve a poder', async () => {
    const ana = await person('sumego|ana');
    for (let index = 0; index < FAMILY_RATE_LIMIT; index += 1) await connect(ana);
    clockOffset = FAMILY_RATE_WINDOW_MS + 1_000;
    await connect(ana);
  });

  it('una ráfaga de canjes a la vez no pasa de 20 y ninguno acaba en 500', async () => {
    const ana = await person('sumego|ana');
    const codes: ReadyCode[] = [];
    for (let index = 0; index < FAMILY_RATE_LIMIT + 5; index += 1) codes.push(await codeFor(ana));
    const statuses = (await Promise.all(codes.map((ready) => exchange(ready)))).map((res) => res.status);
    const issued = statuses.filter((status) => status === 200).length;
    expect(issued).toBeGreaterThan(0);
    expect(issued).toBeLessThanOrEqual(FAMILY_RATE_LIMIT);
    expect(issued + statuses.filter((status) => status === 429).length).toBe(codes.length);
    expect(await liveFamilies()).toBe(issued);
  });

  it('sin un código vigente nunca hay 429 de ritmo: no dice si una cuenta existe', async () => {
    const ana = await person('sumego|ana');
    for (let index = 0; index < FAMILY_RATE_LIMIT; index += 1) await connect(ana);
    const guessed = await exchange({ code: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url') });
    expect(guessed.status).toBe(400);
    expect(await guessed.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('frenar por ritmo no gasta el cupo de fallos de la dirección', async () => {
    const ana = await person('sumego|ana');
    const ready = await codeFor(ana);
    for (let index = 0; index < FAMILY_RATE_LIMIT; index += 1) await connect(ana);
    for (let index = 0; index < FAILURE_POLICIES['/token'].limit + 5; index += 1) expect((await exchange(ready)).status).toBe(429);
    expect((await refresh('hmcp_rt_invalido')).status).toBe(400);
  });
});

describe('ritmo de familias en las páginas del login', () => {
  it('el callback, con el ritmo lleno, enseña una página con el motivo y cuándo reintentar, no un error en crudo', async () => {
    const ana = await person('sumego|ana');
    for (let index = 0; index < FAMILY_RATE_LIMIT; index += 1) await connect(ana);
    const login = await startLogin();
    const page = await sumegoCallback(login, ana);
    expect(page.status).toBe(429);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    const seconds = Number(page.headers.get('retry-after'));
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(FAMILY_RATE_WINDOW_MS / 1000);
    const html = await page.text();
    expect(html).toContain('Demasiadas conexiones nuevas');
    expect(html).toMatch(/dentro de (un minuto|unos \d+ minutos)/);
    expect(html).not.toContain('too_many_requests');
    expect(html).not.toMatch(/form_token/);
    expect(await liveFamilies()).toBe(FAMILY_RATE_LIMIT);
    // Pasada la espera que dice la página, la misma persona entra.
    clockOffset = seconds * 1000 + 1_000;
    await connect(ana);
  });

  it('otra persona no ve esa página', async () => {
    const ana = await person('sumego|ana');
    const beto = await person('sumego|beto');
    for (let index = 0; index < FAMILY_RATE_LIMIT; index += 1) await connect(ana);
    expect((await sumegoCallback(await startLogin(), beto)).status).toBe(200);
  });

  it('el "Permitir", si el ritmo se llenó después del callback, dice lo mismo y no gasta una concesión en Lumbre', async () => {
    const ana = await person('sumego|ana');
    for (let index = 0; index < FAMILY_RATE_LIMIT - 1; index += 1) await connect(ana);
    const login = await startLogin();
    const page = await sumegoCallback(login, ana);
    expect(page.status).toBe(200);
    const formToken = formTokenOf(await page.text());
    await connect(ana);
    const before = lumbreGrants.size;
    const denied = await consent(formToken, login.cookie);
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await denied.text()).toContain('Demasiadas conexiones nuevas');
    expect(lumbreGrants.size).toBe(before);
  });

  it('en /token sigue siendo un JSON de error OAuth con Retry-After', async () => {
    const ana = await person('sumego|ana');
    const ready = await codeFor(ana);
    for (let index = 0; index < FAMILY_RATE_LIMIT; index += 1) await connect(ana);
    const limited = await exchange(ready);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('content-type')).toMatch(/application\/json/);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: 'too_many_requests' });
  });
});

describe('ritmo de familias en el almacén', () => {
  const grant = (accountId: string): ActiveGrant => ({ active: true, credentialId: randomUUID(), clientId: DCR_CLIENT_ID,
    resource: 'https://mcp.hebra.pro/mcp', scope: 'hebra:mcp', accountId, pairedCredentialId: randomUUID(),
    syncVaultId: 'ab'.repeat(16), opaqueDeviceId: 'cd'.repeat(16), expiresAt: new Date(Date.now() + 86400_000).toISOString() });
  const issue = (store: TokenStore, sub: string | null, accountId = 'cuenta') => store.issueFamily({
    clientId: DCR_CLIENT_ID, scope: 'hebra:mcp', resource: 'https://mcp.hebra.pro/mcp', grant: grant(accountId), authorizedAt: Date.now(),
    identity: sub === null ? null : { sub, sid: null } }, 0, async () => undefined);
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'hebra-familias-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('la 21.ª lanza con los segundos que faltan y otra persona sigue', async () => {
    let clock = 1_000_000;
    const store = await TokenStore.open(dir, () => clock);
    for (let index = 0; index < FAMILY_RATE_LIMIT; index += 1) { await issue(store, 'ana'); clock += 1_000; }
    const refused = await issue(store, 'ana').then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(FamilyRateLimitedError);
    expect((refused as FamilyRateLimitedError).retryAfterSeconds).toBe(FAMILY_RATE_WINDOW_MS / 1000 - FAMILY_RATE_LIMIT);
    await expect(issue(store, 'beto')).resolves.toBeDefined();
  });

  it('el login de Lumbre, sin `sub`, cuenta por la cuenta de la concesión', async () => {
    const store = await TokenStore.open(dir);
    for (let index = 0; index < FAMILY_RATE_LIMIT; index += 1) await issue(store, null, 'cuenta-1');
    await expect(issue(store, null, 'cuenta-1')).rejects.toBeInstanceOf(FamilyRateLimitedError);
    await expect(issue(store, null, 'cuenta-2')).resolves.toBeDefined();
  });

  it('una escritura fallida no gasta ritmo', async () => {
    const store = await TokenStore.open(dir);
    // Un directorio en el sitio del fichero: el `rename` final falla.
    const blocker = join(dir, OAUTH_TOKENS_FILE);
    await mkdir(blocker);
    for (let index = 0; index < FAMILY_RATE_LIMIT + 5; index += 1) await expect(issue(store, 'ana')).rejects.not.toBeInstanceOf(FamilyRateLimitedError);
    await rm(blocker, { recursive: true });
    for (let index = 0; index < FAMILY_RATE_LIMIT; index += 1) await issue(store, 'ana');
    expect(store.liveFamilyCount(0)).toBe(FAMILY_RATE_LIMIT);
  });

  it('quien dejó de crear familias no ocupa memoria', async () => {
    let clock = 1_000_000;
    const store = await TokenStore.open(dir, () => clock);
    const starts = (store as unknown as { familyStarts: Map<string, number[]> }).familyStarts;
    await issue(store, 'ana');
    clock += FAMILY_RATE_WINDOW_MS;
    await issue(store, 'beto');
    expect([...starts.keys()]).toEqual(['sub:beto']);
  });
});

describe('solicitudes pendientes: cae la más antigua, no se rechaza la nueva', () => {
  it('40 logins simultáneos desde una IP: ninguno da 429 y quedan 32', async () => {
    const statuses = (await Promise.all(Array.from({ length: 40 }, () => authorize(IP_A)))).map((res) => res.status);
    expect(new Set(statuses)).toEqual(new Set([302]));
    expect(pendingMap().size).toBe(MAX_PENDING_PER_IP);
  });

  it('caen justo las más antiguas de esa IP; las siguientes y las de otra IP siguen vivas', async () => {
    const ana = await person('sumego|ana');
    const other = await startLogin(IP_B);
    const logins: Login[] = [];
    for (let index = 0; index < 40; index += 1) logins.push(await startLogin(IP_A));
    expect((await sumegoCallback(logins[7]!, ana)).status).toBe(400);
    expect((await sumegoCallback(logins[8]!, ana)).status).toBe(200);
    expect((await sumegoCallback(other, ana)).status).toBe(200);
  });

  it('las IPv6 de una misma /64 cuentan juntas', async () => {
    for (let index = 0; index < 40; index += 1) expect((await authorize(`2001:db8:0:1::${index + 1}`)).status).toBe(302);
    expect(pendingMap().size).toBe(MAX_PENDING_PER_IP);
    expect((await authorize('2001:db8:0:2::1')).status).toBe(302);
    expect(pendingMap().size).toBe(MAX_PENDING_PER_IP + 1);
  });

  /** Llena la tabla de anónimas sin 4 096 peticiones HTTP, con la solicitud de otra entrada como molde. */
  async function fillAnonymous(): Promise<void> {
    await authorize('10.9.9.9');
    const pending = pendingMap();
    const model = [...pending.values()].at(-1)!;
    for (let index = pending.size; pending.size < MAX_PENDING; index += 1) {
      pending.set(`relleno-${index}`, { ...model, ip: `10.${index >> 16}.${(index >> 8) & 255}.${index & 255}` });
    }
  }

  it('con el total lleno cae la más antigua, también de otra IP, y la memoria no crece', async () => {
    const ana = await person('sumego|ana');
    const oldest = await startLogin(IP_B);
    await fillAnonymous();
    expect(pendingMap().size).toBe(MAX_PENDING);
    const fresh = await startLogin(IP_A);
    expect(pendingMap().size).toBe(MAX_PENDING);
    expect((await sumegoCallback(oldest, ana)).status).toBe(400);
    expect((await sumegoCallback(fresh, ana)).status).toBe(200);
  });

  it('una inundación anónima no expulsa una solicitud ya autenticada, ni por su IP ni por el total', async () => {
    const ana = await person('sumego|ana');
    const login = await startLogin(IP_A);
    const page = await sumegoCallback(login, ana);
    expect(page.status).toBe(200);
    const formToken = formTokenOf(await page.text());
    for (let index = 0; index < MAX_PENDING_PER_IP * 2; index += 1) await authorize(IP_A);
    await fillAnonymous();
    for (let index = 0; index < 8; index += 1) await authorize(`10.8.8.${index}`);
    // La autenticada no cuenta en el total: sigue habiendo sitio para las 4 096 anónimas.
    expect(pendingMap().size).toBe(MAX_PENDING + 1);
    const approved = await consent(formToken, login.cookie);
    expect(approved.status).toBe(302);
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    expect((await exchange({ code, verifier: login.verifier })).status).toBe(200);
  });

  it('sin tope de códigos: 70 a la vez, y cada uno caduca a los 60 s', async () => {
    const subs = await Promise.all(['a', 'b', 'c', 'd'].map((name) => person(`sumego|${name}`)));
    const codes: ReadyCode[] = [];
    for (let index = 0; index < 70; index += 1) codes.push(await codeFor(subs[index % 4]!));
    const issued = (provider as unknown as { codes: Map<string, unknown> }).codes;
    expect(issued.size).toBe(70);
    clockOffset = 61_000;
    await authorize();
    expect(issued.size).toBe(0);
    expect((await exchange(codes[0]!)).status).toBe(400);
  });
});

describe('cupos por dirección: solo cuentan los fallos', () => {
  it('200 refresh correctos desde una IP no gastan cupo; los malos sí se limitan', async () => {
    const ana = await person('sumego|ana');
    let { refresh_token: current } = await connect(ana);
    for (let index = 0; index < 200; index += 1) {
      const res = await refresh(current);
      expect(res.status).toBe(200);
      current = ((await res.json()) as { refresh_token: string }).refresh_token;
    }
    const { limit } = FAILURE_POLICIES['/token'];
    for (let index = 0; index < limit; index += 1) expect((await refresh('hmcp_rt_invalido')).status).toBe(400);
    const limited = await refresh('hmcp_rt_invalido');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: 'too_many_requests' });
    // Solo esa dirección, y solo durante su ventana.
    expect((await refresh('hmcp_rt_invalido', IP_B)).status).toBe(400);
    expect((await refresh(current, IP_B)).status).toBe(200);
  });

  it('más refresh correctos a la vez que el cupo entero, desde una IP, no dan 429', async () => {
    const subs = await Promise.all(['a', 'b', 'c', 'd'].map((name) => person(`sumego|${name}`)));
    const { limit } = FAILURE_POLICIES['/token'];
    const tokens: string[] = [];
    for (let index = 0; index < limit + 10; index += 1) {
      tokens.push((await connect(subs[index % 4]!)).refresh_token);
    }
    const statuses = (await Promise.all(tokens.map((token) => refresh(token)))).map((res) => res.status);
    expect(new Set(statuses)).toEqual(new Set([200]));
  });

  it('con 200 fallos ajenos desde la IP, un refresh correcto y un canje de código correcto pasan', async () => {
    const ana = await person('sumego|ana');
    const { refresh_token: token } = await connect(ana);
    const ready = await codeFor(ana);
    const { limit } = FAILURE_POLICIES['/token'];
    for (let index = 0; index < 200; index += 1) await refresh('hmcp_rt_invalido');
    expect(limit).toBeLessThan(200);
    const renewed = await refresh(token);
    expect(renewed.status).toBe(200);
    expect((await exchange(ready)).status).toBe(200);
    // El que sigue fallando, desde esa misma IP, recibe 429 con Retry-After.
    const failing = await refresh('hmcp_rt_invalido');
    expect(failing.status).toBe(429);
    expect(Number(failing.headers.get('retry-after'))).toBeGreaterThan(0);
    // Un código inventado y un refresh ya rotado tampoco pasan el freno.
    expect((await exchange({ code: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url') })).status).toBe(429);
    expect((await refresh(token)).status).toBe(429);
  });

  it('el freno de la IP no deja pasar a quien presenta el cliente o el recurso equivocados', async () => {
    const ana = await person('sumego|ana');
    const { refresh_token: token } = await connect(ana);
    const { limit } = FAILURE_POLICIES['/token'];
    for (let index = 0; index < limit; index += 1) await refresh('hmcp_rt_invalido');
    const wrongClient = await fetch(`${app.origin}/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...fromIp(IP_A) },
      body: new URLSearchParams({ client_id: 'otro-cliente', grant_type: 'refresh_token', refresh_token: token }) });
    expect(wrongClient.status).toBe(429);
  });

  it('un 5xx no es un fallo del cliente: una caída de Lumbre no deja a la IP fuera al volver', async () => {
    const ana = await person('sumego|ana');
    const { refresh_token: token } = await connect(ana);
    renewResponse = () => json({ error: 'down' }, 503);
    const { limit } = FAILURE_POLICIES['/token'];
    for (let index = 0; index < limit + 5; index += 1) expect((await refresh(token)).status).toBe(500);
    renewResponse = null;
    expect((await refresh(token)).status).toBe(200);
  });

  it('pasada la ventana, la dirección vuelve a entrar', async () => {
    const { limit, windowMs } = FAILURE_POLICIES['/token'];
    for (let index = 0; index < limit; index += 1) await refresh('hmcp_rt_invalido');
    expect((await refresh('hmcp_rt_invalido')).status).toBe(429);
    clockOffset = windowMs;
    expect((await refresh('hmcp_rt_invalido')).status).toBe(400);
  });

  it('/authorize: los logins correctos no cuentan y los inválidos sí', async () => {
    const { limit } = FAILURE_POLICIES['/authorize'];
    for (let index = 0; index < limit + 10; index += 1) expect((await authorize()).status).toBe(302);
    const bad = () => fetch(`${app.origin}/authorize?client_id=desconocido`, { redirect: 'manual', headers: fromIp(IP_A) });
    for (let index = 0; index < limit; index += 1) expect((await bad()).status).toBe(400);
    expect((await bad()).status).toBe(429);
  });

  it('/register: un registro correcto no cuenta y uno rechazado sí', async () => {
    const register = (redirect: string) => fetch(`${app.origin}/register`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...fromIp(IP_A) },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
    const { limit } = FAILURE_POLICIES['/register'];
    for (let index = 0; index < limit + 5; index += 1) expect((await register(CLAUDE_CALLBACK)).status).toBe(201);
    for (let index = 0; index < limit; index += 1) expect((await register('https://ajeno.example/cb')).status).toBe(400);
    expect((await register(CLAUDE_CALLBACK)).status).toBe(429);
  });

  it('un 429 lleva CORS y la comprobación previa no cuenta ni se bloquea', async () => {
    const { limit } = FAILURE_POLICIES['/token'];
    for (let index = 0; index < limit; index += 1) await refresh('hmcp_rt_invalido');
    const limited = await refresh('hmcp_rt_invalido');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('access-control-allow-origin')).toBe('*');
    const preflight = await fetch(`${app.origin}/token`, { method: 'OPTIONS', headers: fromIp(IP_A) });
    expect(preflight.status).toBeLessThan(400);
  });

  it('el 429 de cupo no menciona ninguna cuenta', async () => {
    const { limit } = FAILURE_POLICIES['/token'];
    for (let index = 0; index < limit; index += 1) await refresh('hmcp_rt_invalido');
    const body = await (await refresh('hmcp_rt_invalido')).text();
    expect(body).not.toMatch(/sub|cuenta|email/i);
  });
});

describe('peticiones que no cambian nada no escriben el fichero de tokens', () => {
  it('un refresh inventado y una revocación desconocida no lo tocan', async () => {
    const ana = await person('sumego|ana');
    await connect(ana);
    const before = await fileIdentity();
    expect((await refresh(`hmcp_rt_${'a'.repeat(22)}.${'b'.repeat(43)}`)).status).toBe(400);
    expect((await refresh('hmcp_rt_invalido')).status).toBe(400);
    const revoked = await fetch(`${app.origin}/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DCR_CLIENT_ID, token: `hmcp_at_${'c'.repeat(43)}` }) });
    expect(revoked.status).toBe(200);
    expect(await fileIdentity()).toBe(before);
  });

  it('revocar un token vigente sigue cortando y persistiendo', async () => {
    const ana = await person('sumego|ana');
    const { access_token: token } = await connect(ana);
    const revoked = await fetch(`${app.origin}/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DCR_CLIENT_ID, token }) });
    expect(revoked.status).toBe(200);
    expect(await liveFamilies()).toBe(0);
    await expect(provider.verifyAccessToken(token)).rejects.toThrow();
  });
});

describe('caché de introspecciones', () => {
  it('acota memoria por expulsión, sin negar acceso a la familia expulsada', async () => {
    const ana = await person('sumego|ana');
    const { access_token: token } = await connect(ana);
    await provider.verifyAccessToken(token);
    const cache = (provider as unknown as { introspections: Map<string, unknown> }).introspections;
    expect(cache.size).toBe(1);
    const [familyId] = [...cache.keys()];
    const entry = cache.get(familyId!)!;
    for (let index = 0; index < MAX_INTROSPECTIONS; index += 1) cache.set(`relleno-${index}`, entry);
    const remember = provider as unknown as { rememberIntrospection(id: string, grant: ActiveGrant, at: number, monotonic: number, epoch: number): void; introspectionEpoch: number };
    const grant = grantsBySub.get(ana)!;
    remember.rememberIntrospection('otra', grant, nowMs(), performance.now(), remember.introspectionEpoch);
    expect(cache.size).toBeLessThanOrEqual(MAX_INTROSPECTIONS + 1);

    // La familia real está fuera: su siguiente petición vuelve a Lumbre y sigue entrando.
    cache.delete(familyId!);
    const before = introspectCount;
    await expect(provider.verifyAccessToken(token)).resolves.toMatchObject({ clientId: DCR_CLIENT_ID });
    expect(introspectCount).toBe(before + 1);
  });

  it('el tope nunca pasa de MAX_INTROSPECTIONS al añadir familias nuevas', () => {
    const cache = (provider as unknown as { introspections: Map<string, unknown> }).introspections;
    const remember = provider as unknown as { rememberIntrospection(id: string, grant: ActiveGrant, at: number, monotonic: number, epoch: number): void; introspectionEpoch: number };
    const grant = { expiresAt: new Date(nowMs() + 86400_000).toISOString() } as ActiveGrant;
    const at = nowMs();
    const monotonic = performance.now();
    for (let index = 0; index <= MAX_INTROSPECTIONS; index += 1) {
      remember.rememberIntrospection(`familia-${index}`, grant, at, monotonic, remember.introspectionEpoch);
    }
    expect(cache.size).toBe(MAX_INTROSPECTIONS);
    expect(cache.has('familia-0')).toBe(false);
    expect(cache.has(`familia-${MAX_INTROSPECTIONS}`)).toBe(true);
  });
});
