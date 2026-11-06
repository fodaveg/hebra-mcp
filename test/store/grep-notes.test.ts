/**
 * `NoteRowsById` y `grepNotePage` (M2 del plan de memoria, 6 nov 2026): las notas vivas en el
 * orden de `hebra_grep` y de la simulación (unidades UTF-16, `byId`), leídas por páginas de
 * SQLite (bytes UTF-8). Lo que se comprueba:
 * 1. Con cualquier tamaño de página y cualquier punto de partida, la lista es la misma que
 *    filtrar y ordenar con `byId` todas las filas de una vez (lo que hacían antes las dos
 *    herramientas), también con ids que tienen unidades desde U+D800 (sustitutos y
 *    U+E000-U+FFFF), donde los dos órdenes no coinciden.
 * 2. Sobre SQLite de verdad: `ORDER BY id` ordena por bytes UTF-8 (la premisa de la
 *    reordenación), `grepNotePage` deja fuera papelera y lápidas, y ninguna página pasa de su
 *    tamaño.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { byId, NoteRowsById } from '../../src/store/grep-notes';
import { grepNotePage, grepNoteRowsFor, type GrepNoteRow, type GrepNotesFrom } from '../../src/store/grep-sql';

/** Ids donde el orden UTF-16 y el UTF-8 no coinciden, mezclados con ids normales. */
const IDS = [
  'a',
  'a\u{10000}',
  'a',
  'a￿',
  'a￿b',
  'a\u{1F600}x',
  'a\u{1F600}',
  'ab',
  'b',
  'b',
  'b\u{10400}',
  'c',
  '',
  '\u{10000}',
  '�',
  'z',
  'ñ',
  'ña',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  'ffffffff-ffff-4fff-bfff-ffffffffffff'
];

const utf8 = (left: string, right: string): number => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

function rowsFor(ids: readonly string[]): GrepNoteRow[] {
  return ids.map((id, index) => ({ rowid: index + 1, id, title: `t${index}`, locked: index % 5 === 0, conflict: false }));
}

/** Un puerto de mentira con el orden de SQLite (bytes UTF-8) y paginación por clave. */
function fakePort(rows: readonly GrepNoteRow[]) {
  const ordered = [...rows].sort((left, right) => utf8(left.id, right.id));
  const calls: number[] = [];
  return {
    calls,
    async grepNotesPage(from: GrepNotesFrom | null, limit: number): Promise<GrepNoteRow[]> {
      const page = ordered
        .filter((row) => from === null || utf8(row.id, from.id) > 0 || (from.inclusive && row.id === from.id))
        .slice(0, limit);
      calls.push(page.length);
      return page;
    }
  };
}

/** Todo, pedido en tandas de 1, 2, 3… (sin relación con el tamaño de página). */
async function drain(source: NoteRowsById): Promise<string[]> {
  const out: string[] = [];
  for (let size = 1; ; size = (size % 4) + 1) {
    const rows = await source.take(size);
    out.push(...rows.map((row) => row.id));
    if (rows.length < size) {
      expect(await source.take(3), 'al acabar no da nada más').toEqual([]);
      return out;
    }
  }
}

/** Lo de antes: todas las filas, filtradas desde `from` y ordenadas con `byId`. */
function expected(ids: readonly string[], from: GrepNotesFrom | null): string[] {
  return [...ids]
    .filter((id) => from === null || byId(id, from.id) > 0 || (from.inclusive && id === from.id))
    .sort(byId);
}

describe('NoteRowsById: el orden de byId leyendo por páginas', () => {
  it('los dos órdenes de verdad difieren con estos ids (si no, la prueba no prueba nada)', () => {
    expect([...IDS].sort(byId)).not.toEqual([...IDS].sort(utf8));
  });

  it('con cualquier página y desde cualquier punto, lo mismo que ordenar todo con byId', async () => {
    const rows = rowsFor(IDS);
    const starts: Array<GrepNotesFrom | null> = [null];
    for (const id of [...IDS, 'a', 'a\u{10001}', 'aa', '', '\u{10FFFF}']) {
      starts.push({ id, inclusive: true }, { id, inclusive: false });
    }
    for (const pageSize of [1, 2, 3, 5, 7, 1_000]) {
      for (const from of starts) {
        const port = fakePort(rows);
        const got = await drain(new NoteRowsById(port, from, pageSize));
        expect(got, JSON.stringify({ pageSize, from })).toEqual(expected(IDS, from));
        expect(Math.max(0, ...port.calls), 'ninguna página pasa de su tamaño').toBeLessThanOrEqual(pageSize);
      }
    }
  });

  it('con ids UUID no lee más de una página de más', async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const port = fakePort(rowsFor(ids));
    expect(await drain(new NoteRowsById(port, null, 8))).toEqual([...ids].sort(byId));
    // 6 páginas llenas y una corta.
    expect(port.calls).toEqual([8, 8, 8, 8, 8, 8, 2]);
  });
});

describe('grepNotePage sobre SQLite', () => {
  function database(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE notes (
      rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, title TEXT, locked INTEGER NOT NULL DEFAULT 0,
      conflict_of TEXT, deleted INTEGER NOT NULL DEFAULT 0, trashed_at INTEGER)`);
    const insert = db.prepare('INSERT INTO notes (id, title, locked, deleted, trashed_at) VALUES (?, ?, ?, ?, ?)');
    for (const [index, id] of IDS.entries()) insert.run(id, `t${index}`, index % 5 === 0 ? 1 : 0, 0, null);
    insert.run('amuerta', 'lápida', 0, 1, null);
    insert.run('apapelera', 'papelera', 0, 0, 1);
    return db;
  }

  it('ORDER BY id es el orden de los bytes UTF-8, y por páginas sale lo de byId', async () => {
    const db = database();
    try {
      const whole = grepNotePage(db, null, 1_000).map((row) => row.id);
      expect(whole).toEqual([...IDS].sort(utf8));
      for (const pageSize of [1, 2, 4, 9]) {
        const pages: number[] = [];
        const port = {
          grepNotesPage: async (from: GrepNotesFrom | null, limit: number) => {
            const page = grepNotePage(db, from, limit);
            pages.push(page.length);
            return page;
          }
        };
        expect(await drain(new NoteRowsById(port, null, pageSize))).toEqual([...IDS].sort(byId));
        expect(Math.max(...pages)).toBeLessThanOrEqual(pageSize);
        expect(pages.length).toBeGreaterThan(IDS.length / pageSize - 1);
      }
      // Desde un id exacto, con y sin él.
      expect(grepNotePage(db, { id: 'b', inclusive: true }, 2).map((row) => row.id)).toEqual(['b', 'b']);
      expect(grepNotePage(db, { id: 'b', inclusive: false }, 2).map((row) => row.id)).toEqual(['b', 'b\u{10400}']);
    } finally {
      db.close();
    }
  });

  it('grepNoteRowsFor: solo las vivas de esos ids, una vez cada una', () => {
    const db = database();
    try {
      const got = grepNoteRowsFor(db, ['b', 'b', 'amuerta', 'apapelera', 'no-existe', 'c'])
        .map((row) => row.id)
        .sort(byId);
      expect(got).toEqual(['b', 'c']);
      expect(grepNoteRowsFor(db, [])).toEqual([]);
    } finally {
      db.close();
    }
  });
});
