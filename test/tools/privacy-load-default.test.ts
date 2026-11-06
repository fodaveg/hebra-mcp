/**
 * Ninguna herramienta carga la biblioteca entera en el filtro de privados (A9b del plan de
 * memoria, 6 nov 2026; las tres del JDex, desde A9a): todas las que anuncia el servidor se
 * registran con `privacyLoad: 'lazy'` y piden solo sus notas con `ensure(ids)` (SPEC.md §6.3).
 * Sin excepciones: desde M2 `'lazy'` es además el valor por defecto de `gated`
 * (`src/server/register-tools.ts`), que no admite declarar `'all'`, y este test hace fallar
 * cualquier herramienta anunciada que no esté en `'lazy'`.
 *
 * Se recorren las herramientas que ANUNCIA el servidor (`tools/list`), no solo las registradas
 * por `gated`: una registrada a pelo no tiene carga declarada y también cuenta como no perezosa.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resolveToolContext } from '../../src/server/context';
import { registerTools, toolPrivacyLoad } from '../../src/server/register-tools';
import { buildTestContext } from '../fixtures/test-context';
import { TOOL_NAMES } from '../fixtures/tool-names';

/** Las herramientas que anuncia `server` cuya carga declarada no es `'lazy'`, con la carga que
 *  declararon (`undefined`: registrada sin `gated`). Sin excepciones. */
async function toolsLoadingAll(server: McpServer): Promise<{ announced: string[]; offenders: string[] }> {
  const client = new Client({ name: 'privacy-load-default', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const announced = (await client.listTools()).tools.map((tool) => tool.name).sort();
    const offenders = announced
      .filter((name) => toolPrivacyLoad(server, name) !== 'lazy')
      .map((name) => `${name}: ${String(toolPrivacyLoad(server, name))}`);
    return { announced, offenders };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("privacyLoad: todas las herramientas en 'lazy'", () => {
  it("todas las herramientas anunciadas están en 'lazy', las del JDex también", async () => {
    const test = await buildTestContext();
    try {
      const server = new McpServer({ name: 'hebra-mcp-privacy-load-default', version: '0.0.0' });
      registerTools(server, test.serverContext);
      const { announced, offenders } = await toolsLoadingAll(server);
      // El recorrido cubre todas las herramientas del servidor, no un subconjunto.
      expect(announced).toEqual([...TOOL_NAMES].sort());
      for (const name of announced) expect(toolPrivacyLoad(server, name), name).toBe('lazy');
      expect(offenders, "herramientas que cargan la biblioteca entera ('all')").toEqual([]);
    } finally {
      await test.close();
    }
  });

  it('una herramienta registrada sin `gated` (sin carga declarada) se detecta', async () => {
    const test = await buildTestContext();
    try {
      const server = new McpServer({ name: 'hebra-mcp-privacy-load-default', version: '0.0.0' });
      registerTools(server, test.serverContext);
      server.registerTool(
        'hebra_sin_carga',
        { title: 'Sin carga declarada', inputSchema: { id: z.string() } },
        async () => ({ content: [{ type: 'text', text: '{}' }] })
      );
      const { offenders } = await toolsLoadingAll(server);
      expect(offenders).toEqual(['hebra_sin_carga: undefined']);
    } finally {
      await test.close();
    }
  });

  it("'all' solo si se pide: resolveToolContext sin opciones no carga ninguna nota (M2)", async () => {
    const test = await buildTestContext();
    try {
      expect((await resolveToolContext(test.serverContext)).privacy.retainedNotes).toBe(0);
      const all = (await resolveToolContext(test.serverContext, { loadAll: true })).privacy;
      expect(all.retainedNotes).toBeGreaterThan(0);
    } finally {
      await test.close();
    }
  });
});
