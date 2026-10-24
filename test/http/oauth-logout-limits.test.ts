/**
 * Cupo y cola del back-channel logout (SPEC.md §12.9, M3): solo los fallos consumen cupo, las
 * IPv6 cuentan por /64, una tabla llena expulsa la dirección más antigua y las verificaciones
 * esperan en una cola corta. Sumego no reintenta: un token válido nunca recibe 429 ni se pierde
 * por un 503 evitable. Con un `SumegoOidc` simulado, sin red ni HTTP.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { BackchannelLogout, MAX_CONCURRENT_LOGOUT_VERIFICATIONS, MAX_QUEUED_LOGOUT_VERIFICATIONS, MAX_TRACKED_ADDRESSES, rateKey } from '../../src/oauth/backchannel-logout';
import type { LogoutJtiStore } from '../../src/oauth/logout-jtis';
import { BACKCHANNEL_LOGOUT_EVENT, SumegoError, type LogoutClaims, type SumegoOidc } from '../../src/oauth/sumego';

const ISSUER = 'https://id.sumego.es';
const CLIENT_ID = 'hebra-mcp';

function b64(value: object): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

/** Con forma de `logout_token` de Sumego (la firma la decide el simulado). */
function plausibleToken(jti: string, iss = ISSUER): string {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'ES256', kid: 'k' })}.${b64({ iss, aud: CLIENT_ID, iat: now, exp: now + 60, jti, sub: 's',
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} } })}.firma`;
}

let verify: (token: string) => Promise<LogoutClaims>;
let handler: BackchannelLogout;
let stderr: ReturnType<typeof vi.spyOn>;

function claimsFor(token: string): LogoutClaims {
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { jti: string; iat: number };
  return { jti: payload.jti, sub: 's', sid: null, iat: payload.iat, rememberUntil: Date.now() + 60_000 };
}

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  verify = async (token) => {
    if (!token.endsWith('.firma')) throw new SumegoError('invalid');
    return claimsFor(token);
  };
  const jtis = new Set<string>();
  handler = new BackchannelLogout({
    oidc: { issuer: ISSUER, clientId: CLIENT_ID, verifyLogoutToken: (token: string) => verify(token) } as unknown as SumegoOidc,
    jtis: { has: (jti: string) => jtis.has(jti), remember: async (jti: string) => { jtis.add(jti); } } as unknown as LogoutJtiStore,
    revoke: async () => 0
  });
});

afterEach(() => { stderr.mockRestore(); vi.useRealTimers(); });

async function post(ip: string, token: string): Promise<number> {
  let status = 0;
  const res = { status(code: number) { status = code; return res; }, end() { return res; } };
  await handler.handle({ ip, socket: { remoteAddress: ip }, body: { logout_token: token } } as unknown as Request, res as unknown as Response);
  return status;
}

describe('cupo', () => {
  it('solo los fallos consumen cupo; un token válido nunca recibe 429', async () => {
    for (let index = 0; index < 100; index += 1) expect(await post('10.0.0.1', plausibleToken(`ok-${index}`))).toBe(200);
    for (let index = 0; index < 60; index += 1) expect(await post('10.0.0.1', 'basura')).toBe(400);
    expect(await post('10.0.0.1', 'basura')).toBe(429);
    // Una firma que no vale con forma plausible sigue verificándose y cuenta como fallo, no 429.
    expect(await post('10.0.0.1', `${plausibleToken('falso').slice(0, -6)}.otra`)).toBe(400);
    expect(await post('10.0.0.1', plausibleToken('valido-tras-cupo'))).toBe(200);
  });

  it('con el cupo agotado, un token con el otro issuer de Sumego no es plausible: 429', async () => {
    for (let index = 0; index < 60; index += 1) expect(await post('10.0.0.2', 'basura')).toBe(400);
    expect(await post('10.0.0.2', plausibleToken('del-otro', 'https://id.lumbre.pro'))).toBe(429);
    expect(await post('10.0.0.2', plausibleToken('del-configurado'))).toBe(200);
  });

  it('las IPv6 cuentan por /64', async () => {
    for (let index = 0; index < 60; index += 1) expect(await post('2001:db8:0:1::1', 'basura')).toBe(400);
    expect(await post('2001:db8:0:1:ffff::2', 'basura')).toBe(429);
    expect(await post('2001:db8:0:2::1', 'basura')).toBe(400);
    expect(rateKey('2001:0db8:0000:0001:aaaa::1')).toBe(rateKey('2001:db8:0:1::bbbb'));
    expect(rateKey('::ffff:10.0.0.1')).toBe('10.0.0.1');
  });

  it('con la tabla llena, una dirección nueva expulsa la más antigua en vez de dar 429', async () => {
    for (let index = 0; index < 60; index += 1) await post('10.1.0.0', 'basura');
    expect(await post('10.1.0.0', 'basura')).toBe(429);
    for (let index = 1; index < MAX_TRACKED_ADDRESSES; index += 1) await post(`10.2.${Math.floor(index / 256)}.${index % 256}`, 'basura');
    expect(await post('10.3.0.1', 'basura')).toBe(400);
    // La más antigua salió de la tabla: su cupo empieza de cero.
    expect(await post('10.1.0.0', 'basura')).toBe(400);
  });
});

describe('cola de verificaciones', () => {
  it('pasadas las 8 a la vez, la siguiente espera su turno en vez de 503; con la cola llena, 503', async () => {
    const gates: Array<() => void> = [];
    verify = (token) => new Promise((resolve) => gates.push(() => resolve(claimsFor(token))));
    const running = Array.from({ length: MAX_CONCURRENT_LOGOUT_VERIFICATIONS + MAX_QUEUED_LOGOUT_VERIFICATIONS },
      (_, index) => post('10.0.0.9', plausibleToken(`cola-${index}`)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(gates).toHaveLength(MAX_CONCURRENT_LOGOUT_VERIFICATIONS);
    expect(await post('10.0.0.9', plausibleToken('sin-sitio'))).toBe(503);
    while (gates.length) {
      gates.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(new Set(await Promise.all(running))).toEqual(new Set([200]));
  });
});
