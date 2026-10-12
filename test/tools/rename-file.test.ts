/**
 * `hebra_rename_file` (D17, 12 oct 2026): otro nombre para un fichero suelto visible y
 * vivo, con la misma extensión y en la misma carpeta, sobre la biblioteca de prueba. Todo
 * por el cliente MCP. La privacidad, en `test/privacy/ficheros-verbos.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FILE_NAMES } from '../fixtures/test-library';
import { sha256, startLooseFiles, type LooseFilesHarness } from '../fixtures/loose-files';

const INVENTARIO_YAML = 'views:\n  - type: table\n';

describe('hebra_rename_file (D17)', () => {
  let h: LooseFilesHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(): Promise<LooseFilesHarness> {
    h = await startLooseFiles();
    return h;
  }

  it('renombra un .base: mismo id, mismos bytes, el nombre nuevo en disco y en la lista', async () => {
    const { call, rawFiles, test } = await start();
    const id = test.library.files.inventario;
    const before = rawFiles().find((row) => row.id === id)!;
    const renamed = await call('hebra_rename_file', { id, name: 'Tareas.base', operationId: 'op-r1' });
    expect(renamed).toEqual({
      isError: false,
      value: {
        id,
        name: 'Tareas.base',
        folderPath: '',
        sha256: sha256(INVENTARIO_YAML),
        byteLength: Buffer.byteLength(INVENTARIO_YAML),
        mimeType: 'text/yaml',
        outcome: 'saved',
        sync: 'not_linked'
      }
    });
    const after = rawFiles().find((row) => row.id === id)!;
    expect(after).toMatchObject({ name: 'Tareas.base', folderId: before.folderId, sha256: before.sha256 });
    expect(after.localSeq).toBeGreaterThan(before.localSeq);
    const listed = (await call('hebra_list_files', { name: 'tareas' })).value.files as Array<{ id: string }>;
    expect(listed.map((entry) => entry.id)).toEqual([id]);
  });

  it('el nombre que ya tiene: outcome "already", sin escribir', async () => {
    const { call, rawFiles, test } = await start();
    const id = test.library.files.inventario;
    const before = rawFiles();
    const same = await call('hebra_rename_file', { id, name: ` ${FILE_NAMES.inventario} `, operationId: 'op-same' });
    expect(same.value).toMatchObject({ id, name: FILE_NAMES.inventario, outcome: 'already' });
    expect(rawFiles()).toEqual(before);
  });

  it('la extensión no cambia (sin distinguir mayúsculas): otra, o quitarla, es invalid_input', async () => {
    const { call, rawFiles, test } = await start();
    const id = test.library.files.inventario;
    const before = rawFiles();
    for (const name of ['Inventario.yaml', 'Inventario', 'Inventario.base.txt', 'Inventario.']) {
      expect(await call('hebra_rename_file', { id, name, operationId: `op-${name}` }), name).toEqual({
        isError: true,
        value: { error: 'invalid_input' }
      });
    }
    for (const name of ['', 'a/b.base', 'a|b.base', `${'x'.repeat(251)}.base`]) {
      expect(await call('hebra_rename_file', { id, name, operationId: 'op-n' })).toEqual({
        isError: true,
        value: { error: 'invalid_input' }
      });
    }
    expect(rawFiles()).toEqual(before);
    // Cambiar solo las mayúsculas de la extensión sí vale.
    const upper = await call('hebra_rename_file', { id, name: 'Inventario.BASE', operationId: 'op-upper' });
    expect(upper.value).toMatchObject({ name: 'Inventario.BASE', outcome: 'saved' });
  });

  it('cualquier tipo: un PDF se renombra igual, con sus bytes', async () => {
    const { call, rawFiles, test } = await start();
    const id = test.library.files.acta;
    const before = rawFiles().find((row) => row.id === id)!;
    const renamed = await call('hebra_rename_file', { id, name: 'Acta 2026.pdf', operationId: 'op-pdf' });
    expect(renamed.value).toMatchObject({ id, name: 'Acta 2026.pdf', sha256: before.sha256, outcome: 'saved' });
  });

  it('otro fichero vivo con ese nombre en la carpeta: file_exists con su id; uno de la papelera no cuenta', async () => {
    const { call, rawFiles, test, engineFile } = await start();
    const other = await engineFile(null, 'Otro.pdf', 'otro pdf');
    const before = rawFiles();
    expect(
      await call('hebra_rename_file', { id: test.library.files.acta, name: 'OTRO.pdf', operationId: 'op-x' })
    ).toEqual({ isError: true, value: { error: 'file_exists', id: other } });
    expect(rawFiles()).toEqual(before);
    // `Borrador tirado.pdf` está en la papelera, en la raíz: no choca.
    const trashedName = await call('hebra_rename_file', {
      id: test.library.files.acta,
      name: FILE_NAMES.trashed,
      operationId: 'op-y'
    });
    expect(trashedName.value).toMatchObject({ outcome: 'saved', name: FILE_NAMES.trashed });
    // Cambiar solo mayúsculas del propio nombre no choca consigo mismo.
    const self = await call('hebra_rename_file', { id: other, name: 'otro.pdf', operationId: 'op-z' });
    expect(self.value).toMatchObject({ id: other, name: 'otro.pdf', outcome: 'saved' });
  });

  it('de la papelera, inexistente o una nota: not_found', async () => {
    const { call, test } = await start();
    for (const id of [test.library.files.trashed, 'no-existe', test.library.publicNoteId]) {
      expect(await call('hebra_rename_file', { id, name: 'x.pdf', operationId: `op-${id}` })).toEqual({
        isError: true,
        value: { error: 'not_found' }
      });
    }
  });

  it('idempotente: el reintento devuelve lo anotado aunque el nombre cambiara después', async () => {
    const { call, test } = await start();
    const id = test.library.files.inventario;
    const args = { id, name: 'Primero.base', operationId: 'op-idem' };
    const first = await call('hebra_rename_file', args);
    await call('hebra_rename_file', { id, name: 'Segundo.base', operationId: 'op-otro' });
    expect(await call('hebra_rename_file', args)).toEqual({
      isError: false,
      value: { ...first.value, replayed: true }
    });
    expect(await call('hebra_rename_file', { ...args, name: 'Tercero.base' })).toEqual({
      isError: true,
      value: { error: 'operation_id_reused' }
    });
  });
});
