/**
 * Filtro de privados y logs, de punta a punta por el protocolo MCP (`InMemoryTransport`
 * del SDK, sin spawnear un proceso: eso lo cubre `test/e2e/stdio-server.test.ts`).
 * Recorre todas las herramientas (`test/fixtures/bait-calls.ts`, también las de papelera
 * y versiones del 30 sep 2026) con argumentos que casarían el cebo (SPEC.md §10 L1,
 * §6.3, §6.4): ni el resultado ni stderr pueden traerlo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/server/register-tools';
import type { ServerContext } from '../src/server/context';
import { buildTestContext, UNRESOLVED_PRIVACY_CONFIG, type TestContext } from './fixtures/test-context';
import { BAIT_ATTACHMENT, BAIT_FOLDER, BAIT_TAG, FILE_NAMES } from './fixtures/test-library';
import { BAIT_APPEND_TEXT, baitCalls } from './fixtures/bait-calls';

const TOOL_NAMES = [
  'hebra_search',
  'hebra_list_notes',
  'hebra_read_note',
  'hebra_list_tags',
  'hebra_list_folders',
  'hebra_links',
  'hebra_status',
  'hebra_create_note',
  'hebra_append_to_note',
  'hebra_list_trash',
  'hebra_trash_note',
  'hebra_restore_note',
  'hebra_list_versions',
  'hebra_read_version',
  'hebra_restore_version',
  'hebra_list_attachments',
  'hebra_read_attachment',
  'hebra_create_folder',
  'hebra_rename_folder',
  'hebra_add_attachment',
  'hebra_list_files',
  'hebra_trash_file',
  'hebra_restore_file',
  'hebra_note_outline'
] as const;

/** Argumentos válidos de las herramientas de papelera y versiones (30 sep 2026). */
const TRASH_AND_VERSION_ARGS: Partial<Record<(typeof TOOL_NAMES)[number], Record<string, unknown>>> = {
  hebra_trash_note: { id: 'lo-que-sea' },
  hebra_restore_note: { id: 'lo-que-sea' },
  hebra_list_versions: { id: 'lo-que-sea' },
  hebra_read_version: { id: 'lo-que-sea', versionId: 1 },
  hebra_restore_version: {
    id: 'lo-que-sea',
    versionId: 1,
    expectedRevision: 'r1.x',
    operationId: 'op'
  },
  hebra_list_attachments: { id: 'lo-que-sea' },
  hebra_read_attachment: { id: 'lo-que-sea', attachmentId: 'a'.repeat(64) },
  hebra_create_folder: { name: 'lo que sea' },
  hebra_rename_folder: { folderId: 'lo-que-sea', name: 'lo que sea' },
  hebra_add_attachment: {
    id: 'lo-que-sea',
    name: 'a.txt',
    dataBase64: 'YQ==',
    mimeType: 'text/plain',
    operationId: 'op'
  },
  // Ficheros sueltos (D10, 9 oct 2026); `hebra_list_files` no necesita argumentos.
  hebra_trash_file: { id: 'lo-que-sea' },
  hebra_restore_file: { id: 'lo-que-sea' },
  // Apartados (D11).
  hebra_note_outline: { id: 'lo-que-sea' }
};

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

describe('filtro de privados y logs, por todas las herramientas', () => {
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
    // D11: la prueba de lo guardado devuelve el final del texto añadido (del propio
    // cliente), pero ni eso ni el título de un apartado llegan al log.
    expect(allOutput).toContain(BAIT_APPEND_TEXT);

    const loggedLines = (stderrSpy!.mock.calls as unknown as [string][]).map(([line]) => line).join('\n');
    expect(loggedLines).not.toContain(BAIT_FOLDER);
    expect(loggedLines).not.toContain(BAIT_TAG);
    expect(loggedLines).not.toContain(BAIT_APPEND_TEXT);
    // Nunca un título, ni siquiera el de una nota PÚBLICA: los logs no llevan contenido.
    expect(loggedLines).not.toContain(test.library.publicNoteTitle);
    // Ni el argumento de una llamada (SPEC.md §6.4: «ni argumentos de herramientas»).
    expect(loggedLines).not.toContain(test.library.privateFolderNoteId);
    // Ni el nombre ni el contenido de un adjunto, aunque la nota sea visible y se haya
    // leído (adjuntos en solo lectura, 30 sep 2026), ni su hash.
    expect(allOutput).toContain(BAIT_ATTACHMENT);
    expect(loggedLines).not.toContain(BAIT_ATTACHMENT);
    expect(loggedLines).not.toContain(test.library.attachments.text);
    // Ficheros sueltos (D10): los visibles salen en la salida, y de ninguno, visible u
    // oculto, sale el nombre ni el id pedido en los logs.
    expect(allOutput).toContain(FILE_NAMES.inventario);
    for (const name of Object.values(FILE_NAMES)) expect(loggedLines).not.toContain(name);
    for (const id of Object.values(test.library.files)) {
      expect(loggedLines).not.toContain(id);
    }
    for (const id of [
      test.library.files.privateFolder,
      test.library.files.referencedByHash,
      test.library.files.referencedByName,
      test.library.files.referencedByLockedNote,
      test.library.files.trashedPrivateFolder,
      test.library.files.trashedDeletedPrivateFolder
    ]) {
      expect(allOutput).not.toContain(id);
    }
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
                  : (TRASH_AND_VERSION_ARGS[name] ?? {});
      const result = (await client.callTool({ name, arguments: arguments_ })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(JSON.parse(textOf(result))).toEqual({ error: 'privacy_config_unresolved' });
    }
  });
});
