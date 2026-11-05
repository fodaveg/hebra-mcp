import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notesPageQuery } from '../../src/hebra';
import { createSyntheticLibrary } from '../fixtures/synthetic-notes';

/**
 * Hebra §26.4 pide que la lista paginada por «anclada aquí» no degrade a un `TEMP B-TREE`. Su
 * test (`library-perf.test.ts`) corre sobre sqlite-wasm; hebra-mcp usa `node:sqlite`, otro
 * SQLite con su `json_each`, así que el plan se mide aquí, sin reloj, con la consulta REAL del
 * motor y notas ancladas en sitios distintos.
 */
describe('plan de la lista con anclados por sitio bajo node:sqlite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-anclados-plan-'));
  const sqlitePath = join(dir, 'library.sqlite');
  let db: DatabaseSync;

  beforeAll(async () => {
    await createSyntheticLibrary(sqlitePath, { notes: 600, folders: 6, tagsPerNote: 1, tagUniverse: 4 });
    db = new DatabaseSync(sqlitePath);
    db.exec(`UPDATE notes SET favorite = 1, pinned_in = '["@notes"]' WHERE rowid % 7 = 0`);
    db.exec(`UPDATE notes SET favorite = 1, pinned_in = '["otra-carpeta"]' WHERE rowid % 11 = 0`);
    db.exec(`UPDATE notes SET favorite = 1, pinned_in = NULL WHERE rowid % 13 = 0`);
    // Columna corrupta: debe leerse como legado sin que `json_each` lance.
    db.exec(`UPDATE notes SET favorite = 1, pinned_in = 'no es json' WHERE rowid % 17 = 0`);
  });
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function plans(statements: readonly { sql: string; bind: readonly unknown[] }[]): string {
    return statements
      .map((statement) =>
        (
          db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...(statement.bind as never[])) as {
            detail: string;
          }[]
        )
          .map((row) => row.detail)
          .join(' | ')
      )
      .join(' || ');
  }

  it('Notas y carpeta, con cursor de ambas bandas: sin TEMP B-TREE y por índice', () => {
    const folder = (db.prepare(`SELECT id FROM folders WHERE id <> 'root' LIMIT 1`).get() as { id: string }).id;
    for (const scope of [{ kind: 'all' } as const, { kind: 'folder', folderId: folder } as const]) {
      for (const cursor of [null, '0:1002000:x', '1:1002000:x']) {
        const query = notesPageQuery(scope, cursor, 60);
        const plan = plans(query.statements);
        expect(plan, `${scope.kind} ${cursor}: ${plan}`).not.toMatch(/TEMP B-TREE/u);
        expect(plan, `${scope.kind} ${cursor}: ${plan}`).toMatch(/USING (COVERING )?INDEX notes_/u);
      }
    }
  });

  it('las sentencias se ejecutan con columna corrupta y devuelven filas', () => {
    const query = notesPageQuery({ kind: 'all' }, null, 60);
    for (const statement of query.statements) {
      const rows = db.prepare(statement.sql).all(...(statement.bind as never[]));
      expect(Array.isArray(rows)).toBe(true);
    }
  });
});
