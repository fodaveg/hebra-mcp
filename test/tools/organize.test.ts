import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { resolveToolContext, type ToolContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import {
  runCreateFolder,
  runMoveFolder,
  runMoveNote,
  runRenameFolder,
  runSetArchived,
  runSetFavorite
} from '../../src/server/tools/organize';
import { runReadNote } from '../../src/server/tools/read-note';
import { runListFolders } from '../../src/server/tools/list-folders';
import { NoteWriter } from '../../src/store/writes';
import type { NodeLibraryPort } from '../../src/store/node-port';

/**
 * Organización por id (D2 ampliada, 28 sep 2026) sobre la biblioteca de prueba
 * (`Proyectos/Lumbre` visible; `Diario` y `Diario/2026` privadas; `secreto` etiqueta
 * privada). Sin sync: `sync: "not_linked"`.
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
    await expect(
      writer.organize({ action: 'createFolder', parentId: folderId(ctx, 'diario'), name: 'x', privacy })
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

  it('crear carpeta: en la raíz o dentro de una visible; nunca en una privada; sin duplicar', async () => {
    test = await buildTestContext();
    const created = await runCreateFolder(await fresh(), { name: 'Nueva' });
    expect(created).toMatchObject({ path: 'nueva', sync: 'not_linked' });
    const ctx = await fresh();
    expect(await runCreateFolder(ctx, { name: 'Hija', parentId: created.id })).toMatchObject({
      path: 'nueva/hija'
    });
    await expectNotFound(runCreateFolder(ctx, { name: 'Espía', parentId: folderId(ctx, 'diario') }));
    await expectNotFound(runCreateFolder(ctx, { name: 'Espía', parentId: 'no-existe' }));
    // Reintentar la misma creación no duplica: choca con el nombre.
    await expect(runCreateFolder(await fresh(), { name: 'nueva' })).rejects.toMatchObject({
      code: 'folder_name_taken'
    });
    for (const name of ['', '   ', 'a/b', 'x'.repeat(256)]) {
      await expect(runCreateFolder(await fresh(), { name })).rejects.toMatchObject({
        code: 'invalid_input'
      });
    }
    const paths = (await runListFolders(await fresh())).folders.map((folder) => folder.path);
    expect(paths.filter((path) => path === 'nueva')).toHaveLength(1);
  });

  it('renombrar carpeta visible; la privada y la raíz, no', async () => {
    test = await buildTestContext();
    const ctx = await fresh();
    const lumbre = folderId(ctx, 'proyectos/lumbre');
    expect(await runRenameFolder(ctx, { id: lumbre, name: 'Hebra' })).toMatchObject({
      id: lumbre,
      path: 'proyectos/hebra'
    });
    expect((await runReadNote(await fresh(), { id: test.library.publicNote2Id })).folderPath).toBe(
      'proyectos/hebra'
    );
    await expectNotFound(runRenameFolder(await fresh(), { id: folderId(ctx, 'diario'), name: 'Otro' }));
    await expect(runRenameFolder(await fresh(), { id: 'root', name: 'Raíz' })).rejects.toMatchObject({
      code: 'invalid_input'
    });
  });

  it('mover carpeta: a la raíz sí; dentro de sí misma o de una descendiente, folder_cycle; a una privada, not_found', async () => {
    test = await buildTestContext();
    const ctx = await fresh();
    const proyectos = folderId(ctx, 'proyectos');
    const lumbre = folderId(ctx, 'proyectos/lumbre');
    for (const parentId of [proyectos, lumbre]) {
      await expect(runMoveFolder(ctx, { id: proyectos, parentId })).rejects.toMatchObject({
        code: 'folder_cycle'
      });
    }
    await expectNotFound(runMoveFolder(ctx, { id: lumbre, parentId: folderId(ctx, 'diario') }));
    await expectNotFound(runMoveFolder(ctx, { id: folderId(ctx, 'diario/2026'), parentId: 'root' }));
    expect(await runMoveFolder(ctx, { id: lumbre, parentId: 'root' })).toMatchObject({
      id: lumbre,
      path: 'lumbre'
    });
  });

  it('renombrar o mover una carpeta con una privada dentro no cambia qué es privado', async () => {
    test = await buildTestContext({ privateFolders: [['proyectos', 'lumbre']], privateTags: [] });
    const ctx = await fresh();
    const proyectos = folderId(ctx, 'proyectos');
    const diario = folderId(ctx, 'diario');
    // `Proyectos` es visible, pero su hija `Lumbre` es privada: cambiarle la ruta dejaría
    // `proyectos/lumbre` sin resolver (o expuesta).
    await expectNotFound(runRenameFolder(ctx, { id: proyectos, name: 'Otros' }));
    await expectNotFound(runMoveFolder(ctx, { id: proyectos, parentId: diario }));
    const after = await fresh();
    expect(after.privacy.unresolved).toBe(false);
    expect(after.privacy.folderPath(proyectos)).toBe('proyectos');
  });
});
