/**
 * Relleno del índice de subcadena de Hebra (`notes_trigram`, H5) al arrancar el escritor:
 * la obligación de un escritor Node de `docs/FACHADA-NODE.md` §3 del submódulo. Una
 * biblioteca de antes de H5 (sin la tabla ni la marca) se abre como escritora, el motor
 * crea la tabla vacía y `LibraryInstance` la rellena por páginas en segundo plano; un
 * lector ni lo intenta.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveNote, SqliteLibraryEngine } from '../../src/hebra';
import { WRITER_LOCK_FILE } from '../../src/lock/writer-lock';
import { NodeLibraryPort, openNodeLibraryPort } from '../../src/store/node-port';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { LibraryInstance, LIBRARY_SQLITE_FILE } from '../../src/sync/library-instance';

const dirs: string[] = [];
const instances: LibraryInstance[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BODIES = [
  '# Garbanzos\n\nGarbanzos con espinacas.\n',
  '# Reunión\n\nLa reunión del martes.\n',
  '# Pan\n\nHarina, agua y sal.\n',
  '# Café\n\nCAFÉ solo.\n',
  '# Árbol\n\nUn árbol pequeño.\n'
];

/**
 * Una biblioteca «de antes de H5»: notas guardadas con el motor y, después, sin la tabla
 * `notes_trigram`, su cola, sus disparadores ni sus marcas en `meta`. Al abrirla como
 * escritora, el motor crea la tabla vacía y, como ya hay notas, sin la marca de completo.
 */
async function legacyLibrary(
  bodies: readonly string[] = BODIES
): Promise<{ dataDir: string; sqlitePath: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'hebra-mcp-trigram-'));
  dirs.push(dataDir);
  const sqlitePath = join(dataDir, LIBRARY_SQLITE_FILE);
  const { db, conn } = openNodeSqliteConn(sqlitePath);
  const engine = await SqliteLibraryEngine.open(conn, 'fixture', { journalMode: 'WAL' });
  for (const body of bodies) {
    const created = await engine.noteCreate(null);
    const derived = deriveNote(body);
    await engine.noteSave({
      id: created.id,
      body,
      title: derived.title,
      titleNorm: derived.titleNorm,
      excerpt: derived.excerpt,
      expectedLocalSeq: created.localSeq,
      baseBodySha256: created.bodySha256,
      tags: derived.tags,
      links: derived.links,
      blobRefs: derived.blobRefs,
      props: derived.props
    });
  }
  db.exec(`DROP TRIGGER IF EXISTS notes_trigram_ai;
    DROP TRIGGER IF EXISTS notes_trigram_ad;
    DROP TRIGGER IF EXISTS notes_trigram_au;
    DROP TABLE IF EXISTS notes_trigram;
    DROP TABLE IF EXISTS notes_trigram_pending;
    DELETE FROM meta WHERE key IN ('substring_index_version', 'substring_index_cursor');`);
  db.close();
  return { dataDir, sqlitePath };
}

