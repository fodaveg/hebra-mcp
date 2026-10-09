import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { NO_PRIVATE } from '../fixtures/no-private';
import { BAIT_FOLDER, BAIT_TAG, FILE_NAMES } from '../fixtures/test-library';
import { FORBIDDEN_FILE_TOOLS, TOOL_NAMES } from '../fixtures/tool-names';
import { resolveToolContext, type ToolContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import { wrapCursor } from '../../src/server/pagination';
import { registerTools } from '../../src/server/register-tools';
import { runListFiles, runRestoreFile, runTrashFile } from '../../src/server/tools/files';
import { runListFolders } from '../../src/server/tools/list-folders';
import { runListTrash } from '../../src/server/tools/list-trash';
import { SqliteLibraryEngine } from '../../src/hebra';
import { PrivacyFilter, type PrivacyConfig } from '../../src/privacy';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { FsBlobStore } from '../../src/store/blob-store-fs';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { NoteWriter, type OrganizeFileActionName } from '../../src/store/writes';

/**
 * Ficheros sueltos (D10, decisión de David del 9 oct 2026) sobre la biblioteca de prueba:
 * `Diario` y `Diario/2026` privadas, `secreto` etiqueta privada. Vivos y visibles:
 * `Acta.pdf` e `Inventario.base` en la raíz y `plano.pdf` en `Proyectos/Lumbre`. Ocultos:
 * uno en `Diario/2026` (por carpeta), uno en la raíz con los bytes del adjunto de una nota
 * privada (por referencia, por hash) y otro en la raíz que la nota de etiqueta privada
 * incrusta por nombre. En la papelera: uno de la raíz y uno de `Proyectos/Antiguo`
 * (carpeta pública borrada), visibles; uno de `Diario/2026` y uno de `Diario/Viejo`
 * (carpeta privada borrada), ocultos. Y una lápida. Sin sync: `sync: "not_linked"`.
 */

const BOTH_ACTIONS: readonly OrganizeFileActionName[] = ['trashFile', 'restoreFile'];

interface RawFileRow {
  id: string;
  localSeq: number;
  dirty: number;
  trashedAt: number | null;
  deleted: number;
}

/** Las filas de `files` tal como están en disco, por otra conexión de solo lectura: lo
 *  que ninguna herramienta enseña (`local_seq`, `dirty`, las lápidas). */
function rawFiles(sqlitePath: string): RawFileRow[] {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    return (
      db
        .prepare('SELECT id, local_seq, dirty, trashed_at, deleted FROM files ORDER BY id')
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      id: String(row.id),
      localSeq: Number(row.local_seq),
      dirty: Number(row.dirty),
      trashedAt: row.trashed_at === null ? null : Number(row.trashed_at),
      deleted: Number(row.deleted)
    }));
  } finally {
    db.close();
  }
}

