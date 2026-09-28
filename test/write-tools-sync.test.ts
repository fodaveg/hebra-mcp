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
    editNote: (input) => mcp.writer.editNote(input),
    recordEditConflict: (operationId, id, copyId) =>
      mcp.writer.recordEditConflict(operationId, id, copyId),
    noteRead: (id) => mcp.port.noteRead(id),
    onConflictCopy: (listener) => mcp.runner.onConflictCopy(listener),
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
