/**
 * Latencia de `hebra_read_note` y `hebra_search` por el camino entero del MCP
 * (`registerTools` y un cliente en memoria, como stdio), para medir lo que añade la puerta
 * final de privacidad (`src/server/privacy-gate.ts`, tarea d64e187e, SPEC.md §6.3). El
 * mismo fichero se corre sobre el árbol de antes y el de después: solo usa lo que existe en
 * los dos. Fuera de la suite normal: `npx vitest run --config vitest.perf.config.ts
 * test/perf/gate-latency.perf.ts --maxWorkers=1`.
 *
 * Biblioteca sintética en un directorio temporal, hecha con el motor de Hebra, que se borra
 * al terminar: 3 000 notas de unos 2 KB en 60 carpetas, una de cada veinte en la carpeta
 * privada y una de cada cincuenta con la etiqueta privada. Imprime en stderr una línea JSON
 * por herramienta (`gate.perf`) con la mediana y el p95 en ms de `ROUNDS` llamadas, tras
 * `WARMUP` en caliente.
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
import { registerTools } from '../../src/server/register-tools';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';

const NOTES = 3_000;
const FOLDERS = 60;
const WARMUP = 30;
const ROUNDS = 300;
const WORDS = (
  'garbanzos reunión canción árbol niño año pequeño café lumbre hebra nota apartado ' +
  'decisión proyecto mañana tarde semana receta pan harina agua sal horno minutos'
).split(' ');

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

async function buildLibrary(): Promise<{ sqlitePath: string; dataDir: string; readId: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'hebra-mcp-gate-perf-'));
  dirs.push(dataDir);
  const sqlitePath = join(dataDir, 'library.sqlite');
  const { db, conn } = openNodeSqliteConn(sqlitePath);
  const engine = await SqliteLibraryEngine.open(conn, 'perf', { journalMode: 'WAL' });
  const diario = await engine.folderCreate(null, 'Diario');
  const folders: string[] = [];
  for (let index = 0; index < FOLDERS; index += 1) {
    folders.push((await engine.folderCreate(index % 3 === 0 ? null : folders[index - 1]!, `Carpeta ${index}`)).id);
  }
  const next = random(7);
  let readId = '';
  for (let index = 0; index < NOTES; index += 1) {
    const lines = [`# Nota ${index}`, ''];
    let size = 0;
    while (size < 2_000) {
      const words: string[] = [];
      const count = Math.floor(next() * 12) + 3;
      for (let word = 0; word < count; word += 1) words.push(WORDS[Math.floor(next() * WORDS.length)]!);
      if (next() < 0.1) lines.push(`## Apartado ${lines.length}`);
      const line = words.join(' ');
      lines.push(line);
      size += line.length + 1;
    }
    if (index % 50 === 0) lines.push('#secreto');
    if (index % 7 === 0) lines.push('aguja_perf');
    const body = lines.join('\n');
    const folderId = index % 20 === 0 ? diario.id : folders[index % FOLDERS]!;
    const created = await engine.noteCreate(folderId);
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
    if (index === 1_001) readId = created.id;
  }
  db.close();
  return { sqlitePath, dataDir, readId };
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

describe('latencia de la puerta final', () => {
  it('hebra_read_note y hebra_search, mediana y p95', { timeout: 600_000 }, async () => {
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
    try {
      const calls: Array<{ tool: string; args: Record<string, unknown> }> = [
        { tool: 'hebra_read_note', args: { id: built.readId } },
        { tool: 'hebra_search', args: { query: 'aguja_perf' } }
      ];
      for (const { tool, args } of calls) {
        const call = async (): Promise<CallToolResult> =>
          (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
        for (let round = 0; round < WARMUP; round += 1) expect((await call()).isError).not.toBe(true);
        const samples: number[] = [];
        let last: CallToolResult | undefined;
        for (let round = 0; round < ROUNDS; round += 1) {
          const started = performance.now();
          last = await call();
          samples.push(performance.now() - started);
        }
        // Que los dos árboles midan la misma respuesta: su tamaño y, en la búsqueda, cuántos.
        const text = last!.content[0]?.type === 'text' ? last!.content[0].text : '';
        const results = (JSON.parse(text) as { results?: unknown[] }).results?.length;
        process.stderr.write(
          `${JSON.stringify({
            event: 'gate.perf',
            tool,
            notes: NOTES,
            rounds: ROUNDS,
            responseChars: text.length,
            ...(results !== undefined ? { results } : {}),
            medianMs: Number(percentile(samples, 0.5).toFixed(2)),
            p95Ms: Number(percentile(samples, 0.95).toFixed(2))
          })}\n`
        );
      }
    } finally {
      await client.close();
      await server.close();
      port.close();
    }
  });
});
