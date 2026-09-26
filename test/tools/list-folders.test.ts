import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { runListFolders } from '../../src/server/tools/list-folders';

describe('hebra_list_folders', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('forma {id,path,count}, con la raíz incluida', async () => {
    test = await buildTestContext();
    const { folders } = await runListFolders(test.ctx);
    const byPath = new Map(folders.map((f) => [f.path, f.count]));
    // publicNote, publicNote2, duplicateB y la copia de conflicto (nace en la misma
    // carpeta que su original): las cuatro notas VIVAS de `proyectos/lumbre`.
    expect(byPath.get('proyectos/lumbre')).toBe(4);
    expect(byPath.has('')).toBe(true); // la raíz
  });

  it('una carpeta privada, y su subcarpeta, nunca aparecen', async () => {
    test = await buildTestContext();
    const { folders } = await runListFolders(test.ctx);
    expect(folders.some((f) => f.path === 'diario')).toBe(false);
    expect(folders.some((f) => f.path === 'diario/2026')).toBe(false);
  });

  it('el recuento de la raíz no cuenta una nota oculta por etiqueta', async () => {
    test = await buildTestContext();
    const { folders } = await runListFolders(test.ctx);
    const root = folders.find((f) => f.path === '')!;
    // La raíz tiene: linkingNote y codeFenceNote, visibles, y (antes de contar la
    // oculta por etiqueta) esa nota NO debe sumar al recuento visible.
    const port = test.ctx.port;
    const hiddenByTag = await port.noteRead(test.library.privateTagNoteId);
    expect(hiddenByTag).not.toBeNull();
    expect(root.count).toBeGreaterThan(0);
    // El recuento visible de la raíz nunca puede superar las notas de raíz VISIBLES
    // conocidas por el test (linkingNote, codeFenceNote); si la oculta contara, sería
    // una de más.
    expect(root.count).toBe(2);
  });
});
