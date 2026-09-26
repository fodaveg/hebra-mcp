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
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SecretKey, SecretStore } from './secret-store';

/** Nombre del fichero dentro del directorio de datos. */
const FILE_NAME = 'secrets.json';

type StoredSecrets = Partial<Record<SecretKey, string>>;

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
  /** `path`: ruta del JSON, normalmente `fileSecretStorePath(dataDir)`. */
  constructor(private readonly path: string) {}

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
      await handle.writeFile(JSON.stringify(values));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, this.path);
  }

  async get(key: SecretKey): Promise<string | null> {
    const values = await this.readAll();
    return values[key] ?? null;
  }

  async set(key: SecretKey, value: string): Promise<void> {
    const values = await this.readAll();
    values[key] = value;
    await this.writeAll(values);
  }

  async delete(key: SecretKey): Promise<boolean> {
    const values = await this.readAll();
    if (!(key in values)) return false;
    delete values[key];
    await this.writeAll(values);
    return true;
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
