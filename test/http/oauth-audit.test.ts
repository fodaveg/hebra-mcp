/**
 * Hallazgos de la auditoría de seguridad de C3 (26 sep 2026), uno por bloque:
 *
 * - M1: el límite de intentos del secreto no se salta con envíos concurrentes (el intento
 *   se reserva antes del primer `await`), scrypt no corre en paralelo (semáforo de 1), y
 *   una solicitud agotada o una IP bloqueada responden igual con secreto bueno o malo.
 * - M2: una ráfaga de fallos desde muchas IP no bloquea al dueño (el umbral global solo
 *   se registra), y una IP no puede expulsar la solicitud pendiente de otra.
 * - B1: aviso contra el enlace enviado por un tercero en la página.
 * - B2: `Origin: null` vale solo en `POST /oauth/consent`.
 * - B3: dos refresh concurrentes con el mismo token no revocan la familia; reutilizarlo
 *   fuera de la ventana de gracia, sí.
 * - B6: un secreto largo pero de muy poca variedad se rechaza.
 *
 * Las IP distintas llegan por `X-Forwarded-For`, que la app acepta de un proxy de
 * loopback (`trust proxy`), igual que acepta la de Caddy en la red `edge`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  CLAUDE_CALLBACK,
  DCR_CLIENT_ID,
  loadOAuthHttpAuth,
  setOwnerSecret
} from '../../src/oauth';
import { OwnerSecretError, type OwnerRecord } from '../../src/oauth/owner';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { startTestHttpApp, type TestHttpApp } from '../fixtures/http-app';

const SECRET = 'secreto-del-dueño-de-prueba-0123456789-abcdef';

let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;
let test: TestContext | undefined;
let app: TestHttpApp | undefined;
let clock = Date.now();

/** Verificación del secreto instrumentada: cuántas y cuántas a la vez. */
const verification: { calls: number; active: number; maxActive: number; gate: Promise<void> | null } = {
  calls: 0,
  active: 0,
  maxActive: 0,
  gate: null
};
async function countingVerify(_record: OwnerRecord, candidate: string): Promise<boolean> {
  verification.calls += 1;
  verification.active += 1;
  verification.maxActive = Math.max(verification.maxActive, verification.active);
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (verification.gate) await verification.gate;
  verification.active -= 1;
  return candidate === SECRET;
}

function stderrEvents(): Array<Record<string, unknown>> {
  return (stderrSpy!.mock.calls as unknown as [string][])
    .flatMap(([chunk]) => String(chunk).split('\n'))
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  verification.calls = 0;
  verification.active = 0;
  verification.maxActive = 0;
  verification.gate = null;
  clock = Date.now();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await test?.close();
  test = undefined;
  stderrSpy?.mockRestore();
});

async function startApp(options: { fakeVerify?: boolean } = {}): Promise<TestHttpApp> {
  test = await buildTestContext();
  await setOwnerSecret(test.dataDir, SECRET);
  // Después de fijar el secreto: fijarlo revoca todo lo emitido hasta ese instante.
  clock = Date.now() + 1;
  app = await startTestHttpApp(test.serverContext, async (config) => {
    const auth = await loadOAuthHttpAuth(test!.dataDir, config, {
      now: () => clock,
      ...(options.fakeVerify ? { verifySecret: countingVerify } : {})
    });
    if (!auth) throw new Error('sin auth');
    return auth;
  });
  return app;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function openRequest(ip: string, challenge = pkce().challenge): Promise<string> {
  const url = new URL(`${app!.origin}/authorize`);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: DCR_CLIENT_ID,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: 'hebra:mcp',
    resource: app!.config.resourceUrl
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const page = await fetch(url, { redirect: 'manual', headers: { 'x-forwarded-for': ip } });
  expect(page.status).toBe(200);
  const html = await page.text();
  return /name="request" value="([^"]+)"/.exec(html)![1]!;
}

