/**
 * Escritor único entre procesos (SPEC.md §8, R4). Claude lanza un proceso de hebra-mcp
 * por sesión y dos procesos escritores sobre la misma SQLite serían dos motores de sync
 * subiendo lo mismo; `syncLeaseAcquire` del motor solo coordina dentro de un proceso.
 *
 * Mecanismo: un fichero `writer.lock` en el directorio de datos con `{pid, nonce,
 * startedAt}` en JSON.
 * - Tomarlo es crearlo con `open(…, 'wx')` (`O_CREAT | O_EXCL`: atómico, falla con
 *   `EEXIST` si ya existe), permisos 0600.
 * - Vivo o huérfano: `process.kill(pid, 0)` no manda ninguna señal, solo comprueba que
 *   el proceso existe (`ESRCH` = muerto; `EPERM` = existe pero es de otro usuario, así
 *   que cuenta como vivo).
 * - Recuperar un huérfano sin carreras: dos instancias pueden ver a la vez el mismo PID
 *   muerto. Cada una RENOMBRA el fichero a un nombre propio (atómico) y comprueba que lo
 *   que se llevó es exactamente el huérfano que leyó (mismo `nonce`). Si se llevó un
 *   bloqueo recién creado por otra, lo devuelve con `link` (atómico, no pisa uno nuevo)
 *   y no lo toma. Además, el poseedor revisa en cada comprobación (`verify`) que el
 *   fichero sigue siendo el suyo, y si no, deja de escribir.
 * - Soltarlo: al cerrar, en `exit` y en `SIGINT`/`SIGTERM`/`SIGHUP`, borrando el fichero
 *   solo si sigue siendo el suyo (mismo `nonce`). Con una señal, solo si nadie más la
 *   escucha: si hay un apagado propio, lo suelta él al terminar de vaciar.
 *
 * Límite conocido: si el SO reutiliza el PID de un poseedor muerto para otro proceso,
 * el bloqueo parece vivo hasta que ese proceso termine. Un fichero con el MISMO PID que
 * este proceso y otro `nonce` es de un proceso anterior (el PID no puede estar vivo dos
 * veces): se trata como huérfano.
 */
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const WRITER_LOCK_FILE = 'writer.lock';

/** Un fichero de bloqueo sin JSON válido (otra instancia está a mitad de escribirlo)
 *  solo se considera huérfano pasado este tiempo desde su última modificación. */
const UNREADABLE_LOCK_GRACE_MS = 10_000;

interface LockContent {
  pid: number;
  nonce: string;
  startedAt: string;
}

export interface WriterLockOptions {
  /** Directorio de datos (tiene que existir). */
  dataDir: string;
  /** PID que se escribe en el bloqueo. Por defecto, `process.pid` (tests: otro). */
  pid?: number;
  /** ¿Sigue vivo `pid`? Por defecto, `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** Registrar la liberación en `exit` y en las señales. Por defecto, sí. */
  releaseOnExit?: boolean;
  now?: () => number;
}

/** `process.kill(pid, 0)`: `ESRCH` = no existe; `EPERM` = existe (de otro usuario). */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseLock(text: string): LockContent | null {
  try {
    const value = JSON.parse(text) as Partial<LockContent>;
    if (
      typeof value.pid === 'number' &&
      Number.isInteger(value.pid) &&
      typeof value.nonce === 'string' &&
      value.nonce.length > 0
    ) {
      return { pid: value.pid, nonce: value.nonce, startedAt: String(value.startedAt ?? '') };
    }
  } catch {
    // JSON a medias o basura.
  }
  return null;
}

