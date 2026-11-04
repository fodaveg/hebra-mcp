/**
 * El catálogo de espacios se limita por bytes de respuesta, no por número de espacios (D22,
 * SPEC.md §12.10). Pasarse cierra: `space_access_denied`, sin usar nada de lo leído.
 */
import { describe, expect, it, vi } from 'vitest';
import { MemorySecretStore, type PairedSecrets } from '../../src/secrets';
import { AgentDevice } from '../../src/spaces/device';
import { catalogueSchema, DEVICE_RESPONSE_MAX_BYTES } from '../../src/spaces/protocol';

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

const base64 = (bytes: number) => Buffer.alloc(bytes, 7).toString('base64url');

/** Un espacio con la forma exacta que valida `parseAgentSpaceGrant`. */
function space(index: number): object {
  const spaceId = `${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  const syncVaultId = 'ab'.repeat(16);
  return {
    spaceId,
    syncVaultId,
    grant: {
      v: 1, spaceId, syncVaultId, accountId: 'cd'.repeat(32), credentialId: paired.connection.credentialId,
      deviceId: 'dispositivo', keyId: 'ef'.repeat(32),
      // Un punto válido de P-256 (el generador de la curva), en base64url canónico.
      ephemeralPublicKey: { kty: 'EC', crv: 'P-256',
        x: 'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY', y: 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU' },
      salt: base64(32), iv: base64(12), ciphertext: base64(48)
    }
  };
}

function deviceAnswering(answer: () => Response): AgentDevice {
  const device = new AgentDevice(paired, new MemorySecretStore(), async () => answer());
  vi.spyOn(device, 'assertPairing').mockResolvedValue();
  return device;
}

describe('catálogo de espacios', () => {
  it('1 500 espacios se aceptan: no hay máximo por número', async () => {
    const spaces = Array.from({ length: 1500 }, (_, index) => space(index));
    const body = JSON.stringify({ spaces });
    expect(Buffer.byteLength(body)).toBeLessThan(DEVICE_RESPONSE_MAX_BYTES);
    const read = await deviceAnswering(() => new Response(body)).request('/spaces/agent-access');
    expect(catalogueSchema.parse(read).spaces).toHaveLength(1500);
  });

  it('una respuesta que declara más bytes del tope se rechaza sin leerla', async () => {
    const answer = new Response('{"spaces":[]}', { headers: { 'content-length': String(DEVICE_RESPONSE_MAX_BYTES + 1) } });
    const read = vi.spyOn(answer.body!, 'getReader');
    await expect(deviceAnswering(() => answer).request('/spaces/agent-access'))
      .rejects.toMatchObject({ code: 'space_access_denied' });
    expect(read).not.toHaveBeenCalled();
  });

  it('una respuesta que no declara su tamaño se corta en cuanto pasa del tope, sin leerla entera', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    let sent = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) { sent += chunk.byteLength; controller.enqueue(chunk); },
      cancel() { cancelled = true; }
    }, { highWaterMark: 0 });
    await expect(deviceAnswering(() => new Response(endless)).request('/spaces/agent-access'))
      .rejects.toMatchObject({ code: 'space_access_denied' });
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThanOrEqual(DEVICE_RESPONSE_MAX_BYTES + chunk.byteLength);
  });

  it('justo en el tope, una respuesta válida pasa', async () => {
    const empty = '{"spaces":[]}';
    const body = `${' '.repeat(DEVICE_RESPONSE_MAX_BYTES - empty.length)}${empty}`;
    const read = await deviceAnswering(() => new Response(body)).request('/spaces/agent-access');
    expect(catalogueSchema.parse(read).spaces).toEqual([]);
  });
});