async function consent(
  requestId: string,
  secret: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; location: string | null }> {
  const response = await fetch(`${app!.origin}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ request: requestId, secret }).toString()
  });
  return { status: response.status, body: await response.text(), location: response.headers.get('location') };
}

async function obtainTokens(): Promise<OAuthTokens> {
  const { verifier, challenge } = pkce();
  const approved = await consent(await openRequest('10.0.0.1', challenge), SECRET);
  expect(approved.status).toBe(302);
  const code = new URL(approved.location!).searchParams.get('code')!;
  const response = await fetch(`${app!.origin}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DCR_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: CLAUDE_CALLBACK
    }).toString()
  });
  expect(response.status).toBe(200);
  return (await response.json()) as OAuthTokens;
}

async function refresh(token: string): Promise<globalThis.Response> {
  return fetch(`${app!.origin}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: DCR_CLIENT_ID, grant_type: 'refresh_token', refresh_token: token }).toString()
  });
}

async function mcpStatus(accessToken: string): Promise<number> {
  const response = await fetch(`${app!.origin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }
    })
  });
  await response.text();
  return response.status;
}

describe('M1: intentos concurrentes', () => {
  it('40 envíos simultáneos desde una IP evalúan el secreto como mucho 5 veces, de una en una', async () => {
    await startApp({ fakeVerify: true });
    const requests = await Promise.all(Array.from({ length: 8 }, () => openRequest('10.0.0.66')));
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        consent(requests[index % requests.length]!, 'no-es-el-secreto', { 'x-forwarded-for': '10.0.0.66' })
      )
    );
    expect(verification.calls).toBeLessThanOrEqual(5);
    expect(verification.maxActive).toBe(1);
    // Ninguno aprobó; los no evaluados salen como IP bloqueada o solicitud agotada.
    expect(results.every((result) => [400, 401, 429].includes(result.status))).toBe(true);
  });

  it('con scrypt de verdad, la ráfaga también se queda en 5 evaluaciones', async () => {
    await startApp();
    const requestId = await openRequest('10.0.0.67');
    await Promise.all(
      Array.from({ length: 20 }, () => consent(requestId, 'no-es-el-secreto', { 'x-forwarded-for': '10.0.0.67' }))
    );
    const evaluated = stderrEvents().filter((event) => event.event === 'oauth.consent' && event.result === 'wrong_secret');
    expect(evaluated.length).toBeLessThanOrEqual(5);
  });

  it('el sexto intento, aunque llegue mientras se evalúa el quinto, no se evalúa y no delata el secreto', async () => {
    await startApp({ fakeVerify: true });
    const requestId = await openRequest('10.0.0.68');
    // 4 fallos desde IP distintas: la solicitud queda a un intento de agotarse.
    for (let index = 0; index < 4; index += 1) {
      expect((await consent(requestId, 'malo', { 'x-forwarded-for': `10.0.1.${index}` })).status).toBe(401);
    }
    // El quinto se queda dentro de la verificación hasta abrir la compuerta.
    let open!: () => void;
    verification.gate = new Promise<void>((resolve) => (open = resolve));
    const fifth = consent(requestId, 'malo', { 'x-forwarded-for': '10.0.2.1' });
    await vi.waitFor(() => expect(verification.active).toBe(1));
    const sixthGood = consent(requestId, SECRET, { 'x-forwarded-for': '10.0.2.2' });
    const sixthBad = consent(requestId, 'malo', { 'x-forwarded-for': '10.0.2.3' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    open();
    const [, good, bad] = await Promise.all([fifth, sixthGood, sixthBad]);
    expect(verification.calls).toBe(5);
    expect(good.location).toBeNull();
    expect(good.status).toBe(bad.status);
    const withoutNonce = (html: string) => html.replace(/nonce-[^']+'|nonce="[^"]+"/g, '');
    expect(withoutNonce(good.body)).toBe(withoutNonce(bad.body));
  });
});

describe('M2: nadie bloquea al dueño', () => {
  it('tras más de 50 fallos desde muchas IP, el secreto bueno sigue pasando y el umbral queda en el log', async () => {
    await startApp({ fakeVerify: true });
    for (let ip = 0; ip < 11; ip += 1) {
      const requestId = await openRequest(`10.1.0.${ip}`);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await consent(requestId, 'malo', { 'x-forwarded-for': `10.1.0.${ip}` });
      }
    }
    const approved = await consent(await openRequest('10.2.0.1'), SECRET, { 'x-forwarded-for': '10.2.0.1' });
    expect(approved.status).toBe(302);
    const alerts = stderrEvents().filter((event) => event.event === 'oauth.consent.global_threshold');
    expect(alerts).toHaveLength(1);
  });

  it('una IP que abre muchas solicitudes no expulsa la pendiente de otra', async () => {
    await startApp({ fakeVerify: true });
    const owners = await openRequest('10.3.0.1');
    for (let index = 0; index < 70; index += 1) await openRequest('10.3.0.99');
    expect((await consent(owners, SECRET, { 'x-forwarded-for': '10.3.0.1' })).status).toBe(302);
  });
});

