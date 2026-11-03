import type { LumbreConnection } from '../../hebra';
import type { Fetcher } from '../lumbre';

const REVOKE_PATH = '/api/integrations/hebra/credential';

/** Revoca solo la credencial de esta instalación. No toca otras cuentas. */
export async function revokeRemoteCredential(
  connection: LumbreConnection,
  fetcher: Fetcher = globalThis.fetch.bind(globalThis)
): Promise<void> {
  const response = await fetcher(new URL(REVOKE_PATH, connection.apiOrigin), {
    method: 'DELETE',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${connection.writeToken}`
    }
  });
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error('pairing_revoke_failed'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('pairing_revoke_failed');
  }
  const record = body as Record<string, unknown>;
  // Primera revocación, o retry inequívoco autenticado por el error cerrado de Lumbre.
  const revoked = response.status === 200 && Object.keys(record).length === 1 && record.ok === true;
  const alreadyRevoked = response.status === 401 && record.status === 401 &&
    record.code === 'credential_revoked' && typeof record.message === 'string';
  if (!revoked && !alreadyRevoked) throw new Error('pairing_revoke_failed');
}
