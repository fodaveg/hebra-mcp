/**
 * Filtro de privados y logs, de punta a punta por el protocolo MCP (`InMemoryTransport`
 * del SDK, sin spawnear un proceso: eso lo cubre `test/e2e/stdio-server.test.ts`).
 * Recorre las NUEVE herramientas (las 7 de lectura de L1 y las 2 de escritura de L3b)
 * con argumentos que casarían el cebo (SPEC.md §10 L1, §6.3, §6.4): ni el resultado ni
 * stderr pueden traerlo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/server/register-tools';
import type { ServerContext } from '../src/server/context';
import { buildTestContext, UNRESOLVED_PRIVACY_CONFIG, type TestContext } from './fixtures/test-context';
import { BAIT_FOLDER, BAIT_TAG } from './fixtures/test-library';
import { baitCalls } from './fixtures/bait-calls';

const TOOL_NAMES = [
  'hebra_search',
  'hebra_list_notes',
  'hebra_read_note',
  'hebra_list_tags',
  'hebra_list_folders',
  'hebra_links',
  'hebra_status',
  'hebra_create_note',
  'hebra_append_to_note'
] as const;

async function connectedClient(ctx: ServerContext): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer({ name: 'hebra-mcp-test', version: '0.0.0' });
  registerTools(server, ctx);
  const client = new Client({ name: 'hebra-mcp-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

describe('filtro de privados y logs, por las 9 herramientas', () => {
  let test: TestContext | undefined;
  let client: Client | undefined;
  let server: McpServer | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    stderrSpy?.mockRestore();
    await client?.close();
    await server?.close();
    await test?.close();
    test = undefined;
    client = undefined;
    server = undefined;
  });

  it('ninguna herramienta, con argumentos que casarían el cebo, lo devuelve ni lo loguea', async () => {
    test = await buildTestContext();
    ({ client, server } = await connectedClient(test.serverContext));

    // Las mismas llamadas que el test por Streamable HTTP (`test/http/serve-http.test.ts`).
    const calls = baitCalls(test.library);

    const texts: string[] = [];
    for (const call of calls) {
      const result = await client.callTool({ name: call.name, arguments: call.arguments });
      texts.push(textOf(result as CallToolResult));
    }
    const allOutput = texts.join('\n');
    expect(allOutput).not.toContain(BAIT_FOLDER);
    expect(allOutput).not.toContain(BAIT_TAG);

    const loggedLines = (stderrSpy!.mock.calls as unknown as [string][]).map(([line]) => line).join('\n');
    expect(loggedLines).not.toContain(BAIT_FOLDER);
    expect(loggedLines).not.toContain(BAIT_TAG);
    // Nunca un título, ni siquiera el de una nota PÚBLICA: los logs no llevan contenido.
    expect(loggedLines).not.toContain(test.library.publicNoteTitle);
    // Ni el argumento de una llamada (SPEC.md §6.4: «ni argumentos de herramientas»).
    expect(loggedLines).not.toContain(test.library.privateFolderNoteId);
  });

  it('un log de cada llamada es un JSON con tool/ok, sin más campos de contenido', async () => {
    test = await buildTestContext();
    ({ client, server } = await connectedClient(test.serverContext));
    await client.callTool({ name: 'hebra_list_tags', arguments: {} });
    const lines = (stderrSpy!.mock.calls as unknown as [string][])
      .map(([line]) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.event).toBe('tool.call');
      expect(typeof parsed.tool).toBe('string');
    }
  });
});

describe('privacy_config_unresolved (carpeta configurada que no existe)', () => {
  let test: TestContext | undefined;
  let client: Client | undefined;
  let server: McpServer | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    stderrSpy?.mockRestore();
    await client?.close();
    await server?.close();
    await test?.close();
    test = undefined;
    client = undefined;
    server = undefined;
  });

  it('toda herramienta responde el mismo código cerrado', async () => {
    test = await buildTestContext(UNRESOLVED_PRIVACY_CONFIG);
    expect(test.ctx.privacy.unresolved).toBe(true);
    ({ client, server } = await connectedClient(test.serverContext));

    for (const name of TOOL_NAMES) {
      const arguments_ =
        name === 'hebra_search'
          ? { query: 'lo que sea' }
          : name === 'hebra_read_note'
            ? { id: 'lo-que-sea' }
            : name === 'hebra_links'
              ? { id: 'lo-que-sea' }
              : name === 'hebra_create_note'
                ? { body: '# lo que sea' }
                : name === 'hebra_append_to_note'
                  ? { id: 'lo-que-sea', text: 'lo que sea' }
                  : {};
      const result = (await client.callTool({ name, arguments: arguments_ })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(JSON.parse(textOf(result))).toEqual({ error: 'privacy_config_unresolved' });
    }
  });
});
