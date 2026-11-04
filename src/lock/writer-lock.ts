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
 *   solo si sigue siendo el suyo (mismo `nonce`). Si el proceso declaró su propio apagado
 *   (`deferSignalRelease`), la primera señal no lo suelta: lo suelta ese apagado al
 *   terminar de vaciar; una segunda señal sí, y termina.
 *
 * Límite conocido: si el SO reutiliza el PID de un poseedor muerto para otro proceso,
 * el bloqueo parece vivo hasta que ese proceso termine. Un fichero con el MISMO PID que
 * este proceso y otro `nonce` es de un proceso anterior (el PID no puede estar vivo dos
 * veces): se trata como huérfano.
 *
 * Dentro de `serve-http` (D22, §12.10) el PID no distingue nada: en el contenedor es
 * siempre el mismo, y un mismo proceso tiene abiertas muchas bibliotecas. Por eso cada
 * bloqueo tomado bajo una raíz con un arranque registrado (`registerServerBoot`) lleva su
 * `serverBootId`, y `classifyWriterLock` decide por ese identificador: lo de otro arranque
 * está obsoleto aunque repita PID, y lo de este arranque no se le quita a nadie, porque
 * dos instancias del mismo proceso las evita el ciclo de vida de los contextos. Registrar
 * un arranque exige tener `control/server.lock` (`./server-lock.ts`), y eso es lo que
 * prueba que los arranques anteriores están muertos.
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
import { constants as osConstants } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const WRITER_LOCK_FILE = 'writer.lock';

/** Un fichero de bloqueo sin JSON válido (otra instancia está a mitad de escribirlo)
 *  solo se considera huérfano pasado este tiempo desde su última modificación. */
const UNREADABLE_LOCK_GRACE_MS = 10_000;

interface LockContent {
  pid: number;
  nonce: string;
  startedAt: string;
  /** Arranque de `serve-http` que lo tomó. Sin él: una orden suelta o un binario anterior a D22. */
  serverBootId?: string;
}

/**
 * Arranques de `serve-http` vivos en este proceso, por raíz de datos. No selecciona nada:
 * solo dice a qué arranque pertenece un bloqueo que se toma o se lee bajo esa raíz, sin
 * pasar el identificador por cada apertura de biblioteca y de espacio. Va por raíz porque
 * los tests levantan varios servidores en un proceso, cada uno sobre su directorio.
 */
const SERVER_BOOTS = new Map<string, string>();

/** Lo llama `acquireServerLock`. Devuelve la función que retira el registro. */
export function registerServerBoot(rootDir: string, bootId: string): () => void {
  const root = resolve(rootDir);
  SERVER_BOOTS.set(root, bootId);
  return () => {
    if (SERVER_BOOTS.get(root) === bootId) SERVER_BOOTS.delete(root);
  };
}

