/**
 * Medida de `hebra_grep` sobre unos 20 MB de cuerpos (aceptación de F1, D13: «por debajo
 * de 1 s en el servidor»). Fuera de la suite normal (tarda unos segundos en generar la
 * biblioteca): `npm run perf:grep` (`vitest.perf.config.ts`). Biblioteca sintética en un
 * directorio temporal, hecha con el propio motor de Hebra, que se borra al terminar; nunca
 * una biblioteca real.
 *
 * Imprime en stderr una línea JSON por consulta (`grep.perf`) con el tiempo de la llamada
 * entera (`runGrep`: filtro de privados, índice, lectura de cuerpos y recorrido), con el
 * índice de subcadena completo y sin él (recorrido completo), y falla si alguna pasa de
 * 1 s.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveNote, SqliteLibraryEngine } from '../../src/hebra';
import { resolveToolContext } from '../../src/server/context';
import { runGrep, type GrepInput } from '../../src/server/tools/grep';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';

const TARGET_BYTES = 20 * 1024 * 1024;
const WORDS = (
  'garbanzos reunión canción Árbol niño año pequeño CAFÉ lumbre hebra nota apartado ' +
  'decisión proyecto mañana tarde semana Diario receta pan harina agua sal horno minutos'
).split(' ');

/** Generador determinista: la misma biblioteca en cada medida. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function buildLibrary(): Promise<{ sqlitePath: string; dataDir: string; bytes: number; notes: number }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'hebra-mcp-grep-perf-'));
  dirs.push(dataDir);
  mkdirSync(dataDir, { recursive: true });
  const sqlitePath = join(dataDir, 'library.sqlite');
  const { db, conn } = openNodeSqliteConn(sqlitePath);
  const engine = await SqliteLibraryEngine.open(conn, 'perf', { journalMode: 'WAL' });
  const diario = await engine.folderCreate(null, 'Diario');
  const next = random(42);
  let bytes = 0;
  let notes = 0;
  while (bytes < TARGET_BYTES) {
    const lines = [`# Nota ${notes} ${WORDS[notes % WORDS.length]}`, ''];
    let size = lines[0]!.length;
    while (size < 5_000) {
      const words: string[] = [];
      const count = Math.floor(next() * 12) + 3;
      for (let index = 0; index < count; index += 1) words.push(WORDS[Math.floor(next() * WORDS.length)]!);
      if (next() < 0.05) words.push(`[[Nota ${Math.floor(next() * 1_000)}|alias]]`);
      if (next() < 0.03) words.push(`hebra://note/${Math.floor(next() * 1e9).toString(16)}`);
      if (next() < 0.1) lines.push(`## Apartado ${lines.length}`);
      const line = words.join(' ');
      lines.push(line);
      size += line.length + 1;
    }
    const body = lines.join('\n');
    // Una de cada veinte, en la carpeta privada.
    const created = await engine.noteCreate(notes % 20 === 0 ? diario.id : null);
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
    bytes += body.length;
    notes += 1;
  }
  db.close();
  return { sqlitePath, dataDir, bytes, notes };
}

const QUERIES: Array<{ name: string; input: GrepInput }> = [
  { name: 'literal raro (prefiltro)', input: { pattern: 'Nota 1234 ' } },
  { name: 'literal que no está', input: { pattern: 'zanahoria' } },
  { name: 'literal común, página de 100', input: { pattern: 'canción', limit: 100 } },
  { name: 'literal común con contexto', input: { pattern: 'harina agua', contextLines: 3, limit: 100 } },
  { name: 'regex con literal', input: { pattern: 'receta\\s+pan\\b', regex: true, limit: 100 } },
  { name: 'regex sin literal que no casa', input: { pattern: '^\\d{4}-\\d{2}$', regex: true } },
  { name: 'regex sin literal, página de 100', input: { pattern: 'ñ\\w+ó', regex: true, limit: 100 } }
];

describe('hebra_grep sobre ~20 MB', () => {
  it('cada consulta, por debajo de 1 s, con y sin índice de subcadena', { timeout: 600_000 }, async () => {
    const built = await buildLibrary();
    process.stderr.write(
      `${JSON.stringify({ event: 'grep.perf.library', notes: built.notes, bodyChars: built.bytes })}\n`
    );
    const port = await openNodeLibraryPort({ sqlitePath: built.sqlitePath, dataDir: built.dataDir });
    try {
      const ctx = await resolveToolContext({
        port,
        privacyConfig: { privateFolders: [['diario']], privateTags: [] },
        status: new UnlinkedStatusSource()
      });
      const measure = async (index: 'con índice' | 'sin índice') => {
        for (const query of QUERIES) {
          await runGrep(ctx, query.input); // en caliente: la primera lectura llena la caché
          const samples: number[] = [];
          let matches = 0;
          let cutoff: string | null = null;
          for (let round = 0; round < 3; round += 1) {
            const started = performance.now();
            const out = await runGrep(ctx, query.input);
            samples.push(performance.now() - started);
            matches = out.matches.length;
            cutoff = out.cutoff;
          }
          const worst = Math.max(...samples);
          process.stderr.write(
            `${JSON.stringify({
              event: 'grep.perf',
              index,
              query: query.name,
              ms: Math.round(worst),
              matches,
              cutoff
            })}\n`
          );
          expect(cutoff, query.name).toBeNull();
          expect(worst, `${query.name} (${index})`).toBeLessThan(1_000);
        }
      };
      await measure('con índice');
      const db = new DatabaseSync(built.sqlitePath);
      db.prepare("DELETE FROM meta WHERE key = 'substring_index_version'").run();
      db.close();
      await measure('sin índice');
    } finally {
      port.close();
    }
  });
});
