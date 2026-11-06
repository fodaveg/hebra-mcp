/**
 * Las últimas herramientas que pasan a `privacyLoad: 'lazy'` (A9b del plan de memoria, 6 nov
 * 2026): `hebra_list_spaces`, `hebra_list_organizations`, `hebra_status`, `hebra_create_folder`
 * y `hebra_rename_folder`. Ninguna pregunta al filtro de privados por una nota: las dos primeras
 * leen el catálogo y el directorio del relé, `hebra_status` solo la configuración, y las de
 * carpetas solo el árbol de carpetas y la configuración (cabecera de
 * `src/server/tools/folders.ts`). Por eso basta la marca, sin `ensure`.
 *
 * Las lecturas pasan por `expectLazyEquivalent` (`test/fixtures/privacy-load.ts`). Las escrituras
 * de carpetas, por dos copias idénticas de la biblioteca (`twinHarness`,
 * `test/fixtures/privacy-load-writes.ts`), comparando además el árbol de carpetas: el estado que
 * mira `expectLazyWriteEquivalent` es el de las notas, y estas herramientas no tocan notas. El
 * id de una carpeta creada lo elige el motor al azar, así que se compara por su ruta.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PrivacyConfig } from '../../src/privacy';
import type { DirectoryView, ServerContext } from '../../src/server/context';
import type { NodeLibraryPort } from '../../src/store';
import { callToolWithLoad, expectLazyEquivalent } from '../fixtures/privacy-load';
import { libraryState, twinHarness, type TwinCalls, type TwinHarness } from '../fixtures/privacy-load-writes';
import { buildTestContext, type TestContext } from '../fixtures/test-context';

const GRANTED_SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SELF = 'a'.repeat(32);

/** Un directorio de relé con una organización, un espacio con concesión y otro sin ella. */
function withDirectory(base: ServerContext): ServerContext {
  const view: DirectoryView = {
    selfAccountId: SELF,
    directory: {
      organizations: [
        {
          orgId: 'c'.repeat(32),
          name: 'Organización de prueba',
          members: [
            { accountId: SELF, role: 'admin', name: 'Yo' },
            { accountId: 'd'.repeat(32), role: 'member', name: null }
          ],
          spaces: [
            { spaceId: GRANTED_SPACE, name: 'Equipo', granted: true },
            { spaceId: OTHER_SPACE, name: null, granted: false }
          ]
        }
      ],
      spaces: []
    }
  };
  return {
    ...base,
    spaces: {
      list: async () => [{ spaceId: GRANTED_SPACE, name: 'Equipo (descifrado)' }],
      resolve: async () => {
        throw new Error('no se usa');
      }
    },
    directory: async () => view
  };
}

