/**
 * Reproducción del hallazgo BLOQUEANTE del coordinador (26 sep 2026, §1): con
 * `PrivacyFilter` cacheado al arrancar, una nota que el SYNC mueve a una carpeta
 * privada (u oculta con una etiqueta privada) mientras el proceso vive seguía viéndose
 * — fuga — y una nota nueva que llega por sync quedaba invisible hasta reiniciar —
 * fallo funcional, sin ser fuga.
 *
 * Dispositivo real (`test/sync/devices.ts`, el mismo que usa `sync-runner.node.test.ts`
 * de L3a): `mcp` es hebra-mcp tal cual corre (`NodeLibraryPort` + `SyncRunner`); `app`
 * es «otro dispositivo» montado como Hebra monta los suyos (`LocalLibraryPort` +
 * `LibrarySyncEngine`). El cambio de carpeta lo hace `app` y llega a `mcp` por una
 * ronda de sync de verdad, contra el relé en memoria de Hebra — no una nota tocada a
 * mano en la SQLite de `mcp`.
 *
 * El cliente MCP se conecta UNA vez y no se reinicia entre pasos: si el filtro
 * estuviera cacheado, el paso 2 (nota movida a una carpeta privada) seguiría
 * devolviéndola y el paso 3 (nota nueva) no aparecería.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../src/server/register-tools';
import type { ServerContext } from '../src/server/context';
import { UnlinkedStatusSource } from '../src/status/status-source';
import type { PrivacyConfig } from '../src/privacy';
import { InMemoryLibraryRelay, appCreate, appDevice, mcpDevice, type McpDevice } from './sync/devices';

const BAIT = 'PALABRA_UNICA_XYZ_c4e1';

const PRIVACY_CONFIG: PrivacyConfig = {
  privateFolders: [['diario']],
  privateTags: []
};

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function connectClient(ctx: ServerContext): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer({ name: 'hebra-mcp-live-refresh-test', version: '0.0.0' });
  registerTools(server, ctx);
  const client = new Client({ name: 'hebra-mcp-live-refresh-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function readNoteIds(client: Client): Promise<{
  read: (id: string) => Promise<CallToolResult>;
  search: () => Promise<string[]>;
  list: () => Promise<string[]>;
}> {
  return {
    read: (id: string) => client.callTool({ name: 'hebra_read_note', arguments: { id } }) as Promise<CallToolResult>,
    async search() {
      const result = (await client.callTool({
        name: 'hebra_search',
        arguments: { query: BAIT }
      })) as CallToolResult;
      const parsed = JSON.parse(textOf(result)) as { results: Array<{ id: string }> };
      return parsed.results.map((item) => item.id);
    },
    async list() {
      const result = (await client.callTool({
        name: 'hebra_list_notes',
        arguments: { limit: 100 }
      })) as CallToolResult;
      const parsed = JSON.parse(textOf(result)) as { notes: Array<{ id: string }> };
      return parsed.notes.map((item) => item.id);
    }
  };
}

describe('el filtro de privados se recalcula del almacén en cada llamada (sin restart)', () => {
  let mcp: McpDevice | undefined;
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
    mcp?.port.close();
    mcp = undefined;
    client = undefined;
    server = undefined;
  });

  it('una nota que el sync mueve a una carpeta privada deja de verse SIN reiniciar, y una nota nueva del sync se ve SIN reiniciar', async () => {
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay);
    const app = await appDevice(relay);

    const publicFolder = await app.port.folderCreate(null, 'Pública');
    const diarioFolder = await app.port.folderCreate(null, 'Diario');

    const noteId = await appCreate(app, `# Nota compartida\n${BAIT}: contenido compartido.\n`);
    await app.port.noteMove(noteId, publicFolder.id);
    await app.sync.runRound();
    await mcp.runner.requestRound();

    const ctx: ServerContext = {
      port: mcp.port,
      privacyConfig: PRIVACY_CONFIG,
      status: new UnlinkedStatusSource()
    };
    ({ client, server } = await connectClient(ctx));
    const tools = await readNoteIds(client);

    // Paso 1: la nota está en una carpeta PÚBLICA, se ve por las tres vías.
    expect((await tools.read(noteId)).isError).toBeFalsy();
    expect(await tools.search()).toContain(noteId);
    expect(await tools.list()).toContain(noteId);

    // Paso 2: OTRO dispositivo la mueve a una carpeta PRIVADA y sincroniza. El cliente
    // MCP sigue siendo el MISMO (no se reinicia el proceso ni se reconstruye `ctx`).
    await app.port.noteMove(noteId, diarioFolder.id);
    await app.sync.runRound();
    await mcp.runner.requestRound();

    const afterMove = await tools.read(noteId);
    expect(afterMove.isError).toBe(true);
    expect(JSON.parse(textOf(afterMove))).toEqual({ error: 'not_found' });
    expect(await tools.search()).not.toContain(noteId);
    expect(await tools.list()).not.toContain(noteId);

    // Paso 3 (fallo simétrico, no fuga): una nota NUEVA que llega por sync, en la
    // carpeta pública, se ve YA, sin reiniciar.
    const secondId = await appCreate(app, `# Nota nueva\n${BAIT}: también esta.\n`);
    await app.port.noteMove(secondId, publicFolder.id);
    await app.sync.runRound();
    await mcp.runner.requestRound();

    expect((await tools.read(secondId)).isError).toBeFalsy();
    const searched = await tools.search();
    expect(searched).toContain(secondId);
    expect(searched).not.toContain(noteId);
    expect(await tools.list()).toContain(secondId);
  });
});
