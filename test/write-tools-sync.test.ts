/**
 * `hebra_create_note`/`hebra_append_to_note` de punta a punta, por el protocolo MCP,
 * contra el motor de sync REAL de Hebra y otro dispositivo montado como Hebra monta los
 * suyos (`test/sync/devices.ts`, el mismo que usa `test/sync/sync-runner.node.test.ts`
 * de L3a): nada de tocar la SQLite a mano.
 *
 * El conflicto real (tercer test) reproduce la fila 6 de `sync-store.ts`
 * (`vendor/hebra/src/lib/library/sync-store.ts`): dentro de una ronda, el motor
 * PRIMERO baja los cambios (`pull`) y DESPUÉS sube los propios (`push`). Con el Mac ya
 * sincronizado y Claude añadiendo sobre su copia local todavía vieja (sin haber
 * sincronizado desde el cambio del Mac), la ronda que la herramienta pide tras el
 * guardado baja la versión del Mac mientras el guardado de Claude sigue sucio: el motor
 * mete la copia de conflicto con el contenido de Claude y dejar el id original con el
 * del Mac, y `sync.conflict_copy` dispara EN LA MISMA ronda que la herramienta espera
 * (`awaitRound`), así que la salida de la llamada ya es `conflict_copy`.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/server/register-tools';
import type { ServerContext } from '../src/server/context';
import { buildWriteContext } from '../src/server/write-context';
import { UnlinkedStatusSource } from '../src/status/status-source';
import type { PrivacyConfig } from '../src/privacy';
import {
  InMemoryLibraryRelay,
  allBodies,
  appCreate,
  appDevice,
  appSave,
  mcpDevice,
  type AppDevice,
  type McpDevice
} from './sync/devices';

const OPEN_PRIVACY_CONFIG: PrivacyConfig = { privateFolders: [], privateTags: [] };

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function ctxFor(mcp: McpDevice): ServerContext {
  const write = buildWriteContext({
    createNote: (input) => mcp.writer.createNote(input),
    appendToNote: (input) => mcp.writer.appendToNote(input),
    editNote: (input) => mcp.writer.editNoteLocal(input),
    recordEditConflict: (operationId, id, copyId) =>
      mcp.writer.recordEditConflict(operationId, id, copyId),
    organize: (input) => mcp.writer.organizeLocal(input),
    restoreVersion: (input) => mcp.writer.restoreVersionLocal(input),
    fetchAttachment: (input) => mcp.writer.fetchAttachment(input, (sha) => mcp.runner.readBlob(sha)),
    createFolder: (input) => mcp.writer.createFolderLocal(input),
    renameFolder: (input) => mcp.writer.renameFolderLocal(input),
    addAttachment: (input) => mcp.writer.addAttachmentLocal(input),
    organizeFile: (input) => mcp.writer.organizeFileLocal(input),
    noteRead: (id) => mcp.port.noteRead(id),
    folderDirty: (id) => mcp.port.folderDirty(id),
    blobUploaded: (sha256) => mcp.port.blobUploaded(sha256),
    looseFileDirty: (id) => mcp.port.looseFileDirty(id),
    onConflictCopy: (listener) => mcp.runner.onConflictCopy(listener),
    isLinked: () => true,
    requestRound: () => mcp.runner.requestRound()
  });
  return {
    port: mcp.port,
    privacyConfig: OPEN_PRIVACY_CONFIG,
    status: new UnlinkedStatusSource(),
    write
  };
}

async function connectClient(ctx: ServerContext): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer({ name: 'hebra-mcp-write-sync-test', version: '0.0.0' });
  registerTools(server, ctx);
  const client = new Client({ name: 'hebra-mcp-write-sync-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('escrituras (L3b) contra el sync real: la nota creada y el texto añadido cruzan a otro dispositivo', () => {
  let mcp: McpDevice | undefined;
  let app: AppDevice | undefined;
  let client: Client | undefined;
  let server: McpServer | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    mcp?.port.close();
    mcp = undefined;
    app = undefined;
    client = undefined;
    server = undefined;
  });

  it('hebra_create_note: la nota nueva aparece en el otro dispositivo tras las rondas', async () => {
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay);
    app = await appDevice(relay);
    ({ client, server } = await connectClient(ctxFor(mcp)));

    const body = '# Nota de Claude\nCreada desde hebra_create_note.\n';
    const result = (await client.callTool({
      name: 'hebra_create_note',
      arguments: { body }
    })) as CallToolResult;
    const parsed = JSON.parse(textOf(result)) as { id: string; title: string };
    expect(parsed.title).toBe('Nota de Claude');

    await mcp.runner.requestRound();
    await app.sync.runRound();

    const seen = await app.port.noteRead(parsed.id);
    expect(seen?.body).toBe(body);
    expect(seen?.title).toBe('Nota de Claude');
  });

  it('hebra_append_to_note: el texto añadido aparece en el otro dispositivo tras las rondas', async () => {
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay);
    app = await appDevice(relay);

    const id = await appCreate(app, '# Nota compartida\ntexto base');
    await app.sync.runRound();
    await mcp.runner.requestRound();

    ({ client, server } = await connectClient(ctxFor(mcp)));
    const result = (await client.callTool({
      name: 'hebra_append_to_note',
      arguments: { id, text: 'texto añadido por Claude' }
    })) as CallToolResult;
    expect(JSON.parse(textOf(result))).toEqual({ id, outcome: 'saved' });

    await mcp.runner.requestRound();
    await app.sync.runRound();

    const seen = await app.port.noteRead(id);
    expect(seen?.body).toBe('# Nota compartida\ntexto base\n\ntexto añadido por Claude');
  });

  it('conflicto real vía la herramienta: outcome conflict_copy, sin perder ningún texto', async () => {
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay);
    app = await appDevice(relay);

    const id = await appCreate(app, '# Compartida\n\ntexto base');
    await app.sync.runRound();
    await mcp.runner.requestRound();
    expect((await mcp.port.noteRead(id))?.body).toBe('# Compartida\n\ntexto base');

    // El Mac edita Y sincroniza: Claude todavía no lo sabe (no ha sincronizado desde
    // el baseline).
    await appSave(app, id, '# Compartida\n\ntexto base\n\nEDICIÓN DEL MAC');
    await app.sync.runRound();

    ({ client, server } = await connectClient(ctxFor(mcp)));
    const result = (await client.callTool({
      name: 'hebra_append_to_note',
      arguments: { id, text: 'AÑADIDO POR CLAUDE' }
    })) as CallToolResult;
    const parsed = JSON.parse(textOf(result)) as {
      id: string;
      outcome: string;
      copyId?: string;
    };
    expect(parsed.outcome).toBe('conflict_copy');
    expect(typeof parsed.copyId).toBe('string');

    // Converge del todo y comprueba los dos textos en los DOS almacenes.
    await app.sync.runRound();
    await mcp.runner.requestRound();
    await app.sync.runRound();

    for (const bodies of [await allBodies(mcp.port), await allBodies(app.port)]) {
      const family = bodies.filter((note) => note.id === id || note.conflictOf === id);
      expect(family.filter((note) => note.conflictOf === id)).toHaveLength(1);
      const joined = family.map((note) => note.body).join('\n---\n');
      expect(joined).toContain('EDICIÓN DEL MAC');
      expect(joined).toContain('AÑADIDO POR CLAUDE');
    }
  });

  it('hebra_edit_note: leer → editar → la edición cruza al otro dispositivo, con sync uploaded', async () => {
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay);
    app = await appDevice(relay);

    const id = await appCreate(app, '# Compartida\n\nuno dos tres');
    await app.sync.runRound();
    await mcp.runner.requestRound();

    ({ client, server } = await connectClient(ctxFor(mcp)));
    const read = JSON.parse(
      textOf((await client.callTool({ name: 'hebra_read_note', arguments: { id } })) as CallToolResult)
    ) as { revision: string };
    const result = (await client.callTool({
      name: 'hebra_edit_note',
      arguments: {
        id,
        edits: [{ find: 'dos', replace: 'DOS' }],
        expectedRevision: read.revision,
        operationId: 'op-sync-1'
      }
    })) as CallToolResult;
    expect(JSON.parse(textOf(result))).toMatchObject({ id, outcome: 'saved', sync: 'uploaded' });

    await app.sync.runRound();
    expect((await app.port.noteRead(id))?.body).toBe('# Compartida\n\nuno DOS tres');
  });

  it('organización: nota movida (a una carpeta creada en Hebra) y archivada cruza al otro dispositivo', async () => {
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay);
    app = await appDevice(relay);

    const id = await appCreate(app, '# Para mover\n\ntexto');
    // Las carpetas se crean en la app (el MCP no las gestiona, opción A de David).
    const folder = await app.engine.folderCreate(null, 'Desde Hebra');
    await app.sync.runRound();
    await mcp.runner.requestRound();

    ({ client, server } = await connectClient(ctxFor(mcp)));
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(textOf((await client!.callTool({ name, arguments: args })) as CallToolResult)) as Record<
        string,
        unknown
      >;
    expect(await call('hebra_move_note', { id, folderId: folder.id })).toMatchObject({
      folderPath: 'desde hebra',
      sync: 'uploaded'
    });
    expect(await call('hebra_set_archived', { id, archived: true })).toMatchObject({
      archived: true,
      sync: 'uploaded'
    });

    await app.sync.runRound();
    const seen = await app.port.noteRead(id);
    expect(seen?.folderId).toBe(folder.id);
    expect(seen?.archivedAt).not.toBeNull();
  });

  it('papelera: mandar y sacar una nota cruza al otro dispositivo en los dos sentidos', async () => {
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay);
    app = await appDevice(relay);

    const id = await appCreate(app, '# Para la papelera\n\ntexto');
    await app.sync.runRound();
    await mcp.runner.requestRound();

    ({ client, server } = await connectClient(ctxFor(mcp)));
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(textOf((await client!.callTool({ name, arguments: args })) as CallToolResult)) as Record<
        string,
        unknown
      >;
    expect(await call('hebra_trash_note', { id })).toEqual({ id, trashed: true, sync: 'uploaded' });
    await app.sync.runRound();
    expect((await app.port.noteRead(id))?.trashedAt).not.toBeNull();

    expect(await call('hebra_restore_note', { id })).toMatchObject({ id, folderPath: '', sync: 'uploaded' });
    await app.sync.runRound();
    const seen = await app.port.noteRead(id);
    expect(seen?.trashedAt).toBeNull();
    expect(seen?.body).toBe('# Para la papelera\n\ntexto');
  });

  it('ficheros sueltos (D10): mandar uno a la papelera y sacarlo cruza al otro dispositivo en los dos sentidos', async () => {
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay, { blobs: true });
    app = await appDevice(relay, 'Mac', { blobs: true });

    // El fichero nace en el otro dispositivo y baja: hebra-mcp no crea ficheros.
    const blob = await app.engine.blobPut(new TextEncoder().encode('bytes del plano'), {
      mime: 'application/pdf'
    });
    const file = await app.engine.fileCreate(null, 'plano.pdf', blob.sha256);
    await app.sync.runRound();
    await mcp.runner.requestRound();

    ({ client, server } = await connectClient(ctxFor(mcp)));
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(textOf((await client!.callTool({ name, arguments: args })) as CallToolResult)) as Record<
        string,
        unknown
      >;
    const listed = (await call('hebra_list_files', {})).files as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: file.id, name: 'plano.pdf', folderPath: '', trashedAt: null });

    expect(await call('hebra_trash_file', { id: file.id })).toEqual({
      id: file.id,
      trashed: true,
      sync: 'uploaded'
    });
    await app.sync.runRound();
    const inAppTrash = app.engine.filesTrashPage(null, 10).items;
    expect(inAppTrash.map((item) => item.id)).toEqual([file.id]);
    expect(inAppTrash[0]?.trashedAt).not.toBeNull();
    // Repetirlo no escribe ni pide ronda: la fila ya está limpia.
    expect(await call('hebra_trash_file', { id: file.id })).toEqual({
      id: file.id,
      trashed: true,
      sync: 'uploaded'
    });

    expect(await call('hebra_restore_file', { id: file.id })).toEqual({
      id: file.id,
      folderPath: '',
      sync: 'uploaded'
    });
    await app.sync.runRound();
    expect(app.engine.filesTrashPage(null, 10).items).toEqual([]);
    const live = app.engine.filesPage('root').items.find((item) => item.id === file.id);
    // Ni el nombre ni la carpeta cambian al ir y volver.
    expect(live).toMatchObject({ name: 'plano.pdf', folderId: 'root', trashedAt: null });

    // Y al revés: lo manda a la papelera el otro dispositivo y hebra-mcp lo ve allí.
    await app.engine.fileTrash(file.id);
    await app.sync.runRound();
    await mcp.runner.requestRound();
    expect((await call('hebra_list_files', {})).files).toEqual([]);
    const trashed = (await call('hebra_list_files', { trashed: true })).files as Array<
      Record<string, unknown>
    >;
    expect(trashed.map((entry) => entry.id)).toEqual([file.id]);
    expect(trashed[0]?.trashedAt).not.toBeNull();
  });

  it('hebra_restore_version con edición a la vez en otro dispositivo: conflict_copy, sin perder texto', async () => {
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay);
    app = await appDevice(relay);

    const id = await appCreate(app, '# Con versiones\n\nREDACCIÓN ORIGINAL');
    await app.sync.runRound();
    await mcp.runner.requestRound();

    ({ client, server } = await connectClient(ctxFor(mcp)));
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(textOf((await client!.callTool({ name, arguments: args })) as CallToolResult)) as Record<
        string,
        unknown
      >;
    // Una edición desde Claude deja la redacción original como versión LOCAL de hebra-mcp.
    const first = await call('hebra_read_note', { id });
    expect(
      await call('hebra_edit_note', {
        id,
        edits: [{ find: 'REDACCIÓN ORIGINAL', replace: 'SEGUNDA REDACCIÓN' }],
        expectedRevision: first.revision,
        operationId: 'op-sync-version-1'
      })
    ).toMatchObject({ outcome: 'saved', sync: 'uploaded' });
    await app.sync.runRound();
    const versions = (await call('hebra_list_versions', { id })).versions as Array<{ versionId: number }>;
    expect(versions).toHaveLength(1);
    const read = await call('hebra_read_note', { id });

    // El Mac edita y sincroniza; Claude restaura sobre su copia local, aún vieja.
    await appSave(app, id, '# Con versiones\n\nSEGUNDA REDACCIÓN\n\nEDICIÓN DEL MAC');
    await app.sync.runRound();

    const args = {
      id,
      versionId: versions[0]!.versionId,
      expectedRevision: read.revision,
      operationId: 'op-sync-version-2'
    };
    const parsed = await call('hebra_restore_version', args);
    expect(parsed.outcome).toBe('conflict_copy');
    expect(typeof parsed.copyId).toBe('string');
    // Reintentar con el mismo operationId devuelve la misma copia, sin restaurar otra vez.
    expect(await call('hebra_restore_version', args)).toMatchObject({
      outcome: 'conflict_copy',
      copyId: parsed.copyId,
      replayed: true
    });

    await app.sync.runRound();
    await mcp.runner.requestRound();
    await app.sync.runRound();
    for (const bodies of [await allBodies(mcp.port), await allBodies(app.port)]) {
      const family = bodies.filter((note) => note.id === id || note.conflictOf === id);
      expect(family.filter((note) => note.conflictOf === id)).toHaveLength(1);
      const joined = family.map((note) => note.body).join('\n---\n');
      expect(joined).toContain('EDICIÓN DEL MAC');
      expect(joined).toContain('REDACCIÓN ORIGINAL');
    }
  });

  it('adjuntos: un adjunto del Mac se baja del relé bajo demanda, y uno de más de 5 MiB se rechaza', async () => {
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay, { blobs: true });
    app = await appDevice(relay, 'Mac', { blobs: true });

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const pngSha = (await app.engine.blobPut(png, { mime: 'image/png' })).sha256;
    const big = new Uint8Array(5 * 1024 * 1024 + 1).fill(0x61);
    const bigSha = (await app.engine.blobPut(big, { mime: 'text/plain' })).sha256;
    const id = await appCreate(
      app,
      `# Con adjuntos\n\n![[sha256:${pngSha}|foto.png]]\n![[sha256:${bigSha}|grande.txt]]\n`
    );
    expect((await app.sync.runRound()).result).toBe('ok');
    await mcp.runner.requestRound();
    // La nota llegó; los bytes siguen en el relé (Blob V2 no dice tamaño ni tipo).
    expect(await mcp.port.blobRead(pngSha)).toBeNull();

    ({ client, server } = await connectClient(ctxFor(mcp)));
    const listed = JSON.parse(
      textOf((await client.callTool({ name: 'hebra_list_attachments', arguments: { id } })) as CallToolResult)
    ) as { attachments: Array<{ attachmentId: string; byteLength: number | null }> };
    expect(listed.attachments.map((entry) => [entry.attachmentId, entry.byteLength])).toEqual([
      [pngSha, null],
      [bigSha, null]
    ]);

    const image = (await client.callTool({
      name: 'hebra_read_attachment',
      arguments: { id, attachmentId: pngSha }
    })) as CallToolResult;
    expect(image.isError).not.toBe(true);
    expect(image.content[1]).toEqual({
      type: 'image',
      data: Buffer.from(png).toString('base64'),
      mimeType: 'image/png'
    });
    // Quedó en la caché del motor (su almacén de adjuntos), no en otra.
    expect(await mcp.port.blobRead(pngSha)).toEqual(png);

    const tooLarge = (await client.callTool({
      name: 'hebra_read_attachment',
      arguments: { id, attachmentId: bigSha }
    })) as CallToolResult;
    expect(tooLarge.isError).toBe(true);
    expect(JSON.parse(textOf(tooLarge))).toEqual({
      error: 'attachment_too_large',
      byteLength: 5 * 1024 * 1024 + 1,
      maxBytes: 5 * 1024 * 1024
    });
  });

  it('hebra_edit_note con edición a la vez en otro dispositivo: conflict_copy con copyId, sin reintento', async () => {
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay);
    app = await appDevice(relay);

    const id = await appCreate(app, '# Compartida\n\ntexto base');
    await app.sync.runRound();
    await mcp.runner.requestRound();

    ({ client, server } = await connectClient(ctxFor(mcp)));
    const read = JSON.parse(
      textOf((await client.callTool({ name: 'hebra_read_note', arguments: { id } })) as CallToolResult)
    ) as { revision: string };

    // El Mac edita y sincroniza; Claude edita sobre su copia local, aún vieja.
    await appSave(app, id, '# Compartida\n\ntexto base\n\nEDICIÓN DEL MAC');
    await app.sync.runRound();

    const args = {
      id,
      edits: [{ find: 'texto base', replace: 'TEXTO DE CLAUDE' }],
      expectedRevision: read.revision,
      operationId: 'op-sync-conflicto'
    };
    const parsed = JSON.parse(
      textOf((await client.callTool({ name: 'hebra_edit_note', arguments: args })) as CallToolResult)
    ) as { outcome: string; copyId?: string; revision?: string };
    expect(parsed.outcome).toBe('conflict_copy');
    expect(typeof parsed.copyId).toBe('string');
    expect(parsed.revision).toBeUndefined();

    // Reintentar con el mismo operationId devuelve la misma copia, sin escribir otra vez.
    const again = JSON.parse(
      textOf((await client.callTool({ name: 'hebra_edit_note', arguments: args })) as CallToolResult)
    ) as { outcome: string; copyId?: string; replayed?: boolean };
    expect(again).toMatchObject({ outcome: 'conflict_copy', copyId: parsed.copyId, replayed: true });

    await app.sync.runRound();
    await mcp.runner.requestRound();
    await app.sync.runRound();
    for (const bodies of [await allBodies(mcp.port), await allBodies(app.port)]) {
      const family = bodies.filter((note) => note.id === id || note.conflictOf === id);
      expect(family.filter((note) => note.conflictOf === id)).toHaveLength(1);
      const joined = family.map((note) => note.body).join('\n---\n');
      expect(joined).toContain('EDICIÓN DEL MAC');
      expect(joined).toContain('TEXTO DE CLAUDE');
    }
  });
});

/** Un PNG de verdad (1×1, transparente). */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'));
const PNG_SHA = createHash('sha256').update(PNG).digest('hex');

