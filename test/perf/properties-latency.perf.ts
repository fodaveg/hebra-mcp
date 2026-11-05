/**
 * Latencia de `hebra_list_properties` y `hebra_query_properties` por el camino entero del MCP
 * (D23, SPEC.md §6.3): las dos leen todas las filas que hacen falta y filtran aquí, porque el
 * motor no calcula sus recuentos ni su orden solo sobre lo visible. Fuera de la suite normal:
 * `npx vitest run --config vitest.perf.config.ts test/perf/properties-latency.perf.ts --maxWorkers=1`.
 *
 * Biblioteca sintética en un directorio temporal, que se borra al terminar: 3 000 notas con 6
 * propiedades, una de cada veinte en la carpeta privada y una de cada cincuenta con la etiqueta
 * privada. Imprime en stderr una línea JSON por llamada (`props.perf`) con la mediana y el p95 en
 * ms de `ROUNDS` llamadas, tras `WARMUP` en caliente.
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
import { openNodeLibraryPort } from '../../src/store';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';

const NOTES = 3_000;
const WARMUP = 10;
const ROUNDS = 50;

function bodyOf(index: number): string {
  const tag = index % 50 === 0 ? '#secreto\n' : '';
  return [
    '---',
    `estado: ${['activo', 'pausado', 'hecho'][index % 3]}`,
    `prioridad: ${index % 100}`,
    `grupo: g${index % 40}`,
    `fecha: 2026-${String((index % 12) + 1).padStart(2, '0')}-01`,
    `autor: a${index % 7}`,
    `unico: u${index}`,
    '---',
    `# Nota ${index}`,
    `${tag}Cuerpo de la nota ${index}.`,
    ''
  ].join('\n');
}

describe('latencia de las propiedades', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-props-perf-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('3 000 notas, por el camino entero', { timeout: 300_000 }, async () => {
    const sqlitePath = join(dir, 'library.sqlite');
    const { db, conn } = openNodeSqliteConn(sqlitePath);
    const engine = await SqliteLibraryEngine.open(conn, 'props-perf');
    const diario = await engine.folderCreate(null, 'Diario');
    for (let index = 0; index < NOTES; index += 1) {
      const created = await engine.noteCreate(index % 20 === 0 ? diario.id : null);
      const body = bodyOf(index);
      await engine.noteSave({
        ...deriveNote(body),
        id: created.id,
        body,
        expectedLocalSeq: created.localSeq,
        baseBodySha256: created.bodySha256
      });
    }
    db.close();

    const port = await openNodeLibraryPort({ sqlitePath, dataDir: dir });
    const server = new McpServer({ name: 'props-perf', version: '0.0.0' });
    registerTools(server, {
      port,
      privacyConfig: { privateFolders: [['diario']], privateTags: ['secreto'] },
      status: new UnlinkedStatusSource()
    });
    const client = new Client({ name: 'props-perf-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['claves', 'hebra_list_properties', {}],
      ['valores', 'hebra_list_properties', { key: 'grupo' }],
      ['consulta sin orden', 'hebra_query_properties', { limit: 50 }],
      ['consulta filtrada', 'hebra_query_properties', { filters: [{ key: 'estado', op: 'equals', value: 'activo' }] }],
      ['consulta por número', 'hebra_query_properties', { sort: { key: 'prioridad', direction: 'descending' } }]
    ];
    try {
      for (const [label, name, args] of cases) {
        const times: number[] = [];
        for (let round = 0; round < WARMUP + ROUNDS; round += 1) {
          const start = performance.now();
          const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
          const elapsed = performance.now() - start;
          expect(result.isError).not.toBe(true);
          if (round >= WARMUP) times.push(elapsed);
        }
        times.sort((left, right) => left - right);
        process.stderr.write(`${JSON.stringify({
          event: 'props.perf',
          label,
          medianMs: Number(times[Math.floor(times.length / 2)]!.toFixed(1)),
          p95Ms: Number(times[Math.floor(times.length * 0.95)]!.toFixed(1))
        })}\n`);
      }
    } finally {
      await client.close();
      port.close();
    }
  });
});
