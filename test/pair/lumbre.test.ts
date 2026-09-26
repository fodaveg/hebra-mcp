/**
 * Credencial de Lumbre (SPEC.md §7.1): PKCE (obligación 4), canje sin `Origin` con el
 * `fetch` REAL de Node (obligación 6) y la guarda de cuenta de `lumbre-pairing.ts`.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PairError } from '../../src/pair/errors';
import {
  checkPairingAccount,
  exchangePairingCode,
  normalizeLumbreOrigin,
  pairingUrl
} from '../../src/pair/lumbre';
import { FakeLumbre, LUMBRE } from './fake-lumbre';

const DEVICE_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab';
const VAULT = 'cd'.repeat(16);

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

describe('pairingUrl', () => {
  it('(4) verifier de 32 bytes aleatorios o más, nuevo en cada flujo, y challenge S256', async () => {
    const input = {
      lumbreOrigin: LUMBRE,
      deviceId: DEVICE_ID,
      label: 'Claude (hebra-mcp)',
      webOrigin: 'http://127.0.0.1:4321'
    };
    const first = await pairingUrl(input);
    const second = await pairingUrl(input);
    expect(Buffer.from(first.verifier, 'base64url').byteLength).toBeGreaterThanOrEqual(32);
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(first.verifier).not.toBe(second.verifier);

    const url = new URL(first.url);
    expect(url.origin + url.pathname).toBe(`${LUMBRE}/integrations/hebra`);
    expect(url.searchParams.get('deviceId')).toBe(DEVICE_ID);
    expect(url.searchParams.get('label')).toBe('Claude (hebra-mcp)');
    expect(url.searchParams.get('webOrigin')).toBe('http://127.0.0.1:4321');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(challengeOf(first.verifier));
    // El verifier nunca viaja en la URL.
    expect(first.url).not.toContain(first.verifier);
  });

  it('solo admite un origen https sin ruta', () => {
    expect(normalizeLumbreOrigin('https://app.lumbre.pro')).toBe('https://app.lumbre.pro');
    for (const bad of ['http://app.lumbre.pro', 'https://app.lumbre.pro/x', 'https://u:p@a.pro', 'nada']) {
      expect(() => normalizeLumbreOrigin(bad)).toThrow(PairError);
    }
  });
});

describe('exchangePairingCode', () => {
  let seen: { headers: IncomingHttpHeaders; body: string }[];
  let status: number;
  let server: ReturnType<typeof createServer>;
  let origin: string;

  beforeEach(async () => {
    seen = [];
    status = 200;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ credentialId: 'c1', readToken: 'r1', writeToken: 'w1' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('(6) el fetch de Node no manda Origin: el canje sale sin esa cabecera', async () => {
    const connection = await exchangePairingCode({
      apiOrigin: origin,
      code: 'ab'.repeat(32),
      deviceId: DEVICE_ID,
      verifier: 'v'.repeat(43),
      fetcher: globalThis.fetch.bind(globalThis)
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.origin).toBeUndefined();
    expect(seen[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen[0].body)).toEqual({
      code: 'ab'.repeat(32),
      deviceId: DEVICE_ID,
      code_verifier: 'v'.repeat(43)
    });
    expect(connection).toMatchObject({ credentialId: 'c1', readToken: 'r1', writeToken: 'w1', apiOrigin: origin });
  });

  it('un 401 de Lumbre es exchange_rejected', async () => {
    status = 401;
    const failure = await exchangePairingCode({
      apiOrigin: origin,
      code: 'ab'.repeat(32),
      deviceId: DEVICE_ID,
      verifier: 'v'.repeat(43),
      fetcher: globalThis.fetch.bind(globalThis)
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PairError);
    expect((failure as PairError).code).toBe('exchange_rejected');
  });
});

describe('checkPairingAccount (lumbre-pairing.ts de Hebra)', () => {
  let fake: FakeLumbre;
  beforeEach(async () => {
    fake = await FakeLumbre.start();
    fake.addLibraryVault('david', VAULT);
  });
  afterEach(async () => {
    await fake.close();
  });

  function connectionOf(userId: string, credentialId: string) {
    return fake.addLinkedApprover(userId, VAULT, credentialId);
  }

  it('sin identidad guardada se acepta sin tocar la red', async () => {
    await checkPairingAccount({ connection: connectionOf('otra', 'c-otra'), vault: null, fetcher: fake.fetcher });
    expect(fake.requested).toEqual([]);
  });

  it('misma cuenta: 200 y se acepta', async () => {
    await checkPairingAccount({
      connection: connectionOf('david', 'c-david'),
      vault: { relayOrigin: LUMBRE, syncVaultId: VAULT },
      fetcher: fake.fetcher
    });
  });

  it('otra cuenta: 404 al leer la bóveda y se rechaza', async () => {
    const failure = await checkPairingAccount({
      connection: connectionOf('otra', 'c-otra'),
      vault: { relayOrigin: LUMBRE, syncVaultId: VAULT },
      fetcher: fake.fetcher
    }).catch((error: unknown) => error);
    expect((failure as PairError).code).toBe('account_mismatch');
  });

  it('otro relé: se rechaza sin preguntar', async () => {
    const failure = await checkPairingAccount({
      connection: connectionOf('david', 'c-david'),
      vault: { relayOrigin: 'https://otro.test', syncVaultId: VAULT },
      fetcher: fake.fetcher
    }).catch((error: unknown) => error);
    expect((failure as PairError).code).toBe('account_mismatch');
    expect(fake.requested).toEqual([]);
  });

  it('cualquier otro fallo: cerrado ante la duda', async () => {
    const failure = await checkPairingAccount({
      connection: connectionOf('david', 'c-david'),
      vault: { relayOrigin: LUMBRE, syncVaultId: VAULT },
      fetcher: async () => new Response('', { status: 500 })
    }).catch((error: unknown) => error);
    expect((failure as PairError).code).toBe('account_unverified');
  });
});
