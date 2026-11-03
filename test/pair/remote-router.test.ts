import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemotePairingRouter } from '../../src/pair/remote/router';
import type { RemotePairingService } from '../../src/pair/remote/service';

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
      sessionForCookie: vi.fn(async () => null),
      authorizeForm: vi.fn(async () => undefined)
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
    expect(service.authorizeForm).not.toHaveBeenCalled();
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
