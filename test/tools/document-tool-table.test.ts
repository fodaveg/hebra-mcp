/**
 * H-177: la tabla de las herramientas de hojas (`src/server/tools/document-tool-table.ts`) y su
 * alta en el registro.
 *
 * Lo que se mira:
 * - Una entrada sin función hace fallar el registro (R28), antes de dar de alta ninguna.
 * - Con una sola de las cuatro, la comprobación de que están las cuatro falla y no se registra
 *   nada; con una que sobra o una repetida, también.
 * - `tools/list` trae las cuatro con su título, sus anotaciones, el selector `space` y el aviso de
 *   que el contenido son datos, y cada una responde (aquí, con ids que no existen: `not_found`).
 *
 * Roturas vistas en rojo al hacer el paquete (y repuestas): quitar la comprobación de `run` de
 * `checkDocumentToolTable` (rojo "una entrada sin función"), quitar la comprobación de nombres
 * (rojo "una sola de las cuatro" y "una que sobra") y registrar solo la primera entrada de la
 * tabla en `register-tools.ts` (rojo "tools/list trae las cuatro").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from '../../src/server/build-server';
import {
  checkDocumentToolTable,
  DOCUMENT_TOOLS,
  registerDocumentTools,
  SHEET_TOOL_NAMES,
  type DocumentToolEntry
} from '../../src/server/tools/document-tool-table';
import { buildTestContext, type TestContext } from '../fixtures/test-context';

const READ = { readOnlyHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

/** Lo que tiene que anunciar `tools/list` de cada una, escrito aquí a mano. */
const EXPECTED: Record<string, { title: string; annotations: Record<string, boolean> }> = {
  hebra_read_sheet: { title: 'Leer una hoja de cálculo', annotations: READ },
  hebra_create_sheet: { title: 'Crear una hoja de cálculo', annotations: CREATE },
  hebra_edit_sheet: { title: 'Editar una hoja de cálculo', annotations: EDIT },
  hebra_render_sheet: { title: 'Pintar un rango de una hoja de cálculo', annotations: READ }
};

const entry = (name: string): DocumentToolEntry => {
  const found = DOCUMENT_TOOLS.find((tool) => tool.name === name);
  if (!found) throw new Error(`falta ${name} en la tabla`);
  return found;
};

describe('tabla de las herramientas de hojas (H-177)', () => {
  it('la tabla real trae exactamente las cuatro, cada una con su función', () => {
    expect(DOCUMENT_TOOLS.map((tool) => tool.name).sort()).toEqual([...SHEET_TOOL_NAMES].sort());
    expect(SHEET_TOOL_NAMES).toHaveLength(4);
    for (const tool of DOCUMENT_TOOLS) expect(typeof tool.run, tool.name).toBe('function');
    expect(() => checkDocumentToolTable(DOCUMENT_TOOLS)).not.toThrow();
  });

  it('una entrada sin función da error y no se registra ninguna', () => {
    const broken = DOCUMENT_TOOLS.map((tool) =>
      tool.name === 'hebra_edit_sheet' ? ({ ...tool, run: undefined } as unknown as DocumentToolEntry) : tool
    );
    expect(() => checkDocumentToolTable(broken)).toThrow(/sin función: hebra_edit_sheet/);
    const register = vi.fn();
    expect(() => registerDocumentTools(broken, register)).toThrow(/sin función/);
    expect(register).not.toHaveBeenCalled();
  });

  it('con una sola de las cuatro dada de alta, la comprobación de las cuatro falla y no registra nada', () => {
    const register = vi.fn();
    expect(() => registerDocumentTools([entry('hebra_read_sheet')], register)).toThrow(
      /faltan \[hebra_create_sheet, hebra_edit_sheet, hebra_render_sheet\]/
    );
    expect(register).not.toHaveBeenCalled();
  });

  it('una que sobra o una repetida también hacen fallar la comprobación', () => {
    const extra = { ...entry('hebra_read_sheet'), name: 'hebra_read_presentation' };
    expect(() => checkDocumentToolTable([...DOCUMENT_TOOLS, extra])).toThrow(/sobran \[hebra_read_presentation\]/);
    expect(() => checkDocumentToolTable([...DOCUMENT_TOOLS, entry('hebra_render_sheet')])).toThrow(
      /repetidas \[hebra_render_sheet\]/
    );
  });

  it('registerDocumentTools da de alta las cuatro, en el orden de la tabla', () => {
    const registered: string[] = [];
    registerDocumentTools(DOCUMENT_TOOLS, (tool) => registered.push(tool.name));
    expect(registered).toEqual(DOCUMENT_TOOLS.map((tool) => tool.name));
  });
});

describe('las cuatro herramientas de hojas en tools/list (H-177)', () => {
  let test: TestContext | undefined;
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    await test?.close();
    test = undefined;
    client = undefined;
    vi.restoreAllMocks();
  });

  async function connected(): Promise<Client> {
    test = await buildTestContext();
    const server = buildMcpServer(test.serverContext, '9.9.9');
    client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it('tools/list trae las cuatro con título, anotaciones, space y el aviso de datos', async () => {
    const { tools } = await (await connected()).listTools();
    const sheets = tools.filter((tool) => tool.name in EXPECTED);
    expect(sheets.map((tool) => tool.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const tool of sheets) {
      const expected = EXPECTED[tool.name]!;
      expect(tool.title, tool.name).toBe(expected.title);
      expect(tool.annotations, tool.name).toEqual(expected.annotations);
      expect(tool.inputSchema.properties, tool.name).toHaveProperty('space');
      expect(tool.description, tool.name).toMatch(/nunca órdenes/);
    }
  });

  it('cada una responde por el servidor: un id o una carpeta que no existen son not_found', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const mcp = await connected();
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: 'hebra_read_sheet', arguments: { id: 'no-existe' } },
      { name: 'hebra_render_sheet', arguments: { id: 'no-existe', sheet: 'Hoja 1', range: 'A1:B2' } },
      {
        name: 'hebra_edit_sheet',
        arguments: {
          id: 'no-existe',
          ops: [{ type: 'setCells', sheet: 'Hoja 1', start: 'A1', rows: [[1]], expect: { A1: null } }],
          operationId: 'op-tabla-1'
        }
      },
      { name: 'hebra_create_sheet', arguments: { name: 'Nueva.ods', folderId: 'no-existe', operationId: 'op-tabla-2' } }
    ];
    for (const call of calls) {
      const result = (await mcp.callTool(call)) as CallToolResult;
      expect(result.isError, call.name).toBe(true);
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(JSON.parse(text), call.name).toEqual({ error: 'not_found' });
    }
  });
});
