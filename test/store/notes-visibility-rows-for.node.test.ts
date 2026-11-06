/**
 * `noteVisibilityRowsFor` (`src/store/privacy-sql.ts`) y `NodeLibraryPort.notesVisibilityIndexFor`:
 * las filas de `noteVisibilityRows` solo de las notas pedidas (pieza A1 del plan de memoria del
 * 6 nov 2026: cada llamada materializaba DOS veces todas las notas vivas, y a 30 000 notas eran
 * 78-104 MiB y unos 0,4 s por llamada; lo que se quiere es un coste O(notas tocadas)).
 *
 * Lo que se comprueba es EQUIVALENCIA con la consulta completa, caso por caso, sobre la
 * biblioteca de prueba más los casos que no trae: nota viva en una lápida (A2, con uno y con dos
 * escalones de subida), nota con la carpeta pendiente del sync, nota bloqueada (A1), con y sin
 * etiquetas, papelera, lápida de nota (purgada) e ids desconocidos. Y que la sentencia es UNA
 * sola para cualquier número de ids (la lista va en JSON a `json_each(?)`), así que nada que
 * cachee sentencias por texto crece con la longitud de la lista.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteLibraryEngine } from '../../src/hebra';
import { FsBlobStore } from '../../src/store/blob-store-fs';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { noteVisibilityRows, noteVisibilityRowsFor } from '../../src/store/privacy-sql';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import type { NoteVisibilityEntry } from '../../src/store/types';
import { createSyntheticLibrary } from '../fixtures/synthetic-notes';
import { buildTestLibrary, createNote, legacyFolderTombstone, type TestLibrary } from '../fixtures/test-library';

const UNKNOWN = 'nota-que-no-existe-0000';

/** Ordenadas por id: ninguna de las dos consultas promete orden. */
function byId(rows: readonly NoteVisibilityEntry[]): NoteVisibilityEntry[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `db` que anota el texto de cada `prepare`. */
function recording(db: DatabaseSync): { db: DatabaseSync; sqls: string[] } {
  const sqls: string[] = [];
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          sqls.push(sql);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return { db: proxy, sqls };
}

interface Scenario {
  library: TestLibrary;
  /** Viva, en una subcarpeta de `Diario` que es lápida: un escalón de subida (A2). */
  tombstoneNoteId: string;
  /** Viva, en `Proyectos/Secreto/Más` con las dos carpetas lápida: dos escalones. */
  deepTombstoneNoteId: string;
  /** Viva, con una carpeta que aún no llegó por sync (`stored_folder_id` sin fila). */
  pendingFolderNoteId: string;
  /** Lápida de nota (`notePurge`): `deleted = 1`. */
  purgedNoteId: string;
  /** Viva, con varias etiquetas (y sus ancestros). */
  multiTagNoteId: string;
}

describe('noteVisibilityRowsFor', () => {
  let dataDir: string;
  let sqlitePath: string;
  let scenario: Scenario;
  let db: DatabaseSync;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-visfor-'));
    sqlitePath = join(dataDir, 'library.sqlite');
    const library = await buildTestLibrary(sqlitePath, { lockedNote: true });
    const writer = openNodeSqliteConn(sqlitePath);
    try {
      const engine = await SqliteLibraryEngine.open(writer.conn, 'visibility-rows-for', {
        blobs: new FsBlobStore(dirname(sqlitePath))
      });
      const sub = await engine.folderCreate(library.folders.diario, 'Sub');
      const tombstoneNote = await createNote(engine, sub.id, '# En una lápida\n#salud\ntexto\n');
      await legacyFolderTombstone(engine, sub.id);

      const secreto = await engine.folderCreate(library.folders.proyectos, 'Secreto');
      const deeper = await engine.folderCreate(secreto.id, 'Más');
      const deepNote = await createNote(engine, deeper.id, '# Dos lápidas\ntexto\n');
      await legacyFolderTombstone(engine, deeper.id);
      await legacyFolderTombstone(engine, secreto.id);

      const pending = await createNote(engine, null, '# Carpeta pendiente\ntexto\n');
      writer.db
        .prepare('UPDATE notes SET folder_id = ? WHERE id = ?')
        .run('carpeta-que-no-ha-llegado', pending.id);

      const purged = await createNote(engine, null, '# Purgada\n#proyectos\ntexto\n');
      await engine.noteTrash(purged.id);
      await engine.notePurge(purged.id);

      const multi = await createNote(engine, library.folders.proyectos, '# Varias\n#uno #dos/tres #cuatro\ntexto\n');

      scenario = {
        library,
        tombstoneNoteId: tombstoneNote.id,
        deepTombstoneNoteId: deepNote.id,
        pendingFolderNoteId: pending.id,
        purgedNoteId: purged.id,
        multiTagNoteId: multi.id
      };
    } finally {
      writer.db.close();
    }
    db = openNodeSqliteConn(sqlitePath, 'readOnly').db;
  });

  afterAll(async () => {
    db?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('el escenario cubre los casos que dice (si no, la equivalencia no probaría nada)', () => {
    const full = new Map(noteVisibilityRows(db).map((row) => [row.id, row]));
    const { library } = scenario;
    expect(full.get(library.lockedPrivateNoteId)?.locked).toBe(true);
    expect(full.get(scenario.tombstoneNoteId)?.folderTrail).toHaveLength(1);
    expect(full.get(scenario.deepTombstoneNoteId)?.folderTrail).toHaveLength(2);
    expect(full.get(scenario.pendingFolderNoteId)?.storedFolderId).toBe('carpeta-que-no-ha-llegado');
    expect(full.get(scenario.pendingFolderNoteId)?.folderTrail).toEqual([]);
    expect(full.get(scenario.multiTagNoteId)?.tags.length).toBeGreaterThanOrEqual(4);
    expect(full.get(library.linkingNoteId)?.tags).toEqual([]);
    expect(full.has(library.trashedNoteId)).toBe(false);
    expect(full.has(library.trashedDeletedPrivateFolderNoteId)).toBe(false);
    expect(full.has(scenario.purgedNoteId)).toBe(false);
    const purged = db.prepare('SELECT deleted FROM notes WHERE id = ?').get(scenario.purgedNoteId) as
      | { deleted: number | bigint }
      | undefined;
    expect(Number(purged?.deleted)).toBe(1);
  });

  it('cada nota, sola: la misma fila que la consulta completa, o ninguna', () => {
    const full = noteVisibilityRows(db);
    const { library } = scenario;
    const ids = [
      library.publicNoteId,
      library.privateFolderNoteId,
      library.privateTagNoteId,
      library.linkingNoteId,
      library.lockedPrivateNoteId,
      scenario.tombstoneNoteId,
      scenario.deepTombstoneNoteId,
      scenario.pendingFolderNoteId,
      scenario.multiTagNoteId,
      library.trashedNoteId,
      library.trashedPrivateFolderNoteId,
      library.trashedDeletedPrivateFolderNoteId,
      scenario.purgedNoteId,
      UNKNOWN
    ];
    for (const id of ids) {
      expect({ id, rows: noteVisibilityRowsFor(db, [id]) }).toEqual({
        id,
        rows: full.filter((row) => row.id === id)
      });
    }
  });

  it('todas las vivas más papelera, lápidas y desconocidos: exactamente las filas completas', () => {
    const full = noteVisibilityRows(db);
    const { library } = scenario;
    const ids = [
      UNKNOWN,
      library.trashedNoteId,
      scenario.purgedNoteId,
      ...full.map((row) => row.id).reverse(),
      library.trashedDeletedPublicFolderNoteId
    ];
    expect(byId(noteVisibilityRowsFor(db, ids))).toEqual(byId(full));
  });

  it('lista vacía: nada, y sin tocar SQLite', () => {
    const counted = recording(db);
    expect(noteVisibilityRowsFor(counted.db, [])).toEqual([]);
    expect(counted.sqls).toEqual([]);
  });

  it('ids repetidos: una fila por nota, sin etiquetas dobles', () => {
    const full = noteVisibilityRows(db);
    const a = scenario.multiTagNoteId;
    const b = scenario.tombstoneNoteId;
    const rows = noteVisibilityRowsFor(db, [a, a, b, a, UNKNOWN, UNKNOWN, b]);
    expect(byId(rows)).toEqual(byId(full.filter((row) => row.id === a || row.id === b)));
  });

  it('un único texto SQL para cualquier número de ids', () => {
    const counted = recording(db);
    const live = noteVisibilityRows(db).map((row) => row.id);
    const padded = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => (i < live.length ? live[i]! : `${UNKNOWN}-${i}`));
    const lengths = [1, 2, 5, live.length, 2000];
    for (const n of lengths) noteVisibilityRowsFor(counted.db, padded(n));
    // La de las notas, una por llamada y siempre la misma; la otra posible es la de las
    // filas de carpeta (`folderRowFacts`), solo cuando alguna nota sube por lápidas.
    const visibility = counted.sqls.filter((sql) => sql.includes('json_each'));
    expect(visibility).toHaveLength(lengths.length);
    expect(new Set(visibility).size).toBe(1);
    expect(new Set(counted.sqls).size).toBeLessThanOrEqual(2);
  });

  it('por el puerto: lo mismo que `notesVisibilityIndex()` filtrado', async () => {
    const port = await openNodeLibraryPort({ sqlitePath, dataDir });
    try {
      const full = await port.notesVisibilityIndex();
      const wanted = new Set([
        scenario.library.lockedPrivateNoteId,
        scenario.deepTombstoneNoteId,
        scenario.library.publicNoteId,
        scenario.library.trashedNoteId,
        UNKNOWN
      ]);
      expect(byId(await port.notesVisibilityIndexFor([...wanted]))).toEqual(
        byId(full.filter((row) => wanted.has(row.id)))
      );
      expect(await port.notesVisibilityIndexFor([])).toEqual([]);
    } finally {
      port.close();
    }
  });
});

describe('noteVisibilityRowsFor con un lote grande', () => {
  it('2 000 ids de 2 000 notas, y medio lote con desconocidos: las mismas filas que la consulta completa', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-visfor-big-'));
    try {
      const sqlitePath = join(dataDir, 'library.sqlite');
      await createSyntheticLibrary(sqlitePath, { notes: 2000, folders: 4, tagsPerNote: 3, tagUniverse: 8 });
      const { db } = openNodeSqliteConn(sqlitePath, 'readOnly');
      try {
        const full = noteVisibilityRows(db);
        expect(full).toHaveLength(2000);
        const ids = full.map((row) => row.id).reverse();
        expect(byId(noteVisibilityRowsFor(db, ids))).toEqual(byId(full));

        const half = ids.filter((_, i) => i % 2 === 0);
        const mixed = [...half, ...Array.from({ length: 1000 }, (_, i) => `${UNKNOWN}-${i}`)];
        const halfSet = new Set(half);
        expect(byId(noteVisibilityRowsFor(db, mixed))).toEqual(byId(full.filter((row) => halfSet.has(row.id))));
      } finally {
        db.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
