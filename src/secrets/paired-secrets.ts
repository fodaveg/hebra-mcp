/**
 * Los tres secretos del dispositivo emparejado (SPEC.md §6.1) y su formato en el llavero:
 *
 * | Entrada | Contenido |
 * |---|---|
 * | `lumbre-connection` | `LumbreConnection` en JSON: `credentialId`, `readToken`, `writeToken`, `apiOrigin`, `connectedAt` |
 * | `recovery-code` | el código de recuperación de la biblioteca (`hebra-recovery-v2:…`), que lleva la clave |
 * | `device-identity` | `{ opaqueDeviceId, lumbreDeviceId }` en JSON |
 *
 * `opaqueDeviceId` es el id del dispositivo en el relé (registro de `…/blob-v2/…/devices`);
 * `lumbreDeviceId`, el uuid al que Lumbre ata el código de emparejado y la credencial
 * (mismo reparto que `TestVaultState` en `test-vault.ts` de Hebra). La bóveda
 * (`syncVaultId`, `relayOrigin`, `vaultKey`) no se guarda aparte: sale del código de
 * recuperación al arrancar.
 *
 * Un valor que no tiene la forma esperada se trata como AUSENTE, sin enseñarlo: el
 * proceso arranca sin emparejar y `pair` lo vuelve a escribir.
 */
import type { LumbreConnection } from '../hebra';
import { SECRET_KEYS, type SecretStore } from './secret-store';

export interface DeviceIdentity {
  opaqueDeviceId: string;
  lumbreDeviceId: string;
}

export interface PairedSecrets {
  connection: LumbreConnection;
  recoveryCode: string;
  device: DeviceIdentity;
}

const LOWER_HEX_16 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECOVERY_CODE = /^hebra-recovery-v2:[A-Za-z0-9_-]+$/;

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseConnection(raw: string | null): LumbreConnection | null {
  const value = parseJson(raw);
  if (
    !value ||
    !isNonEmpty(value.credentialId) ||
    !isNonEmpty(value.readToken) ||
    !isNonEmpty(value.writeToken) ||
    !isNonEmpty(value.apiOrigin) ||
    !isNonEmpty(value.connectedAt)
  ) {
    return null;
  }
  try {
    const url = new URL(value.apiOrigin);
    if (url.protocol !== 'https:' || url.origin !== value.apiOrigin) return null;
  } catch {
    return null;
  }
  return {
    credentialId: value.credentialId,
    readToken: value.readToken,
    writeToken: value.writeToken,
    apiOrigin: value.apiOrigin,
    connectedAt: value.connectedAt
  };
}

export function parseDeviceIdentity(raw: string | null): DeviceIdentity | null {
  const value = parseJson(raw);
  if (
    !value ||
    typeof value.opaqueDeviceId !== 'string' ||
    !LOWER_HEX_16.test(value.opaqueDeviceId) ||
    typeof value.lumbreDeviceId !== 'string' ||
    !UUID.test(value.lumbreDeviceId)
  ) {
    return null;
  }
  return { opaqueDeviceId: value.opaqueDeviceId, lumbreDeviceId: value.lumbreDeviceId };
}

function parseRecoveryCode(raw: string | null): string | null {
  return raw !== null && RECOVERY_CODE.test(raw) ? raw : null;
}

/** La identidad ya guardada (código de recuperación + dispositivo), sin la credencial:
 *  lo que `pair` necesita para renovar solo la credencial (§6.2, tras una revocación). */
export async function readStoredIdentity(
  store: SecretStore
): Promise<{ recoveryCode: string; device: DeviceIdentity } | null> {
  const [recoveryCode, device] = await Promise.all([
    store.get('recovery-code').then(parseRecoveryCode),
    store.get('device-identity').then(parseDeviceIdentity)
  ]);
  return recoveryCode && device ? { recoveryCode, device } : null;
}

/** Los tres secretos, o `null` si falta alguno o no tiene la forma esperada. */
export async function readPairedSecrets(store: SecretStore): Promise<PairedSecrets | null> {
  const [connection, identity] = await Promise.all([
    store.get('lumbre-connection').then(parseConnection),
    readStoredIdentity(store)
  ]);
  return connection && identity ? { connection, ...identity } : null;
}

/** Escribe la identidad primero y la credencial al final: un corte a medias deja una
 *  identidad sin credencial, que `pair` sabe completar, y nunca una credencial suelta. */
export async function writePairedSecrets(store: SecretStore, secrets: PairedSecrets): Promise<void> {
  await store.set('recovery-code', secrets.recoveryCode);
  await store.set('device-identity', JSON.stringify(secrets.device));
  await writeConnection(store, secrets.connection);
}

export async function writeConnection(store: SecretStore, connection: LumbreConnection): Promise<void> {
  await store.set(
    'lumbre-connection',
    JSON.stringify({
      credentialId: connection.credentialId,
      readToken: connection.readToken,
      writeToken: connection.writeToken,
      apiOrigin: connection.apiOrigin,
      connectedAt: connection.connectedAt
    })
  );
}

/** Borra las tres entradas. Devuelve cuántas había. */
export async function clearPairedSecrets(store: SecretStore): Promise<number> {
  let deleted = 0;
  for (const key of SECRET_KEYS) {
    if (await store.delete(key)) deleted += 1;
  }
  return deleted;
}