describe('ficheros sueltos', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  /** Contexto con el filtro recalculado AHORA (el de `test.ctx` es del arranque). */
  function fresh(privacyConfig?: PrivacyConfig): Promise<ToolContext> {
    return resolveToolContext(
      privacyConfig ? { ...test!.serverContext, privacyConfig } : test!.serverContext
    );
  }

  function rowOf(id: string): RawFileRow {
    const row = rawFiles(test!.sqlitePath).find((entry) => entry.id === id);
    if (!row) throw new Error(`sin fila de fichero ${id}`);
    return row;
  }

  async function expectError(promise: Promise<unknown>, code: string): Promise<void> {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe(code);
    expect((error as ToolError).extra).toBeUndefined();
  }

  async function ids(input: Parameters<typeof runListFiles>[1] = {}): Promise<string[]> {
    return (await runListFiles(await fresh(), input)).files.map((file) => file.id);
  }

  /** Ocultos por carpeta o por referencia, vivos y de la papelera. */
  function hiddenFiles(): string[] {
    const { files } = test!.library;
    return [
      files.privateFolder,
      files.referencedByHash,
      files.referencedByName,
      files.referencedByLockedNote,
      files.trashedPrivateFolder,
      files.trashedDeletedPrivateFolder
    ];
  }

  /** Ids que no son de un fichero suelto que exista: inexistente, lápida, una nota
   *  visible, una oculta, el SHA-256 de un adjunto visible y el de uno oculto, y una
   *  carpeta. */
  function notFiles(): string[] {
    const library = test!.library;
    return [
      'no-existe',
      library.files.tombstone,
      library.publicNoteId,
      library.privateFolderNoteId,
      library.attachments.png,
      library.privateAttachmentSha,
      library.folders.lumbre,
      'root'
    ];
  }

  it('hebra_list_files: solo los visibles, por nombre, sin recuento, sin hash y sin la carpeta guardada', async () => {
    test = await buildTestContext();
    const { files } = test.library;
    const result = await runListFiles(await fresh(), {});
    expect(Object.keys(result).sort()).toEqual(['files', 'nextCursor']);
    expect(result.nextCursor).toBeNull();
    expect(result.files.map((file) => file.id)).toEqual([files.acta, files.inventario, files.plano]);
    expect(result.files[0]).toEqual({
      id: files.acta,
      name: FILE_NAMES.acta,
      folderPath: '',
      mimeType: 'application/pdf',
      byteLength: Buffer.byteLength('acta de la reunión'),
      updatedAt: expect.any(String),
      trashedAt: null
    });
    expect(result.files[1]).toMatchObject({ name: FILE_NAMES.inventario, folderPath: '' });
    expect(result.files[2]).toMatchObject({ name: FILE_NAMES.plano, folderPath: 'proyectos/lumbre' });
    for (const file of result.files) {
      expect(Object.keys(file).sort()).toEqual(
        ['byteLength', 'folderPath', 'id', 'mimeType', 'name', 'trashedAt', 'updatedAt'].sort()
      );
      expect(Number.isNaN(Date.parse(file.updatedAt))).toBe(false);
    }
    const text = JSON.stringify(result);
    expect(text).not.toContain(BAIT_FOLDER);
    expect(text).not.toContain(BAIT_TAG);
    expect(text.toLowerCase()).not.toContain('diario');
    expect(text).not.toContain(test.library.privateAttachmentSha);
  });

  it('hebra_list_files con trashed: los de la papelera visibles, con la carpeta a la que volverían', async () => {
    test = await buildTestContext();
    const { files } = test.library;
    const result = await runListFiles(await fresh(), { trashed: true, limit: 100 });
    expect(result.nextCursor).toBeNull();
    const byId = new Map(result.files.map((file) => [file.id, file]));
    expect([...byId.keys()].sort()).toEqual([files.trashed, files.trashedDeletedPublicFolder].sort());
    expect(byId.get(files.trashed)).toMatchObject({ name: FILE_NAMES.trashed, folderPath: '' });
    // Su carpeta se borró: vuelve a la raíz, como en Hebra.
    expect(byId.get(files.trashedDeletedPublicFolder)?.folderPath).toBe('');
    for (const file of result.files) {
      expect(file.trashedAt).not.toBeNull();
      expect(Number.isNaN(Date.parse(file.trashedAt!))).toBe(false);
    }
    const text = JSON.stringify(result);
    expect(text).not.toContain(BAIT_FOLDER);
    expect(text).not.toContain(BAIT_TAG);
    expect(text).not.toContain('viejo');
    // Ni los vivos salen en la papelera ni al revés.
    expect([...byId.keys()]).not.toContain(files.acta);
    expect(await ids()).not.toContain(files.trashed);
  });

  it('hebra_list_files pagina sin delatar los ocultos: la última página visible cierra con null', async () => {
    test = await buildTestContext();
    for (const trashed of [false, true]) {
      const all = await runListFiles(await fresh(), { trashed, limit: 100 });
      const visible = all.files.length;
      expect(visible).toBe(trashed ? 2 : 3);

      // Justo tantos como visibles: no hay página siguiente, aunque queden ocultos detrás
      // (el oculto por carpeta ordena el último por nombre).
      expect((await runListFiles(await fresh(), { trashed, limit: visible })).nextCursor).toBeNull();

      // De uno en uno: los mismos, en el mismo orden, y la última página no está vacía.
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const result = await runListFiles(await fresh(), {
          trashed,
          limit: 1,
          ...(cursor ? { cursor } : {})
        });
        expect(result.files).toHaveLength(1);
        seen.push(result.files[0]!.id);
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
      expect(seen).toEqual(all.files.map((file) => file.id));
    }
  });

  it('el cursor sobrevive a mandar a la papelera (o sacar) el último de la página', async () => {
    test = await buildTestContext();
    const { files } = test.library;
    const first = await runListFiles(await fresh(), { limit: 2 });
    expect(first.files.map((file) => file.id)).toEqual([files.acta, files.inventario]);
    expect(first.nextCursor).not.toBeNull();

    // El uso previsto: listar, mandar a la papelera el último de la página y seguir.
    await runTrashFile(await fresh(), { id: files.inventario });
    const second = await runListFiles(await fresh(), { limit: 2, cursor: first.nextCursor! });
    expect(second.files.map((file) => file.id)).toEqual([files.plano]);
    expect(second.nextCursor).toBeNull();

    // Y en la papelera: sacar el de la página no rompe la siguiente.
    const trashAll = await runListFiles(await fresh(), { trashed: true, limit: 100 });
    expect(trashAll.files).toHaveLength(3);
    const page1 = await runListFiles(await fresh(), { trashed: true, limit: 1 });
    expect(page1.files[0]!.id).toBe(trashAll.files[0]!.id);
    await runRestoreFile(await fresh(), { id: page1.files[0]!.id });
    const page2 = await runListFiles(await fresh(), {
      trashed: true,
      limit: 1,
      cursor: page1.nextCursor!
    });
    expect(page2.files.map((file) => file.id)).toEqual([trashAll.files[1]!.id]);
    expect(page2.nextCursor).not.toBeNull();
  });

  it('folder: una carpeta privada y una inexistente dan la misma lista vacía; las visibles filtran', async () => {
    test = await buildTestContext();
    const { files } = test.library;
    const empty = { files: [], nextCursor: null };
    for (const folder of ['Diario', 'Diario/2026', 'diario/viejo', 'Proyectos/Antiguo', 'No existe']) {
      for (const trashed of [false, true]) {
        for (const subfolders of [false, true]) {
          expect(await runListFiles(await fresh(), { folder, subfolders, trashed })).toEqual(empty);
        }
      }
    }
    expect(await ids({ folder: 'Proyectos/Lumbre' })).toEqual([files.plano]);
    expect(await ids({ folder: 'Proyectos' })).toEqual([]);
    expect(await ids({ folder: 'Proyectos', subfolders: true })).toEqual([files.plano]);
    expect(await ids({ folder: '' })).toEqual([files.acta, files.inventario]);
    expect(await ids({ folder: '', subfolders: true })).toEqual([
      files.acta,
      files.inventario,
      files.plano
    ]);
    // En la papelera, `folder` es la carpeta a la que volverían.
    expect((await ids({ folder: '', trashed: true })).sort()).toEqual(
      [files.trashed, files.trashedDeletedPublicFolder].sort()
    );
    expect(await ids({ folder: 'Proyectos', subfolders: true, trashed: true })).toEqual([]);
  });

  it('name: subcadena sin distinguir mayúsculas, nunca un oculto; fuera de 1 a 255, invalid_input', async () => {
    test = await buildTestContext();
    const { files } = test.library;
    expect(await ids({ name: 'PLANO' })).toEqual([files.plano]);
    expect(await ids({ name: '.pdf' })).toEqual([files.acta, files.plano]);
    expect(await ids({ name: 'inventario.BASE' })).toEqual([files.inventario]);
    for (const name of [BAIT_FOLDER, BAIT_TAG, 'cebo', 'zz-', 'importado', 'dibujo', 'purgado']) {
      expect(await ids({ name }), name).toEqual([]);
    }
    // En la papelera hay uno visible y uno oculto cuyo nombre contiene «tirado».
    expect(await ids({ name: 'tirado', trashed: true })).toEqual([files.trashed]);
    expect(await ids({ name: 'x'.repeat(255) })).toEqual([]);
    await expectError(runListFiles(await fresh(), { name: '' }), 'invalid_input');
    await expectError(runListFiles(await fresh(), { name: 'x'.repeat(256) }), 'invalid_input');
  });

  it('cursor ilegible, de otra herramienta o de la otra lista: invalid_input', async () => {
    test = await buildTestContext();
    const live = (await runListFiles(await fresh(), { limit: 1 })).nextCursor!;
    const trashed = (await runListFiles(await fresh(), { trashed: true, limit: 1 })).nextCursor!;
    const fromTrash = (await runListTrash(await fresh(), { limit: 1 })).nextCursor!;
    const fromFolders = (await runListFolders(await fresh(), { limit: 1 })).nextCursor!;
    expect(live.startsWith('fl1.')).toBe(true);
    for (const [cursor, isTrashed] of [
      ['basura', false],
      [fromTrash, true],
      [fromFolders, false],
      [live, true],
      [trashed, false],
      [wrapCursor('fl1', 'no es json'), false],
      [wrapCursor('fl1', JSON.stringify(['n', 3, 'x'])), false],
      [wrapCursor('fl1', JSON.stringify(['t', 'ayer', 'x'])), true],
      [wrapCursor('fl1', JSON.stringify(['n', 'a'])), false],
      [wrapCursor('fl1', JSON.stringify({ n: 'a' })), false],
      [wrapCursor('fl1', JSON.stringify(['n', 'a', 7])), false]
    ] as Array<[string, boolean]>) {
      await expectError(runListFiles(await fresh(), { cursor, trashed: isTrashed }), 'invalid_input');
    }
  });

  it('mandar a la papelera y sacar un fichero visible (a su carpeta), idempotentes', async () => {
    test = await buildTestContext();
    const id = test.library.files.plano;

    expect(await runTrashFile(await fresh(), { id })).toEqual({
      id,
      trashed: true,
      sync: 'not_linked'
    });
    expect(await ids({ limit: 100 })).not.toContain(id);
    const inTrash = (await runListFiles(await fresh(), { trashed: true, limit: 100 })).files.find(
      (file) => file.id === id
    );
    expect(inTrash).toMatchObject({ name: FILE_NAMES.plano, folderPath: 'proyectos/lumbre' });
    // Otra vez: se queda como está.
    expect(await runTrashFile(await fresh(), { id })).toEqual({ id, trashed: true, sync: 'not_linked' });

    expect(await runRestoreFile(await fresh(), { id })).toEqual({
      id,
      folderPath: 'proyectos/lumbre',
      sync: 'not_linked'
    });
    expect(await ids({ folder: 'Proyectos/Lumbre' })).toEqual([id]);
    expect(rowOf(id).trashedAt).toBeNull();
    // Otra vez: sigue vivo, sin error.
    expect(await runRestoreFile(await fresh(), { id })).toEqual({
      id,
      folderPath: 'proyectos/lumbre',
      sync: 'not_linked'
    });
  });

  it('restaurar un fichero cuya carpeta se borró lo deja en la raíz', async () => {
    test = await buildTestContext();
    const id = test.library.files.trashedDeletedPublicFolder;
    expect(await runRestoreFile(await fresh(), { id })).toEqual({
      id,
      folderPath: '',
      sync: 'not_linked'
    });
    expect(await ids({ folder: '' })).toContain(id);
    expect(await ids({ trashed: true, limit: 100 })).not.toContain(id);
  });

  it('oculto, inexistente, lápida, id de nota o de carpeta y SHA: el mismo not_found, sin escribir', async () => {
    test = await buildTestContext();
    const before = rawFiles(test.sqlitePath);
    for (const id of [...hiddenFiles(), ...notFiles()]) {
      await expectError(runTrashFile(await fresh(), { id }), 'not_found');
      await expectError(runRestoreFile(await fresh(), { id }), 'not_found');
    }
    expect(rawFiles(test.sqlitePath)).toEqual(before);
  });

  it('la herramienta rechaza un oculto ANTES de llegar al escritor', async () => {
    test = await buildTestContext();
    // Un escritor que anota cada petición: para un oculto no tiene que recibir ninguna
    // (si la herramienta no filtrara, la pararía el escritor y no se notaría la falta).
    const reached: string[] = [];
    const write = {
      ...test.ctx.write!,
      organizeFile: (input: { id: string }) => {
        reached.push(input.id);
        return Promise.reject(new Error('la herramienta dejó pasar un oculto'));
      }
    };
    for (const id of [...hiddenFiles(), ...notFiles()]) {
      await expectError(runTrashFile({ ...(await fresh()), write }, { id }), 'not_found');
      await expectError(runRestoreFile({ ...(await fresh()), write }, { id }), 'not_found');
    }
    expect(reached).toEqual([]);
    // Uno visible sí llega.
    await runTrashFile({ ...(await fresh()), write }, { id: test.library.files.acta }).catch(
      () => undefined
    );
    expect(reached).toEqual([test.library.files.acta]);
  });

  it('el escritor rechaza un oculto aunque la petición se salte la herramienta', async () => {
    test = await buildTestContext();
    const before = rawFiles(test.sqlitePath);
    for (const id of [...hiddenFiles(), ...notFiles()]) {
      for (const action of BOTH_ACTIONS) {
        const error = await test.ctx
          .write!.organizeFile({ action, id, privacy: test.ctx.privacyConfig })
          .catch((caught: unknown) => caught);
        expect(error, `${action} ${id}`).toMatchObject({ code: 'not_found' });
      }
    }
    expect(rawFiles(test.sqlitePath)).toEqual(before);

    // Lo que lo para es el filtro del turno, con la configuración de quien pide: sin
    // privados configurados, el mismo id sí es un fichero que se puede mandar.
    const id = test.library.files.privateFolder;
    expect(
      await test.ctx.write!.organizeFile({ action: 'trashFile', id, privacy: NO_PRIVATE })
    ).toMatchObject({ id, trashed: true });
    // Y una configuración que no se puede aplicar, cerrado ante la duda.
    const unresolved = await test.ctx
      .write!.organizeFile({
        action: 'restoreFile',
        id,
        privacy: { privateFolders: [['no-existe']], privateTags: [] }
      })
      .catch((caught: unknown) => caught);
    expect(unresolved).toMatchObject({ code: 'privacy_config_unresolved' });
    expect(rowOf(id).trashedAt).not.toBeNull();
  });

  it('restaurar nunca deja un fichero en una carpeta que el cliente no ve', async () => {
    test = await buildTestContext();
    const id = test.library.files.plano;
    await runTrashFile(await fresh(), { id });

    // Su carpeta (`Proyectos/Lumbre`) pasa a ser privada: ya no se puede sacar, ni por la
    // herramienta ni saltándosela, y sigue en la papelera.
    const stricter: PrivacyConfig = {
      privateFolders: [['diario'], ['proyectos']],
      privateTags: ['secreto']
    };
    await expectError(runRestoreFile(await fresh(stricter), { id }), 'not_found');
    const direct = await test.ctx
      .write!.organizeFile({ action: 'restoreFile', id, privacy: stricter })
      .catch((caught: unknown) => caught);
    expect(direct).toMatchObject({ code: 'not_found' });
    expect(rowOf(id).trashedAt).not.toBeNull();

    // Y todo lo que con esa configuración SÍ se ve en la papelera vuelve exactamente a la
    // carpeta que la lista anunciaba, que es visible.
    const listed = await runListFiles(await fresh(stricter), { trashed: true, limit: 100 });
    expect(listed.files.map((file) => file.id)).not.toContain(id);
    expect(listed.files.length).toBeGreaterThan(0);
    for (const file of listed.files) {
      const restored = await runRestoreFile(await fresh(stricter), { id: file.id });
      expect(restored.folderPath).toBe(file.folderPath);
      const after = await fresh(stricter);
      const folderId = after.privacy.folderIdForPath(restored.folderPath);
      expect(folderId).toBeDefined();
      expect(after.privacy.isFolderHidden(folderId!)).toBe(false);
    }
  });

  it('repetir no ensucia: ni sube local_seq, ni marca la fila, ni llama al motor', async () => {
    test = await buildTestContext();
    const { files } = test.library;
    const writer = new NoteWriter(test.ctx.port as NodeLibraryPort);
    const privacy = test.ctx.privacyConfig;

    const id = files.acta;
    const initial = rowOf(id);
    await runTrashFile(await fresh(), { id });
    const trashed = rowOf(id);
    expect(trashed.localSeq).toBe(initial.localSeq + 1);
    expect(trashed.trashedAt).not.toBeNull();
    await runTrashFile(await fresh(), { id });
    await runTrashFile(await fresh(), { id });
    expect(await writer.organizeFileLocal({ action: 'trashFile', id, privacy })).toEqual({
      result: { id, folderId: 'root', trashed: true },
      wrote: false
    });
    expect(rowOf(id)).toEqual(trashed);

    await runRestoreFile(await fresh(), { id });
    const restored = rowOf(id);
    expect(restored.localSeq).toBe(trashed.localSeq + 1);
    expect(restored.trashedAt).toBeNull();
    await runRestoreFile(await fresh(), { id });
    await runRestoreFile(await fresh(), { id });
    expect(await writer.organizeFileLocal({ action: 'restoreFile', id, privacy })).toEqual({
      result: { id, folderId: 'root', trashed: false },
      wrote: false
    });
    expect(rowOf(id)).toEqual(restored);

    // Uno que ya estaba así desde el principio no se toca nunca.
    const live = rowOf(files.inventario);
    await runRestoreFile(await fresh(), { id: files.inventario });
    expect(rowOf(files.inventario)).toEqual(live);
    const alreadyTrashed = rowOf(files.trashed);
    await runTrashFile(await fresh(), { id: files.trashed });
    expect(rowOf(files.trashed)).toEqual(alreadyTrashed);
  });

  it('hebra_list_folders.count sigue contando solo notas', async () => {
    test = await buildTestContext();
    const before = (await runListFolders(await fresh(), {})).folders;
    await runTrashFile(await fresh(), { id: test.library.files.plano });
    await runTrashFile(await fresh(), { id: test.library.files.acta });
    expect((await runListFolders(await fresh(), {})).folders).toEqual(before);
  });
});

