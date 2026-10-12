/**
 * `hebra_move_file` (D17, 12 oct 2026): un fichero suelto visible y vivo a otra carpeta
 * visible (o a la raíz), con el mismo nombre, sobre la biblioteca de prueba. Todo por el
 * cliente MCP. La privacidad (destino privado, origen oculto), en
 * `test/privacy/ficheros-verbos.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FILE_NAMES } from '../fixtures/test-library';
import { startLooseFiles, type LooseFilesHarness } from '../fixtures/loose-files';

describe('hebra_move_file (D17)', () => {
  let h: LooseFilesHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(): Promise<LooseFilesHarness> {
    h = await startLooseFiles();
    return h;
  }

  it('lo mueve por ruta y lo devuelve a la raíz sin carpeta: mismo id, nombre y bytes', async () => {
    const { call, rawFiles, test } = await start();
    const id = test.library.files.inventario;
    const before = rawFiles().find((row) => row.id === id)!;
    const moved = await call('hebra_move_file', { id, folder: 'Proyectos', operationId: 'op-m1' });
    expect(moved).toEqual({
      isError: false,
      value: {
        id,
        name: FILE_NAMES.inventario,
        folderPath: 'proyectos',
        sha256: before.sha256,
        byteLength: expect.any(Number),
        mimeType: 'text/yaml',
        outcome: 'saved',
        sync: 'not_linked'
      }
    });
    expect(rawFiles().find((row) => row.id === id)).toMatchObject({
      folderId: test.library.folders.proyectos,
      name: FILE_NAMES.inventario,
      sha256: before.sha256
    });
    const back = await call('hebra_move_file', { id, operationId: 'op-m2' });
    expect(back.value).toMatchObject({ id, folderPath: '', outcome: 'saved' });
    expect(rawFiles().find((row) => row.id === id)!.folderId).toBe('root');
  });

  it('por id de carpeta, y cualquier tipo (un PDF)', async () => {
    const { call, test } = await start();
    const moved = await call('hebra_move_file', {
      id: test.library.files.acta,
      folderId: test.library.folders.historial,
      operationId: 'op-pdf'
    });
    expect(moved.value).toMatchObject({ name: FILE_NAMES.acta, folderPath: 'historial', outcome: 'saved' });
  });

  it('ya está en esa carpeta: outcome "already", sin escribir', async () => {
    const { call, rawFiles, test } = await start();
    const before = rawFiles();
    const same = await call('hebra_move_file', {
      id: test.library.files.plano,
      folder: 'Proyectos/Lumbre',
      operationId: 'op-same'
    });
    expect(same.value).toMatchObject({ id: test.library.files.plano, outcome: 'already' });
    expect(rawFiles()).toEqual(before);
  });

  it('en el destino hay otro con ese nombre (sin distinguir mayúsculas): file_exists con su id', async () => {
    const { call, rawFiles, test, engineFile } = await start();
    const twin = await engineFile(null, 'PLANO.PDF', 'otro plano');
    const before = rawFiles();
    expect(
      await call('hebra_move_file', { id: twin, folder: 'Proyectos/Lumbre', operationId: 'op-twin' })
    ).toEqual({ isError: true, value: { error: 'file_exists', id: test.library.files.plano } });
    expect(rawFiles()).toEqual(before);
  });

  it('folder y folderId a la vez: invalid_input; carpeta inexistente, origen de la papelera o inexistente: not_found', async () => {
    const { call, rawFiles, test } = await start();
    const before = rawFiles();
    expect(
      await call('hebra_move_file', {
        id: test.library.files.acta,
        folder: 'Proyectos',
        folderId: 'root',
        operationId: 'op-1'
      })
    ).toEqual({ isError: true, value: { error: 'invalid_input' } });
    const notFound = { isError: true, value: { error: 'not_found' } };
    expect(await call('hebra_move_file', { id: test.library.files.acta, folder: 'No/Existe', operationId: 'op-2' })).toEqual(notFound);
    expect(await call('hebra_move_file', { id: test.library.files.acta, folderId: 'no-existe', operationId: 'op-3' })).toEqual(notFound);
    expect(await call('hebra_move_file', { id: test.library.files.trashed, folder: 'Proyectos', operationId: 'op-4' })).toEqual(notFound);
    expect(await call('hebra_move_file', { id: 'no-existe', folder: 'Proyectos', operationId: 'op-5' })).toEqual(notFound);
    expect(rawFiles()).toEqual(before);
  });

  it('idempotente: el reintento devuelve lo anotado; con otro destino, operation_id_reused', async () => {
    const { call, rawFiles, test } = await start();
    const args = { id: test.library.files.acta, folder: 'Historial', operationId: 'op-idem' };
    const first = await call('hebra_move_file', args);
    const after = rawFiles();
    expect(await call('hebra_move_file', args)).toEqual({ isError: false, value: { ...first.value, replayed: true } });
    expect(rawFiles()).toEqual(after);
    expect(await call('hebra_move_file', { ...args, folder: 'Adjuntos' })).toEqual({
      isError: true,
      value: { error: 'operation_id_reused' }
    });
  });
});
