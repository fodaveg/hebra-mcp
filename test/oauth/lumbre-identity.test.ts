import { describe, expect, it, vi } from 'vitest';
import { lumbreIdentityFromEnv, withLumbreIdentity, type LumbreIdentity } from '../../src/oauth/lumbre-identity';
import { exchangePairingCode } from '../../src/pair/lumbre';
import { revokeRemoteCredential } from '../../src/pair/remote/revoke';
import { logEvent } from '../../src/log/logger';

const SECRET = 'MARCADOR-secreto-compartido-0123456789abcdef';
const ORIGIN = 'https://app.lumbre.pro';
const ANA = '0a1b2c3d-1111-4222-8333-444455556666';
const BEA = 'bea00000-1111-4222-8333-444455556666';
const identity: LumbreIdentity = { secret: SECRET, origin: ORIGIN };

interface Seen { url: string; headers: Headers; redirect?: RequestRedirect }

function recorder(respond: () => Response | Promise<Response> = () => new Response('{}', { status: 200 })) {
  const seen: Seen[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
    return respond();
  };
  return { seen, fetcher };
}

describe('withLumbreIdentity', () => {
  it('pone las dos cabeceras al origen de Lumbre, con el sub en minúsculas y redirect error', async () => {
    const { seen, fetcher } = recorder();
    await withLumbreIdentity(fetcher, identity, ANA.toUpperCase())(`${ORIGIN}/api/integrations/hebra/exchange`, { method: 'POST' });
    expect(seen[0]!.headers.get('x-hebra-mcp-backchannel')).toBe(SECRET);
    expect(seen[0]!.headers.get('x-hebra-mcp-subject')).toBe(ANA);
    expect(seen[0]!.redirect).toBe('error');
  });

  it('llega en /exchange y en el relé (URL como URL) de esa cuenta y no de otra', async () => {
    const { seen, fetcher } = recorder();
    const a = withLumbreIdentity(fetcher, identity, ANA);
    const b = withLumbreIdentity(fetcher, identity, BEA.toUpperCase());
    await Promise.all([
      a(new URL('/api/integrations/hebra/blob/v2/x', ORIGIN)),
      b(`${ORIGIN}/api/integrations/hebra/exchange`),
      a(`${ORIGIN}/api/integrations/hebra/exchange`)
    ]);
    const subjects = seen.map((s) => [s.url, s.headers.get('x-hebra-mcp-subject')]);
    expect(subjects).toEqual([
      [`${ORIGIN}/api/integrations/hebra/blob/v2/x`, ANA],
      [`${ORIGIN}/api/integrations/hebra/exchange`, BEA],
      [`${ORIGIN}/api/integrations/hebra/exchange`, ANA]
    ]);
  });

  it.each([
    'https://app.lumbre.pro.evil.example/x',
    'https://evil.example/https://app.lumbre.pro/x',
    'https://app.lumbre.pro@evil.example/x',
    'http://app.lumbre.pro/x',
    'https://app.lumbre.pro:8443/x',
    'https://sub.app.lumbre.pro/x',
    'https://otro.example/x'
  ])('otro origen (%s) no recibe ninguna y se descartan las del llamador', async (url) => {
    const { seen, fetcher } = recorder();
    await withLumbreIdentity(fetcher, identity, ANA)(url, {
      headers: { 'X-Hebra-Mcp-Backchannel': 'del-cliente', 'x-hebra-mcp-subject': 'otro', authorization: 'Bearer t' }
    });
    expect(seen[0]!.headers.has('x-hebra-mcp-backchannel')).toBe(false);
    expect(seen[0]!.headers.has('x-hebra-mcp-subject')).toBe(false);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer t');
  });

  it('manda el envoltorio sobre las cabeceras del llamador y conserva el resto', async () => {
    const { seen, fetcher } = recorder();
    await withLumbreIdentity(fetcher, identity, ANA)(`${ORIGIN}/x`, {
      headers: { 'X-Hebra-Mcp-Backchannel': 'falso', 'X-Hebra-Mcp-Subject': 'falso', 'content-type': 'application/json' }
    });
    expect(seen[0]!.headers.get('x-hebra-mcp-backchannel')).toBe(SECRET);
    expect(seen[0]!.headers.get('x-hebra-mcp-subject')).toBe(ANA);
    expect(seen[0]!.headers.get('content-type')).toBe('application/json');
  });

  it('una redirección a otro origen no lleva el secreto: redirect error y la petición falla', async () => {
    const hops: Seen[] = [];
    // Simula el comportamiento de fetch: con redirect 'error' lanza; con 'follow' reenviaría las cabeceras.
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      hops.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
      if (init?.redirect === 'error') throw new TypeError('redirect mode is set to error');
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } });
    };
    await expect(withLumbreIdentity(fetcher, identity, ANA)(`${ORIGIN}/x`, { redirect: 'follow' })).rejects.toThrow();
    expect(hops).toHaveLength(1);
    expect(hops[0]!.redirect).toBe('error');
  });

  it('sin sub, sin identidad o sub vacío no envuelve nada', async () => {
    const { seen, fetcher } = recorder();
    for (const f of [withLumbreIdentity(fetcher, identity, null), withLumbreIdentity(fetcher, identity, ''),
      withLumbreIdentity(fetcher, identity, undefined), withLumbreIdentity(fetcher, null, ANA)]) {
      await f(`${ORIGIN}/x`);
    }
    expect(seen).toHaveLength(4);
    for (const s of seen) {
      expect(s.headers.has('x-hebra-mcp-backchannel')).toBe(false);
      expect(s.headers.has('x-hebra-mcp-subject')).toBe(false);
    }
    expect(withLumbreIdentity(fetcher, null, ANA)).toBe(fetcher);
  });

  it.each(['__legacy_unclaimed__', 'sumego|david', 'ana', ' ', `${ANA}x`, ANA.replace(/-/g, '')])(
    'un sub que no es un UUID (%s) no manda ninguna de las dos cabeceras',
    async (sub) => {
      const { seen, fetcher } = recorder();
      await withLumbreIdentity(fetcher, identity, sub)(`${ORIGIN}/x`, {
        headers: { 'X-Hebra-Mcp-Backchannel': 'falso', 'x-hebra-mcp-subject': 'falso' }
      });
      expect(seen[0]!.headers.has('x-hebra-mcp-backchannel')).toBe(false);
      expect(seen[0]!.headers.has('x-hebra-mcp-subject')).toBe(false);
    }
  );

  it('llega en el canje real (exchangePairingCode) y en la revocación', async () => {
    const issued = { credentialId: 'c', readToken: 'r', writeToken: 'w', connectedAt: 'x' };
    const { seen, fetcher } = recorder(() => new Response(JSON.stringify(issued), { status: 200, headers: { 'content-type': 'application/json' } }));
    const wrapped = withLumbreIdentity(fetcher, identity, ANA.toUpperCase());
    await exchangePairingCode({ apiOrigin: ORIGIN, code: 'c', deviceId: 'd', verifier: 'v', fetcher: wrapped }).catch(() => undefined);
    await revokeRemoteCredential({ apiOrigin: ORIGIN, credentialId: 'c', readToken: 'r', writeToken: 'w', connectedAt: 'x' } as never, wrapped).catch(() => undefined);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) {
      expect(s.headers.get('x-hebra-mcp-backchannel')).toBe(SECRET);
      expect(s.headers.get('x-hebra-mcp-subject')).toBe(ANA);
    }
  });

  it('ni el secreto ni el sub salen en el error de un fetch que falla ni en lo registrado', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { writes.push(String(chunk)); return true; }) as never);
    try {
      const fetcher = async (): Promise<Response> => { throw new TypeError('fetch failed'); };
      const wrapped = withLumbreIdentity(fetcher, identity, 'persona-secreta-0000');
      const failure = await exchangePairingCode({ apiOrigin: ORIGIN, code: 'c', deviceId: 'd', verifier: 'v', fetcher: wrapped })
        .then(() => null, (error: unknown) => error);
      logEvent({ event: 'lumbre.fail', error: String(failure) });
      const text = writes.join('') + JSON.stringify(failure, Object.getOwnPropertyNames(failure as object)) + String(failure);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(ANA);
    } finally { spy.mockRestore(); }
  });
});

describe('lumbreIdentityFromEnv', () => {
  it('sin secreto válido no hay identidad (stdio no cambia)', () => {
    expect(lumbreIdentityFromEnv({})).toBeNull();
    expect(lumbreIdentityFromEnv({ HEBRA_MCP_BACKCHANNEL_SECRET: 'corto' })).toBeNull();
  });
  it('toma el origen validado de LUMBRE_APP_ORIGIN o el de producción', () => {
    expect(lumbreIdentityFromEnv({ HEBRA_MCP_BACKCHANNEL_SECRET: SECRET })).toEqual({ secret: SECRET, origin: ORIGIN });
    expect(lumbreIdentityFromEnv({ HEBRA_MCP_BACKCHANNEL_SECRET: SECRET, LUMBRE_APP_ORIGIN: 'https://lumbre.example/' })?.origin)
      .toBe('https://lumbre.example');
  });
});
