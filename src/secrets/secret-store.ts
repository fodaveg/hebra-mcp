/**
 * Dónde viven los secretos del dispositivo (SPEC.md §6.1): en el llavero del SO, servicio
 * `hebra-mcp`, mediante `@napi-rs/keyring` (Keychain en macOS, libsecret en Linux). Nunca
 * en ficheros, variables de entorno ni argumentos de proceso.
 *
 * `SecretStore` es la interfaz que usa el resto del código, con dos implementaciones:
 * - `KeyringSecretStore`: el llavero de verdad. `@napi-rs/keyring` es un módulo nativo
 *   (`.node`) y se carga al crear el almacén, no al importar este fichero: un `serve` en
 *   una plataforma sin binario o sin llavero arranca igual, sin emparejar, y lo dice en
 *   stderr con un código cerrado (`src/server/main.ts`).
 * - `MemorySecretStore`: un `Map`, para tests. No persiste nada.
 *
 * Los valores son cadenas opacas: el formato de cada secreto lo decide
 * `./paired-secrets.ts`. Ninguna función de aquí escribe un valor en un log ni en un
 * mensaje de error.
 */

/** Servicio del llavero (SPEC.md §6.1). */
export const SECRET_SERVICE = 'hebra-mcp';

/** Las tres entradas del llavero (SPEC.md §6.1), por nombre de cuenta. */
export const SECRET_KEYS = ['lumbre-connection', 'recovery-code', 'device-identity', 'agent-device-key'] as const;
/**
 * Secretos globales del conector, no de una persona (D22, SPEC.md §12.10): bearers de
 * concesiones OAuth de todas las cuentas, sus pendientes y la clave AES-256-GCM de los
 * refresh de Sumego guardados cifrados en `oauth-tokens.json` (D20). Separados del
 * emparejado para que `unpair` mantenga su semántica y las familias se invaliden por
 * comparación del vínculo; en modo fichero viven en `control/secrets.json`
 * (`../accounts/control-secrets.ts`).
 */
export const CONTROL_SECRET_KEYS = [
  'hebra-mcp-oauth-grants', 'hebra-mcp-oauth-pending', 'hebra-mcp-sumego-refresh-key'
] as const;

/** Marca de `control/secrets.json`: una vuelta atrás dejó en `secrets.json` la fuente vigente. */
export const CONTROL_ROLLBACK_MARK = 'hebra-mcp-control-rollback';

export type SecretKey = (typeof SECRET_KEYS)[number] | (typeof CONTROL_SECRET_KEYS)[number]
  | typeof CONTROL_ROLLBACK_MARK;

export interface SecretStore {
  get(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string): Promise<void>;
  /** `true` si había algo que borrar. */
  delete(key: SecretKey): Promise<boolean>;
  /** Los stores de fichero pueden cerrar una retirada personal borrando las claves y
   *  cualquier temporal exacto bajo la misma exclusión que sus escrituras. */
  deleteKeysAndTemporaryFiles?(keys: readonly SecretKey[]): Promise<void>;
  /** Los stores de fichero enumeran lo guardado para que el inventario de retirada pueda
   *  detenerse ante una clave sin clasificar. Puede devolver nombres que no son `SecretKey`. */
  keys?(): Promise<string[]>;
}

/** Para tests: nada sale del proceso. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<SecretKey, string>();

  async get(key: SecretKey): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: SecretKey, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: SecretKey): Promise<boolean> {
    return this.values.delete(key);
  }

  /** Cuántas entradas hay (los tests comprueban que `unpair` lo deja en cero). */
  get size(): number {
    return this.values.size;
  }
}

/** Lo que se usa de `AsyncEntry` de `@napi-rs/keyring`. */
interface KeyringEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

type EntryFactory = (service: string, account: string) => KeyringEntry;

/** El llavero del SO. Crear uno con `openKeyringSecretStore`. */
export class KeyringSecretStore implements SecretStore {
  constructor(
    private readonly entry: EntryFactory,
    readonly service: string = SECRET_SERVICE
  ) {}

  async get(key: SecretKey): Promise<string | null> {
    return (await this.entry(this.service, key).getPassword()) ?? null;
  }

  async set(key: SecretKey, value: string): Promise<void> {
    await this.entry(this.service, key).setPassword(value);
  }

  async delete(key: SecretKey): Promise<boolean> {
    return this.entry(this.service, key).deleteCredential();
  }
}

/**
 * Carga `@napi-rs/keyring` y devuelve el almacén sobre `service`. Lanza si el módulo
 * nativo no carga en esta plataforma. `HEBRA_MCP_KEYRING_SERVICE` cambia el servicio
 * (tests de extremo a extremo, para no leer nunca el llavero real de David); no lleva
 * ningún secreto, solo el nombre del servicio.
 */
export async function openKeyringSecretStore(
  env: NodeJS.ProcessEnv = process.env
): Promise<KeyringSecretStore> {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  const service = env.HEBRA_MCP_KEYRING_SERVICE || SECRET_SERVICE;
  return new KeyringSecretStore(
    (entryService, account) => new AsyncEntry(entryService, account),
    service
  );
}
