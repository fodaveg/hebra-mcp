import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LumbreBackchannel } from '../../src/oauth/backchannel';
import { ExchangeDelivery } from '../../src/oauth/exchange-delivery';
import { GrantSecrets } from '../../src/oauth/grants';
import { FileSecretStore, MemorySecretStore, type SecretStore } from '../../src/secrets';

const origin = 'https://hebra.example.test';
const resource = 'https://mcp.example.test/mcp';
const secret = 'test-backchannel-secret'.repeat(3);
const idToken = 'synthetic-id-token-only-in-memory';
const journal = 'hebra-mcp-oauth-exchange-deliveries';
const pending = 'hebra-mcp-oauth-pending';
const ids = { requestId: 'ac000000-0000-4000-8000-000000000001', transactionId: 'A'.repeat(43) };
const grant = {
  credentialId: 'ac000000-0000-4000-8000-000000000002', accessToken: 'ab'.repeat(32), tokenType: 'Bearer',
  clientId: 'hebra-mcp-codex-127', resource, scope: 'hebra:mcp', accountId: 'ac'.repeat(32),
  pairedCredentialId: 'ac000000-0000-4000-8000-000000000003', syncVaultId: 'ad'.repeat(16),
  opaqueDeviceId: 'ae'.repeat(16), expiresAt: '2027-01-01T00:00:00.000Z'
};
const { accessToken: _token, tokenType: _type, ...metadata } = grant;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const prefix = '/api/integrations/hebra-mcp/';
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Handler = (path: string, body: Record<string, unknown>) => Response | Promise<Response>;
function upstream(handle: Handler) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe(origin);
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
    return handle(url.pathname.slice(prefix.length), JSON.parse(String(init?.body)));
  });
}

async function broker(store: SecretStore, fetcher: ReturnType<typeof upstream>) {
  const grants = await GrantSecrets.open(store, []);
  const backchannel = new LumbreBackchannel(secret, resource, origin, fetcher);
  const delivery = new ExchangeDelivery(store, grants, backchannel, resource);
  return { grants, delivery, send: (deliveryId?: string) => backchannel.sumegoExchange({ ...ids, idToken, clientId: grant.clientId, deliveryId }) };
}

