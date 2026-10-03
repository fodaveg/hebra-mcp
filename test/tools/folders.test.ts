/**
 * `hebra_create_folder` y `hebra_rename_folder` (D9, decisión de David del 3 oct 2026)
 * sobre la biblioteca de prueba, sin sync: `Proyectos`, `Proyectos/Lumbre`, `Diario`
 * (privada), `Diario/2026`, `Historial` y `Adjuntos`. Que la carpeta cruce a otro
 * dispositivo va en `test/write-tools-sync.test.ts`, y que un lector la cree por
 * `writer.sock`, en `test/forward/forward.test.ts`.
 *
 * Lo que más importa aquí es `folder_unavailable`: UNA respuesta, byte a byte la misma,
 * para todo lo privado (ruta privada configurada, privada debajo de la que se renombra,
 * choque con una hermana oculta), decidida desde la configuración aunque la carpeta
 * privada ya no esté en el almacén.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ROOT_FOLDER_ID } from '../../src/hebra';
import type { PrivacyConfig } from '../../src/privacy';
import { resolveToolContext, type ToolContext } from '../../src/server/context';
import { toErrorResult, ToolError } from '../../src/server/errors';
import { registerTools } from '../../src/server/register-tools';
import { runCreateFolder, runRenameFolder } from '../../src/server/tools/folders';
import type { NodeLibraryPort } from '../../src/store';
import { buildTestContext, openBusyWriteContext, type TestContext } from '../fixtures/test-context';

const DEFAULT_PRIVACY: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };

/** «Café» escrito de dos formas que Hebra considera el mismo nombre de carpeta (NFC) y
 *  que el filtro de privados, que solo pasa a minúsculas, no: la compuesta (é, U+00E9)
 *  y la descompuesta (e + U+0301). Con `fromCharCode` para que ningún editor las iguale. */
const CAFE_NFC = `Caf${String.fromCharCode(0xe9)}`;
const CAFE_NFD = `Cafe${String.fromCharCode(0x301)}`;

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