describe("lecturas sin notas con privacyLoad lazy: igual que con la biblioteca entera", () => {
  let test: TestContext | undefined;

  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('hebra_status: el mismo estado y las mismas capabilities', async () => {
    test = await buildTestContext();
    const call = await expectLazyEquivalent(test.serverContext, 'hebra_status', {});
    expect(call.isError).toBe(false);
    expect(call.json.capabilities).toBeDefined();
  });

  it('hebra_status con una carpeta privada configurada que no existe: privacy_config_unresolved', async () => {
    test = await buildTestContext();
    const unresolved: PrivacyConfig = { privateFolders: [['no-existe']], privateTags: [] };
    const call = await expectLazyEquivalent({ ...test.serverContext, privacyConfig: unresolved }, 'hebra_status', {});
    expect(call.isError).toBe(true);
    expect(JSON.stringify(call.result)).toContain('privacy_config_unresolved');
  });

  it('hebra_list_spaces sin espacios: lista vacía y organizationsAvailable false', async () => {
    test = await buildTestContext();
    const call = await expectLazyEquivalent(test.serverContext, 'hebra_list_spaces', {});
    expect(call.json).toEqual({ spaces: [], organizationsAvailable: false });
  });

  it('hebra_list_spaces con directorio: los espacios con su organización y `granted`', async () => {
    test = await buildTestContext();
    const call = await expectLazyEquivalent(withDirectory(test.serverContext), 'hebra_list_spaces', {});
    expect(call.json.organizationsAvailable).toBe(true);
    expect(call.json.spaces).toEqual([
      expect.objectContaining({ spaceId: GRANTED_SPACE, name: 'Equipo (descifrado)', granted: true }),
      expect.objectContaining({ spaceId: OTHER_SPACE, name: null, granted: false })
    ]);
  });

  it('hebra_list_organizations con directorio: miembros con isSelf y espacios', async () => {
    test = await buildTestContext();
    const call = await expectLazyEquivalent(withDirectory(test.serverContext), 'hebra_list_organizations', {});
    expect(call.isError).toBe(false);
    expect(call.json.organizations).toHaveLength(1);
    expect(call.json.organizations[0].members).toEqual([
      { accountId: SELF, role: 'admin', name: 'Yo', isSelf: true },
      { accountId: 'd'.repeat(32), role: 'member', name: null, isSelf: false }
    ]);
  });

  it('hebra_list_organizations sin directorio: organizations_unavailable', async () => {
    test = await buildTestContext();
    const call = await expectLazyEquivalent(test.serverContext, 'hebra_list_organizations', {});
    expect(call.isError).toBe(true);
    expect(JSON.stringify(call.result)).toContain('organizations_unavailable');
  });
});

/** El árbol de carpetas de una copia como rutas (`Proyectos/Lumbre`), ordenadas: los ids de las
 *  creadas difieren entre copias, las rutas no. */
async function folderPaths(port: NodeLibraryPort): Promise<string[]> {
  const { folders } = await port.foldersList();
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const pathOf = (id: string, seen = new Set<string>()): string => {
    const folder = byId.get(id);
    if (!folder || folder.parentId === null || seen.has(id)) return folder?.name ?? '';
    seen.add(id);
    const parent = pathOf(folder.parentId, seen);
    return parent ? `${parent}/${folder.name}` : folder.name;
  };
  return folders.map((folder) => pathOf(folder.id)).sort();
}

/** La respuesta MCP con el texto JSON analizado y, si se pide, el `id` cambiado por un marcador. */
function comparable(result: CallToolResult, maskId: boolean): unknown {
  return {
    isError: result.isError === true,
    content: result.content.map((block) => {
      if (block.type !== 'text') return block;
      let json: unknown;
      try {
        json = JSON.parse(block.text);
      } catch {
        return block;
      }
      if (maskId && json && typeof json === 'object' && 'id' in json) json = { ...json, id: '<id>' };
      return { type: 'text', json };
    })
  };
}

/**
 * Llama a `name` en las dos copias (`'all'` forzado en una, la carga declarada en la otra) y
 * exige: registrada `'lazy'`, sin preguntas por notas no cargadas, la misma respuesta (con el id
 * de la carpeta creada como marcador en `hebra_create_folder`), el mismo árbol de carpetas y el
 * mismo estado de las notas.
 */
async function expectLazyFolderWrite(
  h: TwinHarness<void>,
  name: 'hebra_create_folder' | 'hebra_rename_folder',
  args: Record<string, unknown>
): Promise<TwinCalls> {
  const all = await callToolWithLoad(h.all.serverContext, name, args, 'all');
  const lazy = await callToolWithLoad(h.lazy.serverContext, name, args);
  expect(lazy.declared, `${name} no está registrada con privacyLoad: 'lazy'`).toBe('lazy');
  expect(lazy.unloadedLookups, `${name} preguntó por notas que no cargó con ensure`).toBe(0);
  const maskId = name === 'hebra_create_folder';
  expect(comparable(lazy.result, maskId), `${name} responde distinto con 'lazy' que con 'all'`).toEqual(
    comparable(all.result, maskId)
  );
  expect(await folderPaths(h.lazy.port), `${name} deja las carpetas distintas`).toEqual(
    await folderPaths(h.all.port)
  );
  expect(libraryState(h.lazy.sqlitePath)).toEqual(libraryState(h.all.sqlitePath));
  return { all, lazy };
}

