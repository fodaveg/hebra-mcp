/**
 * `FileSecretStore` (SPEC.md §12.3): implementa `SecretStore` sobre un único JSON en
 * 0600, dentro de un directorio 0700 bajo el directorio de datos
 * (`../privacy/data-dir.ts`). Existe para el contenedor remoto (SPEC.md §12): sin
 * Secret Service, `@napi-rs/keyring` cae EN SILENCIO a keyutils, que no persiste tras
 * reiniciar (`node_modules/@napi-rs/keyring/README.md:23-25`). Se elige por
 * `HEBRA_MCP_SECRET_STORE=file` (`./store-mode.ts`), nunca como fallback automático del
 * llavero: si el contenedor lo usara por sorpresa, un reinicio borraría el emparejado
 * sin avisar.
 *
 * No se cifra: la SQLite del mismo volumen ya está en claro (SPEC.md §12.3), la
 * protección en reposo es la del volumen.
 *
 * Escritura atómica: fichero temporal 0600 + `fsync` + `rename` en el mismo directorio
 * (mismo patrón que `../store/blob-store-fs.ts`; `rename` es atómico en POSIX dentro de
 * un mismo sistema de ficheros). Los permisos del directorio y del fichero se corrigen
 * en cada lectura y escritura si los encuentra más abiertos (mismo criterio que
 * `secureSqliteFileModes` de `../store/node-port.ts`): un despliegue anterior con
 * permisos flojos no deja el almacén cerrado para siempre, se corrige solo.
 *
 * Un valor corrupto cuenta como AUSENTE para esa clave, sin lanzar ni registrar su
 * contenido: JSON inválido en todo el fichero (se trata como si no hubiera ninguna
 * clave), o un campo que no sea una cadena (se descarta esa clave, las demás
 * sobreviven). Mismo criterio que `./paired-secrets.ts` con un valor del llavero mal
 * formado.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SecretKey, SecretStore } from './secret-store';

/** Nombre del fichero dentro del directorio de datos. */
const FILE_NAME = 'secrets.json';
const TEMPORARY_FILE = /^\.secrets\.json\..+\.tmp$/;

type StoredSecrets = Partial<Record<SecretKey, string>>;
const mutationQueues = new Map<string, Promise<void>>();

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** JSON inválido, o no es un objeto plano, o un campo no es cadena: la clave (o todas)
 *  cuenta como ausente, sin lanzar. */
function parseStoredSecrets(raw: string): StoredSecrets {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: StoredSecrets = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key as SecretKey] = entry;
  }
  return result;
}

export class FileSecretStore implements SecretStore {
  private readonly queueKey: string;
  /** `path`: ruta del JSON, normalmente `fileSecretStorePath(dataDir)`. */
  constructor(private readonly path: string) { this.queueKey = resolve(path); }

  /** Serializa el read-modify-write entre todas las instancias del mismo fichero. */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const prior = mutationQueues.get(this.queueKey) ?? Promise.resolve();
    const current = prior.then(operation);
    const tail = current.then(() => undefined, () => undefined);
    mutationQueues.set(this.queueKey, tail);
    return current.finally(() => {
      if (mutationQueues.get(this.queueKey) === tail) mutationQueues.delete(this.queueKey);
    });
  }

  private async readAll(): Promise<StoredSecrets> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isEnoent(error)) return {};
      throw error;
    }
    // Corrige un fichero preexistente más abierto (por ejemplo, de un despliegue
    // anterior a este lote): falla cerrado no protege más y deja el almacén inservible.
    await chmod(this.path, 0o600);
    return parseStoredSecrets(raw);
  }

  private async writeAll(values: StoredSecrets): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // `mkdir` solo aplica `mode` al CREAR el directorio: si ya existía (más abierto),
    // corrige aquí.
    await chmod(dir, 0o700);
    const tmpPath = join(dir, `.${FILE_NAME}.${randomUUID()}.tmp`);
    const handle = await open(tmpPath, 'w', 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(values));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmpPath, this.path);
    } catch (error) {
      // El temporal contiene el snapshot completo, incluidas claves que otra operación
      // puede estar retirando. Nunca lo dejes como inventario personal residual si
      // write/sync/close/rename falla.
      try {
        await unlink(tmpPath);
      } catch (cleanupError) {
        if (!isEnoent(cleanupError)) {
          throw new AggregateError(
            [error, cleanupError],
            'No se pudo publicar ni retirar el temporal del almacén de secretos'
          );
        }
      }
      throw error;
    }
  }

  async get(key: SecretKey): Promise<string | null> {
    const values = await this.readAll();
    return values[key] ?? null;
  }

  async set(key: SecretKey, value: string): Promise<void> {
    await this.mutate(async () => {
      const values = await this.readAll();
      values[key] = value;
      await this.writeAll(values);
    });
  }

  async delete(key: SecretKey): Promise<boolean> {
    return this.mutate(async () => {
      const values = await this.readAll();
      if (!(key in values)) return false;
      delete values[key];
      await this.writeAll(values);
      return true;
    });
  }

  /** Cierre de retirada legacy: elimina claves personales y temporales sensibles en
   *  una sola sección crítica. Una escritura concurrente del store espera al barrido. */
  async deleteKeysAndTemporaryFiles(keys: readonly SecretKey[]): Promise<void> {
    await this.mutate(async () => {
      const values = await this.readAll();
      let changed = false;
      for (const key of keys) {
        if (key in values) {
          delete values[key];
          changed = true;
        }
      }
      if (changed) await this.writeAll(values);

      const dir = dirname(this.path);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (error) {
        if (isEnoent(error)) return;
        throw error;
      }
      for (const name of entries) {
        if (TEMPORARY_FILE.test(name)) await rm(join(dir, name));
      }
    });
  }
}

/** Ruta del almacén de fichero bajo el directorio de datos (SPEC.md §12.3). */
export function fileSecretStorePath(dataDir: string): string {
  return join(dataDir, FILE_NAME);
}

/** No hace ninguna E/S al abrir (a diferencia de `openKeyringSecretStore`, que carga el
 *  módulo nativo del llavero): el directorio y el fichero se crean al primer `set`. */
export function openFileSecretStore(dataDir: string): FileSecretStore {
  return new FileSecretStore(fileSecretStorePath(dataDir));
}
