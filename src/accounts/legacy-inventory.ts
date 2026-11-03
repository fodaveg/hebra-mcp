import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SECRET_KEYS, type SecretStore } from '../secrets';

/** Cambiar la clasificación exige una migración/revisión explícita antes de borrar. */
export const LEGACY_INVENTORY_VERSION = 1;

const PERSONAL_ENTRIES = new Set([
  'library.sqlite', 'library.sqlite-shm', 'library.sqlite-wal',
  'blobs', 'config.json', 'spaces',
  'jd-plans.sqlite', 'jd-plans.sqlite-shm', 'jd-plans.sqlite-wal',
  'replace-plans.sqlite', 'replace-plans.sqlite-shm', 'replace-plans.sqlite-wal',
  'writer.lock', 'writer.sock', 'agent-key-lock'
]);

const GLOBAL_ENTRIES = new Set([
  'accounts', 'control', 'accounts-v1.json', 'oauth-tokens.json', 'oauth-revocations-v2.json',
  'oauth-logout-jtis.json', 'secrets.json', 'remote-pairing-v1'
]);

function globalTemporary(name: string): boolean {
  return /^\.(?:accounts-v1|oauth-tokens|oauth-revocations-v2|oauth-logout-jtis)\.json\..+\.tmp$/.test(name);
}
function personalEntry(name: string): boolean {
  return PERSONAL_ENTRIES.has(name) || /^\.secrets\.json\..+\.tmp$/.test(name);
}

export interface LegacyInventoryOptions {
  dataDir: string;
  secrets: SecretStore;
  /** Limpia diarios/filas personales en stores globales añadidos por otros módulos. */
  cleanupShared?(): Promise<void>;
}

/**
 * Inventario cerrado del `legacy-root`. Clasifica todo antes de tocar nada: una entrada
 * desconocida detiene la retirada y conserva los datos para ampliar el inventario.
 */
export async function eraseLegacyAccountData(options: LegacyInventoryOptions): Promise<void> {
  const entries = await readdir(options.dataDir);
  const unknown = entries.filter((name) => !personalEntry(name) && !GLOBAL_ENTRIES.has(name) &&
    !globalTemporary(name));
  if (unknown.length > 0) throw new Error('legacy_inventory_unknown');

  await options.cleanupShared?.();
  for (const key of SECRET_KEYS) await options.secrets.delete(key);
  for (const name of entries) {
    if (personalEntry(name)) await rm(join(options.dataDir, name), { recursive: true, force: true });
  }
}
