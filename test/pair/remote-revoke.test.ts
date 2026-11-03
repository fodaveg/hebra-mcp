import { describe, expect, it } from 'vitest';
import type { LumbreConnection } from '../../src/hebra';
import { revokeRemoteCredential } from '../../src/pair/remote/revoke';

const connection: LumbreConnection = {
  credentialId: '11111111-1111-4111-8111-111111111111',
  readToken: 'read',
  writeToken: 'write',
  apiOrigin: 'https://app.lumbre.pro',
  connectedAt: '2026-11-03T08:00:00.000Z'
};

describe('revokeRemoteCredential', () => {
  it('solo acepta una revocación positiva inequívoca', async () => {
    await expect(revokeRemoteCredential(connection, async () => Response.json({ ok: true })))
      .resolves.toBeUndefined();
    await expect(revokeRemoteCredential(connection, async (_url, init) => {
      expect(new Headers(init?.headers).get('accept')).toBe('application/json');
      return Response.json(
        { code: 'credential_revoked', status: 401, message: 'Credencial de Hebra no válida' },
        { status: 401 }
      );
    })).resolves.toBeUndefined();
    await expect(revokeRemoteCredential(connection, async () => new Response(null, { status: 204 })))
      .rejects.toThrow('pairing_revoke_failed');
    await expect(revokeRemoteCredential(connection, async () => new Response('<html>proxy</html>', { status: 200 })))
      .rejects.toThrow('pairing_revoke_failed');
    await expect(revokeRemoteCredential(connection, async () => new Response(null, { status: 404 })))
      .rejects.toThrow('pairing_revoke_failed');
    await expect(revokeRemoteCredential(connection, async () => new Response(null, { status: 410 })))
      .rejects.toThrow('pairing_revoke_failed');
    await expect(revokeRemoteCredential(connection, async () => Response.json(
      { code: 'other_auth_error', status: 401, message: 'No' },
      { status: 401 }
    ))).rejects.toThrow('pairing_revoke_failed');
  });
});
