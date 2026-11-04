/**
 * Cuánto cuesta `NodeLibraryPort.notesVisibilityIndex()` con 5 000 notas sintéticas (20 carpetas,
 * 3 etiquetas por nota). Fuera de la suite normal, porque mide milisegundos y crea 5 000 notas:
 * `npx vitest run --config vitest.perf.config.ts test/perf/notes-visibility-index.perf.ts --maxWorkers=1`.
 *
 * Que la consulta sea UNA sola vuelta (y no O(notas)) lo comprueba, sin reloj, el test normal
 * `test/store/notes-visibility-index.node.test.ts`. Imprime en stderr una línea JSON
 * (`notesVisibilityIndex.perf`) con lo que tardó crear las notas y cada ronda. El techo de 2 s
 * por ronda es una guarda de regresión holgada (medido en una máquina sin carga: ver la línea).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { createSyntheticLibrary } from '../fixtures/synthetic-notes';

const NOTE_COUNT = 5000;
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

it('notesVisibilityIndex con 5 000 notas', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hebra-mcp-visindex-perf-'));
  dirs.push(dataDir);
  const sqlitePath = join(dataDir, 'library.sqlite');
  const createMs = await createSyntheticLibrary(sqlitePath, {
    notes: NOTE_COUNT,
    folders: 20,
    tagsPerNote: 3,
    tagUniverse: 30
  });
  const port = await openNodeLibraryPort({ sqlitePath, dataDir });
  try {
    const roundsMs: number[] = [];
    let rows: Awaited<ReturnType<typeof port.notesVisibilityIndex>> = [];
    for (let round = 0; round < 5; round += 1) {
      const start = Date.now();
      rows = await port.notesVisibilityIndex();
      roundsMs.push(Date.now() - start);
    }
    process.stderr.write(
      `notesVisibilityIndex.perf ${JSON.stringify({ notes: NOTE_COUNT, createMs, notesVisibilityIndexMs: roundsMs })}\n`
    );
    expect(rows).toHaveLength(NOTE_COUNT);
    expect(Math.min(...roundsMs)).toBeLessThan(2000);
  } finally {
    port.close();
  }
}, 600_000);
