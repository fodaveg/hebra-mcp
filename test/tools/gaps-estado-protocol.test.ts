import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../../src/server/register-tools';
import { buildTestContext, type TestContext } from '../fixtures/test-context';

/**
 * Las lecturas de D23 (5 nov 2026) por el protocolo MCP y la puerta final: la forma de la
 * respuesta y los errores, sobre la biblioteca de prueba compartida (`Diario` privada,
 * `#secreto` privada).
 */
describe('lecturas de estado por el protocolo (D23)', () => {
  let test: TestContext | undefined;
  let client: Client | undefined;
  let server: McpServer | undefined;
  afterEach(async () => {
    await client?.close();
    await server?.close();
    await test?.close();
    test = client = server = undefined;
  });

  async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!test) {
      test = await buildTestContext();
      server = new McpServer({ name: 'hebra-mcp-test', version: '0.0.0' });
      registerTools(server, test.serverContext);
      client = new Client({ name: 'hebra-mcp-test-client', version: '0.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    }
    return (await client!.callTool({ name, arguments: args })) as CallToolResult;
  }

  const textOf = (result: CallToolResult): string =>
    result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

  it('hebra_list_trash con kind folders responde carpetas; sin kind, notas', async () => {
    const folders = await call('hebra_list_trash', { kind: 'folders' });
    expect(folders.isError).toBeFalsy();
    expect(JSON.parse(textOf(folders))).toEqual({ folders: [], nextCursor: null });
    const notes = await call('hebra_list_trash', {});
    expect(Object.keys(JSON.parse(textOf(notes))).sort()).toEqual(['nextCursor', 'notes']);
    const bad = await call('hebra_list_trash', { kind: 'otra' });
    expect(bad.isError).toBe(true);
  });

  it('hebra_note_authors: visible sin autores, y oculta o inexistente igual: not_found', async () => {
    const library = test?.library ?? (await call('hebra_status', {}), test!.library);
    const visible = await call('hebra_note_authors', { id: library.publicNoteId });
    expect(visible.isError).toBeFalsy();
    expect(JSON.parse(textOf(visible))).toEqual({
      id: library.publicNoteId,
      lastEditor: null,
      declaredAuthorId: null,
      mismatch: false,
      namesResolved: false
    });
    const texts = new Set<string>();
    for (const id of [library.privateFolderNoteId, library.privateTagNoteId, library.trashedNoteId, 'no-existe']) {
      const result = await call('hebra_note_authors', { id });
      expect(result.isError).toBe(true);
      texts.add(textOf(result));
    }
    expect([...texts]).toEqual([JSON.stringify({ error: 'not_found' })]);
  });

  it('hebra_list_notes: archived con folder o tag es invalid_input; los campos de estado salen', async () => {
    const bad = await call('hebra_list_notes', { archived: true, folder: 'proyectos' });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(textOf(bad))).toEqual({ error: 'invalid_input' });
    const listed = JSON.parse(textOf(await call('hebra_list_notes', { fields: ['favorite', 'archivedAt', 'generalHidden'], limit: 5 })));
    expect(listed.notes.length).toBeGreaterThan(0);
    for (const note of listed.notes) {
      expect(Object.keys(note).sort()).toEqual(['archivedAt', 'favorite', 'generalHidden', 'id']);
    }
    const read = JSON.parse(textOf(await call('hebra_read_note', { id: test!.library.publicNoteId })));
    expect(read).toMatchObject({ favorite: false, archivedAt: null, generalHidden: false });
  });
});