function inspect<T>(sqlitePath: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function marker(sqlitePath: string): string | null {
  return inspect(sqlitePath, (db) => {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'substring_index_version'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  });
}

function trigramHits(sqlitePath: string, needle: string): number {
  return inspect(sqlitePath, (db) => {
    const row = db
      .prepare('SELECT count(*) AS c FROM notes_trigram WHERE notes_trigram MATCH ?')
      .get(`"${needle}"`) as { c: number | bigint };
    return Number(row.c);
  });
}

function hasTrigramTable(sqlitePath: string): boolean {
  return inspect(
    sqlitePath,
    (db) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes_trigram'").get() !==
      undefined
  );
}

describe('relleno del índice de subcadena (H5)', () => {
  it('el escritor lo rellena al arrancar, en segundo plano, y deja la marca', async () => {
    const { dataDir, sqlitePath } = await legacyLibrary();
    const instance = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false }
    });
    instances.push(instance);
    expect(instance.role).toBe('this');
    await instance.whenSubstringIndexSettled();
    expect(marker(sqlitePath)).toBe('1');
    // «anzos» solo está DENTRO de «Garbanzos»: lo encuentra el índice de subcadena.
    expect(trigramHits(sqlitePath, 'anzos')).toBe(1);
    // Sin distinguir mayúsculas ni tildes (`trigram remove_diacritics 1`).
    expect(trigramHits(sqlitePath, 'reunion')).toBe(1);
    // Y `hebra_search` ya busca por subcadena.
    expect((await instance.port.search('anzos', null, 10)).items).toHaveLength(1);
  });

  it('por páginas, cediendo el turno: una lectura se atiende entre dos páginas', async () => {
    const { dataDir, sqlitePath } = await legacyLibrary();
    const port = await openNodeLibraryPort({ sqlitePath, dataDir });
    try {
      expect(marker(sqlitePath)).toBeNull();
      const readsBetweenPages: number[] = [];
      const result = await port.fillSubstringIndex({
        pageSize: 2,
        yieldControl: async () => {
          readsBetweenPages.push((await port.notesPage(null, 10)).items.length);
        }
      });
      // 5 notas en páginas de 2: tres páginas, dos esperas entre ellas.
      expect(result).toEqual({ ran: true, indexed: 5, done: true });
      expect(readsBetweenPages).toEqual([5, 5]);
      expect(marker(sqlitePath)).toBe('1');
      // Con el índice completo, repetirlo no hace nada.
      expect(await port.fillSubstringIndex()).toEqual({ ran: false, indexed: 0, done: true });
    } finally {
      port.close();
    }
  });

  it('un lector no lo intenta: ni escribe la marca ni crea la tabla', async () => {
    const { dataDir, sqlitePath } = await legacyLibrary();
    // Otro proceso vivo tiene el bloqueo: esta instancia arranca de lectora.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    });
    children.push(child);
    writeFileSync(
      join(dataDir, WRITER_LOCK_FILE),
      JSON.stringify({ pid: child.pid, nonce: 'otro', startedAt: new Date().toISOString() })
    );
    const reader = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false }
    });
    instances.push(reader);
    expect(reader.role).toBe('other_instance');
    await reader.whenSubstringIndexSettled();
    expect(hasTrigramTable(sqlitePath)).toBe(false);
    expect(marker(sqlitePath)).toBeNull();

    // Y el puerto de solo lectura, llamado a mano, vuelve sin escribir.
    const port = await openNodeLibraryPort({ sqlitePath, dataDir, mode: 'readOnly' });
    try {
      expect(await port.fillSubstringIndex()).toEqual({ ran: false, indexed: 0, done: false });
    } finally {
      port.close();
    }
    expect(marker(sqlitePath)).toBeNull();
  });

  it('tras un fallo, checkWriter lo reintenta (con espera entre intentos)', async () => {
    const { dataDir, sqlitePath } = await legacyLibrary();
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    const spy = vi.spyOn(NodeLibraryPort.prototype, 'fillSubstringIndex').mockRejectedValueOnce(busy);
    try {
      const instance = await LibraryInstance.open({
        dataDir,
        checkIntervalMs: null,
        substringIndexRetryMs: 0,
        lock: { releaseOnExit: false }
      });
      instances.push(instance);
      await instance.whenSubstringIndexSettled();
      expect(marker(sqlitePath)).toBeNull();
      // La comprobación periódica del escritor (aquí, a mano) lo vuelve a lanzar.
      await instance.checkWriter();
      await instance.whenSubstringIndexSettled();
      expect(marker(sqlitePath)).toBe('1');
      expect(spy).toHaveBeenCalledTimes(2);
      // Hecho: la siguiente comprobación ya no lo lanza.
      await instance.checkWriter();
      await instance.whenSubstringIndexSettled();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('la espera entre reintentos crece: antes de tiempo, checkWriter no lo lanza', async () => {
    const { dataDir, sqlitePath } = await legacyLibrary();
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    const spy = vi.spyOn(NodeLibraryPort.prototype, 'fillSubstringIndex').mockRejectedValueOnce(busy);
    try {
      const instance = await LibraryInstance.open({
        dataDir,
        checkIntervalMs: null,
        substringIndexRetryMs: 60_000,
        lock: { releaseOnExit: false }
      });
      instances.push(instance);
      await instance.whenSubstringIndexSettled();
      await instance.checkWriter();
      await instance.whenSubstringIndexSettled();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(marker(sqlitePath)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('corta las páginas también por bytes de cuerpo', async () => {
    const big = Array.from({ length: 5 }, (_, index) => `# Nota ${index}\n\n${'x'.repeat(900)}\n`);
    const { dataDir, sqlitePath } = await legacyLibrary(big);
    const port = await openNodeLibraryPort({ sqlitePath, dataDir });
    try {
      let yields = 0;
      const result = await port.fillSubstringIndex({
        pageBytes: 2_000,
        yieldControl: async () => {
          yields += 1;
        }
      });
      // 5 notas de ~920 bytes con 2 000 por página: 3 (la tercera pasa del tope) y 2, que
      // deja la marca.
      expect(result).toEqual({ ran: true, indexed: 5, done: true });
      expect(yields).toBe(1);
      expect(marker(sqlitePath)).toBe('1');
    } finally {
      port.close();
    }
  });
});
