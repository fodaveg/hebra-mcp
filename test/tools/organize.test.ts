import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { REMOVED_FOLDER_TOOLS, TOOL_NAMES } from '../fixtures/tool-names';
import { resolveToolContext, type ToolContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import { registerTools } from '../../src/server/register-tools';
import { runMoveNote, runSetArchived, runSetFavorite } from '../../src/server/tools/organize';
import { runReadNote } from '../../src/server/tools/read-note';
import { runListFolders } from '../../src/server/tools/list-folders';
import { NoteWriter } from '../../src/store/writes';
import type { NodeLibraryPort } from '../../src/store/node-port';

/**
 * Organización de notas por id (D2 ampliada, 28 sep 2026) sobre la biblioteca de prueba
 * (`Proyectos/Lumbre` visible; `Diario` y `Diario/2026` privadas; `secreto` etiqueta
 * privada). Sin sync: `sync: "not_linked"`. Sin herramientas de carpetas (opción A de
 * David, 28 sep 2026).
 */

describe('organización', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  /** Contexto con el filtro recalculado AHORA (el de `test.ctx` es del arranque). */
  function fresh(): Promise<ToolContext> {
    return resolveToolContext(test!.serverContext);
  }

  function folderId(ctx: ToolContext, path: string): string {
    const id = ctx.privacy.folderIdForPath(path);
    if (!id) throw new Error(`sin carpeta ${path}`);
    return id;
  }

  async function expectNotFound(promise: Promise<unknown>): Promise<void> {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe('not_found');
    expect((error as ToolError).extra).toBeUndefined();
  }

  it('mover una nota a una carpeta visible, y a la raíz', async () => {
    test = await buildTestContext();
    const ctx = await fresh();
    const id = test.library.publicNote2Id;
    const moved = await runMoveNote(ctx, { id, folderId: folderId(ctx, 'proyectos') });
    expect(moved).toEqual({
      id,
      folderPath: 'proyectos',
      favorite: false,
      archived: false,
      sync: 'not_linked'
    });
    expect((await runReadNote(await fresh(), { id })).folderPath).toBe('proyectos');
    expect(await runMoveNote(await fresh(), { id, folderId: 'root' })).toMatchObject({ folderPath: '' });
  });

  it('mover una nota a una carpeta privada responde igual que a una inexistente, sin mover nada', async () => {
    test = await buildTestContext();
    const ctx = await fresh();
    const id = test.library.publicNote2Id;
    for (const target of [folderId(ctx, 'diario'), folderId(ctx, 'diario/2026'), 'no-existe']) {
      await expectNotFound(runMoveNote(ctx, { id, folderId: target }));
    }
    expect((await runReadNote(await fresh(), { id })).folderPath).toBe('proyectos/lumbre');
  });

  it('el escritor lo vuelve a comprobar dentro de la escritura, sin pasar por la herramienta', async () => {
    test = await buildTestContext();
    const ctx = await fresh();
    const writer = new NoteWriter(ctx.port as NodeLibraryPort);
    const privacy = test.serverContext.privacyConfig;
    const id = test.library.publicNote2Id;
    await expect(
      writer.organize({ action: 'moveNote', id, folderId: folderId(ctx, 'diario'), privacy })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      writer.organize({ action: 'setFavorite', id: test.library.privateTagNoteId, favorite: true, privacy })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await ctx.port.noteRead(id))?.folderId).toBe(folderId(ctx, 'proyectos/lumbre'));
  });

  it('notas ocultas, en la papelera o inexistentes: not_found en las tres de nota', async () => {
    test = await buildTestContext();
    const ctx = await fresh();
    for (const id of [
      test.library.privateFolderNoteId,
      test.library.privateTagNoteId,
      test.library.trashedNoteId,
      'no-existe'
    ]) {
      await expectNotFound(runMoveNote(ctx, { id, folderId: 'root' }));
      await expectNotFound(runSetFavorite(ctx, { id, favorite: true }));
      await expectNotFound(runSetArchived(ctx, { id, archived: true }));
    }
  });

  it('favorita y archivar, en los dos sentidos e idempotentes', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    expect(await runSetFavorite(await fresh(), { id, favorite: true })).toMatchObject({ favorite: true });
    expect(await runSetFavorite(await fresh(), { id, favorite: true })).toMatchObject({ favorite: true });
    expect(await runSetArchived(await fresh(), { id, archived: true })).toMatchObject({
      archived: true,
      favorite: true
    });
    expect(await runSetArchived(await fresh(), { id, archived: true })).toMatchObject({ archived: true });
    // Archivada sigue siendo visible para el MCP: se puede desarchivar.
    expect(await runSetArchived(await fresh(), { id, archived: false })).toMatchObject({ archived: false });
    expect(await runSetFavorite(await fresh(), { id, favorite: false })).toMatchObject({ favorite: false });
  });

  it('sin herramientas de carpetas: tools/list no las trae y llamarlas es una herramienta inexistente', async () => {
    // Opción A de David (28 sep 2026): crear, renombrar y mover carpetas quedan fuera del
    // MCP porque sus errores revelaban carpetas privadas. «Carpeta privada = inexistente»
    // al mover una NOTA lo cubre el test de arriba («mover una nota a una carpeta
    // privada responde igual que a una inexistente»).
    test = await buildTestContext();
    const server = new McpServer({ name: 'hebra-mcp-organize-test', version: '0.0.0' });
    registerTools(server, test.serverContext);
    const client = new Client({ name: 'hebra-mcp-organize-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual(TOOL_NAMES);
      for (const name of REMOVED_FOLDER_TOOLS) expect(names).not.toContain(name);

      const foldersBefore = (await runListFolders(await fresh())).folders.length;
      for (const name of REMOVED_FOLDER_TOOLS) {
        const result = (await client.callTool({
          name,
          arguments: { id: 'root', name: 'Nueva', parentId: 'root' }
        })) as CallToolResult;
        // El error genérico del SDK (1.30.1, `McpServer`: `McpError` InvalidParams
        // envuelto en un resultado `isError`) para una herramienta no registrada: ni una
        // salida nuestra ni ninguno de nuestros códigos cerrados.
        expect(result.isError).toBe(true);
        const text = result.content
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        expect(text).toContain(`Tool ${name} not found`);
      }
      expect((await runListFolders(await fresh())).folders).toHaveLength(foldersBefore);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
