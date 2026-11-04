/**
 * `control/server.lock` (D22, §12.10): un solo `serve-http` vivo sobre cada `/data`, y la
 * prueba de que los arranques anteriores están muertos.
 *
 * Un fichero con un PID no sirve para esa prueba: en el contenedor el PID del servidor es
 * siempre el mismo, de modo que tras un SIGKILL no se distingue de otro servidor vivo en
 * un segundo contenedor sobre el mismo volumen, que también es PID 1 en su espacio de PIDs.
 * Aquí el bloqueo lo tiene el kernel: una transacción `BEGIN EXCLUSIVE` de SQLite sobre el
 * fichero, abierta mientras el proceso viva. El kernel la suelta con la muerte del proceso,
 * sea como sea (SIGKILL, OOM), sin nada que limpiar ni que comprobar, y la ve cualquier
 * proceso que abra el mismo fichero, esté o no en el mismo contenedor.
 *
 * `server.lock` no guarda datos: se queda en disco, vacío, también al soltarlo. Borrarlo
 * dejaría a dos procesos con bloqueos sobre ficheros distintos. Mientras se tiene, SQLite
 * deja al lado un `server.lock-journal` vacío, que un SIGKILL puede dejar ahí: como nunca se
 * escribe nada, no hay que recuperar nada de él.
 *
 * Cuidado: es un bloqueo POSIX, y POSIX lo suelta cuando el proceso cierra CUALQUIER
 * descriptor de ese fichero. Este proceso no debe abrir `server.lock` fuera de aquí, ni
 * para leerlo. SQLite sí sabe convivir con esto entre sus propias conexiones.
 *
 * Dos arranques en un mismo proceso (los tests) los excluye el registro de arranques, antes
 * de tocar el fichero.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { registerServerBoot, serverBootIdFor } from './writer-lock';

export const SERVER_LOCK_FILE = 'server.lock';

/** `SQLITE_BUSY`, sin los bits de código extendido. */
const SQLITE_BUSY = 5;

export interface ServerLock {
  /** Identificador de este arranque: lo llevan los `writer.lock` que se tomen bajo la raíz. */
  readonly bootId: string;
  /** Lo suelta. Se llama después de cerrar todos los contextos. */
  release(): void;
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown }).errcode;
  return typeof code === 'number' && (code & 0xff) === SQLITE_BUSY;
}

/**
 * Toma `server.lock` en `controlDir` (tiene que existir) y registra el arranque para la
 * raíz `dataDir`. Devuelve `null` si hay otro `serve-http` vivo sobre esa raíz. No recorre
 * ninguna cuenta: los `writer.lock` obsoletos se limpian al abrir o retirar cada una.
 */
export function acquireServerLock(dataDir: string, controlDir: string): ServerLock | null {
  if (serverBootIdFor(dataDir) !== undefined) return null;
  const path = join(controlDir, SERVER_LOCK_FILE);
  // Lo crea aquí para fijar 0600: SQLite lo crearía con los permisos por defecto.
  closeSync(openSync(path, 'a', 0o600));
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    if (isBusy(error)) return null;
    throw error;
  }
  const bootId = randomUUID();
  const unregister = registerServerBoot(dataDir, bootId);
  let held = true;
  return {
    bootId,
    release() {
      if (!held) return;
      held = false;
      unregister();
      db.close();
    }
  };
}

export type DataRootGuard =
  | { kind: 'single-account' }
  | { kind: 'held'; lock: ServerLock }
  | { kind: 'busy' };

/**
 * Para las órdenes que abren la biblioteca de un directorio de datos y pueden escribir
 * (`serve` por stdio, los ficheros de trabajo, `pair`, `unpair`). Una orden en OTRO contenedor
 * sobre el mismo volumen (`compose run`) también es PID 1: el PID de un `writer.lock` vivo del
 * servidor no la distingue y lo trataría como huérfano, con dos escritores. Si el directorio es
 * la raíz de un `serve-http` (tiene `control/server.lock`), la orden toma ese bloqueo como lo hace
 * el servidor: ocupado = hay un servidor vivo y la orden no escribe; libre = ningún servidor y
 * queda registrado su arranque, con lo que el `writer.lock` de uno caído se reconoce obsoleto.
 * Un directorio de una sola cuenta en local (sin `server.lock`) no cambia.
 */
export function acquireDataRootGuard(dataDir: string): DataRootGuard {
  const controlDir = join(dataDir, 'control');
  if (!existsSync(join(controlDir, SERVER_LOCK_FILE))) return { kind: 'single-account' };
  const lock = acquireServerLock(dataDir, controlDir);
  return lock ? { kind: 'held', lock } : { kind: 'busy' };
}
