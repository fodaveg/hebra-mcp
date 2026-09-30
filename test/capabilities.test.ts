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
    expect(capabilities.notAllowed).toEqual(
      expect.arrayContaining(['delete_or_purge_notes', 'folder_management', 'attachments'])
    );
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