describe('carpetas (D9): crear y renombrar', () => {
  let test: TestContext | undefined;
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    await test?.close();
    test = undefined;
  });

  function fresh(): Promise<ToolContext> {
    return resolveToolContext(test!.serverContext);
  }

  /** El puerto del contexto es un `NodeLibraryPort`: su turno de escritura, para preparar
   *  carpetas que el MCP no crearía (una privada con tilde, renombrar la privada). */
  function port(): NodeLibraryPort {
    return test!.ctx.port as NodeLibraryPort;
  }

  async function folderNames(): Promise<Map<string, string>> {
    const { folders } = await port().foldersList();
    return new Map(folders.map((folder) => [folder.id, folder.name]));
  }

  async function expectCode(promise: Promise<unknown>, code: string): Promise<ToolError> {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe(code);
    return error as ToolError;
  }

  /** Lo que recibe el cliente MCP por un error de herramienta, byte a byte. */
  function wire(error: ToolError): string {
    return textOf(toErrorResult(error));
  }

  async function mcpClient(): Promise<Client> {
    const server = new McpServer({ name: 'hebra-mcp-folders-test', version: '0.0.0' });
    registerTools(server, test!.serverContext);
    const client = new Client({ name: 'hebra-mcp-folders-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  it('crea en la raíz y dentro de una carpeta visible (por ruta y por id)', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const root = await runCreateFolder(await fresh(), { name: '  Nueva  ' });
    expect(root).toEqual({ id: root.id, path: 'nueva', created: true, sync: 'not_linked' });
    expect((await folderNames()).get(root.id)).toBe('Nueva');

    const byPath = await runCreateFolder(await fresh(), { parent: 'Proyectos/Lumbre', name: 'Audits' });
    expect(byPath).toMatchObject({ path: 'proyectos/lumbre/audits', created: true });
    const byId = await runCreateFolder(await fresh(), {
      parentId: test.library.folders.historial,
      name: 'Capturas'
    });
    expect(byId).toMatchObject({ path: 'historial/capturas', created: true });
    const nested = await runCreateFolder(await fresh(), { parentId: byId.id, name: '2026' });
    expect(nested.path).toBe('historial/capturas/2026');
    const explicitRoot = await runCreateFolder(await fresh(), { parentId: ROOT_FOLDER_ID, name: 'Otra' });
    expect(explicitRoot.path).toBe('otra');
  });

  it('idempotente: una hermana VISIBLE con ese nombre se devuelve, sin crear otra', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const before = (await folderNames()).size;
    for (const name of ['Proyectos', 'proyectos', ' PROYECTOS ']) {
      const result = await runCreateFolder(await fresh(), { name });
      expect(result).toEqual({
        id: test.library.folders.proyectos,
        path: 'proyectos',
        created: false,
        sync: 'not_linked'
      });
    }
    const created = await runCreateFolder(await fresh(), { parent: 'Proyectos', name: 'Nueva' });
    const again = await runCreateFolder(await fresh(), { parent: 'Proyectos', name: 'Nueva' });
    expect(again).toEqual({ ...created, created: false });
    expect((await folderNames()).size).toBe(before + 1);
  });

  it('padre oculto o inexistente: not_found, igual en los dos casos', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const before = (await folderNames()).size;
    const responses = new Set<string>();
    for (const input of [
      { parent: 'Diario', name: 'Nueva' },
      { parent: 'Diario/2026', name: 'Nueva' },
      { parentId: test.library.folders.diario, name: 'Nueva' },
      { parentId: test.library.folders.diario2026, name: 'Nueva' },
      { parent: 'no-existe', name: 'Nueva' },
      { parentId: 'no-existe', name: 'Nueva' }
    ]) {
      responses.add(wire(await expectCode(runCreateFolder(await fresh(), input), 'not_found')));
    }
    expect([...responses]).toEqual(['{"error":"not_found"}']);
    expect((await folderNames()).size).toBe(before);
  });

  it('ruta privada configurada: folder_unavailable, la misma respuesta exista o no la carpeta privada', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const client = await mcpClient();
    // 1. `Diario` existe (y el motor habría respondido `folder_name_taken`).
    const existing = textOf(
      (await client.callTool({ name: 'hebra_create_folder', arguments: { name: 'Diario' } })) as CallToolResult
    );
    expect(existing).toBe('{"error":"folder_unavailable"}');
    expect(textOf(
      (await client.callTool({ name: 'hebra_create_folder', arguments: { name: ' DIARIO ' } })) as CallToolResult
    )).toBe(existing);

    // 2. La misma decisión cuando la carpeta privada YA NO ESTÁ en el almacén: con el
    //    filtro de antes (el de una llamada en curso) y `Diario` renombrada por debajo,
    //    el motor crearía «Diario» sin quejarse; la herramienta lo decide por la
    //    configuración y responde lo mismo, byte a byte, sin crear nada.
    const stale = await fresh();
    await port().writeExclusive((store) => store.folderRename(test!.library.folders.diario, 'Renombrada'));
    const before = (await folderNames()).size;
    const missing = wire(await expectCode(runCreateFolder(stale, { name: 'Diario' }), 'folder_unavailable'));
    expect(missing).toBe(existing);
    expect((await folderNames()).size).toBe(before);
    // (Con la configuración ya sin resolver, todo el MCP responde
    // `privacy_config_unresolved`, sea cual sea la herramienta: cerrado ante la duda.)
    expect(textOf(
      (await client.callTool({ name: 'hebra_create_folder', arguments: { name: 'Diario' } })) as CallToolResult
    )).toBe('{"error":"privacy_config_unresolved"}');
  });

  it('choque con una hermana OCULTA que el filtro no ve como ruta privada: folder_unavailable, la misma respuesta', async () => {
    test = await buildTestContext({ privateFolders: [[CAFE_NFC.toLowerCase()]], privateTags: [] });
    await port().writeExclusive((store) => store.folderCreate(ROOT_FOLDER_ID, CAFE_NFC));
    const ctx = await fresh();
    expect(ctx.privacy.unresolved).toBe(false);
    const before = (await folderNames()).size;
    // La ruta privada exacta (decidida por la configuración)…
    const byConfig = wire(await expectCode(runCreateFolder(ctx, { name: CAFE_NFC }), 'folder_unavailable'));
    // …y la otra forma del mismo nombre: su ruta no es la configurada, pero el motor la
    // tomaría por la misma carpeta (NFC) y diría `folder_name_taken` con una hermana oculta.
    const byHomonym = wire(await expectCode(runCreateFolder(ctx, { name: CAFE_NFD }), 'folder_unavailable'));
    expect(byHomonym).toBe(byConfig);
    expect((await folderNames()).size).toBe(before);
  });

  it('el escritor lo vuelve a decidir dentro de su turno, aunque la petición no pase por la herramienta', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const write = test.ctx.write!;
    const before = (await folderNames()).size;
    await expect(
      write.createFolder({ parentId: ROOT_FOLDER_ID, name: 'Diario', privacy: DEFAULT_PRIVACY })
    ).rejects.toMatchObject({ code: 'folder_unavailable' });
    await expect(
      write.createFolder({ parentId: test.library.folders.diario, name: 'x', privacy: DEFAULT_PRIVACY })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      write.renameFolder({ id: test.library.folders.proyectos, name: 'Diario', privacy: DEFAULT_PRIVACY })
    ).rejects.toMatchObject({ code: 'folder_unavailable' });
    expect((await folderNames()).size).toBe(before);
  });

  it('renombra una carpeta visible, e idempotente con el nombre que ya tiene', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const id = test.library.folders.historial;
    const renamed = await runRenameFolder(await fresh(), { folderId: id, name: ' Archivo ' });
    expect(renamed).toEqual({ id, path: 'archivo', renamed: true, sync: 'not_linked' });
    expect((await folderNames()).get(id)).toBe('Archivo');

    const before = (await port().foldersList()).folders.find((folder) => folder.id === id);
    const again = await runRenameFolder(await fresh(), { folderId: id, name: 'Archivo' });
    expect(again).toEqual({ ...renamed, renamed: false });
    const after = (await port().foldersList()).folders.find((folder) => folder.id === id);
    expect(after?.updatedAt).toBe(before?.updatedAt);

    // Solo cambiar mayúsculas es renombrar (el motor no choca consigo misma).
    expect(await runRenameFolder(await fresh(), { folderId: id, name: 'ARCHIVO' })).toMatchObject({
      renamed: true,
      path: 'archivo'
    });
  });

  it('renombrar con una carpeta privada debajo, o hacia una ruta privada: folder_unavailable, sin escribir', async () => {
    test = await buildTestContext({ privateFolders: [['proyectos', 'lumbre']], privateTags: [] });
    const before = await folderNames();
    const responses = new Set<string>();
    // `Proyectos` tiene `Proyectos/Lumbre` (privada) debajo: renombrarla cambiaría su ruta.
    responses.add(
      wire(
        await expectCode(
          runRenameFolder(await fresh(), { folderId: test.library.folders.proyectos, name: 'Otros' }),
          'folder_unavailable'
        )
      )
    );
    // `Historial` → `Proyectos`? Choque con una hermana visible: eso no es privado.
    await expectCode(
      runRenameFolder(await fresh(), { folderId: test.library.folders.historial, name: 'Proyectos' }),
      'folder_name_taken'
    );
    // Una carpeta nueva dentro de `Proyectos` renombrada a `Lumbre`: la ruta resultante es
    // la privada.
    const sibling = await runCreateFolder(await fresh(), { parent: 'Proyectos', name: 'Tmp' });
    responses.add(
      wire(
        await expectCode(
          runRenameFolder(await fresh(), { folderId: sibling.id, name: 'Lumbre' }),
          'folder_unavailable'
        )
      )
    );
    expect([...responses]).toEqual(['{"error":"folder_unavailable"}']);
    const after = await folderNames();
    expect(after.get(test.library.folders.proyectos)).toBe(before.get(test.library.folders.proyectos));
    expect(after.get(sibling.id)).toBe('Tmp');
  });

  it('choque al renombrar: folder_name_taken con una hermana visible, folder_unavailable con una oculta', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const id = test.library.folders.historial;
    const taken = await expectCode(
      runRenameFolder(await fresh(), { folderId: id, name: 'adjuntos' }),
      'folder_name_taken'
    );
    expect(wire(taken)).toBe('{"error":"folder_name_taken"}');
    await expectCode(runRenameFolder(await fresh(), { folderId: id, name: 'Diario' }), 'folder_unavailable');
    expect((await folderNames()).get(id)).toBe('Historial');
  });

  it('renombrar la raíz, una carpeta oculta o una que no existe', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    await expectCode(runRenameFolder(await fresh(), { folderId: ROOT_FOLDER_ID, name: 'x' }), 'invalid_input');
    const hidden = wire(
      await expectCode(
        runRenameFolder(await fresh(), { folderId: test.library.folders.diario2026, name: 'x' }),
        'not_found'
      )
    );
    const missing = wire(
      await expectCode(runRenameFolder(await fresh(), { folderId: 'no-existe', name: 'x' }), 'not_found')
    );
    expect(hidden).toBe(missing);
  });

  it('nombres que no valen: invalid_input, sin crear nada', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const before = (await folderNames()).size;
    for (const name of ['', '   ', 'a/b', 'x'.repeat(256), 'a\nb', `a${String.fromCharCode(0x2028)}b`, 'a\u0000b']) {
      await expectCode(runCreateFolder(await fresh(), { name }), 'invalid_input');
      await expectCode(
        runRenameFolder(await fresh(), { folderId: test.library.folders.historial, name }),
        'invalid_input'
      );
    }
    await expectCode(
      runCreateFolder(await fresh(), { name: 'x', parent: 'Proyectos', parentId: ROOT_FOLDER_ID }),
      'invalid_input'
    );
    expect((await runCreateFolder(await fresh(), { name: 'x'.repeat(255) })).created).toBe(true);
    expect((await folderNames()).size).toBe(before + 1);
  });

  it('nombres con caracteres de formato invisibles (Unicode Cf): invalid_input', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const before = (await folderNames()).size;
    for (const code of [0x200b, 0x202e, 0xfeff, 0x00ad, 0x2066]) {
      const name = `Ca${String.fromCharCode(code)}rpeta`;
      await expectCode(runCreateFolder(await fresh(), { name }), 'invalid_input');
      await expectCode(
        runRenameFolder(await fresh(), { folderId: test.library.folders.historial, name }),
        'invalid_input'
      );
    }
    // Un invisible delante de «Diario» tampoco esquiva la ruta privada: no llega a mirarse.
    await expectCode(
      runCreateFolder(await fresh(), { name: `${String.fromCharCode(0x200b)}Diario` }),
      'invalid_input'
    );
    expect((await folderNames()).size).toBe(before);
  });

  it('otra instancia en solo lectura sin escritor: busy_other_instance', async () => {
    test = await buildTestContext(DEFAULT_PRIVACY);
    const busy = await openBusyWriteContext(test);
    closers.push(async () => busy.close());
    const ctx: ToolContext = { ...(await fresh()), write: busy.write };
    await expectCode(runCreateFolder(ctx, { name: 'Nueva' }), 'busy_other_instance');
    await expectCode(
      runRenameFolder(ctx, { folderId: test.library.folders.historial, name: 'Nueva' }),
      'busy_other_instance'
    );
  });
});
