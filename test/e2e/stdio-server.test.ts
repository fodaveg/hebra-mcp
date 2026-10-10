/**
 * Extremo a extremo real: arranca `dist/cli.mjs serve` como proceso hijo y habla MCP por
 * stdio con el CLIENTE del SDK (SPEC.md §10 L1: «inspección con
 * `npx @modelcontextprotocol/inspector`» — aquí, automatizado con el mismo protocolo).
 * `beforeAll` construye el bundle con `scripts/build.mjs`: así `npm test` solo (sin
 * `npm run build` antes) sigue siendo autosuficiente.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_NAMES } from '../fixtures/tool-names';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = join(root, 'dist', 'cli.mjs');

describe('hebra-mcp serve (proceso real, protocolo MCP por stdio)', () => {
  let dataDir: string;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  beforeAll(() => {
    execFileSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' });
  }, 30_000);

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-e2e-'));
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    transport = undefined;
    await rm(dataDir, { recursive: true, force: true });
  });

  afterAll(() => {
    // Nada que limpiar aquí: cada `afterEach` ya cerró su cliente (y, con él, el
    // proceso hijo que lanzó `StdioClientTransport`).
  });

  it('initialize, tools/list y una llamada (hebra_status)', async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: [cliPath, 'serve'],
      // Servicio del llavero propio y vacío: `serve` lee el llavero al arrancar (L2), y
      // este test no puede leer nunca los secretos reales de David.
      env: {
        ...process.env,
        HEBRA_MCP_DATA_DIR: dataDir,
        HEBRA_MCP_KEYRING_SERVICE: `hebra-mcp-e2e-${process.pid}-${Date.now()}`
      } as Record<string, string>,
      stderr: 'ignore'
    });
    client = new Client({ name: 'hebra-mcp-e2e', version: '0.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(TOOL_NAMES);

    const result = await client.callTool({ name: 'hebra_status', arguments: {} });
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (block) => block.type === 'text'
    )?.text;
    expect(text && JSON.parse(text)).toMatchObject({ linked: false });

    // D13: `hebra_grep` desde el bundle, también con expresión regular (el hilo recibe el
    // código de `scanBody` ya empaquetado) y la lectura por líneas de lo que encuentra.
    const textOf = (output: unknown): unknown =>
      JSON.parse(
        ((output as { content: Array<{ type: string; text?: string }> }).content.find(
          (block) => block.type === 'text'
        )?.text) ?? 'null'
      );
    const created = textOf(
      await client.callTool({
        name: 'hebra_create_note',
        arguments: { body: '# Prueba\n\n## Despensa\nlínea con garbanzos\n' }
      })
    ) as { id: string };
    for (const args of [{ pattern: 'GARBANZOS' }, { pattern: 'garban\\w+$', regex: true }]) {
      const found = textOf(await client.callTool({ name: 'hebra_grep', arguments: args })) as {
        matches: Array<{ id: string; line: number; heading: string }>;
      };
      expect(found.matches.map((match) => [match.id, match.line, match.heading])).toEqual([
        [created.id, 4, 'Despensa']
      ]);
    }
    const lines = textOf(
      await client.callTool({
        name: 'hebra_read_note',
        arguments: { id: created.id, lines: { from: 4, to: 4 } }
      })
    ) as { body: string; totalLines: number };
    expect(lines).toMatchObject({ body: 'línea con garbanzos\n', totalLines: 4 });
  }, 20_000);
});
