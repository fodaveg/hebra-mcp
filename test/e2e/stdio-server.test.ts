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
      env: { ...process.env, HEBRA_MCP_DATA_DIR: dataDir } as Record<string, string>,
      stderr: 'ignore'
    });
    client = new Client({ name: 'hebra-mcp-e2e', version: '0.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        'hebra_append_to_note',
        'hebra_create_note',
        'hebra_links',
        'hebra_list_folders',
        'hebra_list_notes',
        'hebra_list_tags',
        'hebra_read_note',
        'hebra_search',
        'hebra_status'
      ].sort()
    );

    const result = await client.callTool({ name: 'hebra_status', arguments: {} });
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (block) => block.type === 'text'
    )?.text;
    expect(text && JSON.parse(text)).toMatchObject({ linked: false });
  }, 20_000);
});
