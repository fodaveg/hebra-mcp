/**
 * Privacidad de crear, renombrar, mover y duplicar ficheros sueltos (D17, 12 oct 2026;
 * SPEC.md §6.3), sobre la biblioteca de prueba: `Diario` y `Diario/2026` privadas,
 * `secreto` etiqueta privada, y los ficheros ocultos de D10 (por carpeta, por referencia por
 * nombre, por hash y desde una nota bloqueada). Lo que se comprueba:
 * - un destino oculto responde EXACTAMENTE como uno inexistente, también el que solo oculta
 *   la memoria de carpetas privadas de D16;
 * - un resultado que quedaría oculto (lo enlaza una nota oculta por nombre o por hash, o hay
 *   una nota bloqueada oculta) se rechaza sin escribir;
 * - un homónimo oculto nunca da `file_exists`;
 * - un origen oculto es `not_found`, igual que uno inexistente, una lápida o una nota;
 * - el escritor lo vuelve a comprobar dentro de su turno, aunque la herramienta no lo haga;
 * - la idempotencia (repetición y `operation_id_reused`) y un reintento de algo ya oculto;
 * - el reenvío lector→escritor por `writer.sock`, con la privacidad del lector.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PrivacyConfig } from '../../src/privacy';
import type { ServerContext } from '../../src/server/context';
import { buildRoutedWriteContext, RoutedStatusSource, writerSocketHandlers } from '../../src/server/forward';
import { registerTools } from '../../src/server/register-tools';
import { localWriteContext } from '../../src/server/serve';
import { LibraryInstance } from '../../src/sync/library-instance';
import { BAIT_FOLDER, createNote } from '../fixtures/test-library';
import { sha256, startLooseFiles, type LooseFilesHarness } from '../fixtures/loose-files';

const NOT_FOUND = { isError: true, value: { error: 'not_found' } };
const NAME_UNAVAILABLE = { isError: true, value: { error: 'file_name_unavailable' } };
const DEFAULT_CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };

let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

function stderrText(): string {
  return (stderrSpy!.mock.calls as unknown as [string][]).map(([line]) => String(line)).join('');
}

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy?.mockRestore();
  stderrSpy = undefined;
});

describe('ficheros sueltos, crear, renombrar, mover y duplicar (D17): privacidad', () => {
  let h: LooseFilesHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(options?: { lockedNote?: boolean }): Promise<LooseFilesHarness> {
    h = await startLooseFiles(undefined, options);
    return h;
  }

  it('un destino oculto (privada, subcarpeta) responde igual que uno inexistente, sin escribir', async () => {
    const { call, rawFiles, test } = await start();
    const { files, folders } = test.library;
    const before = rawFiles();
    const destinations: Array<Record<string, string>> = [
      { folder: 'Diario' },
      { folder: 'Diario/2026' },
      { folderId: folders.diario },
      { folderId: folders.diario2026 }
    ];
    const missing: Array<Record<string, string>> = [{ folder: 'No/Existe' }, { folderId: 'no-existe' }];
    for (const where of [...destinations, ...missing]) {
      const label = JSON.stringify(where);
      expect(
        await call('hebra_create_file', { ...where, name: 'Nueva.base', text: 'x: 1\n', operationId: `c-${label}` }),
        label
      ).toEqual(NOT_FOUND);
      expect(
        await call('hebra_move_file', { ...where, id: files.inventario, operationId: `m-${label}` }),
        label
      ).toEqual(NOT_FOUND);
      expect(
        await call('hebra_duplicate_file', { ...where, id: files.acta, name: 'Copia.pdf', operationId: `d-${label}` }),
        label
      ).toEqual(NOT_FOUND);
    }
    expect(rawFiles()).toEqual(before);
    // Ni en el log: la misma línea para el oculto y para el inexistente, sin ids ni rutas.
    expect(stderrText()).not.toContain(folders.diario);
    expect(stderrText()).not.toContain('Nueva.base');
  });

  it('la carpeta que solo oculta la memoria de carpetas privadas (D16) también responde como inexistente', async () => {
    const { call, rawFiles, test, withEngine } = await start();
    const { folders, files } = test.library;
    // Una llamada cualquiera anota a qué carpeta resolvió `diario`.
    await call('hebra_list_files', {});
    await withEngine(async (engine) => {
      await engine.folderMove(folders.diario, folders.historial);
      await engine.folderCreate(null, 'Diario');
    });
    const before = rawFiles();
    for (const where of [{ folder: 'Historial/Diario' }, { folderId: folders.diario }]) {
      const label = JSON.stringify(where);
      expect(
        await call('hebra_create_file', { ...where, name: 'Nueva.base', text: 'x', operationId: `c-${label}` }),
        label
      ).toEqual(NOT_FOUND);
      expect(await call('hebra_move_file', { ...where, id: files.acta, operationId: `m-${label}` }), label).toEqual(NOT_FOUND);
    }
    expect(rawFiles()).toEqual(before);
  });

  it('un nombre que enlaza una nota oculta: crear da file_name_unavailable y renombrar o duplicar not_found, sin escribir', async () => {
    const { call, rawFiles, test, withEngine } = await start();
    await withEngine((engine) =>
      createNote(engine, null, '# Plan secreto\n#secreto\n\nLa vista: ![[Oculta.base]]\n')
    );
    const before = rawFiles();
    expect(
      await call('hebra_create_file', { name: 'Oculta.base', text: 'views: []\n', operationId: 'op-c' })
    ).toEqual(NAME_UNAVAILABLE);
    expect(
      await call('hebra_rename_file', { id: test.library.files.inventario, name: 'Oculta.base', operationId: 'op-r' })
    ).toEqual(NOT_FOUND);
    expect(
      await call('hebra_duplicate_file', { id: test.library.files.inventario, name: 'Oculta.base', operationId: 'op-d' })
    ).toEqual(NOT_FOUND);
    // Una nota de la papelera oculta cuenta igual (por etiqueta, la de la papelera).
    await withEngine(async (engine) => {
      const note = await createNote(engine, null, '# Tirada\n#secreto\n\n![[Tirada.base]]\n');
      await engine.noteTrash(note.id);
    });
    expect(
      await call('hebra_create_file', { name: 'Tirada.base', text: 'x', operationId: 'op-c2' })
    ).toEqual(NAME_UNAVAILABLE);
    expect(rawFiles()).toEqual(before);
    // El mismo nombre, enlazado solo desde una nota VISIBLE, se crea sin más.
    await withEngine((engine) => createNote(engine, null, '# Plan público\n\n![[Visible.base]]\n'));
    expect((await call('hebra_create_file', { name: 'Visible.base', text: 'x', operationId: 'op-v' })).value).toMatchObject({
      outcome: 'saved'
    });
  });

  it('unos bytes que una nota oculta adjunta por hash: crear con ese texto da file_name_unavailable', async () => {
    const { call, rawFiles } = await start();
    const before = rawFiles();
    // Los bytes del adjunto de la nota de `Diario/2026` (`privateAttachmentSha`).
    const text = `${BAIT_FOLDER} en un adjunto privado\n`;
    expect(await call('hebra_create_file', { name: 'Copia.txt', text, operationId: 'op-h' })).toEqual(NAME_UNAVAILABLE);
    expect(rawFiles()).toEqual(before);
  });

  it('un homónimo OCULTO nunca da file_exists: se crea al lado; uno oculto por el nombre, file_name_unavailable', async () => {
    const { call, rawFiles, test } = await start();
    const hiddenByHash = rawFiles().find((row) => row.id === test.library.files.referencedByHash)!;
    const created = await call('hebra_create_file', {
      name: hiddenByHash.name,
      text: 'otro contenido, visible',
      operationId: 'op-homo'
    });
    expect(created.value).toMatchObject({ outcome: 'saved', name: hiddenByHash.name, folderPath: '' });
    expect(created.value.id).not.toBe(test.library.files.referencedByHash);
    // Mover uno visible a su lado tampoco choca: Diario es privada, así que se prueba en la
    // raíz con un duplicado de nombre igual al oculto.
    const dup = await call('hebra_duplicate_file', {
      id: created.value.id,
      name: hiddenByHash.name.toUpperCase(),
      folder: 'Proyectos',
      operationId: 'op-homo-dup'
    });
    expect(dup.value).toMatchObject({ outcome: 'saved' });
    // El oculto por NOMBRE (lo incrusta la nota de etiqueta privada) no da `file_exists`
    // con su id: crear ese nombre lo dejaría oculto también.
    const hiddenByName = rawFiles().find((row) => row.id === test.library.files.referencedByName)!;
    const renamed = await call('hebra_rename_file', {
      id: test.library.files.acta,
      name: hiddenByName.name.replace(/\.png$/, '.pdf'),
      operationId: 'op-homo-name'
    });
    expect(renamed.value).toMatchObject({ outcome: 'saved' });
    const text = JSON.stringify([created, dup, renamed]);
    for (const id of [test.library.files.referencedByHash, test.library.files.referencedByName]) {
      expect(text).not.toContain(id);
    }
  });

  it('con una nota bloqueada oculta, crear un fichero que se puede incrustar por nombre es file_name_unavailable', async () => {
    const { call, rawFiles } = await start({ lockedNote: true });
    const before = rawFiles();
    for (const name of ['Nueva.base', 'datos.json', 'tabla.csv', 'notas.txt']) {
      expect(await call('hebra_create_file', { name, text: 'x', operationId: `op-${name}` }), name).toEqual(
        NAME_UNAVAILABLE
      );
    }
    expect(rawFiles()).toEqual(before);
  });

  it('un origen oculto es not_found, igual que uno inexistente, una lápida, una nota o uno de la papelera', async () => {
    const { call, rawFiles, test } = await start();
    const { files } = test.library;
    const before = rawFiles();
    const targets = [
      files.privateFolder,
      files.referencedByHash,
      files.referencedByName,
      files.referencedByLockedNote,
      files.trashedPrivateFolder,
      files.trashedDeletedPrivateFolder,
      files.tombstone,
      files.trashed,
      test.library.privateFolderNoteId,
      'no-existe'
    ];
    for (const id of targets) {
      expect(await call('hebra_rename_file', { id, name: 'x.pdf', operationId: `r-${id}` }), id).toEqual(NOT_FOUND);
      expect(await call('hebra_move_file', { id, folder: 'Proyectos', operationId: `m-${id}` }), id).toEqual(NOT_FOUND);
      expect(await call('hebra_duplicate_file', { id, name: 'x.pdf', operationId: `d-${id}` }), id).toEqual(NOT_FOUND);
    }
    expect(rawFiles()).toEqual(before);
    for (const id of targets) expect(stderrText()).not.toContain(id);
  });

  it('el escritor lo vuelve a comprobar en su turno aunque la herramienta no lo haga', async () => {
    const { test, rawFiles, withEngine } = await start();
    await withEngine((engine) => createNote(engine, null, '# Oculta\n#secreto\n\n![[Escondida.base]]\n'));
    const write = test.serverContext.write!.looseFileWrite!;
    const before = rawFiles();
    const rejected = async (input: Parameters<typeof write>[0]) =>
      write(input).then(
        () => 'escrito',
        (error: { code?: string }) => error.code
      );
    const privacy = DEFAULT_CONFIG;
    const { files, folders } = test.library;
    expect(await rejected({ action: 'createFile', folderId: folders.diario, name: 'a.base', text: 'x', operationId: 'w1', privacy })).toBe('not_found');
    expect(await rejected({ action: 'createFile', folderId: 'root', name: 'Escondida.base', text: 'x', operationId: 'w2', privacy })).toBe('file_name_unavailable');
    expect(await rejected({ action: 'renameFile', id: files.privateFolder, name: 'a.base', operationId: 'w3', privacy })).toBe('not_found');
    expect(await rejected({ action: 'renameFile', id: files.inventario, name: 'Escondida.base', operationId: 'w4', privacy })).toBe('not_found');
    expect(await rejected({ action: 'moveFile', id: files.inventario, folderId: folders.diario2026, operationId: 'w5', privacy })).toBe('not_found');
    expect(await rejected({ action: 'moveFile', id: files.referencedByHash, folderId: 'root', operationId: 'w6', privacy })).toBe('not_found');
    expect(await rejected({ action: 'duplicateFile', id: files.referencedByName, name: 'b.png', operationId: 'w7', privacy })).toBe('not_found');
    expect(
      await rejected({ action: 'createFile', folderId: 'root', name: 'a.base', text: 'x', operationId: 'w8', privacy: { privateFolders: [['no-existe']], privateTags: [] } })
    ).toBe('privacy_config_unresolved');
    expect(rawFiles()).toEqual(before);
  });

  it('idempotencia: repetición con replayed, otra petición operation_id_reused, y un reintento de algo ya oculto es not_found', async () => {
    const { call, rawFiles, withEngine } = await start();
    const args = { name: 'Temporal.base', text: 'views: []\n', operationId: 'op-idem' };
    const first = await call('hebra_create_file', args);
    expect(first.value).toMatchObject({ outcome: 'saved' });
    expect(await call('hebra_create_file', args)).toEqual({ isError: false, value: { ...first.value, replayed: true } });
    expect(await call('hebra_create_file', { ...args, name: 'Otro.base' })).toEqual({
      isError: true,
      value: { error: 'operation_id_reused' }
    });
    // Una nota oculta pasa a incrustarlo: el reintento ya no lo enseña.
    await withEngine((engine) => createNote(engine, null, '# Ahora oculta\n#secreto\n\n![[Temporal.base]]\n'));
    const count = rawFiles().length;
    expect(await call('hebra_create_file', args)).toEqual(NOT_FOUND);
    // Y un `operationId` de algo ya oculto cuenta como nunca usado (C12): no delata nada.
    const reused = await call('hebra_create_file', { ...args, name: 'Distinto.base' });
    expect(reused.value).toMatchObject({ outcome: 'saved', name: 'Distinto.base' });
    expect(rawFiles().length).toBe(count + 1);
    expect(JSON.stringify(reused)).not.toContain(first.value.id as string);
  });
});

describe('reenvío lector→escritor (D17)', () => {
  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  const instances: LibraryInstance[] = [];
  const clients: Array<{ client: Client; server: McpServer }> = [];

  afterEach(async () => {
    for (const { client, server } of clients.splice(0)) {
      await client.close();
      await server.close();
    }
    for (const instance of instances.splice(0)) await instance.close();
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function connect(ctx: ServerContext): Promise<Client> {
    const server = new McpServer({ name: 'hebra-mcp-verbos-fwd', version: '0.0.0' });
    registerTools(server, ctx);
    const client = new Client({ name: 'hebra-mcp-verbos-fwd-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    clients.push({ client, server });
    return client;
  }

  it('hebra_create_file desde un lector: lo crea el escritor, con su registro, y file_exists cruza el socket con el id', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hebra-mcp-verbos-fwd-'));
    dirs.push(dataDir);
    const writer = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false },
      writerSocket: (opened) => writerSocketHandlers(localWriteContext(opened), opened)
    });
    instances.push(writer);
    // Un proceso vivo declara el bloqueo del lector: no puede tomarlo y reenvía.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    const reader = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false, pid: child.pid! }
    });
    instances.push(reader);
    expect(reader.role).toBe('other_instance');
    const open: PrivacyConfig = { privateFolders: [], privateTags: [] };
    const routedWrite = buildRoutedWriteContext(reader, localWriteContext(reader));
    const client = await connect({
      port: reader.port,
      privacyConfig: open,
      status: new RoutedStatusSource(reader, false),
      write: routedWrite
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return {
        isError: result.isError === true,
        value: JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
      };
    };

    const yaml = 'views:\n  - type: table\n    name: Reenviada\n';
    const args = { name: 'Reenviada.base', text: yaml, operationId: 'op-fwd' };
    const created = await call('hebra_create_file', args);
    expect(created).toEqual({
      isError: false,
      value: {
        id: expect.any(String),
        name: 'Reenviada.base',
        folderPath: '',
        sha256: sha256(yaml),
        byteLength: Buffer.byteLength(yaml),
        mimeType: 'text/yaml',
        outcome: 'saved',
        sync: 'not_linked'
      }
    });
    const onWriter = (await writer.port.filesIndex()).files.map((file) => file.id);
    expect(onWriter).toEqual([created.value.id]);
    // El reintento lo sirve el registro del escritor.
    expect(await call('hebra_create_file', args)).toEqual({ isError: false, value: { ...created.value, replayed: true } });
    // Otro operationId con el mismo nombre: file_exists, con el id, por el socket.
    expect(await call('hebra_create_file', { ...args, operationId: 'op-fwd-2' })).toEqual({
      isError: true,
      value: { error: 'file_exists', id: created.value.id }
    });
    expect(await call('hebra_create_file', { ...args, text: 'otro' })).toEqual({
      isError: true,
      value: { error: 'operation_id_reused' }
    });
    // Renombrar, mover y duplicar también van al escritor.
    const folder = await call('hebra_create_folder', { name: 'Docs' });
    expect(folder.isError).toBe(false);
    const moved = await call('hebra_move_file', { id: created.value.id, folder: 'Docs', operationId: 'op-fwd-m' });
    expect(moved.value).toMatchObject({ outcome: 'saved', folderPath: 'docs' });

    // La privacidad del LECTOR viaja y la aplica el escritor dentro del turno.
    const docs = folder.value.id as string;
    const privateDocs = await routedWrite.looseFileWrite!({
      action: 'createFile',
      folderId: docs,
      name: 'Secreta.base',
      text: 'x',
      operationId: 'op-fwd-priv',
      privacy: { privateFolders: [['docs']], privateTags: [] }
    }).catch((error: unknown) => error);
    expect(privateDocs).toMatchObject({ code: 'not_found' });
    const unresolved = await routedWrite.looseFileWrite!({
      action: 'renameFile',
      id: created.value.id as string,
      name: 'Otra.base',
      operationId: 'op-fwd-unres',
      privacy: { privateFolders: [['no-existe']], privateTags: [] }
    }).catch((error: unknown) => error);
    expect(unresolved).toMatchObject({ code: 'privacy_config_unresolved' });
    expect((await writer.port.filesIndex()).files.map((file) => file.name)).toEqual(['Reenviada.base']);

    expect(stderrText()).toContain('"event":"write.forward","op":"looseFileWrite","outcome":"forwarded"');
    expect(stderrText()).not.toContain('Reenviada');
  });
});
