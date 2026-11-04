/**
 * El directorio de organizaciones se limita por bytes como el catálogo (D22, SPEC.md §12.10):
 * pasarse da `organizations_unavailable`, sin leer la respuesta entera.
 */
import { describe, expect, it, vi } from 'vitest';
import { MemorySecretStore, type PairedSecrets } from '../../src/secrets';
import { AgentDevice } from '../../src/spaces/device';
import { fetchAgentDirectory } from '../../src/spaces/directory';
import { DEVICE_RESPONSE_MAX_BYTES } from '../../src/spaces/protocol';

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

function device(): AgentDevice {
  const d = new AgentDevice(paired, new MemorySecretStore(), async () => new Response());
  vi.spyOn(d, 'assertPairing').mockResolvedValue();
  return d;
}

describe('directorio de organizaciones', () => {
  it('una respuesta sin tamaño declarado se corta en cuanto pasa del tope', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    let sent = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) { sent += chunk.byteLength; controller.enqueue(chunk); },
      cancel() { cancelled = true; }
    }, { highWaterMark: 0 });
    await expect(fetchAgentDirectory(device(), async () => new Response(endless)))
      .rejects.toMatchObject({ code: 'organizations_unavailable', extra: { reason: 'invalid_response' } });
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThanOrEqual(DEVICE_RESPONSE_MAX_BYTES + chunk.byteLength);
  });

  it('una respuesta que declara más bytes del tope no se lee', async () => {
    const answer = new Response('{"organizations":[]}', {
      headers: { 'content-length': String(DEVICE_RESPONSE_MAX_BYTES + 1) }
    });
    const read = vi.spyOn(answer.body!, 'getReader');
    await expect(fetchAgentDirectory(device(), async () => answer))
      .rejects.toMatchObject({ code: 'organizations_unavailable', extra: { reason: 'invalid_response' } });
    expect(read).not.toHaveBeenCalled();
  });
});