/** El código de error de una respuesta (`null` si no es un error). */
function errorCode(call: TwinCalls['lazy']): string | null {
  return call.isError ? (call.json?.error ?? JSON.stringify(call.result)) : null;
}

describe('carpetas con privacyLoad lazy: igual que con la biblioteca entera', () => {
  let h: TwinHarness<void> | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  const harness = (): Promise<TwinHarness<void>> => twinHarness<void>(async () => undefined);

  describe('hebra_create_folder', () => {
    it('en la raíz: la crea; repetida, la misma con created: false', async () => {
      h = await harness();
      const first = await expectLazyFolderWrite(h, 'hebra_create_folder', { name: 'Perezosa' });
      // Las rutas de la respuesta salen en minúsculas, como `path` de hebra_list_folders.
      expect(first.lazy.json).toMatchObject({ path: 'perezosa', created: true });
      const again = await expectLazyFolderWrite(h, 'hebra_create_folder', { name: 'Perezosa' });
      expect(again.lazy.json).toMatchObject({ path: 'perezosa', created: false });
    });

    it('dentro de una visible, por ruta y por id', async () => {
      h = await harness();
      const byPath = await expectLazyFolderWrite(h, 'hebra_create_folder', { name: 'Dentro', parent: 'Proyectos' });
      expect(byPath.lazy.json).toMatchObject({ path: 'proyectos/dentro', created: true });
      const byId = await expectLazyFolderWrite(h, 'hebra_create_folder', {
        name: 'Otra',
        parentId: h.library.folders.lumbre
      });
      expect(byId.lazy.json).toMatchObject({ path: 'proyectos/lumbre/otra', created: true });
    });

    it('ruta privada, padre privado o inexistente: el mismo rechazo en las dos cargas', async () => {
      h = await harness();
      const privatePath = await expectLazyFolderWrite(h, 'hebra_create_folder', { name: 'diario' });
      expect(privatePath.lazy.isError).toBe(true);
      expect(errorCode(privatePath.lazy)).toContain('folder_unavailable');
      for (const args of [
        { name: 'Nada', parent: 'Diario' },
        { name: 'Nada', parentId: h.library.folders.diario2026 },
        { name: 'Nada', parent: 'No/Existe' }
      ]) {
        const call = await expectLazyFolderWrite(h, 'hebra_create_folder', args);
        expect(call.lazy.isError, JSON.stringify(args)).toBe(true);
      }
    });
  });

  describe('hebra_rename_folder', () => {
    it('una visible: la renombra; con el nombre que ya tiene, renamed: false', async () => {
      h = await harness();
      const folderId = h.library.folders.historial;
      const first = await expectLazyFolderWrite(h, 'hebra_rename_folder', { folderId, name: 'Historia' });
      expect(first.lazy.json).toMatchObject({ id: folderId, path: 'historia', renamed: true });
      const again = await expectLazyFolderWrite(h, 'hebra_rename_folder', { folderId, name: 'Historia' });
      expect(again.lazy.json).toMatchObject({ id: folderId, path: 'historia', renamed: false });
    });

    it('choque con una hermana visible, ruta privada, carpeta privada o inexistente: el mismo rechazo', async () => {
      h = await harness();
      const taken = await expectLazyFolderWrite(h, 'hebra_rename_folder', {
        folderId: h.library.folders.historial,
        name: 'Proyectos'
      });
      expect(errorCode(taken.lazy)).toContain('folder_name_taken');
      const privatePath = await expectLazyFolderWrite(h, 'hebra_rename_folder', {
        folderId: h.library.folders.historial,
        name: 'diario'
      });
      expect(errorCode(privatePath.lazy)).toContain('folder_unavailable');
      for (const folderId of [h.library.folders.diario, h.library.folders.diario2026, 'no-existe-0000']) {
        const call = await expectLazyFolderWrite(h, 'hebra_rename_folder', { folderId, name: 'Renombrada' });
        expect(call.lazy.isError, folderId).toBe(true);
      }
    });
  });
});
