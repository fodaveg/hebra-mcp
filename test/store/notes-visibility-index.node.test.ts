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
 * 2. Coste medido (no estimado) con 5 000 notas sintéticas: el número exacto va en el
 *    informe de cierre del lote, tomado de la salida de este test.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteLibraryEngine } from '$lib/library/sqlite-engine';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { openNodeLibraryPort } from '../../src/store/node-port';
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

  it(
    'mide 5 000 notas sintéticas (medido, no estimado)',
    async () => {
      const NOTE_COUNT = 5000;
      const FOLDER_COUNT = 20;
      const TAGS_PER_NOTE = 3;
      const TAG_UNIVERSE = 30;

      const dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-visindex-perf-'));
      const sqlitePath = join(dataDir, 'library.sqlite');

      // Se generan con el motor DIRECTAMENTE (como `test-library.ts`), sin `deriveNote`:
      // lo que se mide es la consulta de `notesVisibilityIndex`, no el analizador de
      // Markdown, y saltárselo deja crear 5 000 notas en segundos, no en minutos.
      const { db, conn } = openNodeSqliteConn(sqlitePath);
      const engine = await SqliteLibraryEngine.open(conn, 'perf-fixture');
      const folderIds: string[] = [];
      for (let i = 0; i < FOLDER_COUNT; i += 1) {
        const folder = await engine.folderCreate(null, `Carpeta ${i}`);
        folderIds.push(folder.id);
      }
      const createStart = Date.now();
      for (let i = 0; i < NOTE_COUNT; i += 1) {
        const folderId = folderIds[i % FOLDER_COUNT]!;
        const created = await engine.noteCreate(folderId);
        const tags = Array.from({ length: TAGS_PER_NOTE }, (_, t) => {
          const tag = `tag${(i + t) % TAG_UNIVERSE}`;
          return { tag, label: tag };
        });
        await engine.noteSave({
          id: created.id,
          body: `# Nota ${i}\ncuerpo sintético ${i}`,
          title: `Nota ${i}`,
          titleNorm: `nota ${i}`,
          excerpt: `cuerpo sintético ${i}`,
          expectedLocalSeq: created.localSeq,
          baseBodySha256: created.bodySha256,
          tags
        });
      }
      const createMs = Date.now() - createStart;
      db.close();

      const port = await openNodeLibraryPort({ sqlitePath, dataDir });
      try {
        const rounds = 5;
        const roundsMs: number[] = [];
        let rows: Awaited<ReturnType<typeof port.notesVisibilityIndex>> = [];
        for (let round = 0; round < rounds; round += 1) {
          const start = Date.now();
          rows = await port.notesVisibilityIndex();
          roundsMs.push(Date.now() - start);
        }
        expect(rows).toHaveLength(NOTE_COUNT);

        // eslint-disable-next-line no-console
        console.log(
          `notesVisibilityIndex perf: ${JSON.stringify({
            notes: NOTE_COUNT,
            folders: FOLDER_COUNT,
            createMs,
            notesVisibilityIndexMs: roundsMs
          })}`
        );

        // Cota generosa (no de rendimiento fino): esto es una guarda de regresión, no
        // un objetivo de latencia. El número medido de verdad va en el informe.
        expect(Math.min(...roundsMs)).toBeLessThan(2000);
      } finally {
        port.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    120_000
  );
});
