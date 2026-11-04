import { describe, expect, it, vi } from 'vitest';
import { MemorySecretStore, type PairedSecrets } from '../../src/secrets';
import { AgentDevice } from '../../src/spaces/device';

const paired: PairedSecrets = {
  connection: {
    credentialId: '11111111-1111-4111-8111-111111111111',
    readToken: 'read',
    writeToken: 'write',
    apiOrigin: 'https://app.lumbre.pro',
    connectedAt: '2026-11-03T08:00:00.000Z'
  },
  recoveryCode: 'recovery',
  device: { opaqueDeviceId: 'aa'.repeat(16), lumbreDeviceId: '22222222-2222-4222-8222-222222222222' }
};

/** SvelteKit rechaza como formulario cross-site un método que cambia datos sin `Content-Type`. */
describe('AgentDevice.request', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s sin cuerpo manda Content-Type: application/json', async (method) => {
    const secrets = new MemorySecretStore();
    const seen: Array<{ method?: string; contentType: string | null }> = [];
    const device = new AgentDevice(paired, secrets, async (_url, init) => {
      seen.push({ method: init?.method, contentType: new Headers(init?.headers).get('content-type') });
      return Response.json({ ok: true });
    });
    vi.spyOn(device, 'assertPairing').mockResolvedValue();
    await device.request('/x', method);
    expect(seen).toEqual([{ method, contentType: 'application/json' }]);
  });

  it('GET no lleva Content-Type', async () => {
    const secrets = new MemorySecretStore();
    let contentType: string | null = 'sin-medir';
    const device = new AgentDevice(paired, secrets, async (_url, init) => {
      contentType = new Headers(init?.headers).get('content-type');
      return Response.json({});
    });
    vi.spyOn(device, 'assertPairing').mockResolvedValue();
    await device.request('/x');
    expect(contentType).toBeNull();
  });

  it('un 429 del relé es "no disponible" con el Retry-After de Lumbre, no una denegación', async () => {
    const device = new AgentDevice(paired, new MemorySecretStore(), async () =>
      new Response('{}', { status: 429, headers: { 'retry-after': '17' } })
    );
    vi.spyOn(device, 'assertPairing').mockResolvedValue();
    await expect(device.request('/x')).rejects.toMatchObject({
      code: 'space_unavailable',
      extra: { reason: 'rate_limited', retryAfterSeconds: 17 }
    });
  });

  it('un 429 sin Retry-After válido propone un plazo por defecto', async () => {
    const device = new AgentDevice(paired, new MemorySecretStore(), async () =>
      new Response('{}', { status: 429, headers: { 'retry-after': 'mañana' } })
    );
    vi.spyOn(device, 'assertPairing').mockResolvedValue();
    await expect(device.request('/x')).rejects.toMatchObject({
      code: 'space_unavailable',
      extra: { reason: 'rate_limited', retryAfterSeconds: 5 }
    });
  });

  it('un 403 sigue siendo space_access_denied', async () => {
    const device = new AgentDevice(paired, new MemorySecretStore(), async () => new Response('{}', { status: 403 }));
    vi.spyOn(device, 'assertPairing').mockResolvedValue();
    await expect(device.request('/x')).rejects.toMatchObject({ code: 'space_access_denied' });
  });
});
