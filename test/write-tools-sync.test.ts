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
    noteRead: (id) => mcp.port.noteRead(id),
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
