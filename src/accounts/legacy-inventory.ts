import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTROL_SECRET_KEYS, SECRET_KEYS, type SecretStore } from '../secrets';
import { SERVER_LOCK_FILE } from '../lock/server-lock';
import { WRITER_LOCK_FILE } from '../lock/writer-lock';
import { SECRETS_FILE_NAME, SECRETS_TEMPORARY_FILE } from '../secrets/file-secret-store';
import { accountControlDir, CONTROL_SOCKET } from './control-ipc';
import { PENDING_UPLOADS_FILE, PENDING_UPLOADS_TEMPORARY } from './pending-sweep';

/** Cambiar la clasificación exige una migración/revisión explícita antes de borrar. */
export const LEGACY_INVENTORY_VERSION = 2;

const PERSONAL_ENTRIES = new Set([
  'library.sqlite', 'library.sqlite-shm', 'library.sqlite-wal',
  'blobs', 'config.json', 'spaces',
  'jd-plans.sqlite', 'jd-plans.sqlite-shm', 'jd-plans.sqlite-wal',
  'replace-plans.sqlite', 'replace-plans.sqlite-shm', 'replace-plans.sqlite-wal',
  'writer.lock', 'writer.sock', 'agent-key-lock'
]);

/** `secrets.json` es de la persona de `legacy-root`, pero el fichero se queda: su retirada
 *  borra las claves de `SECRET_KEYS`, y los secretos globales viven en `control/secrets.json`
 *  (D22). Si una vuelta atrás los hubiera dejado también aquí, tampoco son suyos. */
const GLOBAL_ENTRIES = new Set([
  'accounts', 'control', 'accounts-v1.json', 'oauth-tokens.json', 'oauth-revocations-v2.json',
  'oauth-logout-jtis.json', 'secrets.json', 'remote-pairing-v1'
]);

/**
 * Contenido de `control/`, global entero y nunca borrado: tampoco aquí se presume nada por la
 * ubicación, y un fichero nuevo tiene que clasificarse antes de poder retirar a nadie. Los
 * nombres salen de quien los escribe, no de una copia: `server.lock` (con los ficheros que SQLite
 * deja al lado según su modo de diario; `-journal` si un SIGKILL lo deja), `writer.lock` (el de
 * `control-secrets-rollback`), el socket de retirada, `secrets.json` y la lista durable de
 * subidas pendientes.
 */
const CONTROL_ENTRIES = new Set([
  WRITER_LOCK_FILE, CONTROL_SOCKET, SECRETS_FILE_NAME, PENDING_UPLOADS_FILE,
  SERVER_LOCK_FILE, `${SERVER_LOCK_FILE}-journal`, `${SERVER_LOCK_FILE}-wal`, `${SERVER_LOCK_FILE}-shm`
]);

function globalTemporary(name: string): boolean {
  return /^\.(?:accounts-v1|oauth-tokens|oauth-revocations-v2|oauth-logout-jtis)\.json\..+\.tmp$/.test(name);
}
function personalEntry(name: string): boolean {
  // `writer.lock.stale-*`: lo deja `WriterLock` si muere mientras retira un bloqueo obsoleto.
  return PERSONAL_ENTRIES.has(name) || /^\.secrets\.json\..+\.tmp$/.test(name) || /^writer\.lock\.stale-/.test(name);
}
function controlEntry(name: string): boolean {
  return CONTROL_ENTRIES.has(name) || SECRETS_TEMPORARY_FILE.test(name) || PENDING_UPLOADS_TEMPORARY.test(name) ||
    /^writer\.lock\.stale-.+$/.test(name);
}

async function controlEntries(dataDir: string): Promise<string[]> {
  try {
    return await readdir(accountControlDir(dataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export interface LegacyInventoryOptions {
  dataDir: string;
  secrets: SecretStore;
  /** Limpia diarios/filas personales en stores globales añadidos por otros módulos. */
  cleanupShared?(): Promise<void>;
  /** La retirada conserva sus mutex hasta terminar de publicar la fase durable. */
  eraseEntry?(path: string): Promise<void>;
}

/**
 * Inventario cerrado del `legacy-root`. Clasifica todo antes de tocar nada: una entrada
 * o una clave de `secrets.json` desconocida detiene la retirada y conserva los datos para
 * ampliar el inventario.
 */
export async function eraseLegacyAccountData(options: LegacyInventoryOptions): Promise<void> {
  const entries = await readdir(options.dataDir);
  const unknown = entries.filter((name) => !personalEntry(name) && !GLOBAL_ENTRIES.has(name) &&
    !globalTemporary(name));
  if (unknown.length > 0) throw new Error('legacy_inventory_unknown');
  if ((await controlEntries(options.dataDir)).some((name) => !controlEntry(name))) {
    throw new Error('legacy_inventory_unknown');
  }
  const classified = new Set<string>([...SECRET_KEYS, ...CONTROL_SECRET_KEYS]);
  if (((await options.secrets.keys?.()) ?? []).some((key) => !classified.has(key))) {
    throw new Error('legacy_inventory_unknown');
  }

  await options.cleanupShared?.();
  if (options.secrets.deleteKeysAndTemporaryFiles) {
    await options.secrets.deleteKeysAndTemporaryFiles(SECRET_KEYS);
  } else {
    for (const key of SECRET_KEYS) await options.secrets.delete(key);
  }
  for (const name of entries) {
    if (personalEntry(name)) {
      const path = join(options.dataDir, name);
      if (options.eraseEntry) await options.eraseEntry(path);
      else await rm(path, { recursive: true, force: true });
    }
  }
}
