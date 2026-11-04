/**
 * La página puente de `/lumbre/connect` (D22, SPEC.md §12.10) con las cabeceras reales de
 * `createHttpApp` y el router y el servicio de verdad. Sin navegador: el script de la página se
 * ejecuta en un contexto `vm` con un `document`, un `location` y un `history` simulados.
 *
 * Lo que este test NO prueba, porque exige un navegador: que Chrome y Safari ejecuten el script
 * bajo `default-src 'none'; script-src 'nonce-...'`, que conserven el fragmento `#code=` a lo
 * largo de la redirección desde Lumbre, que envíen la cookie `SameSite=Lax` en esa navegación
 * entre sitios y que el envío del formulario lleve `Origin: https://mcp.hebra.pro`.
 */
import { request, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApp } from '../../src/http/app';
import { httpConfigFor } from '../../src/http/config';
import { PairError } from '../../src/pair/errors';
import { RemotePairingJournalStore } from '../../src/pair/remote/journal';
import { createRemotePairingRouter, REMOTE_PAIRING_COOKIE } from '../../src/pair/remote/router';
import { REMOTE_PAIRING_ORIGIN, RemotePairingService } from '../../src/pair/remote/service';
import { staticBearerAuth } from '../fixtures/http-app';

const NOW = Date.parse('2026-11-04T08:00:00.000Z');
const CODE = 'ab'.repeat(32);
const HOST = new URL(REMOTE_PAIRING_ORIGIN).host;

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

