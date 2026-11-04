/**
 * `NodeLibraryPort.notesVisibilityIndex()` (`src/store/node-port.ts`): UNA consulta SQL
 * que sustituye la composición anterior de `src/privacy/library-index.ts` (O(notas)
 * `noteRead` + un `notesPage` por etiqueta), pedida por el coordinador el 26 sep 2026
 * junto con el hallazgo de la fuga del filtro de privados (§1: `PrivacyFilter` ya no se
 * cachea, se reconstruye en cada llamada de herramienta, y esto es lo que lo hace
 * barato).
 *
 * Dos cosas se comprueban aquí:
 * 1. Corrección: carpeta EFECTIVA y etiquetas (con ancestros) de cada nota viva,
 *    contra hechos conocidos de la biblioteca de prueba (`test-library.ts`) — el
 *    resto de la suite (147 tests antes de este fichero) ya prueba, sin haber
 *    cambiado una sola aserción, que el comportamiento observable de las 7
 *    herramientas es el mismo que con la composición anterior.
 * 2. Que sea UNA vuelta de SQL (las sentencias que prepara no crecen con las notas). Los
 *    milisegundos con 5 000 notas están en `test/perf/notes-visibility-index.perf.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { noteVisibilityRows } from '../../src/store/privacy-sql';
import { createSyntheticLibrary } from '../fixtures/synthetic-notes';
import { buildTestLibrary } from '../fixtures/test-library';

describe('notesVisibilityIndex', () => {
  it('carpeta efectiva y etiquetas (con ancestros) de cada nota viva; la papelera queda fuera', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-visindex-'));
    const sqlitePath = join(dataDir, 'library.sqlite');
    const library = await buildTestLibrary(sqlitePath);
    const port = await openNodeLibraryPort({ sqlitePath, dataDir });
    try {
      const rows = await port.notesVisibilityIndex();
      const byId = new Map(rows.map((row) => [row.id, row]));

      // La papelera nunca sale (SPEC.md §5).
      expect(byId.has(library.trashedNoteId)).toBe(false);

      // Las cuatro notas de `Proyectos/Lumbre` comparten carpeta: pública, pública 2,
      // la copia de conflicto (nace en la carpeta del original) y la duplicada B.
      const lumbreFolderId = byId.get(library.publicNoteId)?.folderId;
      expect(lumbreFolderId).toBeDefined();
      expect(byId.get(library.publicNote2Id)?.folderId).toBe(lumbreFolderId);
      expect(byId.get(library.conflictCopyId)?.folderId).toBe(lumbreFolderId);
      expect(byId.get(library.duplicateNoteBId)?.folderId).toBe(lumbreFolderId);
      // La duplicada A está en `Proyectos` (la carpeta padre), no en `Lumbre`.
      expect(byId.get(library.duplicateNoteAId)?.folderId).not.toBe(lumbreFolderId);

      // La oculta de carpeta está en `Diario/2026`, otra carpeta distinta.
      const diarioFolderId = byId.get(library.privateFolderNoteId)?.folderId;
      expect(diarioFolderId).toBeDefined();
      expect(diarioFolderId).not.toBe(lumbreFolderId);

      // Etiquetas CON ancestros (como las guarda `note_tags`): `proyectos/lumbre`
      // también lleva `proyectos`, y `secreto/personal` también lleva `secreto`.
      expect(new Set(byId.get(library.publicNoteId)?.tags)).toEqual(
        new Set(['proyectos', 'proyectos/lumbre'])
      );
      expect(new Set(byId.get(library.privateTagNoteId)?.tags)).toEqual(
        new Set(['secreto', 'secreto/personal'])
      );
      // Sin etiquetas: `[]`, no `undefined` ni `null`.
      expect(byId.get(library.linkingNoteId)?.tags).toEqual([]);
    } finally {
      port.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('es UNA vuelta de SQL: las sentencias que prepara no crecen con el número de notas', async () => {
    const prepared = async (notes: number): Promise<{ statements: number; rows: number }> => {
      const dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-visindex-count-'));
      try {
        const sqlitePath = join(dataDir, 'library.sqlite');
        await createSyntheticLibrary(sqlitePath, { notes, folders: 4, tagsPerNote: 3, tagUniverse: 8 });
        const { db } = openNodeSqliteConn(sqlitePath, 'readOnly');
        let statements = 0;
        const counted = new Proxy(db, {
          get(target, prop) {
            if (prop === 'prepare') {
              return (sql: string) => {
                statements += 1;
                return target.prepare(sql);
              };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
        const rows = noteVisibilityRows(counted).length;
        db.close();
        return { statements, rows };
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    };
    const small = await prepared(10);
    const large = await prepared(120);
    expect({ rows: [small.rows, large.rows], sameStatements: small.statements === large.statements }).toEqual({
      rows: [10, 120],
      sameStatements: true
    });
  });
});