/** El arranque vivo cuya raíz contiene `dataDir`, o `undefined` fuera de `serve-http`. */
export function serverBootIdFor(dataDir: string): string | undefined {
  let current = resolve(dataDir);
  for (;;) {
    const bootId = SERVER_BOOTS.get(current);
    if (bootId !== undefined) return bootId;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * De quién es un `writer.lock` (D22, §12.10):
 * - `none`: no hay fichero.
 * - `stale`: de un arranque anterior del servidor (aunque repita PID) o de un proceso
 *   muerto. Lo limpia `WriterLock.tryAcquire` al abrir o retirar esa cuenta.
 * - `this-boot`: de este arranque. Lo gestiona el ciclo de vida de los contextos: hay que
 *   esperar a que se cierre, nunca quitárselo.
 * - `other-process`: de otro proceso vivo, como una orden por `compose exec`. Bloquea.
 */
export type WriterLockOwner = 'none' | 'stale' | 'this-boot' | 'other-process';

export interface ClassifyWriterLockOptions {
  /** ¿Sigue vivo ese PID? Por defecto, `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

interface LockObserver {
  pid: number;
  bootId: string | undefined;
  isAlive: (pid: number) => boolean;
}

function ownerOfContent(content: LockContent, me: LockObserver): Exclude<WriterLockOwner, 'none'> {
  if (me.bootId !== undefined) {
    if (content.serverBootId === me.bootId) return 'this-boot';
    // Tener `server.lock` prueba que el arranque que lo escribió ya no vive.
    if (content.serverBootId !== undefined) return 'stale';
    // Sin identificador y con el PID de este servidor: un binario anterior a D22 que murió
    // aquí. Una orden externa vive en otro PID.
    if (content.pid === me.pid) return 'stale';
  } else if (content.pid === me.pid) {
    // Fuera de un arranque no hay con qué probar que sea anterior: el lado seguro.
    return 'this-boot';
  }
  return me.isAlive(content.pid) ? 'other-process' : 'stale';
}

/** ¿Lleva un fichero ilegible más tiempo del que tarda otra instancia en escribirlo? */
function unreadableIsStale(path: string, now: number): boolean {
  try {
    return now - statSync(path).mtimeMs > UNREADABLE_LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

/**
 * Clasifica el `writer.lock` de `dataDir` sin tocarlo. Toma el arranque de la raíz que
 * contiene `dataDir` (`serverBootIdFor`). Sin arranque registrado, un mismo PID sale
 * `this-boot`: no se puede probar que sea anterior.
 */
export function classifyWriterLock(dataDir: string, options: ClassifyWriterLockOptions = {}): WriterLockOwner {
  const path = join(dataDir, WRITER_LOCK_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    throw error;
  }
  const content = parseLock(raw);
  if (!content) return unreadableIsStale(path, (options.now ?? Date.now)()) ? 'stale' : 'other-process';
  return ownerOfContent(content, {
    pid: process.pid,
    bootId: serverBootIdFor(dataDir),
    isAlive: options.isAlive ?? processIsAlive
  });
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
      return {
        pid: value.pid,
        nonce: value.nonce,
        startedAt: String(value.startedAt ?? ''),
        ...(typeof value.serverBootId === 'string' ? { serverBootId: value.serverBootId } : {})
      };
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
  private readonly serverBootId: string | undefined;
  private owned = false;
  private hooksInstalled = false;
  /** `deferSignalRelease`: el proceso tiene su propio apagado, que suelta el bloqueo. */
  private signalReleaseDeferred = false;
  /** Ya llegó una señal con el soltado aplazado: la siguiente suelta y termina. */
  private deferredSignalSeen = false;
  private readonly onExit = (): void => this.release();
  private readonly onSignal = (signal: NodeJS.Signals): void => {
    // Con un apagado propio (`serve`, `serve-http`: `deferSignalRelease`), la primera señal
    // no suelta el bloqueo: ese apagado vacía la ronda y la cola y lo suelta al final
    // (`LibraryInstance.close()`), y el hook de `exit` queda de red. Soltarlo aquí dejaba
    // entrar a otro escritor mientras este seguía escribiendo (M1 del audit de robustez,
    // 10 oct 2026: hasta 28 s con dos escritores). Lo decide el indicador y no cuántos
    // oyentes quedan: con `process.once`, Node quita el envoltorio antes de llamarlo, y un
    // `serve` que toma el relevo después de arrancar tiene su oyente DELANTE del de aquí
    // (vería 0 oyentes y mataría el proceso a mitad del apagado). Se vuelve a armar para
    // que una segunda señal suelte el bloqueo y termine.
    if (this.signalReleaseDeferred && !this.deferredSignalSeen) {
      this.deferredSignalSeen = true;
      process.once(signal, this.onSignal);
      return;
    }
    this.release();
    this.removeHooks();
    if (process.listenerCount(signal) === 0) {
      // Nadie más escucha la señal: se repite para que el proceso termine como lo habría
      // hecho sin este manejador (con el código de la señal).
      process.kill(process.pid, signal);
    } else if (this.deferredSignalSeen) {
      // Segunda señal con otro oyente que no termina el proceso: se termina aquí, con el
      // código convencional de una muerte por señal.
      process.exit(128 + (osConstants.signals[signal] ?? 0));
    }
  };

  constructor(private readonly options: WriterLockOptions) {
    this.path = join(options.dataDir, WRITER_LOCK_FILE);
    this.pid = options.pid ?? process.pid;
    this.isAlive = options.isAlive ?? processIsAlive;
    this.now = options.now ?? Date.now;
    this.serverBootId = serverBootIdFor(options.dataDir);
  }

  /** ¿Tiene esta instancia el bloqueo (según su última comprobación)? */
  get held(): boolean {
    return this.owned;
  }

  /**
   * El proceso tiene su propio apagado para SIGINT/SIGTERM/SIGHUP, que cierra la
   * instancia y suelta el bloqueo al terminar de vaciar (`main.ts` lo llama al registrarlo,
   * por `LibraryInstance.deferSignalRelease`). Desde entonces la primera señal no suelta el
   * bloqueo; la segunda sí, y termina el proceso. Vale tenga o no el bloqueo todavía (un
   * lector que toma el relevo después lo hereda). Sin llamarlo, una señal lo suelta en el
   * acto, como siempre.
   */
  deferSignalRelease(): void {
    this.signalReleaseDeferred = true;
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
        startedAt: new Date(this.now()).toISOString(),
        ...(this.serverBootId !== undefined ? { serverBootId: this.serverBootId } : {})
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

  private observe(): Observed {
    const raw = this.readRaw();
    if (raw === null) return { kind: 'absent' };
    const content = parseLock(raw);
    if (!content) {
      return unreadableIsStale(this.path, this.now()) ? { kind: 'orphan', raw } : { kind: 'held', content: null, raw };
    }
    const owner = ownerOfContent(content, { pid: this.pid, bootId: this.serverBootId, isAlive: this.isAlive });
    // Fuera de `serve-http`, un mismo PID con otro `nonce` es un proceso anterior: aquí cada
    // proceso abre una sola biblioteca por directorio.
    const samePidOutsideServer = owner === 'this-boot' && this.serverBootId === undefined && content.nonce !== this.nonce;
    return owner === 'stale' || samePidOutsideServer ? { kind: 'orphan', raw } : { kind: 'held', content, raw };
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
