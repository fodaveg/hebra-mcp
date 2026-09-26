/**
 * De los secretos del llavero (`src/secrets/`) a lo que necesitan el `SyncRunner` de L3a y
 * el relé (SPEC.md §6.1, §7.4), igual que `resolveLibrarySyncIdentity`
 * (`library/identity.ts` de Hebra), pero con el llavero del SO en vez de Keychain de Tauri
 * o IndexedDB:
 *
 * - La bóveda (`relayOrigin`, `syncVaultId`), `vaultKey` y `keyEpoch` salen del código de
 *   recuperación (`decodeRecoveryCode`).
 * - Si el relé de la credencial no es el del código, no hay sync (Hebra devuelve `null` en
 *   el mismo caso): `null`.
 * - `registerLinkedDevice` registra `opaqueDeviceId` en la bóveda (`POST
 *   …/blob-v2/vaults/{id}/devices`, `HDR2`). Sin ese registro, la fila de la bóveda no
 *   existe para esta credencial y la primera ronda recibe 404 (FUGA-SYNC-02 de Hebra). Es
 *   idempotente en el relé, así que se llama en `pair` y en cada arranque de `serve`.
 */
import {
  buildDeviceRegistration,
  classifyError,
  decodeRecoveryCode,
  HttpBlobRelayV2,
  type BlobRelayConnectionProviderV2,
  type SyncEngineIdentity
} from '../hebra';
import type { PairedSecrets } from '../secrets';
import type { LibrarySyncConfig } from './library-instance';
import type { SyncEmit } from './runner';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface LinkedSync {
  identity: SyncEngineIdentity;
  opaqueDeviceId: string;
  connection: BlobRelayConnectionProviderV2;
  /** Para `LibraryInstance.open({ sync })`. */
  config: LibrarySyncConfig;
}

export async function linkedSyncFrom(
  secrets: PairedSecrets,
  options: { fetcher?: Fetcher; emit?: SyncEmit; intervalMs?: number | null } = {}
): Promise<LinkedSync | null> {
  const recovered = await decodeRecoveryCode(secrets.recoveryCode);
  if (new URL(secrets.connection.apiOrigin).origin !== recovered.relayOrigin) return null;
  const { apiOrigin, readToken, writeToken } = secrets.connection;
  const connection: BlobRelayConnectionProviderV2 = async () => ({
    apiOrigin,
    readToken,
    writeToken
  });
  const identity: SyncEngineIdentity = {
    relayOrigin: recovered.relayOrigin,
    syncVaultId: recovered.syncVaultId
  };
  return {
    identity,
    opaqueDeviceId: secrets.device.opaqueDeviceId,
    connection,
    config: {
      identity,
      vaultKey: recovered.vaultKey,
      keyEpoch: recovered.keyEpoch,
      connection,
      fetcher: options.fetcher,
      emit: options.emit,
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs })
    }
  };
}

/**
 * Registra el dispositivo en la bóveda. Devuelve `ok` o el código cerrado del fallo
 * (`classifyError` del motor: `offline`, `http_401`…), sin lanzar.
 */
export async function registerLinkedDevice(
  linked: Pick<LinkedSync, 'identity' | 'opaqueDeviceId' | 'connection'>,
  fetcher?: Fetcher
): Promise<string> {
  const relay = new HttpBlobRelayV2(linked.connection, fetcher ?? globalThis.fetch.bind(globalThis));
  try {
    await relay.registerDevice(
      buildDeviceRegistration({
        syncVaultId: linked.identity.syncVaultId,
        opaqueDeviceId: linked.opaqueDeviceId
      })
    );
    return 'ok';
  } catch (error) {
    return classifyError(error).code;
  }
}
