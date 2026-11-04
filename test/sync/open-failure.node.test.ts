import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WRITER_LOCK_FILE, WriterLock } from '../../src/lock/writer-lock';
import { LIBRARY_SQLITE_FILE, LibraryInstance } from '../../src/sync/library-instance';
import { IDENTITY, VAULT_KEY } from './devices';

/**
 * Una apertura que falla despues de abrir la SQLite en lectura-escritura no puede dejar el
 * bloqueo cogido ni la conexion abierta (D22, §12.10): la persona quedaria con un escritor
 * "vivo" que nadie cierra hasta reiniciar el proceso.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-openfail-'));
  dirs.push(dir);
  return dir;
}

// Sin `transport` ni `connection`, `SyncRunner.create` lanza justo despues de abrir el puerto.
const BROKEN_SYNC = { identity: IDENTITY, vaultKey: VAULT_KEY } as never;

describe('apertura fallida del escritor', () => {
  it('suelta el bloqueo, cierra la conexion y relanza el error original', async () => {
    const dataDir = tempDataDir();
    await expect(
      LibraryInstance.open({
        dataDir,
        checkIntervalMs: null,
        sync: BROKEN_SYNC,
        lock: { releaseOnExit: false }
      })
    ).rejects.toThrow(/hace falta `transport` o `connection`/);

    expect(existsSync(join(dataDir, WRITER_LOCK_FILE))).toBe(false);
    // Cerrada la ultima conexion, SQLite borra el WAL: sigue abierta si queda el fichero.
    expect(existsSync(join(dataDir, `${LIBRARY_SQLITE_FILE}-wal`))).toBe(false);
    const next = new WriterLock({ dataDir, releaseOnExit: false });
    expect(next.tryAcquire()).toBe(true);
    next.release();
  });

  it('si cerrar la conexion falla a medias, el reintento no suelta el bloqueo hasta cerrarla', async () => {
    const dataDir = tempDataDir();
    const instance = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false }
    });
    const db = (instance as unknown as { current: { db: { close(): void; isOpen: boolean } } })
      .current.db;
    const realClose = db.close.bind(db);
    let fail = true;
    db.close = () => {
      if (fail) throw new Error('close fallido');
      realClose();
    };
    await expect(instance.close()).rejects.toThrow('close fallido');
    expect(existsSync(join(dataDir, WRITER_LOCK_FILE))).toBe(true);
    expect(db.isOpen).toBe(true);

    fail = false;
    await instance.close();
    expect(db.isOpen).toBe(false);
    expect(existsSync(join(dataDir, WRITER_LOCK_FILE))).toBe(false);
  });

  it('un segundo intento sano abre como escritor sin esperar a nadie', async () => {
    const dataDir = tempDataDir();
    await expect(
      LibraryInstance.open({
        dataDir,
        checkIntervalMs: null,
        sync: BROKEN_SYNC,
        lock: { releaseOnExit: false }
      })
    ).rejects.toThrow();
    const instance = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false }
    });
    try {
      expect(instance.role).toBe('this');
    } finally {
      await instance.close();
    }
  });
});