describe('ficheros sueltos por MCP', () => {
  let test: TestContext | undefined;
  let client: Client | undefined;
  let server: McpServer | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    stderrSpy?.mockRestore();
    await client?.close();
    await server?.close();
    await test?.close();
    test = undefined;
    client = undefined;
    server = undefined;
  });

  function textOf(result: CallToolResult): string {
    return result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  function loggedLines(): string[] {
    return (stderrSpy!.mock.calls as unknown as [string][])
      .map(([line]) => String(line).trim())
      .filter((line) => line.length > 0);
  }

  async function connect(): Promise<void> {
    test = await buildTestContext();
    server = new McpServer({ name: 'hebra-mcp-files-test', version: '0.0.0' });
    registerTools(server, test.serverContext);
    client = new Client({ name: 'hebra-mcp-files-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }

  it('las tres herramientas están y purgar, crear, renombrar, mover, reemplazar o leer no existe', async () => {
    await connect();
    const names = (await client!.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(TOOL_NAMES);
    for (const name of ['hebra_list_files', 'hebra_trash_file', 'hebra_restore_file']) {
      expect(names).toContain(name);
    }
    const before = rawFiles(test!.sqlitePath);
    for (const name of FORBIDDEN_FILE_TOOLS) {
      expect(names).not.toContain(name);
      const result = (await client!.callTool({
        name,
        arguments: { id: test!.library.files.trashed, name: 'x', folderId: 'root' }
      })) as CallToolResult;
      expect(result.isError).toBe(true);
    }
    expect(rawFiles(test!.sqlitePath)).toEqual(before);
  });

  it('not_found es idéntico, en la respuesta y en el log, para oculto, inexistente, lápida, nota y SHA', async () => {
    await connect();
    const library = test!.library;
    const targets = [
      library.files.privateFolder,
      library.files.referencedByHash,
      library.files.referencedByName,
      library.files.referencedByLockedNote,
      library.files.trashedPrivateFolder,
      library.files.trashedDeletedPrivateFolder,
      library.files.tombstone,
      'no-existe',
      library.publicNoteId,
      library.privateAttachmentSha
    ];
    for (const name of ['hebra_trash_file', 'hebra_restore_file']) {
      stderrSpy!.mockClear();
      const answers = new Set<string>();
      for (const id of targets) {
        const result = (await client!.callTool({ name, arguments: { id } })) as CallToolResult;
        expect(result.isError).toBe(true);
        answers.add(textOf(result));
      }
      expect([...answers]).toEqual(['{"error":"not_found"}']);
      expect([...new Set(loggedLines())]).toEqual([
        JSON.stringify({ event: 'tool.call', tool: name, ok: false, code: 'not_found' })
      ]);
    }
  });

  it('hebra_restore_file registra lo escrito aunque el filtro de después falle, y la respuesta no da ruta', async () => {
    test = await buildTestContext();
    const library = test.library;
    const real = test.ctx.write!;
    const writer = new NoteWriter(test.ctx.port as NodeLibraryPort);
    // Lo que la ronda de después de escribir puede traer de otro dispositivo, hecho aquí
    // por un escritor sin privados justo tras la escritura: una nota privada que incrusta
    // el fichero (pasa a oculto) y el renombrado de la carpeta privada configurada (la
    // configuración deja de poder aplicarse).
    const cases: Array<{ id: string; code: string; afterWrite: () => Promise<unknown> }> = [
      {
        id: library.files.trashed,
        code: 'not_found',
        afterWrite: () =>
          writer.createNote({
            body: `# Privada\n\n![[${FILE_NAMES.trashed}]]\n`,
            folderId: library.folders.diario2026,
            privacy: NO_PRIVATE
          })
      },
      {
        id: library.files.trashedDeletedPublicFolder,
        code: 'privacy_config_unresolved',
        afterWrite: () =>
          writer.renameFolderLocal({
            id: library.folders.diario,
            name: 'Renombrada',
            privacy: NO_PRIVATE
          })
      }
    ];
    for (const { id, code, afterWrite } of cases) {
      stderrSpy!.mockClear();
      const ctx = await resolveToolContext(test.serverContext);
      const write = {
        ...real,
        organizeFile: async (input: Parameters<typeof real.organizeFile>[0]) => {
          const outcome = await real.organizeFile(input);
          await afterWrite();
          return outcome;
        }
      };
      const error = await runRestoreFile({ ...ctx, write }, { id }).catch((caught: unknown) => caught);
      expect(error, code).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe(code);
      // La respuesta es solo el código: ni ruta ni nada más.
      expect((error as ToolError).extra).toBeUndefined();
      // La escritura quedó hecha...
      expect(rawFiles(test.sqlitePath).find((row) => row.id === id)?.trashedAt).toBeNull();
      // ...y registrada.
      expect(loggedLines().map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual({
        event: 'file.organize',
        id,
        action: 'restoreFile',
        sync: 'not_linked'
      });
    }
  });

  it('los logs llevan el id, la acción y el estado de sync, nunca el nombre', async () => {
    await connect();
    const id = test!.library.files.inventario;
    const listed = (await client!.callTool({ name: 'hebra_list_files', arguments: {} })) as CallToolResult;
    expect(textOf(listed)).toContain(FILE_NAMES.inventario);
    expect(JSON.parse(textOf(listed))).not.toHaveProperty('count');
    await client!.callTool({ name: 'hebra_trash_file', arguments: { id } });
    await client!.callTool({ name: 'hebra_restore_file', arguments: { id } });
    const lines = loggedLines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual({ event: 'tool.call', tool: 'hebra_list_files', ok: true, count: 3 });
    expect(lines).toContainEqual({ event: 'file.organize', id, action: 'trashFile', sync: 'not_linked' });
    expect(lines).toContainEqual({ event: 'file.organize', id, action: 'restoreFile', sync: 'not_linked' });
    const logged = loggedLines().join('\n');
    for (const name of Object.values(FILE_NAMES)) expect(logged).not.toContain(name);
    expect(logged).not.toContain(BAIT_FOLDER);
    expect(logged).not.toContain(BAIT_TAG);
  });
});

describe('hebra_list_files sobre una biblioteca propia', () => {
  /**
   * Una biblioteca montada con el motor de Hebra ANTES de abrir el puerto (hebra-mcp no
   * crea ficheros ni borra carpetas) y un contexto sin privados sobre ella.
   */
  async function withOwnLibrary<T>(
    build: (engine: SqliteLibraryEngine) => Promise<T>,
    run: (ctx: ToolContext, built: T) => Promise<void>
  ): Promise<void> {
    const dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-files-own-'));
    const sqlitePath = join(dataDir, 'library.sqlite');
    let built: T;
    const { db, conn } = openNodeSqliteConn(sqlitePath);
    try {
      built = await build(
        await SqliteLibraryEngine.open(conn, 'test-fixture', { blobs: new FsBlobStore(dataDir) })
      );
    } finally {
      db.close();
    }
    const port = await openNodeLibraryPort({ sqlitePath, dataDir });
    try {
      const ctx: ToolContext = {
        port,
        privacy: await PrivacyFilter.build(port, NO_PRIVATE),
        privacyConfig: NO_PRIVATE,
        status: new UnlinkedStatusSource()
      };
      await run(ctx, built);
    } finally {
      port.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }

  /** Las páginas de una en una, hasta el final. */
  async function oneByOne(
    ctx: ToolContext,
    input: { trashed?: boolean },
    eachCursor: (cursor: string) => void = () => undefined
  ): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await runListFiles(ctx, { ...input, limit: 1, ...(cursor ? { cursor } : {}) });
      expect(result.files).toHaveLength(1);
      seen.push(result.files[0]!.id);
      if (result.nextCursor === null) break;
      eachCursor(result.nextCursor);
      cursor = result.nextCursor;
    }
    return seen;
  }

  it('un nombre larguísimo no rompe el cursor: la clave de orden se acota y el id desempata', async () => {
    // El motor no pone tope al nombre de un fichero; con el nombre entero en el cursor,
    // el de la primera página ya no cabría en los 2 048 caracteres de un cursor.
    const long = 'ñ'.repeat(3_000);
    await withOwnLibrary(
      async (engine) => {
        const blob = await engine.blobPut(new TextEncoder().encode('bytes'), { mime: 'text/plain' });
        const created: string[] = [];
        for (const suffix of ['-c.txt', '-a.txt', '-b.txt']) {
          created.push((await engine.fileCreate(null, `${long}${suffix}`, blob.sha256)).id);
        }
        return created;
      },
      async (ctx, created) => {
        const all = await runListFiles(ctx, {});
        // Coinciden en los primeros 200 caracteres: entre ellos manda el id.
        expect(all.files.map((file) => file.id)).toEqual([...created].sort());
        const seen = await oneByOne(ctx, {}, (cursor) => expect(cursor.length).toBeLessThan(2_048));
        expect(seen).toEqual(all.files.map((file) => file.id));
      }
    );
  });

  it('en la papelera, a igual fecha desempata el id DESCENDENTE, como el motor y hebra_list_trash', async () => {
    await withOwnLibrary(
      async (engine) => {
        const blob = await engine.blobPut(new TextEncoder().encode('bytes'), { mime: 'text/plain' });
        // Borrar una carpeta manda a la papelera todos sus ficheros con la MISMA fecha.
        const folder = await engine.folderCreate(null, 'Para borrar');
        const together: string[] = [];
        for (const name of ['uno.txt', 'dos.txt', 'tres.txt', 'cuatro.txt']) {
          together.push((await engine.fileCreate(folder.id, name, blob.sha256)).id);
        }
        const apart = (await engine.fileCreate(null, 'aparte.txt', blob.sha256)).id;
        await engine.folderTrash(folder.id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await engine.fileTrash(apart);
        // El orden del motor (`ORDER BY trashed_at DESC, id DESC`), leído de él.
        const engineOrder = engine.filesTrashPage(null, 50).items.map((item) => item.id);
        return { together, apart, engineOrder };
      },
      async (ctx, { together, apart, engineOrder }) => {
        const listed = await runListFiles(ctx, { trashed: true });
        const ids = listed.files.map((file) => file.id);
        // Los cuatro de la carpeta comparten fecha: entre ellos, id descendente.
        const dates = new Set(
          listed.files.filter((file) => together.includes(file.id)).map((file) => file.trashedAt)
        );
        expect(dates.size).toBe(1);
        expect(ids).toEqual([apart, ...[...together].sort().reverse()]);
        expect(ids).toEqual(engineOrder);
        // Y el cursor recorre ese mismo orden sin saltarse ni repetir ninguno.
        expect(await oneByOne(ctx, { trashed: true })).toEqual(ids);
      }
    );
  });
});

describe('filesIndex: lo que el filtro lee del almacén', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('trae los ficheros sin lápidas ni hash, y qué notas los enlazan por nombre o por hash', async () => {
    test = await buildTestContext();
    const library = test.library;
    const index = await test.ctx.port.filesIndex();
    const fileIds = index.files.map((file) => file.id);
    expect(fileIds).not.toContain(library.files.tombstone);
    expect(fileIds.sort()).toEqual(
      Object.entries(library.files)
        .filter(([key]) => key !== 'tombstone')
        .map(([, id]) => id)
        .sort()
    );
    for (const file of index.files) {
      expect(Object.keys(file).sort()).toEqual(
        ['byteLength', 'folderId', 'id', 'mime', 'name', 'trashedAt', 'updatedAt'].sort()
      );
    }
    // La carpeta es la GUARDADA: la de una carpeta ya borrada no es una carpeta viva.
    const live = new Set((await test.ctx.port.foldersList()).folders.map((folder) => folder.id));
    const stored = new Map(index.files.map((file) => [file.id, file.folderId]));
    expect(live.has(stored.get(library.files.trashedDeletedPublicFolder)!)).toBe(false);
    expect(stored.get(library.files.plano)).toBe(library.folders.lumbre);

    expect(index.refs).toContainEqual({
      fileId: library.files.referencedByHash,
      noteId: library.privateAttachmentNoteId,
      noteTrashed: false
    });
    expect(index.refs).toContainEqual({
      fileId: library.files.referencedByName,
      noteId: library.privateTagNoteId,
      noteTrashed: false
    });
    // Nadie enlaza los visibles.
    for (const id of [library.files.acta, library.files.inventario, library.files.plano]) {
      expect(index.refs.filter((ref) => ref.fileId === id)).toEqual([]);
    }
    expect(index.trash.notes.map((note) => note.id)).toContain(library.trashedNoteId);
  });

  it('una nota BLOQUEADA y oculta también oculta el fichero suelto que adjunta (solo consta en note_blob_refs)', async () => {
    test = await buildTestContext();
    const library = test.library;
    const id = library.files.referencedByLockedNote;
    // La premisa, medida en el almacén: el motor no deriva enlaces de una nota bloqueada
    // (`links` no tiene ninguna fila suya) y sí guarda sus adjuntos en `note_blob_refs`.
    const db = new DatabaseSync(test.sqlitePath, { readOnly: true });
    try {
      expect(
        db.prepare('SELECT count(*) AS n FROM links WHERE src_note_id = ?').get(library.lockedPrivateNoteId)
      ).toEqual({ n: 0 });
      expect(
        db.prepare('SELECT sha256 FROM note_blob_refs WHERE note_id = ?').all(library.lockedPrivateNoteId)
      ).toEqual([{ sha256: library.lockedAttachmentSha }]);
    } finally {
      db.close();
    }
    expect((await test.ctx.port.noteRead(library.lockedPrivateNoteId))?.body.startsWith('hebra-locked:v1:')).toBe(
      true
    );

    // El fichero está en la raíz, una carpeta visible: solo la referencia lo oculta.
    const index = await test.ctx.port.filesIndex();
    expect(index.files.find((file) => file.id === id)?.folderId).toBe('root');
    expect(index.refs).toContainEqual({
      fileId: id,
      noteId: library.lockedPrivateNoteId,
      noteTrashed: false
    });

    const ctx = await resolveToolContext(test.serverContext);
    const listed = await runListFiles(ctx, { limit: 100 });
    expect(listed.files.map((file) => file.id)).not.toContain(id);
    expect(JSON.stringify(listed)).not.toContain(BAIT_FOLDER);
    expect(await runListFiles(ctx, { name: 'contrato' })).toEqual({ files: [], nextCursor: null });
    for (const run of [runTrashFile, runRestoreFile]) {
      const error = await run(await resolveToolContext(test.serverContext), { id }).catch(
        (caught: unknown) => caught
      );
      expect(error).toMatchObject({ code: 'not_found' });
    }
    const direct = await test.ctx
      .write!.organizeFile({ action: 'trashFile', id, privacy: test.ctx.privacyConfig })
      .catch((caught: unknown) => caught);
    expect(direct).toMatchObject({ code: 'not_found' });
  });

  it('el hash se compara sin distinguir mayúsculas, y una nota de la papelera sigue contando', async () => {
    test = await buildTestContext();
    const library = test.library;
    // Otro dispositivo podría guardar el hash de `files` en mayúsculas: el motor da por
    // hecho que no, el índice no. (Por otra conexión: ninguna vía de hebra-mcp lo cambia.)
    const db = new DatabaseSync(test.sqlitePath);
    try {
      db.prepare('UPDATE files SET sha256 = upper(sha256) WHERE id = ?').run(
        library.files.referencedByHash
      );
    } finally {
      db.close();
    }
    // La nota de etiqueta privada, a la papelera (con el escritor y sin privados: por las
    // herramientas es `not_found`): sigue oculta allí, y su fichero también.
    await test.ctx.write!.organize({
      action: 'trashNote',
      id: library.privateTagNoteId,
      privacy: NO_PRIVATE
    });

    const index = await test.ctx.port.filesIndex();
    expect(index.refs).toContainEqual({
      fileId: library.files.referencedByHash,
      noteId: library.privateAttachmentNoteId,
      noteTrashed: false
    });
    expect(index.refs).toContainEqual({
      fileId: library.files.referencedByName,
      noteId: library.privateTagNoteId,
      noteTrashed: true
    });
    const listed = await runListFiles(await resolveToolContext(test.serverContext), { limit: 100 });
    expect(listed.files.map((file) => file.id)).toEqual([
      library.files.acta,
      library.files.inventario,
      library.files.plano
    ]);
  });
});
