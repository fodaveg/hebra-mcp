/**
 * Capacidades anunciadas (SPEC.md §5): `instructions` del `initialize` y `capabilities`
 * de `hebra_status`. Sin nombres privados ni contenido; la lista de herramientas no se
 * desvía de las registradas.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/server/build-server';
import { buildCapabilities, CAPABILITY_TOOLS, SERVER_INSTRUCTIONS } from '../src/server/capabilities';
import { runStatus } from '../src/server/tools/status';
import { buildTestContext, type TestContext } from './fixtures/test-context';
import { BAIT_FOLDER, BAIT_TAG } from './fixtures/test-library';
import { TOOL_NAMES } from './fixtures/tool-names';

describe('capacidades', () => {
  let test: TestContext | undefined;
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    await test?.close();
    test = undefined;
    client = undefined;
  });

  it('la lista de herramientas anunciada es la registrada', async () => {
    expect([...CAPABILITY_TOOLS].sort()).toEqual([...TOOL_NAMES]);
    test = await buildTestContext();
    const server = buildMcpServer(test.serverContext, '9.9.9');
    client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...CAPABILITY_TOOLS].sort());
    await server.close();
  });

  it('`initialize` lleva las `instructions`, sin datos de la biblioteca', async () => {
    test = await buildTestContext();
    const server = buildMcpServer(test.serverContext, '9.9.9');
    client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const instructions = client.getInstructions();
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
    expect(instructions).toContain('nextCursor');
    expect(instructions).toContain('fields');
    await server.close();
  });

  it('hebra_status trae `capabilities` con versión, límites y lo que no permite', async () => {
    test = await buildTestContext();
    const { capabilities } = await runStatus(test.ctx, '1.2.3');
    expect(capabilities.server).toEqual({ name: 'hebra-mcp', version: '1.2.3' });
    expect(capabilities.tools).toContain('hebra_search');
    expect(capabilities.limits.search).toEqual({ default: 20, max: 50 });
    expect(capabilities.limits.listNotes).toEqual({ default: 50, max: 100 });
    expect(capabilities.limits.createNoteBodyChars).toBe(100_000);
    expect(capabilities.limits.appendTextChars).toBe(20_000);
    // D9 (3 oct 2026): crear y renombrar carpetas y añadir adjuntos ya se permiten; mover
    // o borrar carpetas y cambiar o borrar adjuntos, no. D10 (9 oct 2026): listar los
    // ficheros sueltos y mandarlos a la papelera sí; purgarlos, crearlos, renombrarlos,
    // moverlos, reemplazarlos o leer su contenido, no.
    expect(capabilities.notAllowed).toEqual([
      'purge_notes_or_empty_trash_or_irreversible_delete',
      'folder_move_or_delete',
      'attachment_change_or_delete',
      'file_purge_create_rename_move_replace_or_read_content'
    ]);
    expect(capabilities.limits.listTrash).toEqual({ default: 50, max: 100 });
    expect(capabilities.limits.listFiles).toEqual({ default: 50, max: 100 });
    expect(capabilities.limits.attachmentBytes).toBe(5 * 1024 * 1024);
    expect(capabilities.limits.attachmentTextChars).toBe(100_000);
    expect(capabilities.limits.addAttachmentBytes).toBe(5 * 1024 * 1024);
    expect(capabilities.limits.attachmentNameChars).toBe(255);
    expect(capabilities.limits.folderNameChars).toBe(255);
    expect(capabilities.limits.listVersions).toEqual({ default: 50, max: 200 });
    expect(capabilities.limits.listAttachments).toEqual({ max: 200 });
    expect(capabilities.tools).toEqual(
      expect.arrayContaining([
        'hebra_list_attachments',
        'hebra_read_attachment',
        'hebra_add_attachment',
        'hebra_create_folder',
        'hebra_rename_folder',
        'hebra_list_files',
        'hebra_trash_file',
        'hebra_restore_file'
      ])
    );
  });

  it('las `instructions` nombran las tres de ficheros sueltos y lo que sigue fuera (D10)', () => {
    expect(SERVER_INSTRUCTIONS).toContain('hebra_list_files');
    expect(SERVER_INSTRUCTIONS).toContain('hebra_trash_file');
    expect(SERVER_INSTRUCTIONS).toContain('hebra_restore_file');
    expect(SERVER_INSTRUCTIONS).toContain('No se lee su contenido');
    expect(SERVER_INSTRUCTIONS).toContain(
      'ni purgar, crear, renombrar, mover o reemplazar ficheros sueltos'
    );
  });

  it('las `instructions` ya no dicen que no gestiona carpetas ni añade adjuntos (D9)', () => {
    expect(SERVER_INSTRUCTIONS).toContain('hebra_create_folder');
    expect(SERVER_INSTRUCTIONS).toContain('hebra_rename_folder');
    expect(SERVER_INSTRUCTIONS).toContain('hebra_add_attachment');
    expect(SERVER_INSTRUCTIONS).not.toContain('ni gestionar carpetas');
    expect(SERVER_INSTRUCTIONS).not.toContain('ni añadir, cambiar o borrar adjuntos');
    expect(SERVER_INSTRUCTIONS).toContain('ni mover o borrar carpetas');
    expect(SERVER_INSTRUCTIONS).toContain('ni cambiar o borrar adjuntos');
  });

  it('con privados configurados solo sale un booleano, nunca sus nombres', async () => {
    test = await buildTestContext();
    const { capabilities } = await runStatus(test.ctx, '1.2.3');
    expect(capabilities.privacyConfigured).toBe(true);
    const text = JSON.stringify(await runStatus(test.ctx, '1.2.3')).toLowerCase();
    expect(text).not.toContain('diario');
    expect(text).not.toContain('secreto');
    expect(text).not.toContain(BAIT_FOLDER.toLowerCase());
    expect(text).not.toContain(BAIT_TAG.toLowerCase());
  });

  it('sin configuración de privados, `privacyConfigured` es false', () => {
    expect(buildCapabilities('1.0.0', { privateFolders: [], privateTags: [] }).privacyConfigured).toBe(
      false
    );
  });
});
