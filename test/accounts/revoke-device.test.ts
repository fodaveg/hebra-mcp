/**
 * Una cuenta sin secretos legibles no se queda en `removing`: sin credencial no hay nada que
 * revocar en remoto, y la retirada termina dejando constancia en el log (D22).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revokeAccountDevice } from '../../src/accounts/revoke-device';
import { MemorySecretStore, writeConnection } from '../../src/secrets';

const CONNECTION = {
  credentialId: '11111111-1111-4111-8111-111111111111',
  readToken: 'read',
  writeToken: 'write',
  apiOrigin: 'https://app.lumbre.pro',
  connectedAt: '2026-11-04T08:00:00.000Z'
};

afterEach(() => vi.restoreAllMocks());

describe('revokeAccountDevice', () => {
  it('sin credencial guardada termina sin llamar a Lumbre y lo deja en el log', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetcher = vi.fn();
    await expect(revokeAccountDevice(new MemorySecretStore(), fetcher as never)).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(stderr.mock.calls.join('')).toContain('skipped_no_credential');
  });

  it('con credencial, aunque falte la identidad, la revoca', async () => {
    const store = new MemorySecretStore();
    await writeConnection(store, CONNECTION);
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    await revokeAccountDevice(store, fetcher as never);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('si Lumbre no confirma, la retirada falla y se reintenta', async () => {
    const store = new MemorySecretStore();
    await writeConnection(store, CONNECTION);
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(revokeAccountDevice(store, fetcher as never)).rejects.toThrow();
  });
});
