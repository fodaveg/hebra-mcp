import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PairError } from '../../src/pair/errors';
import { RemotePairingJournalStore } from '../../src/pair/remote/journal';
import { escapeRemoteHtml } from '../../src/pair/remote/pages';
import { createRemotePairingRouter } from '../../src/pair/remote/router';
import { REMOTE_PAIRING_ORIGIN, RemotePairingService } from '../../src/pair/remote/service';

describe('router del emparejado remoto', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    }
    server = null;
  });

  it('rechaza callback sin cookie y POST desde otro origen antes de consumir el formulario', async () => {
    const service = {
      sessionForCookie: vi.fn(async () => null)
    } as unknown as RemotePairingService;
    const app = express();
    app.use(createRemotePairingRouter(service, {
      resumeOauth: async () => '/oauth/continue',
      cancelOauth: async () => undefined,
      reauthenticate: async () => undefined
    }));
    const address = await listen(app);

    const callback = await fetch(`${address}/lumbre/connect`);
    expect(callback.status).toBe(403);
    expect(callback.headers.get('cache-control')).toBe('private, no-store');

    const crossed = await fetch(`${address}/lumbre/connect`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        cookie: '__Host-hebra_mcp_pair=other-browser',
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: 'form_token=token&code=code'
    });
    expect(crossed.status).toBe(403);
    expect(service.sessionForCookie).not.toHaveBeenCalled();
  });

  it('Lumbre rechaza el registro del agente (401): página que dice qué se sabe, la solicitud OAuth se cierra y no es la genérica', async () => {
    const { RemotePairingError } = await import('../../src/pair/remote/types');
    const service = {
      sessionForCookie: vi.fn(async () => ({ id: 's', oauthRequestId: 'oauth-1', sub: 'sumego|david' })),
      receiveCredential: vi.fn(async () => { throw new RemotePairingError('agent_rejected', 'tokens_kept'); })
    } as unknown as RemotePairingService;
    const cancelOauth = vi.fn(async () => undefined);
    const app = express();
    app.use(createRemotePairingRouter(service, { resumeOauth: async () => '/x', cancelOauth, reauthenticate: async () => undefined }));
    const address = await listen(app);
    const reply = await fetch(`${address}/lumbre/connect`, { method: 'POST',
      headers: { origin: REMOTE_PAIRING_ORIGIN, cookie: '__Host-hebra_mcp_pair=c', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ form_token: 't', code: 'ab'.repeat(32) }) });
    expect(reply.status).toBe(409);
    const html = await reply.text();
    expect(html).toContain('Lumbre rechaza esta conexión');
    expect(html).toContain('Comprueba en Hebra que el agente está activado');
    expect(html).toContain('no hace falta que vuelvas a conectar');
    expect(html).not.toContain('está desactivado en Hebra');
    expect(html).not.toContain('No disponible');
    expect(cancelOauth).toHaveBeenCalledWith({ oauthRequestId: 'oauth-1' });
    expect(reply.headers.get('set-cookie')).toMatch(/__Host-hebra_mcp_pair=;/);
  });

  it('un 429 de /exchange: página con Retry-After, sin cerrar la solicitud OAuth ni la cookie', async () => {
    const { RemotePairingError } = await import('../../src/pair/remote/types');
    const service = {
      sessionForCookie: vi.fn(async () => ({ id: 's', oauthRequestId: 'oauth-1', sub: 'sumego|david' })),
      noticeForCookie: vi.fn(async () => null),
      receiveCredential: vi.fn(async () => { throw new RemotePairingError('rate_limited', 'exchange_failed:429', 23); })
    } as unknown as RemotePairingService;
    const cancelOauth = vi.fn(async () => undefined);
    const app = express();
    app.use(createRemotePairingRouter(service, { resumeOauth: async () => '/x', cancelOauth, reauthenticate: async () => undefined }));
    const address = await listen(app);
    const reply = await fetch(`${address}/lumbre/connect`, { method: 'POST',
      headers: { origin: REMOTE_PAIRING_ORIGIN, cookie: '__Host-hebra_mcp_pair=c', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ form_token: 't', code: 'ab'.repeat(32) }) });
    expect(reply.status).toBe(429);
    expect(reply.headers.get('retry-after')).toBe('23');
    expect(await reply.text()).toContain('Espera unos 23 segundos');
    expect(cancelOauth).not.toHaveBeenCalled();
    expect(reply.headers.get('set-cookie')).toBeNull();
  });

  it('confirmar sin la casilla de pérdida: vuelve a enseñar la vista previa, sin cancelar la solicitud OAuth', async () => {
    const { RemotePairingError } = await import('../../src/pair/remote/types');
    const preview = { titles: [], vaultCreatedAt: '2026-01-01T00:00:00.000Z', recordsRead: 0, more: false,
      replacesLibrary: true, pendingWrites: 4 };
    const confirm = vi.fn(async () => { throw new RemotePairingError('loss_unconfirmed'); });
    const service = {
      sessionForCookie: vi.fn(async () => ({ id: 's', oauthRequestId: 'oauth-1', sub: 'sumego|david' })),
      confirm,
      previewOf: vi.fn(async () => preview),
      formToken: vi.fn(async () => 'nuevo')
    } as unknown as RemotePairingService;
    const cancelOauth = vi.fn(async () => undefined);
    const app = express();
    app.use(createRemotePairingRouter(service, { resumeOauth: async () => '/x', cancelOauth, reauthenticate: async () => undefined }));
    const address = await listen(app);
    const post = (body: Record<string, string>) => fetch(`${address}/lumbre/pairing/confirm`, { method: 'POST',
      headers: { origin: REMOTE_PAIRING_ORIGIN, cookie: '__Host-hebra_mcp_pair=c', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body) });
    const reply = await post({ form_token: 't' });
    expect(reply.status).toBe(409);
    const html = await reply.text();
    expect(html).toContain('4 escrituras');
    expect(html).toContain('Marca la casilla');
    expect(html).toContain('value="nuevo"');
    expect(cancelOauth).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenLastCalledWith('s', expect.anything(), { acknowledgeLoss: false });
    await post({ form_token: 't', accept_loss: '1' });
    expect(confirm).toHaveBeenLastCalledWith('s', expect.anything(), { acknowledgeLoss: true });
  });

  it('demasiados códigos rechazados: la transacción y la solicitud OAuth terminan con una página clara', async () => {
    const { RemotePairingError } = await import('../../src/pair/remote/types');
    const service = {
      sessionForCookie: vi.fn(async () => ({ id: 's', oauthRequestId: 'oauth-1', sub: 'sumego|david' })),
      receiveCredential: vi.fn(async () => { throw new RemotePairingError('too_many_codes', 'rejected_codes'); })
    } as unknown as RemotePairingService;
    const cancelOauth = vi.fn(async () => undefined);
    const app = express();
    app.use(createRemotePairingRouter(service, { resumeOauth: async () => '/x', cancelOauth, reauthenticate: async () => undefined }));
    const address = await listen(app);
    const reply = await fetch(`${address}/lumbre/connect`, { method: 'POST',
      headers: { origin: REMOTE_PAIRING_ORIGIN, cookie: '__Host-hebra_mcp_pair=c', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ form_token: 't', code: 'ab'.repeat(32) }) });
    expect(reply.status).toBe(429);
    expect(await reply.text()).toContain('Demasiados intentos');
    expect(cancelOauth).toHaveBeenCalledWith({ oauthRequestId: 'oauth-1' });
    expect(reply.headers.get('set-cookie')).toMatch(/__Host-hebra_mcp_pair=;/);
  });

  describe('con el servicio real', () => {
    const NOW = Date.parse('2026-11-04T08:00:00.000Z');
    const CODE = 'ab'.repeat(32);
    let root: string;
    const exchange = vi.fn();

    afterEach(async () => { exchange.mockReset(); await rm(root, { recursive: true, force: true }); });

    async function app() {
      root = await mkdtemp(join(tmpdir(), 'hebra-remote-router-'));
      const journals = new RemotePairingJournalStore(join(root, 'journals'));
      const service = new RemotePairingService({ journals, now: () => NOW, exchangeCode: exchange,
        prepareAgent: async () => { throw new Error('no se llega'); },
        ownership: { verify: async () => { throw new Error('no se llega'); } },
        publisher: { publish: async () => ({ id: 'a', generation: 1 }), findCommitted: async () => null, cleanupOrphan: async () => undefined } });
      const started = await service.start({ oauthRequestId: 'oauth-1', sub: 'sumego|david', email: 'david@example.test',
        identityExpiresAt: new Date(NOW + 60_000).toISOString() });
      const application = express();
      application.use(createRemotePairingRouter(service, { resumeOauth: async () => '/x', cancelOauth: async () => undefined,
        reauthenticate: async () => undefined }));
      return { address: await listen(application), started, journals, service, cookie: `__Host-hebra_mcp_pair=${started.cookie}` };
    }

    const post = (address: string, cookie: string, body: Record<string, string>) => fetch(`${address}/lumbre/connect`, {
      method: 'POST', redirect: 'manual',
      headers: { origin: REMOTE_PAIRING_ORIGIN, cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body) });

    it('#code=basura sin una transacción de este navegador: la página no lleva el script que envía', async () => {
      const { address, journals, started } = await app();
      const noCookie = await fetch(`${address}/lumbre/connect`);
      expect(noCookie.status).toBe(403);
      const noCookieHtml = await noCookie.text();
      expect(noCookieHtml).not.toContain('<script');
      expect(noCookieHtml).not.toContain('form_token');
      const stranger = await fetch(`${address}/lumbre/connect`, { headers: { cookie: '__Host-hebra_mcp_pair=ajena' } });
      expect(stranger.status).toBe(403);
      expect(await stranger.text()).not.toContain('<script');
      expect(exchange).not.toHaveBeenCalled();
      expect(await journals.read(started.id)).toMatchObject({ phase: 'credential', cleanupRequired: false });
    });

    it('con la cookie, un código sin la forma de Lumbre no se persiste ni se canjea, y la transacción sigue', async () => {
      const { address, journals, started, cookie } = await app();
      const before = (await journals.read(started.id))!.csrfHash;
      const refused = await post(address, cookie, { form_token: started.formToken, code: 'basura' });
      expect(refused.status).toBe(403);
      expect(exchange).not.toHaveBeenCalled();
      const journal = (await journals.read(started.id))!;
      expect(journal).toMatchObject({ phase: 'credential', cleanupRequired: false });
      expect(journal.pairingCode).toBeUndefined();
      expect(journal.csrfHash).toBe(before);
      expect((await fetch(`${address}/lumbre/connect`, { headers: { cookie } })).status).toBe(200);
    });

    it('un código con forma válida que Lumbre rechaza deja volver a autorizar', async () => {
      const { address, journals, started, cookie } = await app();
      exchange.mockRejectedValue(new PairError('exchange_rejected', 401));
      const page = await post(address, cookie, { form_token: started.formToken, code: CODE });
      expect(page.status).toBe(400);
      const html = await page.text();
      expect(html).toContain('Continuar en Lumbre');
      expect(html).not.toContain(CODE);
      expect(await journals.read(started.id)).toMatchObject({ phase: 'credential', cleanupRequired: false });
    });

    it('el aviso previo nombra la cuenta y dice lo que hace falta antes de salir hacia Lumbre', async () => {
      const { address, started, cookie } = await app();
      const page = await fetch(`${address}/lumbre/pairing/start`, { headers: { cookie } });
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(page.headers.get('cache-control')).toBe('private, no-store');
      expect(html).toContain('david@example.test');
      expect(html).toContain('Hebra instalada con esta misma cuenta');
      expect(html).toContain('código de recuperación exportado');
      expect(html).toContain(escapeRemoteHtml(new URL(started.authorizationUrl).toString()));
      expect((await fetch(`${address}/lumbre/pairing/start`)).status).toBe(403);
    });

    it('una vez recibido el código, la página puente no vuelve a enviar nada', async () => {
      const { address, journals, started, cookie } = await app();
      const journal = (await journals.read(started.id))!;
      journal.phase = 'approval';
      await journals.write(journal);
      const html = await (await fetch(`${address}/lumbre/connect`, { headers: { cookie } })).text();
      expect(html).not.toContain('<script');
      expect(html).toContain('Aprueba en Hebra');
    });
  });

  async function listen(app: express.Express): Promise<string> {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve);
      server!.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listen_failed');
    return `http://127.0.0.1:${address.port}`;
  }
});
