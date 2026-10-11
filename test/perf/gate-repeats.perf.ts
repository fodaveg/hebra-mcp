/**
 * Cuántas llamadas repite la puerta final de privacidad (`src/server/privacy-gate.ts`, la
 * época de privacidad de la tarea d64e187e) y cuántas acaban en el estado fresco, sin
 * escrituras y con escrituras concurrentes (lo que traería una ronda de sync a mitad de
 * llamada). Fuera de la suite normal: `npx vitest run --config vitest.perf.config.ts
 * test/perf/gate-repeats.perf.ts --maxWorkers=1`.
 *
 * Biblioteca sintética de 3 000 notas de unos 2 KB (como `gate-latency.perf.ts`), en un
 * directorio temporal que se borra al terminar. Las escrituras concurrentes las hace el motor
 * de Hebra en OTRA conexión, como otro proceso o una ronda de sync: cada `WRITE_EVERY_MS` guarda
 * una nota pública distinta (nunca una de las que se leen). Imprime en stderr una línea JSON
 * por escenario (`gate.repeats`) con las llamadas, los intentos repetidos (por la época y por
 * la configuración) y las respuestas del estado fresco (`gateStats`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { deriveNote, SqliteLibraryEngine } from '../../src/hebra';
import { gateStats } from '../../src/server/privacy-gate';
import { registerTools } from '../../src/server/register-tools';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';

const NOTES = 3_000;
const ROUNDS = 300;
const WRITE_EVERY_MS = 20;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function saveBody(engine: SqliteLibraryEngine, id: string, body: string): Promise<void> {
  const row = (await engine.noteRead(id))!;
  const derived = deriveNote(body);
  await engine.noteSave({
    id,
    body,
    title: derived.title,
    titleNorm: derived.titleNorm,
    excerpt: derived.excerpt,
    expectedLocalSeq: row.localSeq,
    baseBodySha256: row.bodySha256,
    tags: derived.tags,
    links: derived.links,
    blobRefs: derived.blobRefs,
    props: derived.props
  });
}

async function buildLibrary(): Promise<{ sqlitePath: string; dataDir: string; ids: string[] }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'hebra-mcp-gate-repeats-'));
  dirs.push(dataDir);
  const sqlitePath = join(dataDir, 'library.sqlite');
  const { db, conn } = openNodeSqliteConn(sqlitePath);
  const engine = await SqliteLibraryEngine.open(conn, 'perf', { journalMode: 'WAL' });
  const diario = await engine.folderCreate(null, 'Diario');
  const ids: string[] = [];
  for (let index = 0; index < NOTES; index += 1) {
    const filler = 'nota de prueba con texto para la búsqueda '.repeat(50);
    const body = `# Nota ${index}\n\n${filler}\n${index % 7 === 0 ? 'aguja_perf\n' : ''}${index % 50 === 0 ? '#secreto\n' : ''}`;
    const created = await engine.noteCreate(index % 20 === 0 ? diario.id : null);
    await saveBody(engine, created.id, body);
    ids.push(created.id);
  }
  db.close();
  return { sqlitePath, dataDir, ids };
}

describe('repeticiones de la puerta final', () => {
  it('sin escrituras y con escrituras concurrentes', { timeout: 600_000 }, async () => {
    const built = await buildLibrary();
    const port = await openNodeLibraryPort({ sqlitePath: built.sqlitePath, dataDir: built.dataDir });
    const server = new McpServer({ name: 'hebra-mcp-perf', version: '0.0.0' });
    registerTools(server, {
      port,
      privacyConfig: { privateFolders: [['diario']], privateTags: ['secreto'] },
      status: new UnlinkedStatusSource()
    });
    const client = new Client({ name: 'hebra-mcp-perf-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // Las que se leen y las que escribe «otro»: nunca las mismas.
    const readId = built.ids[1_001]!;
    const writable = built.ids.filter((id, index) => index % 20 !== 0 && index % 50 !== 0 && index % 7 !== 0 && id !== readId);
    const other = openNodeSqliteConn(built.sqlitePath);
    const otherEngine = await SqliteLibraryEngine.open(other.conn, 'otro', { journalMode: 'WAL' });
    try {
      // La escritura de «otro» entra en mitad de la llamada, entre el filtro de la llamada y la
      // puerta: en la lectura principal de cada herramienta (`noteRead`, `search`), si desde la
      // anterior pasaron `writeEveryMs`. Un temporizador aparte no se colaría: la llamada por el
      // transporte en memoria no cede el hilo a los temporizadores.
      const realNoteRead = port.noteRead.bind(port);
      const realSearch = port.search.bind(port);
      const run = async (scenario: string, writeEveryMs: number | null): Promise<void> => {
        let writes = 0;
        let last = performance.now();
        const maybeWrite = async (): Promise<void> => {
          if (writeEveryMs === null || performance.now() - last < writeEveryMs) return;
          last = performance.now();
          const id = writable[writes % writable.length]!;
          await saveBody(otherEngine, id, `# Escrita ${writes}\n\notro texto\n`);
          writes += 1;
        };
        port.noteRead = async (id) => {
          await maybeWrite();
          return realNoteRead(id);
        };
        port.search = async (...args) => {
          await maybeWrite();
          return realSearch(...args);
        };
        for (const [tool, args] of [
          ['hebra_read_note', { id: readId }],
          ['hebra_search', { query: 'aguja_perf' }]
        ] as const) {
          gateStats.reset();
          let errors = 0;
          const started = performance.now();
          for (let round = 0; round < ROUNDS; round += 1) {
            const result = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
            if (result.isError) errors += 1;
          }
          process.stderr.write(
            `${JSON.stringify({
              event: 'gate.repeats',
              scenario,
              tool,
              calls: gateStats.calls,
              repeats: gateStats.repeats,
              repeatsByEpoch: gateStats.repeatsByEpoch,
              fresh: gateStats.fresh,
              errors,
              msPerCall: Number(((performance.now() - started) / ROUNDS).toFixed(2))
            })}\n`
          );
          expect(gateStats.calls).toBe(ROUNDS);
        }
        port.noteRead = realNoteRead;
        port.search = realSearch;
        process.stderr.write(`${JSON.stringify({ event: 'gate.repeats.writes', scenario, writes })}\n`);
      };
      // El coste de la época sola, al lado del índice de visibilidad que ya pagaba el filtro.
      const median = async (read: () => Promise<unknown>): Promise<number> => {
        const samples: number[] = [];
        for (let round = 0; round < 100; round += 1) {
          const started = performance.now();
          await read();
          samples.push(performance.now() - started);
        }
        return Number(samples.sort((a, b) => a - b)[50]!.toFixed(2));
      };
      process.stderr.write(
        `${JSON.stringify({
          event: 'gate.repeats.cost',
          epochMs: await median(() => port.privacyEpoch()),
          visibilityIndexMs: await median(() => port.notesVisibilityIndex())
        })}\n`
      );
      await run('sin escrituras', null);
      await run('una escritura cada 1000 ms', 1_000);
      await run(`una escritura cada ${WRITE_EVERY_MS} ms`, WRITE_EVERY_MS);
      await run('una escritura en cada lectura', 0);
    } finally {
      other.db.close();
      await client.close();
      await server.close();
      port.close();
    }
  });
});
