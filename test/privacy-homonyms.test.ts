/**
 * Carpetas privadas con hermanas HOMÓNIMAS (revisión de D9, 3 oct 2026). El motor admite
 * dos hermanas con el mismo nombre cuando llegan por sync (dos dispositivos crean la
 * misma carpeta a la vez; `ensureFolderNameFree` solo frena lo local), y el índice de
 * rutas del filtro guardaba UNA carpeta por ruta: la última tapaba a las demás, así que
 * con `Privado` y `privado` y `privateFolders: [["privado"]]` una de las dos (y sus
 * notas) quedaba visible. Ahora se ocultan TODAS las carpetas de una ruta privada, también
 * las que solo difieren en mayúsculas, espacios de los extremos o en la forma NFC/NFD de
 * una tilde, por todas las salidas, y ninguna se puede renombrar.
 *
 * Las homónimas se fabrican como las deja el sync: carpetas creadas con otro nombre y
 * renombradas por SQL, por debajo del motor (el motor no las crea en local).
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ROOT_FOLDER_ID } from '../src/hebra';
import type { PrivacyConfig } from '../src/privacy';
import type { PrivacyFilter } from '../src/privacy/filter';
import { registerTools } from '../src/server/register-tools';
import type { NodeLibraryPort } from '../src/store';
import { planRenameFolder } from '../src/store/folders';
import { buildTestContext, type TestContext } from './fixtures/test-context';

const OPEN: PrivacyConfig = { privateFolders: [], privateTags: [] };
const CAFE_NFC = `caf${String.fromCharCode(0xe9)}`;
const CAFE_NFD = `Cafe${String.fromCharCode(0x301)}`;
const BAIT = 'CEBO_HOMONIMO_4f2a';

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

describe('carpetas privadas con hermanas homónimas', () => {
  let test: TestContext | undefined;
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    await test?.close();
    test = undefined;
  });

  /** Cinco carpetas en la raíz: `Privado`, y por SQL `privado`, ` PRIVADO `, `café` (NFC) y
   *  `Cafe´` (NFD); una nota con el cebo en cada una. */
  async function homonyms(): Promise<{ folders: string[]; notes: string[] }> {
    test = await buildTestContext({ privateFolders: [['privado'], [CAFE_NFC]], privateTags: [] });
    const port = test.ctx.port as NodeLibraryPort;
    const create = (name: string) =>
      port.writeExclusive((store) => store.folderCreate(ROOT_FOLDER_ID, name)).then((row) => row.id);
    const folders = [
      await create('Privado'),
      await create('tmp-1'),
      await create('tmp-2'),
      await create(CAFE_NFC),
      await create('tmp-3')
    ];
    const db = new DatabaseSync(test.sqlitePath);
    const rename = db.prepare('UPDATE folders SET name = ? WHERE id = ?');
    rename.run('privado', folders[1]!);
    rename.run(' PRIVADO ', folders[2]!);
    rename.run(CAFE_NFD, folders[4]!);
    db.close();
    const notes: string[] = [];
    for (const [index, folderId] of folders.entries()) {
      const note = await test.ctx.write!.createNote({
        body: `# Homónima ${index}\n${BAIT} ${index}\n`,
        folderId,
        privacy: OPEN
      });
      notes.push(note.id);
    }
    return { folders, notes };
  }

  async function client(): Promise<Client> {
    const server = new McpServer({ name: 'hebra-mcp-homonyms-test', version: '0.0.0' });
    registerTools(server, test!.serverContext);
    const mcp = new Client({ name: 'hebra-mcp-homonyms-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    closers.push(async () => {
      await mcp.close();
      await server.close();
    });
    return mcp;
  }

  async function call(mcp: Client, name: string, args: Record<string, unknown>) {
    const result = (await mcp.callTool({ name, arguments: args })) as CallToolResult;
    return { isError: result.isError === true, text: textOf(result) };
  }

  it('todas las homónimas de una ruta privada quedan ocultas en list_folders, list_notes, search y read_note', async () => {
    const { folders, notes } = await homonyms();
    const mcp = await client();

    const listed = JSON.parse((await call(mcp, 'hebra_list_folders', {})).text) as {
      folders: Array<{ id: string }>;
    };
    const listedIds = listed.folders.map((folder) => folder.id);
    for (const id of folders) expect(listedIds).not.toContain(id);

    const notesList = await call(mcp, 'hebra_list_notes', { limit: 100 });
    const searched = await call(mcp, 'hebra_search', { query: BAIT });
    for (const output of [notesList.text, searched.text]) {
      expect(output).not.toContain(BAIT);
      for (const id of notes) expect(output).not.toContain(id);
    }
    expect(JSON.parse(searched.text)).toEqual({ results: [], nextCursor: null });
    for (const id of notes) {
      expect(await call(mcp, 'hebra_read_note', { id })).toEqual({
        isError: true,
        text: '{"error":"not_found"}'
      });
    }
  });

  it('renombrar cualquiera de ellas responde como una carpeta inexistente, sin escribir', async () => {
    const { folders } = await homonyms();
    const mcp = await client();
    const missing = await call(mcp, 'hebra_rename_folder', { folderId: 'no-existe', name: 'Otra' });
    expect(missing).toEqual({ isError: true, text: '{"error":"not_found"}' });
    for (const folderId of folders) {
      expect(await call(mcp, 'hebra_rename_folder', { folderId, name: 'Otra' })).toEqual(missing);
    }
    // Crear otra homónima más (con la ruta privada) tampoco.
    expect(await call(mcp, 'hebra_create_folder', { name: 'PRIVADO' })).toEqual({
      isError: true,
      text: '{"error":"folder_unavailable"}'
    });
    const port = test!.ctx.port as NodeLibraryPort;
    const names = new Map((await port.foldersList()).folders.map((folder) => [folder.id, folder.name]));
    expect(folders.map((id) => names.get(id))).toEqual(['Privado', 'privado', ' PRIVADO ', CAFE_NFC, CAFE_NFD]);
  });

  it('el plan de renombrado mira la ruta propia aunque el índice no la hubiera marcado oculta', () => {
    // Un filtro de mentira en el que la carpeta es visible pero su ruta es privada: el plan
    // la rechaza por la configuración, sin depender del índice de ocultas.
    const filter = {
      folderExists: () => true,
      isFolderHidden: () => false,
      folderSegments: (id: string) => (id === 'f1' ? ['privado'] : []),
      isPrivateFolderPath: (segments: readonly string[]) => segments[0] === 'privado',
      hasHiddenFolderBelow: () => false
    } as unknown as PrivacyFilter;
    expect(planRenameFolder(filter, 'f1', 'Otra')).toEqual({ kind: 'reject', code: 'folder_unavailable' });
  });
});
