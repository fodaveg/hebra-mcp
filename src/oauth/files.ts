/**
 * Ficheros del OAuth de un solo dueño (SPEC.md §12.2), en el directorio de datos:
 *
 * - `oauth-owner.json`: el hash del secreto del dueño y la marca de revocación
 *   (`revokedBefore`). Solo lo escriben los subcomandos `oauth-set-secret` y
 *   `oauth-revoke-all`; `serve-http` solo lo lee.
 * - `oauth-tokens.json`: las familias de tokens (hashes, nunca los tokens). Solo lo escribe
 *   `serve-http`.
 *
 * Un escritor por fichero: así `oauth-revoke-all`, que corre en OTRO proceso mientras el
 * servidor vive, no puede pisar una escritura del servidor ni al revés, sin necesidad de
 * un bloqueo entre procesos.
 *
 * Escritura atómica: temporal 0600 + `fsync` + `rename` en el mismo directorio (0700), el
 * mismo patrón que `src/store/blob-store-fs.ts`.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const OAUTH_OWNER_FILE = 'oauth-owner.json';
export const OAUTH_TOKENS_FILE = 'oauth-tokens.json';

export function ownerFilePath(dataDir: string): string {
  return join(dataDir, OAUTH_OWNER_FILE);
}

export function tokensFilePath(dataDir: string): string {
  return join(dataDir, OAUTH_TOKENS_FILE);
}

/** Escribe `value` como JSON en `path`, de forma atómica y con permisos 0600. */
export async function writeJsonAtomic(dataDir: string, path: string, value: unknown): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmpPath, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
  await chmod(path, 0o600);
}

/** El JSON de `path`, `null` si no existe. Un JSON corrupto lanza `SyntaxError`. */
export async function readJsonOrNull(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text) as unknown;
}
