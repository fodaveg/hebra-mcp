/**
 * `hebra_create_file` (D17, decidido por David el 12 oct 2026: «que pueda crear bases»):
 * un fichero suelto de texto nuevo, sobre la biblioteca de prueba (`Diario` privada,
 * `Inventario.base` y `Acta.pdf` en la raíz, `plano.pdf` en `Proyectos/Lumbre`). Todo por
 * el cliente MCP, para comparar respuestas enteras. Sin sync: `sync: "not_linked"`. La
 * privacidad, en `test/privacy/ficheros-verbos.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FILE_NAMES } from '../fixtures/test-library';
import { sha256, startLooseFiles, type LooseFilesHarness } from '../fixtures/loose-files';

/** Una base de Obsidian Bases de verdad: un filtro por carpeta y una vista de tabla. */
const BASE_YAML =
  'filters:\n' +
  '  and:\n' +
  '    - file.inFolder("Diccionario")\n' +
  'views:\n' +
  '  - type: table\n' +
  '    name: Palabras\n' +
  '    order:\n' +
  '      - file.name\n' +
  '      - definicion\n';
const BASE_NAME = '📚 Base - Diccionario.base';

describe('hebra_create_file (D17)', () => {
  let h: LooseFilesHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(): Promise<LooseFilesHarness> {
    h = await startLooseFiles();
    return h;
  }

  it('aceptación: crea «📚 Base - Diccionario.base» y hebra_read_file lo lee igual, con el mismo sha256', async () => {
    const { call, callRaw, rawFiles } = await start();
    const created = await call('hebra_create_file', {
      name: BASE_NAME,
      text: BASE_YAML,
      operationId: 'op-base'
    });
    expect(created).toEqual({
      isError: false,
      value: {
        id: expect.any(String),
        name: BASE_NAME,
        folderPath: '',
        sha256: sha256(BASE_YAML),
        byteLength: Buffer.byteLength(BASE_YAML),
        mimeType: 'text/yaml',
        outcome: 'saved',
        sync: 'not_linked'
      }
    });
    const id = created.value.id as string;
    const row = rawFiles().find((entry) => entry.id === id)!;
    expect(row).toMatchObject({ name: BASE_NAME, folderId: 'root', sha256: sha256(BASE_YAML) });

    const read = await callRaw('hebra_read_file', { id });
    expect(read.isError).not.toBe(true);
    const meta = JSON.parse((read.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(meta).toMatchObject({ id, name: BASE_NAME, mimeType: 'text/yaml', sha256: sha256(BASE_YAML) });
    // Sin BOM ni nada añadido: los bytes son el texto tal cual.
    expect((read.content[1] as { text: string }).text).toBe(BASE_YAML);

    const listed = (await call('hebra_list_files', { name: 'Diccionario' })).value.files as Array<{ id: string }>;
    expect(listed.map((entry) => entry.id)).toEqual([id]);
  });

  it('en una carpeta por ruta o por id; el tipo sale de la extensión, sin distinguir mayúsculas', async () => {
    const { call, test } = await start();
    const byPath = await call('hebra_create_file', {
      folder: 'Proyectos/Lumbre',
      name: 'datos.JSON',
      text: '{"a": 1}',
      operationId: 'op-json'
    });
    expect(byPath.value).toMatchObject({
      name: 'datos.JSON',
      folderPath: 'proyectos/lumbre',
      mimeType: 'application/json',
      outcome: 'saved'
    });
    const byId = await call('hebra_create_file', {
      folderId: test.library.folders.proyectos,
      name: 'tabla.csv',
      text: 'a,b\n1,2\n',
      operationId: 'op-csv'
    });
    expect(byId.value).toMatchObject({ folderPath: 'proyectos', mimeType: 'text/csv' });
    for (const [name, mimeType] of [
      ['notas.txt', 'text/plain'],
      ['config.yml', 'text/yaml'],
      ['config.yaml', 'text/yaml']
    ] as const) {
      const result = await call('hebra_create_file', { name, text: 'x: 1\n', operationId: `op-${name}` });
      expect(result.value, name).toMatchObject({ name, mimeType, outcome: 'saved' });
    }
    // Un .json que no se lee como JSON se guarda igual, y se lee como texto plano.
    const loose = await call('hebra_create_file', { name: 'roto.json', text: '{', operationId: 'op-roto' });
    expect(loose.value).toMatchObject({ outcome: 'saved', mimeType: 'text/plain' });
    // El nombre se recorta.
    const trimmed = await call('hebra_create_file', { name: '  espacios.txt  ', text: '', operationId: 'op-sp' });
    expect(trimmed.value).toMatchObject({ name: 'espacios.txt', byteLength: 0 });
  });

  it('solo .base, .yaml, .yml, .json, .csv o .txt: un .md o cualquier otra, file_type_not_allowed, sin escribir', async () => {
    const { call, rawFiles } = await start();
    const before = rawFiles();
    for (const name of ['Nota.md', 'foto.png', 'doc.pdf', 'Sin extension', 'script.base.js']) {
      expect(await call('hebra_create_file', { name, text: 'x', operationId: `op-${name}` }), name).toEqual({
        isError: true,
        value: { error: 'file_type_not_allowed' }
      });
    }
    expect(rawFiles()).toEqual(before);
  });

  it('nombre y texto inválidos: invalid_input; texto de más, file_too_large con su tamaño', async () => {
    const { call, rawFiles } = await start();
    const before = rawFiles();
    const invalid = { isError: true, value: { error: 'invalid_input' } };
    for (const name of ['', '   ', '.base', 'a/b.base', 'a|b.base', 'a#b.base', '[a].base', 'a\nb.base', `${'x'.repeat(251)}.base`]) {
      expect(await call('hebra_create_file', { name, text: 'x', operationId: 'op-n' }), JSON.stringify(name)).toEqual(invalid);
    }
    for (const text of ['con\u0000nul', 'suplente \ud800 suelto', '%PDF-1.4\n%prueba\n', 'GIF89a y un texto']) {
      expect(await call('hebra_create_file', { name: 'x.txt', text, operationId: 'op-t' }), JSON.stringify(text)).toEqual(invalid);
    }
    expect(await call('hebra_create_file', { name: 'x.txt', text: 'x', operationId: '' })).toEqual(invalid);
    expect(
      await call('hebra_create_file', { name: 'x.txt', text: 'x', operationId: 'o'.repeat(201) })
    ).toEqual(invalid);
    expect(
      await call('hebra_create_file', { folder: 'Proyectos', folderId: 'root', name: 'x.txt', text: 'x', operationId: 'op-2' })
    ).toEqual(invalid);
    expect(
      await call('hebra_create_file', { name: 'grande.txt', text: 'ñ'.repeat(500_001), operationId: 'op-big' })
    ).toEqual({ isError: true, value: { error: 'file_too_large', byteLength: 1_000_002, maxBytes: 1_000_000 } });
    expect(rawFiles()).toEqual(before);
    // 1 000 000 bytes justos sí.
    const max = await call('hebra_create_file', { name: 'justo.txt', text: 'a'.repeat(1_000_000), operationId: 'op-max' });
    expect(max.value).toMatchObject({ outcome: 'saved', byteLength: 1_000_000 });
  });

  it('nombre repetido en la carpeta (sin distinguir mayúsculas): file_exists con el id del que ya está', async () => {
    const { call, rawFiles, test, engineFile } = await start();
    const before = rawFiles();
    expect(
      await call('hebra_create_file', { name: 'INVENTARIO.base', text: 'x: 1\n', operationId: 'op-dup' })
    ).toEqual({ isError: true, value: { error: 'file_exists', id: test.library.files.inventario } });
    // Uno en la papelera no cuenta (no está vivo), ni uno de otra carpeta.
    expect(
      (await call('hebra_create_file', { name: 'Borrador tirado.txt', text: 'x', operationId: 'op-t' })).value
    ).toMatchObject({ outcome: 'saved' });
    const other = await call('hebra_create_file', {
      folder: 'Proyectos',
      name: FILE_NAMES.inventario,
      text: 'x: 2\n',
      operationId: 'op-otra'
    });
    expect(other.value).toMatchObject({ outcome: 'saved', folderPath: 'proyectos' });
    // La forma de una tilde (NFD frente a NFC) tampoco distingue.
    const nfc = await engineFile(null, 'Canción.txt', 'la');
    expect(
      await call('hebra_create_file', { name: 'Canción.txt', text: 'x', operationId: 'op-nfd' })
    ).toEqual({ isError: true, value: { error: 'file_exists', id: nfc } });
    expect(rawFiles().length).toBe(before.length + 3);
  });

  it('carpeta inexistente: not_found, por ruta y por id', async () => {
    const { call } = await start();
    const notFound = { isError: true, value: { error: 'not_found' } };
    expect(await call('hebra_create_file', { folder: 'No/Existe', name: 'x.txt', text: 'x', operationId: 'op-1' })).toEqual(notFound);
    expect(await call('hebra_create_file', { folderId: 'no-existe', name: 'x.txt', text: 'x', operationId: 'op-2' })).toEqual(notFound);
  });

  it('idempotente: el mismo operationId con la misma petición devuelve lo anotado; con otra, operation_id_reused', async () => {
    const { call, rawFiles } = await start();
    const args = { name: 'Una.base', text: BASE_YAML, operationId: 'op-idem' };
    const first = await call('hebra_create_file', args);
    const count = rawFiles().length;
    const again = await call('hebra_create_file', args);
    expect(again).toEqual({ isError: false, value: { ...first.value, replayed: true } });
    expect(rawFiles().length).toBe(count);
    expect(await call('hebra_create_file', { ...args, text: 'otra: cosa\n' })).toEqual({
      isError: true,
      value: { error: 'operation_id_reused' }
    });
    expect(await call('hebra_rename_file', { id: first.value.id, name: 'Otra.base', operationId: 'op-idem' })).toEqual({
      isError: true,
      value: { error: 'operation_id_reused' }
    });
    expect(rawFiles().length).toBe(count);
  });
});
