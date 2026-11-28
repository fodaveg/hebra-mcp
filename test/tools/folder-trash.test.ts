/**
 * `hebra_trash_folder` y `hebra_restore_folder` (D29, 28 nov 2026) sobre la biblioteca de prueba,
 * sin sync: `Proyectos`, `Proyectos/Lumbre` (con notas y `plano.pdf`), `Diario` (privada),
 * `Diario/2026`, `Historial` y `Adjuntos`. Que un lector lo pida por `writer.sock` va en
 * `test/forward/forward.folder-trash.test.ts`; que solo el turno del escritor alcance el motor, en
 * `test/store/surface.node.test.ts`.
 *
 * Pruebas negativas hechas a mano al escribirlo (se rompe, el test cae, se restaura): quitar la
 * regla de la configuración de `planFolderTrash` (cae «una ruta privada configurada debajo»), y
 * mandar la carpeta sin cortar antes si ya estaba en la papelera (cae «idempotente»).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ROOT_FOLDER_ID } from '../../src/hebra';
import type { PrivacyConfig } from '../../src/privacy';
import { PrivacyFilter } from '../../src/privacy/filter';
import { resolveToolContext, type ToolContext } from '../../src/server/context';
import { toErrorResult, ToolError } from '../../src/server/errors';
import { registerTools } from '../../src/server/register-tools';
import { runRestoreFolder, runTrashFolder } from '../../src/server/tools/folder-trash';
import { runListFiles } from '../../src/server/tools/files';
import { runListFolders } from '../../src/server/tools/list-folders';
import { runListTrash } from '../../src/server/tools/list-trash';
import type { NodeLibraryPort } from '../../src/store';
import { planFolderTrash, trashedFolderSegments } from '../../src/store/folder-trash';
import { buildTestContext, type TestContext } from '../fixtures/test-context';

const DEFAULT_PRIVACY: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

describe('carpetas a la papelera (D29)', () => {
  let test: TestContext | undefined;
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    await test?.close();
    test = undefined;
  });

  function fresh(): Promise<ToolContext> {
    return resolveToolContext(test!.serverContext);
  }

  function port(): NodeLibraryPort {
    return test!.ctx.port as NodeLibraryPort;
  }

  async function liveFolderIds(): Promise<Set<string>> {
    const { folders } = await port().foldersList();
    return new Set(folders.map((folder) => folder.id));
  }

  async function expectCode(promise: Promise<unknown>, code: string): Promise<ToolError> {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe(code);
    return error as ToolError;
  }

  async function mcpClient(): Promise<Client> {
    const server = new McpServer({ name: 'hebra-mcp-folder-trash-test', version: '0.0.0' });
    registerTools(server, test!.serverContext);
    const client = new Client({ name: 'hebra-mcp-folder-trash-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  it('manda la carpeta con sus subcarpetas, notas y ficheros, y la saca con todo', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const { proyectos, lumbre } = test.library.folders;
    const notesBefore = (await runListTrash(await fresh(), { limit: 100 })).notes.length;
    const plano = test.library.files.plano;

    const trashed = await runTrashFolder(await fresh(), { folderId: proyectos });
    expect(trashed).toEqual({ id: proyectos, trashed: true, changed: true, sync: 'not_linked' });
    const live = await liveFolderIds();
    expect(live.has(proyectos)).toBe(false);
    expect(live.has(lumbre)).toBe(false);
    const inTrash = await runListTrash(await fresh(), { kind: 'folders', limit: 100 });
    const paths = new Map(inTrash.folders.map((folder) => [folder.id, folder.path]));
    expect(paths.get(proyectos)).toBe('proyectos');
    expect(paths.get(lumbre)).toBe('proyectos/lumbre');
    // Las notas de dentro entran en la papelera con ella, y el fichero suelto también.
    expect((await runListTrash(await fresh(), { limit: 100 })).notes.length).toBeGreaterThan(notesBefore);
    const trashedFiles = await runListFiles(await fresh(), { trashed: true, limit: 100 });
    expect(trashedFiles.files.map((file) => file.id)).toContain(plano);

    const restored = await runRestoreFolder(await fresh(), { folderId: proyectos });
    expect(restored).toEqual({ id: proyectos, path: 'proyectos', restored: true, sync: 'not_linked' });
    const back = await liveFolderIds();
    expect(back.has(proyectos)).toBe(true);
    expect(back.has(lumbre)).toBe(true);
    expect((await runListTrash(await fresh(), { limit: 100 })).notes.length).toBe(notesBefore);
    const liveFiles = await runListFiles(await fresh(), { limit: 100 });
    expect(liveFiles.files.find((file) => file.id === plano)?.folderPath).toBe('proyectos/lumbre');
  });

  it('idempotente: mandar una que ya está en la papelera o sacar una viva no escribe', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const { historial } = test.library.folders;
    await runTrashFolder(await fresh(), { folderId: historial });
    const seq = (): Promise<unknown> =>
      port().writeExclusive(async (store) => store.foldersTrash().find((entry) => entry.id === historial)?.trashedAt);
    const mark = await seq();
    expect(await runTrashFolder(await fresh(), { folderId: historial })).toEqual({
      id: historial,
      trashed: true,
      changed: false,
      sync: 'not_linked'
    });
    // La misma marca: no volvió a pasar por el motor.
    expect(await seq()).toBe(mark);
    await runRestoreFolder(await fresh(), { folderId: historial });
    expect(await runRestoreFolder(await fresh(), { folderId: historial })).toEqual({
      id: historial,
      path: 'historial',
      restored: false,
      sync: 'not_linked'
    });
  });

  it('sacar una subcarpeta saca también la madre que estaba en la papelera', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const { proyectos, lumbre } = test.library.folders;
    await runTrashFolder(await fresh(), { folderId: proyectos });
    const restored = await runRestoreFolder(await fresh(), { folderId: lumbre });
    expect(restored).toMatchObject({ id: lumbre, path: 'proyectos/lumbre', restored: true });
    expect((await liveFolderIds()).has(proyectos)).toBe(true);
  });

  it('oculta, inexistente o la raíz: not_found igual (invalid_input la raíz), sin escribir', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const { diario, diario2026 } = test.library.folders;
    // Una carpeta de la papelera dentro de la privada, puesta ahí con el motor (como la app).
    const hiddenTrashed = await port().writeExclusive(async (store) => {
      const folder = await store.folderCreate(diario, 'Vieja');
      await store.folderTrash(folder.id);
      return folder.id;
    });
    const before = await liveFolderIds();
    const responses = new Set<string>();
    for (const folderId of [diario, diario2026, hiddenTrashed, 'no-existe']) {
      for (const run of [runTrashFolder, runRestoreFolder]) {
        const error = await expectCode(run(await fresh(), { folderId }), 'not_found');
        responses.add(textOf(toErrorResult(error)));
      }
    }
    // Byte a byte la misma respuesta, exista o no la carpeta oculta.
    expect(responses.size).toBe(1);
    await expectCode(runTrashFolder(await fresh(), { folderId: ROOT_FOLDER_ID }), 'invalid_input');
    await expectCode(runRestoreFolder(await fresh(), { folderId: ROOT_FOLDER_ID }), 'invalid_input');
    expect(await liveFolderIds()).toEqual(before);
    const trash = await port().writeExclusive(async (store) => store.foldersTrash().map((entry) => entry.id));
    expect(trash).toEqual([hiddenTrashed]);
  });

  it('una ruta privada configurada debajo: folder_unavailable, desde la configuración y sin escribir', async () => {
    test = await buildTestContext({ privateFolders: [['proyectos', 'lumbre']], privateTags: [] });
    const { proyectos } = test.library.folders;
    const before = await liveFolderIds();
    await expectCode(runTrashFolder(await fresh(), { folderId: proyectos }), 'folder_unavailable');
    expect(await liveFolderIds()).toEqual(before);
  });

  it('el escritor rehace el plan en su turno: lo que la herramienta no rechazó, él sí', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const write = test.serverContext.write!;
    await expect(
      write.organizeFolder!({ action: 'trashFolder', id: test.library.folders.diario, privacy: DEFAULT_PRIVACY })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      write.organizeFolder!({
        action: 'trashFolder',
        id: test.library.folders.proyectos,
        privacy: { privateFolders: [['proyectos', 'lumbre']], privateTags: [] }
      })
    ).rejects.toMatchObject({ code: 'folder_unavailable' });
    expect((await liveFolderIds()).has(test.library.folders.proyectos)).toBe(true);
  });

  it('por MCP: la respuesta pasa la puerta final; la de sacar trae la ruta y la de mandar no', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const client = await mcpClient();
    const { historial } = test.library.folders;
    const trashed = (await client.callTool({
      name: 'hebra_trash_folder',
      arguments: { folderId: historial }
    })) as CallToolResult;
    expect(trashed.isError).toBeFalsy();
    expect(JSON.parse(textOf(trashed))).toEqual({ id: historial, trashed: true, changed: true, sync: 'not_linked' });
    const restored = (await client.callTool({
      name: 'hebra_restore_folder',
      arguments: { folderId: historial }
    })) as CallToolResult;
    expect(restored.isError).toBeFalsy();
    expect(JSON.parse(textOf(restored))).toEqual({ id: historial, path: 'historial', restored: true, sync: 'not_linked' });
    const hidden = (await client.callTool({
      name: 'hebra_trash_folder',
      arguments: { folderId: test.library.folders.diario }
    })) as CallToolResult;
    expect(hidden.isError).toBe(true);
    expect(textOf(hidden)).toContain('not_found');
  });
});

describe('planFolderTrash (D29): la regla de la configuración también al sacar', () => {
  it('una carpeta de la papelera con una ruta privada configurada en su ruta original: folder_unavailable', () => {
    // `Proyectos` viva; `Lumbre` en la papelera debajo. La configuración nombra algo por debajo
    // de `proyectos/lumbre` (el filtro no resuelve, pero el plan no se fía de eso).
    const live = PrivacyFilter.fromSnapshot(
      { folders: [{ id: 'p', parentId: null, name: 'Proyectos', noteCount: 0, parentState: 'ok' }] } as never,
      [],
      { privateFolders: [['proyectos', 'lumbre', 'x']], privateTags: [] }
    );
    const trashed = [{ id: 'l', parentId: 'p', name: ' Lumbre ', trashedAt: 1 }];
    expect(trashedFolderSegments(live, trashed, 'l')).toEqual(['proyectos', 'lumbre']);
    const view = { trashed, trash: { restoreFolderOf: () => ROOT_FOLDER_ID } };
    expect(planFolderTrash(live, view, 'restoreFolder', 'l')).toEqual({ kind: 'reject', code: 'folder_unavailable' });
    // Sin esa ruta configurada, se saca; y mandarla otra vez no escribe.
    const open = PrivacyFilter.fromSnapshot(
      { folders: [{ id: 'p', parentId: null, name: 'Proyectos', noteCount: 0, parentState: 'ok' }] } as never,
      [],
      { privateFolders: [], privateTags: [] }
    );
    expect(planFolderTrash(open, view, 'restoreFolder', 'l')).toEqual({ kind: 'write' });
    expect(planFolderTrash(open, view, 'trashFolder', 'l')).toEqual({ kind: 'unchanged' });
    // Una antecesora purgada (la subida no llega a nada vivo): no se sabe, not_found.
    const orphan = [{ id: 'h', parentId: 'purgada', name: 'Hija', trashedAt: 1 }];
    expect(planFolderTrash(open, { trashed: orphan, trash: view.trash }, 'restoreFolder', 'h')).toEqual({
      kind: 'reject',
      code: 'not_found'
    });
  });
});
