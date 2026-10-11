/**
 * La puerta final de privacidad (`src/server/privacy-gate.ts`, tarea d64e187e): toda
 * herramienta que anuncia el servidor tiene que estar registrada por ella (`gated` de
 * `src/server/register-tools.ts`). Una que se registre con `server.registerTool` a pelo, sin
 * pasar por la puerta, hace fallar este test.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { gatedTools, registerTools } from '../../src/server/register-tools';
import { buildTestContext, type TestContext } from '../fixtures/test-context';

/** Las herramientas que anuncia `server` y que no pasan por la puerta final. */
async function ungatedTools(server: McpServer): Promise<string[]> {
  const client = new Client({ name: 'gate-registration', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    const gated = gatedTools(server);
    return tools.map((tool) => tool.name).filter((name) => !gated.has(name));
  } finally {
    await client.close();
    await server.close();
  }
}

describe('puerta final: registro', () => {
  let test: TestContext | undefined;

  it('todas las herramientas del servidor pasan por la puerta final', async () => {
    test = await buildTestContext();
    try {
      const server = new McpServer({ name: 'hebra-mcp-gate', version: '0.0.0' });
      registerTools(server, test.serverContext);
      expect(gatedTools(server).size).toBeGreaterThanOrEqual(32);
      expect(await ungatedTools(server), 'herramientas registradas sin la puerta final').toEqual([]);
    } finally {
      await test.close();
    }
  });

  it('una herramienta registrada a pelo, sin la puerta, se detecta', async () => {
    test = await buildTestContext();
    try {
      const server = new McpServer({ name: 'hebra-mcp-gate', version: '0.0.0' });
      registerTools(server, test.serverContext);
      server.registerTool(
        'hebra_sin_puerta',
        { title: 'Sin puerta', inputSchema: { id: z.string() } },
        async () => ({ content: [{ type: 'text', text: '{}' }] })
      );
      expect(await ungatedTools(server)).toEqual(['hebra_sin_puerta']);
    } finally {
      await test.close();
    }
  });
});
