/**
 * Equivalencia de una herramienta perezosa (`privacyLoad: 'lazy'`, A4.0 del plan de memoria,
 * 6 nov 2026) con la misma herramienta cargando la biblioteca entera (`'all'`).
 *
 * Una herramienta pasa a `'lazy'` marcando SU llamada a `gated` en
 * `src/server/register-tools.ts` (`gated(nombre, run, { privacyLoad: 'lazy' })`) y pidiendo
 * sus notas con `await ctx.privacy.ensure(ids)` antes de preguntar por ellas. Si se olvida de
 * alguna, el filtro la trata como oculta (falla cerrando) y su respuesta cambia en silencio:
 * eso es lo que caza `expectLazyEquivalent`, por el mismo camino que producción (un cliente MCP
 * en memoria contra `registerTools`, con la puerta final):
 * 1. la herramienta está registrada como `'lazy'` (si no, la comparación no prueba nada);
 * 2. la llamada perezosa no sube `unloadedLookupsTotal()` (ninguna pregunta por una nota que no
 *    pidió);
 * 3. su resultado es IDÉNTICO al de la misma llamada con `forcePrivacyLoad: 'all'`.
 *
 * Corre la herramienta dos veces sobre el mismo almacén (primero con `'all'`): sirve para
 * lecturas y para lo que responda igual la segunda vez. Devuelve la respuesta perezosa, para
 * que el test compruebe además QUÉ responde (las dos podrían estar mal a la vez).
 */
import { expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { unloadedLookupsTotal } from '../../src/privacy/library-index';
import type { ServerContext, ToolPrivacyLoad } from '../../src/server/context';
import { registerTools, toolPrivacyLoad } from '../../src/server/register-tools';

/** Una llamada de herramienta, como la ve el cliente. */
export interface LoadedToolCall {
  /** La respuesta MCP tal cual (lo que se compara). */
  result: CallToolResult;
  isError: boolean;
  /** El primer bloque de texto como JSON (`null` si no lo es). */
  json: any;
  /** La `privacyLoad` con la que se REGISTRÓ la herramienta (la declarada). */
  declared: ToolPrivacyLoad | undefined;
  /** Cuánto subió `unloadedLookupsTotal()` durante la llamada. */
  unloadedLookups: number;
}

/**
 * Llama a `name` con `args` por un servidor nuevo (`registerTools` sobre `serverContext`) y un
 * cliente MCP en memoria. Con `load` `'declared'` (por defecto), con la carga que declaró la
 * herramienta; con `'all'`, forzando la biblioteca entera (`forcePrivacyLoad`).
 */
export async function callToolWithLoad(
  serverContext: ServerContext,
  name: string,
  args: Record<string, unknown>,
  load: 'declared' | 'all' = 'declared'
): Promise<LoadedToolCall> {
  const server = new McpServer({ name: 'hebra-mcp-privacy-load', version: '0.0.0' });
  registerTools(server, serverContext, '0.0.0', load === 'all' ? { forcePrivacyLoad: 'all' } : {});
  const client = new Client({ name: 'hebra-mcp-privacy-load-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const before = unloadedLookupsTotal();
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const unloadedLookups = unloadedLookupsTotal() - before;
    const first = result.content.find((block) => block.type === 'text');
    let json: any = null;
    try {
      json = first?.type === 'text' ? JSON.parse(first.text) : null;
    } catch {
      json = null;
    }
    return {
      result,
      isError: result.isError === true,
      json,
      declared: toolPrivacyLoad(server, name),
      unloadedLookups
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * Comprueba que `name`, registrada como `'lazy'`, responde a `args` exactamente lo mismo que
 * con `'all'` y sin preguntar por notas que no cargó (cabecera). Devuelve la llamada perezosa.
 */
export async function expectLazyEquivalent(
  serverContext: ServerContext,
  name: string,
  args: Record<string, unknown>
): Promise<LoadedToolCall> {
  const all = await callToolWithLoad(serverContext, name, args, 'all');
  const lazy = await callToolWithLoad(serverContext, name, args);
  expect(lazy.declared, `${name} no está registrada con privacyLoad: 'lazy'`).toBe('lazy');
  expect(lazy.unloadedLookups, `${name} preguntó por notas que no cargó con ensure`).toBe(0);
  expect(lazy.result, `${name} responde distinto con 'lazy' que con 'all'`).toEqual(all.result);
  return lazy;
}