describe('B1 y B2: página y Origin null', () => {
  it('la página avisa del enlace enviado por un tercero', async () => {
    await startApp({ fakeVerify: true });
    const url = new URL(`${app!.origin}/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: DCR_CLIENT_ID,
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge_method: 'S256',
      code_challenge: pkce().challenge
    }).toString();
    const html = await (await fetch(url)).text();
    expect(html).toContain(
      'Continúa solo si acabas de pulsar Conectar en claude.ai. Si alguien te ha enviado este enlace, ciérralo.'
    );
  });

  it('Origin: null vale en POST /oauth/consent y en ninguna otra ruta', async () => {
    await startApp({ fakeVerify: true });
    const approved = await consent(await openRequest('10.4.0.1'), SECRET, { origin: 'null' });
    expect(approved.status).toBe(302);
    const mcp = await fetch(`${app!.origin}/mcp`, {
      method: 'POST',
      headers: { origin: 'null', 'content-type': 'application/json' },
      body: '{}'
    });
    expect(mcp.status).toBe(403);
    const health = await fetch(`${app!.origin}/healthz`, { headers: { origin: 'null' } });
    expect(health.status).toBe(403);
  });
});

describe('B3: ventana de gracia del refresh', () => {
  it('dos refresh concurrentes con el mismo token: uno gana y la familia sigue viva', async () => {
    await startApp({ fakeVerify: true });
    const tokens = await obtainTokens();
    const [first, second] = await Promise.all([refresh(tokens.refresh_token!), refresh(tokens.refresh_token!)]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 400]);
    const winner = (await (first.status === 200 ? first : second).json()) as OAuthTokens;
    expect(await mcpStatus(winner.access_token)).toBe(200);
    expect((await refresh(winner.refresh_token!)).status).toBe(200);
  });

  it('el refresh rotado reutilizado pasada la ventana revoca la familia', async () => {
    await startApp({ fakeVerify: true });
    const tokens = await obtainTokens();
    const rotation = await refresh(tokens.refresh_token!);
    expect(rotation.status).toBe(200);
    const rotated = (await rotation.json()) as OAuthTokens;
    expect(await mcpStatus(rotated.access_token)).toBe(200);
    clock += 31_000;
    expect((await refresh(tokens.refresh_token!)).status).toBe(400);
    expect(await mcpStatus(rotated.access_token)).toBe(401);
    expect((await refresh(rotated.refresh_token!)).status).toBe(400);
  });
});

describe('B6: variedad del secreto', () => {
  it('rechaza un secreto largo con menos de 10 caracteres distintos', async () => {
    test = await buildTestContext();
    await expect(setOwnerSecret(test.dataDir, 'a'.repeat(40))).rejects.toBeInstanceOf(OwnerSecretError);
    await expect(setOwnerSecret(test.dataDir, 'abcdefghi'.repeat(5))).rejects.toThrow(/distintos/);
    await expect(setOwnerSecret(test.dataDir, 'abcdefghij'.repeat(4))).resolves.toBeUndefined();
  });
});