describe('página puente con las cabeceras reales de serve-http', () => {
  let root: string;
  let server: Server;
  let port: number;
  let cookie: string;
  let formToken: string;
  const exchange = vi.fn();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hebra-bridge-'));
    const service = new RemotePairingService({ journals: new RemotePairingJournalStore(join(root, 'journals')),
      now: () => NOW, exchangeCode: exchange,
      prepareAgent: async () => { throw new Error('no se llega'); },
      ownership: { verify: async () => { throw new Error('no se llega'); } },
      publisher: { publish: async () => ({ id: 'a', generation: 1 }), findCommitted: async () => null, cleanupOrphan: async () => undefined } });
    const started = await service.start({ oauthRequestId: 'oauth-1', sub: 'sumego|david',
      identityExpiresAt: new Date(NOW + 60_000).toISOString() });
    cookie = `${REMOTE_PAIRING_COOKIE}=${started.cookie}`;
    formToken = started.formToken;
    const router = createRemotePairingRouter(service, { resumeOauth: async () => '/x', cancelOauth: async () => undefined,
      reauthenticate: async () => undefined });
    // El origen público real: el filtro de Host y Origin de la app es el de producción.
    server = createHttpServer(router);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    exchange.mockReset();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  });

  function createHttpServer(router: ReturnType<typeof createRemotePairingRouter>): Server {
    const app = createHttpApp({ ctx: undefined as never, version: '0.0.0-test', config: httpConfigFor(REMOTE_PAIRING_ORIGIN, 0),
      auth: staticBearerAuth('x'), remotePairing: router });
    return app.listen(0, '127.0.0.1');
  }

  /** `fetch` no deja fijar `Host`: se pide con `node:http`, como llegaría desde el proxy. */
  function send(method: 'GET' | 'POST', path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers: { host: HOST, ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  const form = (code: string) => new URLSearchParams({ form_token: formToken, code }).toString();
  const post = (headers: Record<string, string>, code = CODE) => send('POST', '/lumbre/connect',
    { 'content-type': 'application/x-www-form-urlencoded', ...headers }, form(code));

  it('cabeceras: CSP cerrada con el nonce de ESTA respuesta, sin otra fuente de script, y referrer same-origin', async () => {
    const page = await send('GET', '/lumbre/connect', { cookie });
    expect(page.status).toBe(200);
    const csp = String(page.headers['content-security-policy']);
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]{24})'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toMatch(/^default-src 'none'; form-action 'self'; /);
    expect(csp.match(/script-src/g)).toHaveLength(1);
    expect(csp).not.toMatch(/unsafe-eval|\*/);
    expect(/script-src ([^;]*)/.exec(csp)![1]).toBe(`'nonce-${nonce}'`);
    // Un único script, con ese nonce y ningún atributo o recurso externo.
    expect(page.body.match(/<script/g)).toHaveLength(1);
    expect(page.body).toContain(`<script nonce="${nonce}">`);
    expect(page.body).not.toMatch(/<script[^>]*\ssrc=|https?:\/\//);
    // Sin `same-origin` el navegador manda `Origin: null` en el POST y el filtro de Host/Origin lo rechaza.
    expect(page.headers['referrer-policy']).toBe('same-origin');
    expect(page.headers['cache-control']).toBe('private, no-store');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    // El nonce cambia en cada respuesta: uno fijo no protegería nada.
    const again = await send('GET', '/lumbre/connect', { cookie });
    expect(/script-src 'nonce-([^']+)'/.exec(String(again.headers['content-security-policy']))?.[1]).not.toBe(nonce);
  });

  it('el formulario de la página envía a la ruta que el router sirve por POST, con su token', async () => {
    const page = await send('GET', '/lumbre/connect', { cookie });
    expect(page.body).toMatch(/<form id="bridge" method="post" action="\/lumbre\/connect">/);
    expect(page.body).toContain(`name="form_token" value="${formToken}"`);
    expect(page.body).toContain('<input type="hidden" name="code" value="">');
  });

  describe('el script, ejecutado con un navegador simulado', () => {
    async function scriptOf(): Promise<string> {
      const page = await send('GET', '/lumbre/connect', { cookie });
      return /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(page.body)![1]!;
    }

    function run(script: string, hash: string) {
      const submitted: string[] = [];
      const code = { value: '' };
      const problem = { hidden: true };
      const replaced: unknown[][] = [];
      const bridge = { elements: { code }, submit: () => { submitted.push(code.value); } };
      runInNewContext(script, {
        URLSearchParams,
        location: { hash },
        history: { replaceState: (...args: unknown[]) => { replaced.push(args); } },
        document: { getElementById: (id: string) => (id === 'bridge' ? bridge : id === 'problem' ? problem : null) }
      });
      return { submitted, problem, replaced };
    }

    it('#code= con la forma de Lumbre: se envía, y la URL se limpia', async () => {
      const result = run(await scriptOf(), `#code=${CODE}`);
      expect(result.submitted).toEqual([CODE]);
      expect(result.problem.hidden).toBe(true);
      expect(result.replaced).toEqual([[null, '', '/lumbre/connect']]);
    });

    it.each(['', '#', '#code=basura', `#code=${CODE.toUpperCase()}`, `#code=${CODE}&code=${CODE}`, `#otro=${CODE}`, `#code=${CODE}00`])(
      'fragmento %j: no se envía, se limpia la URL y la página ofrece volver a autorizar', async (hash) => {
        const result = run(await scriptOf(), hash);
        expect(result.submitted).toEqual([]);
        expect(result.problem.hidden).toBe(false);
        expect(result.replaced).toEqual([[null, '', '/lumbre/connect']]);
      });
  });

  it('el POST del formulario, con el Host y el Origin de producción, llega al servicio con el código', async () => {
    exchange.mockRejectedValue(new PairError('exchange_rejected', 401));
    const reply = await post({ cookie, origin: REMOTE_PAIRING_ORIGIN });
    // 400 de "código no reconocido": pasó el filtro de la app, el del router y la forma del código.
    expect(reply.status).toBe(400);
    expect(exchange).toHaveBeenCalledOnce();
    expect(exchange.mock.calls[0]![0]).toMatchObject({ code: CODE });
  });

  it('un POST con Origin null (referrer no-referrer) o ajeno se rechaza sin tocar el servicio', async () => {
    expect((await post({ cookie, origin: 'null' })).status).toBe(403);
    expect((await post({ cookie, origin: 'https://evil.example' })).status).toBe(403);
    expect(exchange).not.toHaveBeenCalled();
  });
});
