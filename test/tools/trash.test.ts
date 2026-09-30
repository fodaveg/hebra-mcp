import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { BAIT_FOLDER, BAIT_TAG } from '../fixtures/test-library';
import { FORBIDDEN_TRASH_TOOLS, TOOL_NAMES } from '../fixtures/tool-names';
import { resolveToolContext, type ToolContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import { registerTools } from '../../src/server/register-tools';
import { runListTrash } from '../../src/server/tools/list-trash';
import { runRestoreNote, runTrashNote } from '../../src/server/tools/organize';
import { runReadNote } from '../../src/server/tools/read-note';
import { PrivacyFilter, TrashFilter, type PrivacyConfig } from '../../src/privacy';
import type { FoldersList } from '../../src/hebra';

/**
 * Papelera (ampliación de D2, decisión de David del 30 sep 2026) sobre la biblioteca de
 * prueba: `Diario` y `Diario/2026` privadas, `secreto` etiqueta privada. En la papelera
 * hay una nota de la raíz, una de `Proyectos/Lumbre`, una de `Diario/2026`, una con
 * `#secreto/personal` y dos de carpetas BORRADAS: `Diario/Viejo` (privada) y
 * `Proyectos/Antiguo` (pública). Sin sync: `sync: "not_linked"`.
 */

describe('papelera', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  /** Contexto con el filtro recalculado AHORA (el de `test.ctx` es del arranque). */
  function fresh(): Promise<ToolContext> {
    return resolveToolContext(test!.serverContext);
  }

  async function expectNotFound(promise: Promise<unknown>): Promise<void> {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe('not_found');
    expect((error as ToolError).extra).toBeUndefined();
  }

  function hiddenTrashed(): string[] {
    const library = test!.library;
    return [
      library.trashedPrivateFolderNoteId,
      library.trashedPrivateTagNoteId,
      library.trashedDeletedPrivateFolderNoteId
    ];
  }

  it('hebra_list_trash: solo las visibles, con la carpeta de restauración y sin recuento', async () => {
    test = await buildTestContext();
    const library = test.library;
    const result = await runListTrash(await fresh(), { limit: 100 });
    expect(Object.keys(result).sort()).toEqual(['nextCursor', 'notes']);
    expect(result.nextCursor).toBeNull();
    const byId = new Map(result.notes.map((note) => [note.id, note]));
    expect([...byId.keys()].sort()).toEqual(
      [
        library.trashedNoteId,
        library.trashedPublicFolderNoteId,
        library.trashedDeletedPublicFolderNoteId
      ].sort()
    );
    expect(byId.get(library.trashedNoteId)).toMatchObject({
      title: 'Nota en la papelera',
      folderPath: '',
      isConflictCopy: false
    });
    expect(byId.get(library.trashedPublicFolderNoteId)?.folderPath).toBe('proyectos/lumbre');
    // Su carpeta se borró: vuelve a la raíz, como en Hebra.
    expect(byId.get(library.trashedDeletedPublicFolderNoteId)?.folderPath).toBe('');
    for (const note of result.notes) {
      expect(Number.isNaN(Date.parse(note.trashedAt))).toBe(false);
    }
    const text = JSON.stringify(result);
    expect(text).not.toContain(BAIT_FOLDER);
    expect(text).not.toContain(BAIT_TAG);
    expect(text).not.toContain('viejo');
  });

  it('hebra_list_trash pagina sin delatar las ocultas: la última página visible cierra con null', async () => {
    test = await buildTestContext();
    const ctx = await fresh();
    const all = await runListTrash(ctx, { limit: 100 });
    const visible = all.notes.length;
    expect(visible).toBe(3);

    // Justo tantas como visibles: no hay página siguiente, aunque queden ocultas detrás.
    expect((await runListTrash(ctx, { limit: visible })).nextCursor).toBeNull();

    // De una en una: las mismas, en el mismo orden, y la última página no está vacía.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await runListTrash(ctx, { limit: 1, ...(cursor ? { cursor } : {}) });
      expect(result.notes).toHaveLength(1);
      seen.push(result.notes[0]!.id);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(all.notes.map((note) => note.id));
  });

  it('mandar a la papelera y restaurar una nota visible (a su carpeta), idempotentes', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;

    expect(await runTrashNote(await fresh(), { id })).toEqual({
      id,
      trashed: true,
      sync: 'not_linked'
    });
    // Las demás herramientas no ven la papelera; la lista de la papelera sí.
    await expectNotFound(runReadNote(await fresh(), { id }));
    expect((await runListTrash(await fresh(), {})).notes.map((note) => note.id)).toContain(id);
    // Otra vez: se queda como está.
    expect(await runTrashNote(await fresh(), { id })).toMatchObject({ id, trashed: true });

    expect(await runRestoreNote(await fresh(), { id })).toEqual({
      id,
      folderPath: 'proyectos/lumbre',
      favorite: false,
      archived: false,
      sync: 'not_linked'
    });
    expect((await runReadNote(await fresh(), { id })).folderPath).toBe('proyectos/lumbre');
    expect((await test.ctx.port.noteRead(id))?.trashedAt).toBeNull();
    // Otra vez: sigue viva, sin error.
    expect(await runRestoreNote(await fresh(), { id })).toMatchObject({ id, folderPath: 'proyectos/lumbre' });
  });

  it('restaurar una nota cuya carpeta se borró la deja en la raíz', async () => {
    test = await buildTestContext();
    const id = test.library.trashedDeletedPublicFolderNoteId;
    expect(await runRestoreNote(await fresh(), { id })).toMatchObject({ id, folderPath: '' });
    expect((await runReadNote(await fresh(), { id })).title).toBe('Nota de carpeta borrada');
  });

  it('mandar a la papelera una nota oculta o inexistente: not_found, igual, sin escribir', async () => {
    test = await buildTestContext();
    const library = test.library;
    for (const id of [library.privateFolderNoteId, library.privateTagNoteId, 'no-existe']) {
      await expectNotFound(runTrashNote(await fresh(), { id }));
    }
    for (const id of [library.privateFolderNoteId, library.privateTagNoteId]) {
      expect((await test.ctx.port.noteRead(id))?.trashedAt).toBeNull();
    }
  });

  it('restaurar una nota oculta de la papelera (también de una carpeta privada ya borrada): not_found', async () => {
    test = await buildTestContext();
    for (const id of [...hiddenTrashed(), 'no-existe']) {
      await expectNotFound(runRestoreNote(await fresh(), { id }));
    }
    for (const id of hiddenTrashed()) {
      expect((await test.ctx.port.noteRead(id))?.trashedAt).not.toBeNull();
    }
  });

  it('el escritor rechaza restaurar una oculta aunque la petición se salte la herramienta', async () => {
    test = await buildTestContext();
    for (const id of hiddenTrashed()) {
      const error = await test.ctx
        .write!.organize({ action: 'restoreNote', id, privacy: test.ctx.privacyConfig })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'not_found' });
      expect((await test.ctx.port.noteRead(id))?.trashedAt).not.toBeNull();
    }
    const error = await test.ctx
      .write!.organize({
        action: 'trashNote',
        id: test.library.privateFolderNoteId,
        privacy: test.ctx.privacyConfig
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'not_found' });
  });

  it('por MCP: las seis herramientas nuevas están y purgar o vaciar la papelera no existe', async () => {
    test = await buildTestContext();
    const server = new McpServer({ name: 'hebra-mcp-trash-test', version: '0.0.0' });
    registerTools(server, test.serverContext);
    const client = new Client({ name: 'hebra-mcp-trash-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual(TOOL_NAMES);
      for (const name of FORBIDDEN_TRASH_TOOLS) {
        expect(names).not.toContain(name);
        const result = (await client.callTool({
          name,
          arguments: { id: test.library.trashedNoteId }
        })) as CallToolResult;
        expect(result.isError).toBe(true);
      }
      expect((await test.ctx.port.noteRead(test.library.trashedNoteId))?.trashedAt).not.toBeNull();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('TrashFilter: carpetas borradas', () => {
  const root = { id: 'root', parentId: null, parentState: 'ok' as const, name: '', createdAt: 0, updatedAt: 0, noteCount: 0 };

  function filterFor(
    folders: FoldersList['folders'],
    rows: Array<{ id: string; parentId: string | null; name: string | null; deleted: boolean }>,
    notes: Array<{ id: string; folderId: string; tags?: string[] }>,
    config: PrivacyConfig
  ): TrashFilter {
    const live = PrivacyFilter.fromSnapshot({ folders }, [], config);
    return TrashFilter.fromSnapshot(
      live,
      {
        notes: notes.map((note) => ({ tags: [], trashedAt: 1, ...note })),
        folders: rows
      },
      config
    );
  }

  it('una carpeta privada borrada y vuelta a crear con el mismo nombre no destapa las notas de la vieja', () => {
    const config: PrivacyConfig = { privateFolders: [['diario']], privateTags: [] };
    const nueva = { ...root, id: 'nueva', parentId: 'root', name: 'Diario' };
    const filter = filterFor(
      [root, nueva],
      [
        { id: 'root', parentId: null, name: '', deleted: false },
        { id: 'nueva', parentId: 'root', name: 'Diario', deleted: false },
        { id: 'vieja', parentId: 'root', name: 'Diario', deleted: true },
        { id: 'vieja-sub', parentId: 'vieja', name: '2025', deleted: true },
        { id: 'otra', parentId: 'root', name: 'Recetas', deleted: true }
      ],
      [
        { id: 'n-vieja', folderId: 'vieja' },
        { id: 'n-vieja-sub', folderId: 'vieja-sub' },
        { id: 'n-otra', folderId: 'otra' }
      ],
      config
    );
    expect(filter.isVisible('n-vieja')).toBe(false);
    expect(filter.isVisible('n-vieja-sub')).toBe(false);
    expect(filter.visibleMeta('n-otra')).toEqual({ folderId: 'root', tags: [], trashedAt: 1 });
  });

  it('cerrado ante la duda: carpeta sin fila, sin nombre o en ciclo, oculta', () => {
    const config: PrivacyConfig = { privateFolders: [], privateTags: [] };
    const filter = filterFor(
      [root],
      [
        { id: 'sin-nombre', parentId: 'root', name: null, deleted: true },
        { id: 'a', parentId: 'b', name: 'A', deleted: true },
        { id: 'b', parentId: 'a', name: 'B', deleted: true }
      ],
      [
        { id: 'n-fantasma', folderId: 'no-hay-fila' },
        { id: 'n-sin-nombre', folderId: 'sin-nombre' },
        { id: 'n-ciclo', folderId: 'a' },
        { id: 'n-raiz', folderId: 'root' }
      ],
      config
    );
    expect(filter.isVisible('n-fantasma')).toBe(false);
    expect(filter.isVisible('n-sin-nombre')).toBe(false);
    expect(filter.isVisible('n-ciclo')).toBe(false);
    expect(filter.isVisible('n-raiz')).toBe(true);
    expect(filter.isVisible('no-esta-en-la-papelera')).toBe(false);
  });
});
