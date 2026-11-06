/**
 * Memoria de las conexiones SQLite de un contexto: los PRAGMA de caché quedan aplicados y las
 * bases de planes (`jd-plans.sqlite`, `replace-plans.sqlite`) se abren al primer uso, no al
 * abrir el puerto, y se cierran con él si llegaron a abrirse.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { JD_PLANS_SQLITE_FILE, openJdPlansDatabase } from '../../src/store/jd-plans';
import { openReplacePlansDatabase, REPLACE_PLANS_SQLITE_FILE } from '../../src/store/replace-plans';
import { LIBRARY_CACHE_SIZE_KIB, PLANS_CACHE_SIZE_KIB } from '../../src/store/sqlite-conn-node';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-plans-lazy-'));
  dirs.push(dir);
  return dir;
}

function pragma(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number | bigint>;
  return Number(Object.values(row)[0]);
}

/** Los campos privados con las conexiones, para comprobar si están abiertas. */
interface Internals { db: DatabaseSync; jdPlansDb: DatabaseSync | null; replacePlansDb: DatabaseSync | null }

describe('PRAGMA de memoria', () => {
  it('la biblioteca (escritor y lector) y las bases de planes llevan cache_size pequeño y mmap_size 0', async () => {
    const dir = tempDir();
    const sqlitePath = join(dir, 'library.sqlite');
    const writer = await openNodeLibraryPort({ sqlitePath, dataDir: dir });
    const reader = await openNodeLibraryPort({ sqlitePath, dataDir: dir, mode: 'readOnly' });
    for (const port of [writer, reader]) {
      const db = (port as unknown as Internals).db;
      expect(pragma(db, 'cache_size')).toBe(-LIBRARY_CACHE_SIZE_KIB);
      expect(pragma(db, 'mmap_size')).toBe(0);
    }
    reader.close();
    writer.close();
    for (const open of [openJdPlansDatabase, openReplacePlansDatabase]) {
      const plans = open(sqlitePath);
      expect(pragma(plans, 'cache_size')).toBe(-PLANS_CACHE_SIZE_KIB);
      expect(pragma(plans, 'mmap_size')).toBe(0);
      plans.close();
    }
  });
});

describe('bases de planes al primer uso', () => {
  it('un contexto que no usa planes no crea ni abre esas bases', async () => {
    const dir = tempDir();
    const port = await openNodeLibraryPort({ sqlitePath: join(dir, 'library.sqlite'), dataDir: dir });
    await port.writeExclusive(async (store) => { await store.noteCreate(null); });
    const inner = port as unknown as Internals;
    expect(inner.jdPlansDb).toBeNull();
    expect(inner.replacePlansDb).toBeNull();
    expect(existsSync(join(dir, JD_PLANS_SQLITE_FILE))).toBe(false);
    expect(existsSync(join(dir, REPLACE_PLANS_SQLITE_FILE))).toBe(false);
    port.close();
    expect(port.writable).toBe(false);
  });

  it('el primer uso de cada registro abre su base y el cierre la cierra', async () => {
    const dir = tempDir();
    const port = await openNodeLibraryPort({ sqlitePath: join(dir, 'library.sqlite'), dataDir: dir });
    const inner = port as unknown as Internals;
    await port.writeExclusive(async (store) => { void store.jdPlans.get('x'); });
    expect(inner.jdPlansDb?.isOpen).toBe(true);
    expect(inner.replacePlansDb).toBeNull();
    expect(existsSync(join(dir, JD_PLANS_SQLITE_FILE))).toBe(true);
    expect(existsSync(join(dir, REPLACE_PLANS_SQLITE_FILE))).toBe(false);
    await port.writeExclusive(async (store) => { void store.replacePlans; });
    expect(inner.replacePlansDb?.isOpen).toBe(true);
    expect(existsSync(join(dir, REPLACE_PLANS_SQLITE_FILE))).toBe(true);
    const opened = [inner.jdPlansDb, inner.replacePlansDb];
    port.close();
    expect(opened.map((db) => db?.isOpen)).toEqual([false, false]);
    expect(inner.db.isOpen).toBe(false);
  });

  it('un escritor nuevo ve los planes que dejó el anterior sin haberlos abierto antes', async () => {
    const dir = tempDir();
    const sqlitePath = join(dir, 'library.sqlite');
    const first = await openNodeLibraryPort({ sqlitePath, dataDir: dir });
    await first.writeExclusive(async (store) => { void store.replacePlans; });
    first.close();
    const second = await openNodeLibraryPort({ sqlitePath, dataDir: dir });
    expect((second as unknown as Internals).replacePlansDb).toBeNull();
    await second.privacyRecheck({ notes: [], trash: false, files: false, blobs: [], operationTargets: ['nada'] });
    expect((second as unknown as Internals).replacePlansDb?.isOpen).toBe(true);
    second.close();
  });
});
