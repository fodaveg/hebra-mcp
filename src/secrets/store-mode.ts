/**
 * Selección EXPLÍCITA del almacén de secretos (SPEC.md §12.3), por
 * `HEBRA_MCP_SECRET_STORE=file|keychain` (por defecto `keychain`). Nunca un fallback
 * automático de uno a otro: en el contenedor remoto, sin Secret Service,
 * `@napi-rs/keyring` cae en silencio a keyutils (no persiste tras reiniciar), así que
 * elegirlo sin que nadie lo pida sería peor que fallar. La variable solo lleva el modo,
 * jamás un secreto.
 *
 * `src/server/main.ts` llama a `resolveSecretStoreMode` y `openSecretStoreForMode` en
 * `serve`, `pair` y `unpair`. En modo `file`, `openSecretStoreForMode` nunca importa
 * `@napi-rs/keyring` (el import dinámico vive solo dentro de `openKeyringSecretStore`,
 * en `./secret-store.ts`, y esta función no lo llama para ese modo).
 */
import { openFileSecretStore } from './file-secret-store';
import { openKeyringSecretStore, type SecretStore } from './secret-store';

export const SECRET_STORE_MODES = ['keychain', 'file'] as const;
export type SecretStoreMode = (typeof SECRET_STORE_MODES)[number];

const DEFAULT_SECRET_STORE_MODE: SecretStoreMode = 'keychain';

function isKnownMode(value: string): value is SecretStoreMode {
  return (SECRET_STORE_MODES as readonly string[]).includes(value);
}

/** Modo inválido: falla con un error claro y un `code` cerrado (`main.ts` ya reporta el
 *  `code` de cualquier error fatal en stderr, sin exponer mensajes libres de otros
 *  errores; este es seguro de mostrar entero, porque solo cita el propio valor de la
 *  variable de modo). */
export class SecretStoreModeError extends Error {
  readonly code = 'secret_store_mode_invalid';

  constructor(raw: string) {
    super(`HEBRA_MCP_SECRET_STORE=${JSON.stringify(raw)} no es válido (usa "keychain" o "file")`);
    this.name = 'SecretStoreModeError';
  }
}

export function resolveSecretStoreMode(env: NodeJS.ProcessEnv = process.env): SecretStoreMode {
  const raw = env.HEBRA_MCP_SECRET_STORE;
  if (raw === undefined || raw === '') return DEFAULT_SECRET_STORE_MODE;
  if (isKnownMode(raw)) return raw;
  throw new SecretStoreModeError(raw);
}

/** Abre el almacén del modo dado. En `file`, síncrono en la práctica (no hay E/S hasta
 *  el primer `set`); en `keychain`, carga `@napi-rs/keyring` y lanza si no hay binario
 *  nativo para esta plataforma o no hay llavero disponible. */
export async function openSecretStoreForMode(
  mode: SecretStoreMode,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<SecretStore> {
  if (mode === 'file') return openFileSecretStore(dataDir);
  return openKeyringSecretStore(env);
}
