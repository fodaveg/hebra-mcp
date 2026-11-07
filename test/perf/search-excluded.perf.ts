/**
 * Coste de `hebra_search` por la búsqueda segura (con algo privado configurado, SPEC.md §6.3,
 * tarea 237558ca). Fuera de la suite normal:
 * `npx vitest run --config vitest.perf.config.ts test/perf/search-excluded.perf.ts --maxWorkers=1`.
 *
 * Dos bibliotecas sintéticas en un directorio temporal, que se borra al terminar:
 * - 10 001 notas «garbanzos N»: `garbanzos -anzos` con `limit: 1` excluye todas, así que sin tope
 *   se recorre el motor entero. Mide consultas al motor por llamada, ms y el tramo más largo sin
 *   ceder el hilo (un `setImmediate` que se reprograma: el mayor hueco entre dos vueltas).
 * - 200 notas de 100 000 caracteres que casan por palabra y por subcadena: mide la llamada entera
 *   y, aparte, cuánto se va en `substringSnippet` (el fragmento de la rama de subcadenas).
 * Imprime una línea JSON por caso (`search.perf`) en stderr.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { deriveNote, SqliteLibraryEngine } from '../../src/hebra';
import * as hebra from '../../src/hebra';
import { registerTools } from '../../src/server/register-tools';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { openNodeLibraryPort } from '../../src/store';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';

/** Una línea JSON en stderr, fuera de la captura de consola de vitest. */
function report(fields: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(fields)}\n`);
}

async function build(path: string, bodies: Iterable<string>): Promise<void> {
  const { db, conn } = openNodeSqliteConn(path);
  const engine = await SqliteLibraryEngine.open(conn, 'search-perf');
  await engine.folderCreate(null, 'Diario');
  for (const body of bodies) {
    const created = await engine.noteCreate(null);
    await engine.noteSave({
      ...deriveNote(body),
      id: created.id,
      body,
      expectedLocalSeq: created.localSeq,
      baseBodySha256: created.bodySha256
    });
  }
  db.close();
}

async function connect(sqlitePath: string, dataDir: string) {
  const port = await openNodeLibraryPort({ sqlitePath, dataDir });
  const server = new McpServer({ name: 'search-perf', version: '0.0.0' });
  registerTools(server, {
    port,
    // Algo privado: la búsqueda va por `safeTextSearch`, no por la del motor entera.
    privacyConfig: { privateFolders: [['diario']], privateTags: [] },
    status: new UnlinkedStatusSource()
  });
  const client = new Client({ name: 'search-perf-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const engine = (port as unknown as { engine: SqliteLibraryEngine }).engine;
  return { port, client, engine };
}

/** El mayor hueco entre dos vueltas del event loop mientras corre `work`, y lo que tarda. */
async function measure<T>(work: () => Promise<T>): Promise<{ value: T; ms: number; longestBlockMs: number }> {
  let last = performance.now();
  let longest = 0;
  let timer: NodeJS.Immediate;
  const tick = (): void => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    timer = setImmediate(tick);
  };
  timer = setImmediate(tick);
  const started = performance.now();
  try {
    const value = await work();
    return { value, ms: performance.now() - started, longestBlockMs: longest };
  } finally {
    clearImmediate(timer!);
  }
}

describe('coste de hebra_search por la búsqueda segura', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-search-perf-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('10 001 notas, término negativo por subcadena', { timeout: 600_000 }, async () => {
    const path = join(dir, 'excluded.sqlite');
    await build(path, (function* () {
      for (let i = 0; i < 10_001; i += 1) yield `# Garbanzos ${i}\ngarbanzos ${i}\n`;
    })());
    const { client, engine } = await connect(path, join(dir, 'excluded'));
    const search = vi.spyOn(engine, 'search');
    const call = () => client.callTool({ name: 'hebra_search', arguments: { query: 'garbanzos -anzos', limit: 1 } });
    await call();
    search.mockClear();
    const { value, ms, longestBlockMs } = await measure(call);
    const result = JSON.parse((value as CallToolResult).content[0]!.type === 'text'
      ? ((value as CallToolResult).content[0] as { text: string }).text : '{}');
    report({ event: 'search.perf', case: 'excluded', queries: search.mock.calls.length,
      ms: Math.round(ms), longestBlockMs: Math.round(longestBlockMs), results: result.results?.length,
      nextCursor: result.nextCursor !== null });
    expect(result.results).toEqual([]);
  });

  it('200 notas de 100 000 caracteres', { timeout: 600_000 }, async () => {
    const path = join(dir, 'long.sqlite');
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(1_900);
    await build(path, (function* () {
      for (let i = 0; i < 200; i += 1) yield `# Larga ${i}\nmarmota y escarabajo ${i}\n${filler}`.slice(0, 100_000);
    })());
    const { client } = await connect(path, join(dir, 'long'));
    for (const [label, query] of [['palabra', 'marmota'], ['subcadena', 'carabaj']] as const) {
      for (const limit of [50, 1]) {
        const call = () => client.callTool({ name: 'hebra_search', arguments: { query, limit } });
        await call();
        const { ms, longestBlockMs } = await measure(call);
        report({ event: 'search.perf', case: `long-${label}-limit${limit}`, ms: Math.round(ms),
          longestBlockMs: Math.round(longestBlockMs) });
      }
    }
    // El fragmento de la rama de subcadenas, solo: 200 cuerpos de 100 000 caracteres.
    const body = `# Larga\nmarmota y escarabajo\n${filler}`.slice(0, 100_000);
    const started = performance.now();
    for (let i = 0; i < 200; i += 1) {
      hebra.substringSnippet(body, ['carabaj'], { start: hebra.SEARCH_MARK_START, end: hebra.SEARCH_MARK_END }, 12);
    }
    report({ event: 'search.perf', case: 'substringSnippet-200x100k',
      ms: Math.round(performance.now() - started) });
  });
});