type Observed =
  | { kind: 'absent' }
  | { kind: 'held'; content: LockContent | null; raw: string }
  | { kind: 'orphan'; raw: string };

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export class WriterLock {
  readonly path: string;
  private readonly pid: number;
  private readonly nonce = randomUUID();
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private owned = false;
  private hooksInstalled = false;
  private readonly onExit = (): void => this.release();
  private readonly onSignal = (signal: NodeJS.Signals): void => {
    // Otro oyente de la señal (el apagado de `serve` o `serve-http`, `main.ts`) va a
    // vaciar la ronda y la cola y cerrar: el bloqueo lo suelta `LibraryInstance.close()`
    // al final, y el hook de `exit` queda de red. Soltarlo aquí dejaba entrar a otro
    // escritor mientras este seguía escribiendo (M1 del audit de robustez, 10 oct 2026:
    // hasta 28 s con dos escritores). Se vuelve a armar para que una segunda señal, ya
    // sin ese oyente (`once`), suelte el bloqueo y termine.
    if (process.listenerCount(signal) > 0) {
      process.once(signal, this.onSignal);
      return;
    }
    this.release();
    this.removeHooks();
    // Nadie más escucha la señal: se repite para que el proceso termine como lo habría
    // hecho sin este manejador (con el código de la señal).
    process.kill(process.pid, signal);
  };

  constructor(private readonly options: WriterLockOptions) {
    this.path = join(options.dataDir, WRITER_LOCK_FILE);
    this.pid = options.pid ?? process.pid;
    this.isAlive = options.isAlive ?? processIsAlive;
    this.now = options.now ?? Date.now;
  }

  /** ¿Tiene esta instancia el bloqueo (según su última comprobación)? */
  get held(): boolean {
    return this.owned;
  }

  /**
   * Intenta tomar el bloqueo: `true` si ya lo tenía y sigue siendo suyo, o si lo acaba
   * de crear (también recuperando un huérfano). `false` si lo tiene otra instancia viva.
   */
  tryAcquire(): boolean {
    if (this.owned) return this.verify();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.createExclusive()) {
        this.owned = true;
        this.installHooks();
        return true;
      }
      const observed = this.observe();
      if (observed.kind === 'held') return false;
      if (observed.kind === 'orphan') this.removeOrphan(observed.raw);
      // `absent` (lo soltaron entre medias) u huérfano retirado: otro intento.
    }
    return false;
  }

  /** ¿Sigue el fichero siendo el de esta instancia? Si no, deja de considerarse dueña. */
  verify(): boolean {
    if (!this.owned) return false;
    const raw = this.readRaw();
    const content = raw === null ? null : parseLock(raw);
    if (!content || content.nonce !== this.nonce) {
      this.owned = false;
      this.removeHooks();
    }
    return this.owned;
  }

  /** Suelta el bloqueo si es suyo. Síncrono: vale dentro de un manejador de `exit`. */
  release(): void {
    if (!this.owned) return;
    this.owned = false;
    const raw = this.readRaw();
    if (raw !== null && parseLock(raw)?.nonce === this.nonce) {
      try {
        unlinkSync(this.path);
      } catch {
        // Ya no estaba: nada que soltar.
      }
    }
    this.removeHooks();
  }

  private createExclusive(): boolean {
    let fd: number;
    try {
      fd = openSync(this.path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    try {
      const content: LockContent = {
        pid: this.pid,
        nonce: this.nonce,
        startedAt: new Date(this.now()).toISOString()
      };
      writeSync(fd, JSON.stringify(content));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  }

  private readRaw(): string | null {
    try {
      return readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private mtimeMs(): number | null {
    try {
      return statSync(this.path).mtimeMs;
    } catch {
      return null;
    }
  }

  private observe(): Observed {
    const raw = this.readRaw();
    if (raw === null) return { kind: 'absent' };
    const content = parseLock(raw);
    if (!content) {
      const mtime = this.mtimeMs();
      const stale = mtime !== null && this.now() - mtime > UNREADABLE_LOCK_GRACE_MS;
      return stale ? { kind: 'orphan', raw } : { kind: 'held', content: null, raw };
    }
    const samePidOtherProcess = content.pid === this.pid && content.nonce !== this.nonce;
    if (!samePidOtherProcess && this.isAlive(content.pid)) return { kind: 'held', content, raw };
    return { kind: 'orphan', raw };
  }

  /** Retira el huérfano `raw` sin llevarse por error un bloqueo recién creado. */
  private removeOrphan(raw: string): void {
    const aside = `${this.path}.stale-${randomUUID()}`;
    try {
      renameSync(this.path, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // otra lo retiró
      throw error;
    }
    let taken: string | null = null;
    try {
      taken = readFileSync(aside, 'utf8');
    } catch {
      taken = null;
    }
    if (taken !== raw) {
      // Se llevó el bloqueo que otra instancia acababa de crear: se devuelve. `link`
      // falla si ya hay otro fichero en su sitio; en ese caso, esa otra instancia verá
      // en su `verify` que ya no es la dueña.
      try {
        linkSync(aside, this.path);
      } catch {
        // Ver arriba.
      }
    }
    try {
      unlinkSync(aside);
    } catch {
      // Nada que limpiar.
    }
  }

  private installHooks(): void {
    if (this.hooksInstalled || this.options.releaseOnExit === false) return;
    this.hooksInstalled = true;
    process.once('exit', this.onExit);
    for (const signal of SIGNALS) process.once(signal, this.onSignal);
  }

  private removeHooks(): void {
    if (!this.hooksInstalled) return;
    this.hooksInstalled = false;
    process.removeListener('exit', this.onExit);
    for (const signal of SIGNALS) process.removeListener(signal, this.onSignal);
  }
}
