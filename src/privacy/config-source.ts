/**
 * `config.json` releído cuando cambia (M5 del audit de privacidad adversarial, 10 oct 2026;
 * decisión de la sesión principal del 11 oct 2026; SPEC.md §6.3).
 *
 * Antes se leía una vez al arrancar: un `serve` arrancado antes de configurar una carpeta
 * privada la seguía sirviendo hasta reiniciarlo, y como el escritor aplica la configuración
 * que le manda cada lector (§8), también escribía con la vieja. Ahora `serve` mira en cada
 * llamada de herramienta (y antes de cada ronda de sync) la huella del fichero (`mtime`,
 * `ctime`, tamaño e inodo, un `stat`) y que se puede leer (`access` con `R_OK`), y lo vuelve
 * a leer solo si la huella cambió: la configuración nueva se aplica en esa misma llamada.
 *
 * Revisión de Codex del 11 oct 2026:
 * - C7, recargas a la vez: hay UNA recarga en vuelo y las llamadas que llegan mientras tanto
 *   esperan esa misma promesa; la huella nueva solo se publica cuando la configuración nueva
 *   ya está instalada. Antes la primera publicaba la huella antes de leer, y una segunda
 *   llamada simultánea usaba la configuración vieja con la huella nueva.
 * - C8, una entrada que existe y no se lee: si `config.json` existe como entrada (`lstat`) y
 *   no se puede leer (un enlace sin destino, sin permiso, un directorio), es
 *   `PrivacyConfigUnreadable`, nunca «sin configuración». Solo si la entrada no existe en
 *   absoluto se toma la configuración vacía, como siempre.
 * - Permisos sin cambio de huella: `chmod` cambia `ctime`, que va en la huella, y además
 *   cada llamada comprueba `R_OK`: un `config.json` que deja de poderse leer bloquea en la
 *   misma llamada, aunque su contenido siga cacheado.
 *
 * Cerrado ante la duda: con `PrivacyConfigUnreadable` las herramientas responden
 * `privacy_config_unresolved` hasta que se arregle, en vez de seguir con la configuración de
 * antes. Si el fichero no existe, ninguna carpeta ni etiqueta privada, igual que al arrancar.
 *
 * Límite: un cambio que no altera ni `mtime` ni `ctime` ni tamaño ni inodo (resolución de
 * nanosegundos en APFS y ext4) no se ve hasta el siguiente.
 */
import { accessSync, constants, lstatSync, statSync } from 'node:fs';
import { access, lstat, readFile, stat } from 'node:fs/promises';
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

/** La huella del fichero, `null` si la entrada no existe; lanza `PrivacyConfigUnreadable`
 *  si existe y no se puede leer. */
async function stampOf(path: string): Promise<string | null> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new PrivacyConfigUnreadable();
  }
  try {
    // `stat` sigue un enlace: uno sin destino falla aquí (C8), y no cuenta como ausente.
    const info = await stat(path, { bigint: true });
    if (!info.isFile()) throw new PrivacyConfigUnreadable();
    await access(path, constants.R_OK);
    return `${info.mtimeNs}:${info.ctimeNs}:${info.size}:${info.ino}`;
  } catch {
    throw new PrivacyConfigUnreadable();
  }
}

/** `stampOf` sin esperar a nada: lo usa la puerta final DENTRO de su transacción de lectura
 *  (`src/server/privacy-gate.ts`), para que después de ella no quede ninguna espera. */
function stampOfSync(path: string): string | null {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new PrivacyConfigUnreadable();
  }
  try {
    const info = statSync(path, { bigint: true });
    if (!info.isFile()) throw new PrivacyConfigUnreadable();
    accessSync(path, constants.R_OK);
    return `${info.mtimeNs}:${info.ctimeNs}:${info.size}:${info.ino}`;
  } catch {
    throw new PrivacyConfigUnreadable();
  }
}

export class PrivacyConfigSource {
  private readonly path: string;
  /** Huella de la configuración INSTALADA (`null`: no existía el fichero). */
  private stamp: string | null;
  /** La instalada; `null` si la última lectura no se pudo aplicar. */
  private config: PrivacyConfig | null;
  /** La recarga en vuelo, si la hay (C7): una sola, y las demás llamadas la esperan. */
  private reloading: Promise<void> | null = null;

  private constructor(dataDir: string, initial: PrivacyConfig, initialStamp: string | null) {
    this.path = join(dataDir, 'config.json');
    this.config = initial;
    this.stamp = initialStamp;
  }

  /** Lee `config.json` como al arrancar: si existe y no se lee o no es JSON, lanza (el
   *  proceso no arranca). */
  static async open(dataDir: string): Promise<PrivacyConfigSource> {
    const path = join(dataDir, 'config.json');
    const stamp = await stampOf(path);
    const config = stamp === null ? EMPTY : parsePrivacyConfig(await readFile(path, 'utf8'));
    return new PrivacyConfigSource(dataDir, config, stamp);
  }

  /**
   * ¿Sigue `config.json` siendo el de la configuración instalada? Síncrono (un `lstat`, un
   * `stat` y un `access`), para la transacción de la puerta final: `false` si la huella
   * cambió, hay una recarga en vuelo o ya no se puede leer.
   */
  isInstalledNow(): boolean {
    if (this.reloading || this.config === null) return false;
    try {
      return stampOfSync(this.path) === this.stamp;
    } catch {
      return false;
    }
  }

  /** La de arrancar (o la última instalada), sin mirar el fichero. */
  get initial(): PrivacyConfig {
    return this.config ?? EMPTY;
  }

  /** La configuración vigente, releída si el fichero cambió. */
  async current(): Promise<PrivacyConfig> {
    for (;;) {
      // Mientras otra llamada recarga, se espera a que termine (y se vuelve a mirar).
      if (this.reloading) {
        await this.reloading;
        continue;
      }
      // Si no se puede leer AHORA, lanza: bloquea aunque haya una configuración cacheada.
      const stamp = await stampOf(this.path);
      if (this.reloading) continue;
      if (stamp === this.stamp) {
        if (this.config === null) throw new PrivacyConfigUnreadable();
        return this.config;
      }
      this.reloading = this.reload(stamp).finally(() => {
        this.reloading = null;
      });
    }
  }

  /** Lee e instala la configuración de `stamp`; la huella se publica a la vez que ella. */
  private async reload(stamp: string | null): Promise<void> {
    if (stamp === null) {
      this.config = EMPTY;
      this.stamp = null;
      return;
    }
    let parsed: PrivacyConfig | null;
    try {
      parsed = parsePrivacyConfig(await readFile(this.path, 'utf8'));
    } catch {
      parsed = null;
    }
    this.config = parsed;
    this.stamp = stamp;
  }
}
