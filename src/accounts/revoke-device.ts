import { logEvent } from '../log/logger';
import type { Fetcher } from '../pair/lumbre';
import { revokeRemoteCredential } from '../pair/remote/revoke';
import type { SecretStore } from '../secrets';
import { parseConnection } from '../secrets/paired-secrets';

/**
 * La revocación remota de una cuenta que se retira (`AccountRemovalService.revokeDevice`).
 *
 * Sin secretos legibles no hay credencial que revocar en Lumbre: la retirada termina igual y el log
 * dice que no se revocó nada. Lanzar aquí dejaría la cuenta en `removing` para siempre, y con ella
 * a la persona fuera hasta que un operador interviniera (D22). Un fallo al LEER el store sí lanza:
 * ahí puede haber una credencial viva que no se ve.
 */
export async function revokeAccountDevice(store: SecretStore, fetcher?: Fetcher): Promise<void> {
  // Solo hace falta la credencial: una identidad ausente no impide revocarla.
  const connection = parseConnection(await store.get('lumbre-connection'));
  if (!connection) {
    logEvent({ event: 'account.removal.revoke', result: 'skipped_no_credential' });
    return;
  }
  await revokeRemoteCredential(connection, fetcher);
}
