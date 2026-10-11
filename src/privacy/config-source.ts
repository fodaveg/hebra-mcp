/**
 * `config.json` releído cuando cambia (M5 del audit de privacidad adversarial, 10 oct 2026;
 * decisión de la sesión principal del 11 oct 2026; SPEC.md §6.3).
 *
 * Antes se leía una vez al arrancar: un `serve` arrancado antes de configurar una carpeta
 * privada la seguía sirviendo hasta reiniciarlo, y como el escritor aplica la configuración
 * que le manda cada lector (§8), también escribía con la vieja. Ahora `serve` mira en cada
 * llamada de herramienta (y antes de cada ronda de sync) el `mtime`, el tamaño y el inodo del
 * fichero, que es una llamada a `stat`, y lo vuelve a leer solo si cambió: la configuración
 * nueva se aplica en esa misma llamada.
 *
 * Cerrado ante la duda: si el fichero existe pero no se puede leer o no es JSON (a medio
 * escribir, o con un error), `current()` lanza `PrivacyConfigUnreadable` y las herramientas
 * responden `privacy_config_unresolved` hasta que se arregle, en vez de seguir con la
 * configuración de antes. Si el fichero no existe, ninguna carpeta ni etiqueta privada, igual
 * que al arrancar.
 *
 * Límite: un cambio que deja el mismo tamaño dentro del mismo instante del `mtime` (la
 * resolución del sistema de ficheros: nanosegundos en APFS y ext4) no se ve hasta el
 * siguiente cambio.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePrivacyConfig, type PrivacyConfig } from './config';

const EMPTY: PrivacyConfig = { privateFolders: [], privateTags: [] };

/** `config.json` existe y no se puede aplicar (no se lee o no es JSON). */
export class PrivacyConfigUnreadable extends Error {
  constructor() {
    super('privacy_config_unreadable');
    this.name = 'PrivacyConfigUnreadable';
  }
}

export class PrivacyConfigSource {
  private readonly path: string;
  /** Huella del fichero de lo último leído (`null`: no existía). */
  private stamp: string | null;
  private config: PrivacyConfig | null;

  /** `initial` es lo que ya se leyó al arrancar; `initialStamp`, la huella de entonces. */
  private constructor(dataDir: string, initial: PrivacyConfig, initialStamp: string | null) {
    this.path = join(dataDir, 'config.json');
    this.config = initial;
    this.stamp = initialStamp;
  }

  /** Lee `config.json` como al arrancar: si no es JSON, lanza (el proceso no arranca). */
  static async open(dataDir: string): Promise<PrivacyConfigSource> {
    const path = join(dataDir, 'config.json');
    const stamp = await stampOf(path);
    const config = stamp === null ? EMPTY : parsePrivacyConfig(await readFile(path, 'utf8'));
    return new PrivacyConfigSource(dataDir, config, stamp);
  }

  /** La de arrancar (o la última leída), sin mirar el fichero. */
  get initial(): PrivacyConfig {
    return this.config ?? EMPTY;
  }

  /** La configuración vigente, releída si el fichero cambió. */
  async current(): Promise<PrivacyConfig> {
    let stamp: string | null;
    try {
      stamp = await stampOf(this.path);
    } catch {
      this.config = null;
      throw new PrivacyConfigUnreadable();
    }
    if (stamp === this.stamp) {
      if (this.config === null) throw new PrivacyConfigUnreadable();
      return this.config;
    }
    this.stamp = stamp;
    if (stamp === null) {
      this.config = EMPTY;
      return EMPTY;
    }
    try {
      this.config = parsePrivacyConfig(await readFile(this.path, 'utf8'));
    } catch {
      this.config = null;
      throw new PrivacyConfigUnreadable();
    }
    return this.config;
  }
}

/** `mtime` (ns), tamaño e inodo; `null` si el fichero no existe. */
async function stampOf(path: string): Promise<string | null> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.mtimeNs}:${info.size}:${info.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