describe('carpetas y adjuntos (D9) contra el sync real: cruzan a otro dispositivo', () => {
  let mcp: McpDevice | undefined;
  let app: AppDevice | undefined;
  const opened: Array<{ client: Client; server: McpServer; device: McpDevice }> = [];

  afterEach(async () => {
    for (const entry of opened.splice(0)) {
      await entry.client.close();
      await entry.server.close();
      entry.device.port.close();
    }
    mcp = undefined;
    app = undefined;
  });

  async function open(device: McpDevice): Promise<Client> {
    const { client, server } = await connectClient(ctxFor(device));
    opened.push({ client, server, device });
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return { isError: result.isError === true, result, value: JSON.parse(textOf(result)) as Record<string, unknown> };
  }

  it('hebra_create_folder y hebra_rename_folder: la carpeta aparece en el otro dispositivo tras la ronda', async () => {
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay);
    app = await appDevice(relay);
    const client = await open(mcp);

    const created = await call(client, 'hebra_create_folder', { name: 'Audits' });
    expect(created.value).toMatchObject({ path: 'audits', created: true, sync: 'uploaded' });
    const id = created.value.id as string;
    const sub = await call(client, 'hebra_create_folder', { parentId: id, name: 'Capturas' });
    expect(sub.value).toMatchObject({ path: 'audits/capturas', created: true, sync: 'uploaded' });

    expect((await app.sync.runRound()).result).toBe('ok');
    let folders = new Map((await app.port.foldersList()).folders.map((folder) => [folder.id, folder]));
    expect(folders.get(id)?.name).toBe('Audits');
    expect(folders.get(sub.value.id as string)).toMatchObject({ name: 'Capturas', parentId: id });

    const renamed = await call(client, 'hebra_rename_folder', { folderId: id, name: 'Auditorías' });
    expect(renamed.value).toEqual({ id, path: 'auditorías', renamed: true, sync: 'uploaded' });
    expect((await app.sync.runRound()).result).toBe('ok');
    folders = new Map((await app.port.foldersList()).folders.map((folder) => [folder.id, folder]));
    expect(folders.get(id)?.name).toBe('Auditorías');

    // Repetir no escribe: ni carpeta nueva ni ronda.
    const again = await call(client, 'hebra_create_folder', { name: 'auditorías' });
    expect(again.value).toEqual({ id, path: 'auditorías', created: false, sync: 'uploaded' });
  });

  it('hebra_add_attachment: el blob SUBE con la ronda, y lo leen la app de Hebra y un segundo hebra-mcp', async () => {
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay, { blobs: true });
    app = await appDevice(relay, 'Mac', { blobs: true });
    const id = await appCreate(app, '# Para capturas\n\ntexto');
    expect((await app.sync.runRound()).result).toBe('ok');
    await mcp.runner.requestRound();
    const client = await open(mcp);

    const added = await call(client, 'hebra_add_attachment', {
      id,
      name: 'captura.png',
      dataBase64: PNG_BASE64,
      operationId: 'op-sync-png'
    });
    const markdown = `![[sha256:${PNG_SHA}|captura.png]]`;
    // `uploaded` = la nota sin cambios pendientes Y el blob en el relé, en la misma ronda.
    expect(added.value).toMatchObject({
      id,
      outcome: 'saved',
      attachmentId: PNG_SHA,
      markdown,
      sync: 'uploaded'
    });
    expect(await mcp.port.blobUploaded(PNG_SHA)).toBe(true);

    // La app de Hebra (su motor, no el nuestro): la nota trae la referencia y los bytes
    // bajan del relé, porque esta app nunca los tuvo.
    expect((await app.sync.runRound()).result).toBe('ok');
    expect((await app.port.noteRead(id))?.body).toBe(`# Para capturas\n\ntexto\n\n${markdown}`);
    expect(await app.port.blobRead(PNG_SHA)).toBeNull();
    expect(await app.sync.readBlob(PNG_SHA)).toEqual(PNG);

    // Un segundo hebra-mcp, vacío: la nota llega con la ronda y el adjunto se lee por la
    // herramienta, que lo baja del relé.
    const second = await mcpDevice(relay, { blobs: true });
    expect((await second.runner.requestRound())?.result).toBe('ok');
    expect(await second.port.blobRead(PNG_SHA)).toBeNull();
    const secondClient = await open(second);
    const read = await secondClient.callTool({
      name: 'hebra_read_attachment',
      arguments: { id, attachmentId: PNG_SHA }
    });
    expect(read.isError).not.toBe(true);
    expect((read as CallToolResult).content[1]).toEqual({
      type: 'image',
      data: PNG_BASE64,
      mimeType: 'image/png'
    });
    expect(await second.port.blobRead(PNG_SHA)).toEqual(PNG);
  });

  it('hebra_add_attachment con edición a la vez en otro dispositivo: conflict_copy, y el adjunto sigue subido', async () => {
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay, { blobs: true });
    app = await appDevice(relay, 'Mac', { blobs: true });
    const id = await appCreate(app, '# Compartida\n\ntexto base');
    expect((await app.sync.runRound()).result).toBe('ok');
    await mcp.runner.requestRound();

    // El Mac edita y sincroniza; Claude añade sobre su copia local, aún vieja.
    await appSave(app, id, '# Compartida\n\ntexto base\n\nEDICIÓN DEL MAC');
    expect((await app.sync.runRound()).result).toBe('ok');

    const client = await open(mcp);
    const args = { id, name: 'captura.png', dataBase64: PNG_BASE64, operationId: 'op-sync-conflicto' };
    const added = await call(client, 'hebra_add_attachment', args);
    expect(added.value).toMatchObject({ outcome: 'conflict_copy', attachmentId: PNG_SHA });
    const copyId = added.value.copyId as string;
    expect(typeof copyId).toBe('string');
    expect(copyId).not.toBe(id);
    expect(added.value.revision).toBeUndefined();

    // El reintento devuelve la misma copia, sin añadir la referencia otra vez.
    const again = await call(client, 'hebra_add_attachment', args);
    expect(again.value).toMatchObject({ outcome: 'conflict_copy', copyId, replayed: true });

    await app.sync.runRound();
    await mcp.runner.requestRound();
    await app.sync.runRound();
    const markdown = `![[sha256:${PNG_SHA}|captura.png]]`;
    for (const bodies of [await allBodies(mcp.port), await allBodies(app.port)]) {
      const family = bodies.filter((note) => note.id === id || note.conflictOf === id);
      expect(family.filter((note) => note.conflictOf === id)).toHaveLength(1);
      const joined = family.map((note) => note.body).join('\n---\n');
      expect(joined).toContain('EDICIÓN DEL MAC');
      expect(joined.split(markdown)).toHaveLength(2);
    }
    // La copia referencia el blob: subió, y la app lo baja del relé.
    expect(await app.sync.readBlob(PNG_SHA)).toEqual(PNG);
  });
});
