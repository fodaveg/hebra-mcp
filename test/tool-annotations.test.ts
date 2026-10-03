/**
 * `annotations` MCP de las 24 herramientas (C3 del audit; D9 del 3 oct 2026): cada una
 * contra una tabla escrita aquí, para que un cambio de contrato sea una decisión y no un
 * descuido.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/server/build-server';
import { buildTestContext, type TestContext } from './fixtures/test-context';

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};
const WRITE_NEW = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};

const EXPECTED: Record<string, Record<string, boolean>> = {
  hebra_search: READ,
  hebra_list_notes: READ,
  hebra_read_note: READ,
  hebra_list_tags: READ,
  hebra_list_folders: READ,
  hebra_links: READ,
  hebra_status: READ,
  hebra_list_trash: READ,
  hebra_list_versions: READ,
  hebra_read_version: READ,
  hebra_list_attachments: READ,
  hebra_read_attachment: READ,
  hebra_move_note: WRITE_IDEMPOTENT,
  hebra_set_favorite: WRITE_IDEMPOTENT,
  hebra_set_archived: WRITE_IDEMPOTENT,
  hebra_trash_note: WRITE_IDEMPOTENT,
  hebra_restore_note: WRITE_IDEMPOTENT,
  hebra_edit_note: WRITE_IDEMPOTENT,
  hebra_restore_version: WRITE_IDEMPOTENT,
  // D9: crear devuelve la que ya hay, renombrar al mismo nombre no escribe, y añadir un
  // adjunto se reintenta con su `operationId` sin duplicarlo.
  hebra_create_folder: WRITE_IDEMPOTENT,
  hebra_rename_folder: WRITE_IDEMPOTENT,
  hebra_add_attachment: WRITE_IDEMPOTENT,
  hebra_create_note: WRITE_NEW,
  hebra_append_to_note: WRITE_NEW
};

describe('annotations de las herramientas', () => {
  let test: TestContext | undefined;
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    await test?.close();
    test = undefined;
    client = undefined;
  });

  it('cada herramienta lleva la anotación de la tabla, y la tabla las cubre todas', async () => {
    test = await buildTestContext();
    const server = buildMcpServer(test.serverContext, '9.9.9');
    client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toEqual(EXPECTED[tool.name]);
    }
    await server.close();
  });
});
