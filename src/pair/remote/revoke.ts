import type { LumbreConnection } from '../../hebra';
import type { Fetcher } from '../lumbre';

const REVOKE_PATH = '/api/integrations/hebra/credential';

/** Revocación no confirmada; guarda solo el estado HTTP (nunca el cuerpo) para el log. */
export class RevokeError extends Error {
  constructor(readonly status: number) {
    super('pairing_revoke_failed');
    this.name = 'RevokeError';
  }
}

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
      // Sin `Content-Type`, la protección CSRF de SvelteKit trata el DELETE como un formulario
      // y lo rechaza con 403 antes de llegar al handler (incidente 3 nov 2026). El handler de
      // Lumbre ignora el cuerpo.
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.writeToken}`
    },
    body: '{}'
  });
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new RevokeError(response.status); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RevokeError(response.status);
  }
  const record = body as Record<string, unknown>;
  // Primera revocación, o retry inequívoco autenticado por el error cerrado de Lumbre.
  const revoked = response.status === 200 && Object.keys(record).length === 1 && record.ok === true;
  const alreadyRevoked = response.status === 401 && record.status === 401 &&
    record.code === 'credential_revoked' && typeof record.message === 'string';
  if (!revoked && !alreadyRevoked) throw new RevokeError(response.status);
}
