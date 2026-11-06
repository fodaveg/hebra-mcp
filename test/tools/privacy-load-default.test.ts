/**
 * Ninguna herramienta carga la biblioteca entera en el filtro de privados (A9b del plan de
 * memoria, 6 nov 2026): todas las que anuncia el servidor se registran con
 * `privacyLoad: 'lazy'` y piden solo sus notas con `ensure(ids)` (SPEC.md §6.3). Es el paso
 * previo a cambiar el valor por defecto de `gated` (hoy `'all'`, `src/server/register-tools.ts`):
 * mientras tanto, este test hace fallar cualquier herramienta nueva, o vieja, que se quede en
 * `'all'` por omisión.
 *
 * Se recorren las herramientas que ANUNCIA el servidor (`tools/list`), no solo las registradas
 * por `gated`: una registrada a pelo no tiene carga declarada y también cuenta como no perezosa.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools, toolPrivacyLoad } from '../../src/server/register-tools';
import { buildTestContext } from '../fixtures/test-context';
import { TOOL_NAMES } from '../fixtures/tool-names';

/**
 * Las que aún pueden quedarse en `'all'`. Vacía salvo las tres del JDex: otra pieza del plan de
 * memoria las pasa a `'lazy'` en paralelo y, cuando entre, las quitará de aquí. No se exige que
 * sigan en `'all'`, para que esa pieza no rompa este test al integrarse.
 */
const STILL_ALL: ReadonlySet<string> = new Set([
  // Quitar cuando la pieza del JDex las pase a 'lazy' (src/server/tools/jd*.ts).
  'hebra_jd_new_id',
  'hebra_jd_audit',
  'hebra_jd_move'
]);

/** Las herramientas que anuncia `server` cuya carga declarada no es `'lazy'` y no están en
 *  `STILL_ALL`, con la carga que declararon (`undefined`: registrada sin `gated`). */
async function toolsLoadingAll(server: McpServer): Promise<{ announced: string[]; offenders: string[] }> {
  const client = new Client({ name: 'privacy-load-default', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const announced = (await client.listTools()).tools.map((tool) => tool.name).sort();
    const offenders = announced
      .filter((name) => !STILL_ALL.has(name))
      .filter((name) => toolPrivacyLoad(server, name) !== 'lazy')
      .map((name) => `${name}: ${String(toolPrivacyLoad(server, name))}`);
    return { announced, offenders };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("privacyLoad: todas las herramientas en 'lazy'", () => {
  it("ninguna herramienta anunciada se queda en 'all', salvo las del JDex mientras no estén hechas", async () => {
    const test = await buildTestContext();
    try {
      const server = new McpServer({ name: 'hebra-mcp-privacy-load-default', version: '0.0.0' });
      registerTools(server, test.serverContext);
      const { announced, offenders } = await toolsLoadingAll(server);
      // El recorrido cubre todas las herramientas del servidor, no un subconjunto.
      expect(announced).toEqual([...TOOL_NAMES].sort());
      for (const name of STILL_ALL) expect(announced, `${name} ya no existe: quitarla de STILL_ALL`).toContain(name);
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
});
