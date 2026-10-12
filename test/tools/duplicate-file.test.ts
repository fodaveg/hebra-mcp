/**
 * `hebra_duplicate_file` (D17, 12 oct 2026): un fichero suelto nuevo con los mismos bytes
 * que otro visible y vivo, con otro nombre de la misma extensión, en la carpeta del origen
 * o en otra visible; hasta 5 MiB. Sobre la biblioteca de prueba, por el cliente MCP. La
 * privacidad, en `test/privacy/ficheros-verbos.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FILE_NAMES } from '../fixtures/test-library';
import { sha256, startLooseFiles, type LooseFilesHarness } from '../fixtures/loose-files';

const INVENTARIO_YAML = 'views:\n  - type: table\n';

describe('hebra_duplicate_file (D17)', () => {
  let h: LooseFilesHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(): Promise<LooseFilesHarness> {
    h = await startLooseFiles();
    return h;
  }

  it('copia un .base en su carpeta: id nuevo, mismo sha256, y se lee igual que el original', async () => {
    const { call, callRaw, rawFiles, test } = await start();
    const source = test.library.files.inventario;
    const before = rawFiles();
    const copy = await call('hebra_duplicate_file', {
      id: source,
      name: 'Inventario copia.base',
      operationId: 'op-d1'
    });
    expect(copy).toEqual({
      isError: false,
      value: {
        id: expect.any(String),
        name: 'Inventario copia.base',
        folderPath: '',
        sha256: sha256(INVENTARIO_YAML),
        byteLength: Buffer.byteLength(INVENTARIO_YAML),
        mimeType: 'text/yaml',
        outcome: 'saved',
        sync: 'not_linked'
      }
    });
    expect(copy.value.id).not.toBe(source);
    expect(rawFiles().length).toBe(before.length + 1);
    // El original, intacto.
    expect(rawFiles().find((row) => row.id === source)).toEqual(before.find((row) => row.id === source));
    const read = await callRaw('hebra_read_file', { id: copy.value.id });
    expect((read.content[1] as { text: string }).text).toBe(INVENTARIO_YAML);
  });

  it('a otra carpeta, por ruta o por id, y cualquier tipo (un PDF)', async () => {
    const { call, test } = await start();
    const byPath = await call('hebra_duplicate_file', {
      id: test.library.files.plano,
      name: FILE_NAMES.plano,
      folder: 'Historial',
      operationId: 'op-path'
    });
    expect(byPath.value).toMatchObject({ name: FILE_NAMES.plano, folderPath: 'historial', outcome: 'saved' });
    const byId = await call('hebra_duplicate_file', {
      id: test.library.files.acta,
      name: 'Acta (copia).PDF',
      folderId: test.library.folders.proyectos,
      operationId: 'op-id'
    });
    expect(byId.value).toMatchObject({ name: 'Acta (copia).PDF', folderPath: 'proyectos', outcome: 'saved' });
  });

  it('otra extensión: invalid_input; en el destino ya hay uno con ese nombre: file_exists con su id', async () => {
    const { call, rawFiles, test } = await start();
    const before = rawFiles();
    expect(
      await call('hebra_duplicate_file', { id: test.library.files.inventario, name: 'Copia.yaml', operationId: 'op-ext' })
    ).toEqual({ isError: true, value: { error: 'invalid_input' } });
    // El mismo nombre en la misma carpeta choca con el propio original.
    expect(
      await call('hebra_duplicate_file', {
        id: test.library.files.inventario,
        name: 'inventario.base',
        operationId: 'op-same'
      })
    ).toEqual({ isError: true, value: { error: 'file_exists', id: test.library.files.inventario } });
    expect(
      await call('hebra_duplicate_file', {
        id: test.library.files.acta,
        name: FILE_NAMES.plano,
        folder: 'Proyectos/Lumbre',
        operationId: 'op-twin'
      })
    ).toEqual({ isError: true, value: { error: 'file_exists', id: test.library.files.plano } });
    expect(rawFiles()).toEqual(before);
  });

  it('más de 5 MiB: file_too_large con su tamaño; sin los bytes aquí y sin sync: file_unavailable', async () => {
    const { call, rawFiles, engineFile, exec } = await start();
    const bigBytes = new Uint8Array(5 * 1024 * 1024 + 1).fill(0x61);
    const big = await engineFile(null, 'grande.txt', bigBytes, 'text/plain');
    const before = rawFiles();
    expect(await call('hebra_duplicate_file', { id: big, name: 'grande 2.txt', operationId: 'op-big' })).toEqual({
      isError: true,
      value: { error: 'file_too_large', byteLength: 5 * 1024 * 1024 + 1, maxBytes: 5 * 1024 * 1024 }
    });
    const absent = await engineFile(null, 'ausente.txt', 'bytes que se fueron', 'text/plain');
    exec('UPDATE blobs SET present = 0 WHERE sha256 = ?', sha256('bytes que se fueron'));
    expect(await call('hebra_duplicate_file', { id: absent, name: 'ausente 2.txt', operationId: 'op-abs' })).toEqual({
      isError: true,
      value: { error: 'file_unavailable' }
    });
    expect(rawFiles().length).toBe(before.length + 1);
  });

  it('origen en la papelera o inexistente, o carpeta inexistente: not_found', async () => {
    const { call, test } = await start();
    const notFound = { isError: true, value: { error: 'not_found' } };
    expect(await call('hebra_duplicate_file', { id: test.library.files.trashed, name: 'x.pdf', operationId: 'op-1' })).toEqual(notFound);
    expect(await call('hebra_duplicate_file', { id: 'no-existe', name: 'x.pdf', operationId: 'op-2' })).toEqual(notFound);
    expect(
      await call('hebra_duplicate_file', { id: test.library.files.acta, name: 'x.pdf', folder: 'No/Existe', operationId: 'op-3' })
    ).toEqual(notFound);
  });

  it('idempotente: el reintento devuelve el mismo fichero sin crear otro; con otra petición, operation_id_reused', async () => {
    const { call, rawFiles, test } = await start();
    const args = { id: test.library.files.acta, name: 'Acta B.pdf', operationId: 'op-idem' };
    const first = await call('hebra_duplicate_file', args);
    const count = rawFiles().length;
    expect(await call('hebra_duplicate_file', args)).toEqual({ isError: false, value: { ...first.value, replayed: true } });
    expect(rawFiles().length).toBe(count);
    expect(await call('hebra_duplicate_file', { ...args, name: 'Acta C.pdf' })).toEqual({
      isError: true,
      value: { error: 'operation_id_reused' }
    });
    expect(rawFiles().length).toBe(count);
  });
});