describe('entrega recuperable en el backchannel de Hebra', () => {
  it('reintenta la misma solicitud tras perder la respuesta y sella el bearer antes del ACK y al promocionarlo', async () => {
    const store = new MemorySecretStore();
    const bodies: Record<string, unknown>[] = [];
    const calls: string[] = [];
    const fetcher = upstream(async (path, body) => {
      calls.push(path);
      if (path === 'exchange/capabilities') return json({ deliveryId: true });
      if (path === 'sumego/exchange') {
        const saved = await store.get(journal);
        expect(saved).toContain(String(body.deliveryId));
        expect(saved).not.toContain(idToken);
        expect(saved).not.toContain(secret);
        bodies.push(body);
        if (bodies.length === 1) throw new Error('respuesta perdida');
        return json(grant);
      }
      if (path === 'introspect') return json({ active: true, ...metadata });
      if (path === 'exchange/ack') {
        expect(body).toEqual({ ...ids, deliveryId: bodies[0]!.deliveryId });
        expect(await store.get(pending)).toContain('sealedToken');
        expect(await store.get(pending)).not.toContain(grant.accessToken);
        return json({ acknowledged: true });
      }
      throw new Error('ruta inesperada');
    });
    const first = await broker(store, fetcher);
    const result = await first.delivery.exchange(ids, first.send);
    expect(result.grant.accessToken).toBe(grant.accessToken);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(calls).toEqual(['exchange/capabilities', 'sumego/exchange', 'exchange/capabilities', 'sumego/exchange', 'introspect', 'exchange/ack']);
    const familyId = 'B'.repeat(22);
    await first.grants.markPromoting(result.stageHash!, familyId);
    await first.grants.set(familyId, result.grant.accessToken, [familyId], result.stageHash);
    const sealedFamilies = await store.get('hebra-mcp-oauth-grants');
    expect(sealedFamilies).toContain('v1.');
    expect(sealedFamilies).not.toContain(grant.accessToken);
    const reopened = await GrantSecrets.open(store, [familyId]);
    const revoke = vi.fn(async () => {});
    await GrantSecrets.recoverPending(store, [familyId], reopened, revoke);
    expect(reopened.get(familyId)).toBe(grant.accessToken);
    expect(revoke).not.toHaveBeenCalled();
    expect(await store.get(journal)).toBe('[]');
  });

  it('reinicia con solo el diario, espera confirmación y recupera únicamente para revocar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hebra-exchange-delivery-'));
    dirs.push(dir);
    const path = join(dir, 'control', 'secrets.json');
    const store = new FileSecretStore(path);
    const first = await broker(store, upstream(path => {
      if (path === 'exchange/capabilities') return json({ deliveryId: true });
      throw new Error('respuesta perdida');
    }));
    await expect(first.delivery.exchange(ids, first.send)).rejects.toMatchObject({ kind: 'unavailable' });
    const before = await store.get(journal);
    expect(before).not.toContain(idToken);
    expect(before).not.toContain(grant.accessToken);
    const reference = JSON.parse(before!)[0];
    const calls: string[] = [];
    let pendingReply = true;
    const reopened = new FileSecretStore(path);
    const after = await broker(reopened, upstream(async (path, body) => {
      calls.push(path);
      if (path === 'exchange/recover') {
        expect(body).toEqual({ ...ids, deliveryId: reference.deliveryId });
        return pendingReply ? json({ state: 'pending' }, 202) : json(grant);
      }
      if (path === 'revoke') {
        expect(body).toEqual({ accessToken: grant.accessToken });
        expect(await store.get(pending)).not.toContain(grant.accessToken);
        return json({ revoked: true });
      }
      if (path === 'exchange/ack') return json({ acknowledged: true });
      throw new Error('recuperar no debe emitir una concesión');
    }));
    await after.delivery.recover();
    expect(await store.get(journal)).toBe(before);
    pendingReply = false;
    await after.delivery.recover();
    expect(calls).toEqual(['exchange/recover', 'exchange/recover', 'revoke', 'exchange/ack']);
    expect(await store.get(journal)).toBe('[]');
    expect(await store.get(pending)).toBe('{}');
    expect(await store.get('hebra-mcp-oauth-grants')).toBe('{}');
  });

  it('rechaza un bearer que ya no es activo y cierra su diario con la negativa canónica', async () => {
    const store = new MemorySecretStore();
    const calls: string[] = [];
    const fetcher = upstream((path) => {
      calls.push(path);
      if (path === 'exchange/capabilities') return json({ deliveryId: true });
      if (path === 'sumego/exchange') return json(grant);
      if (path === 'introspect') return json({ active: false });
      if (path === 'exchange/recover') return json({ error: 'pairing_revoked' }, 410);
      throw new Error('ruta inesperada');
    });
    const first = await broker(store, fetcher);
    await expect(first.delivery.exchange(ids, first.send)).rejects.toMatchObject({ kind: 'inactive' });
    const reopened = await broker(store, fetcher);
    await reopened.delivery.recover();
    expect(calls).toEqual(['exchange/capabilities', 'sumego/exchange', 'introspect', 'exchange/recover']);
    expect(await store.get(journal)).toBe('[]');
  });

  it('si se pierde el ACK, el reinicio revoca desde el sobre local aunque Hebra ya lo hubiese confirmado', async () => {
    const store = new MemorySecretStore();
    const first = await broker(store, upstream(path => {
      if (path === 'exchange/capabilities') return json({ deliveryId: true });
      if (path === 'sumego/exchange') return json(grant);
      if (path === 'introspect') return json({ active: true, ...metadata });
      if (path === 'exchange/ack') throw new Error('ACK confirmado sin respuesta');
      throw new Error('ruta inesperada');
    }));
    await expect(first.delivery.exchange(ids, first.send)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(await store.get(pending)).not.toContain(grant.accessToken);
    const after = await broker(store, upstream(path => {
      expect(path).toBe('exchange/recover');
      return json({ error: 'transaction_not_found' }, 404);
    }));
    const revoke = vi.fn(async () => {});
    await GrantSecrets.recoverPending(store, [], after.grants, revoke);
    await after.delivery.recover();
    expect(revoke).toHaveBeenCalledWith(grant.accessToken);
    expect(await store.get(pending)).toBe('{}');
    expect(await store.get(journal)).toBe('[]');
  });

  it('con un servidor anterior solo envía el canje histórico una vez', async () => {
    const store = new MemorySecretStore();
    const fetcher = upstream((path, body) => {
      if (path === 'exchange/capabilities') return new Response(null, { status: 404 });
      expect(path).toBe('sumego/exchange');
      expect(body).not.toHaveProperty('deliveryId');
      throw new Error('respuesta perdida de un servidor anterior');
    });
    const first = await broker(store, fetcher);
    await expect(first.delivery.exchange(ids, first.send)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await store.get(journal)).toBeNull();
  });

  it('si un servidor pierde la capacidad entre intentos, conserva la obligación y evita reenviar', async () => {
    const store = new MemorySecretStore();
    const calls: string[] = [];
    const fetcher = upstream((path) => {
      calls.push(path);
      if (path === 'exchange/capabilities') return json({ deliveryId: calls.length === 1 });
      if (path === 'exchange/recover') return new Response('legacy 404', { status: 404 });
      throw new Error('respuesta perdida al último canje');
    });
    const first = await broker(store, fetcher);
    await expect(first.delivery.exchange(ids, first.send)).rejects.toMatchObject({ kind: 'unavailable' });
    const before = await store.get(journal);
    await first.delivery.recover();
    expect(calls).toEqual(['exchange/capabilities', 'sumego/exchange', 'exchange/capabilities', 'exchange/recover']);
    expect(await store.get(journal)).toBe(before);
  });
});
