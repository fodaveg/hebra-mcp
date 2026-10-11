/**
 * A3 (audit de privacidad adversarial, 10 oct 2026): la memoria de las carpetas a las que
 * resolvió cada ruta privada (`src/privacy/folder-memory.ts`). Qué se olvida (una ruta que
 * deja de estar configurada) y cuándo se anota sin que nadie llame a una herramienta: en el
 * escritor, antes de cada ronda de sync. El caso de la sonda, por las herramientas, está en
 * `./audit-a3-moved-folder.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../../src/server/register-tools';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { privacyWithMemory } from '../../src/privacy/folder-memory';
import { openNodeLibraryPort } from '../../src/store';
import type { PrivacyConfig } from '../../src/privacy';
import { BAIT_FOLDER } from '../fixtures/test-library';
import { appCreate, appDevice, InMemoryLibraryRelay, mcpDevice, type McpDevice } from '../sync/devices';
import { auditHarness, NOT_FOUND } from './audit-harness';

const CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('A3: la memoria de las rutas privadas', () => {
  it('quitar la ruta de la configuración la olvida: volver a ponerla oculta solo la de ahora', async () => {
    const h = await auditHarness(async () => ({}));
    try {
      await privacyWithMemory(h.port, CONFIG);
      await h.mutate(async (engine, library) => {
        await engine.folderMove(library.folders.diario, library.folders.historial);
        await engine.folderCreate(null, 'Diario');
      });
      const remembered = await privacyWithMemory(h.port, CONFIG);
      expect(remembered.filter.isFolderHidden(h.library.folders.diario)).toBe(true);
      expect(remembered.config.knownPrivateFolderIds).toContain(h.library.folders.diario);
      // David quita `Diario`: la memoria de esa ruta se borra.
      await privacyWithMemory(h.port, { privateFolders: [], privateTags: ['secreto'] });
      const again = await privacyWithMemory(h.port, CONFIG);
      expect(again.filter.isFolderHidden(h.library.folders.diario)).toBe(false);
      expect(again.filter.isHiddenNote(h.library.privateFolderNoteId)).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('un lector (solo lectura) recuerda en memoria lo que no puede escribir, y lee lo que anotó el escritor', async () => {
    const h = await auditHarness(async () => ({}));
    const reader = await openNodeLibraryPort({ sqlitePath: h.sqlitePath, dataDir: h.dataDir, mode: 'readOnly' });
    try {
      // El lector resuelve antes que nadie: lo guarda en su proceso.
      await privacyWithMemory(reader, CONFIG);
      expect(await h.port.rememberedPrivateFolders()).toEqual([]);
      await h.mutate(async (engine, library) => {
        await engine.folderMove(library.folders.diario, library.folders.historial);
        await engine.folderCreate(null, 'Diario');
      });
      const fromReader = await privacyWithMemory(reader, CONFIG);
      expect(fromReader.filter.isHiddenNote(h.library.privateFolderNoteId)).toBe(true);
      // El escritor anota la de ahora en la tabla; un lector nuevo la lee de ahí.
      await privacyWithMemory(h.port, CONFIG);
      const rows = await reader.rememberedPrivateFolders();
      expect(rows.map((row) => row.pathKey)).toEqual(expect.arrayContaining(['diario']));
    } finally {
      reader.close();
      await h.close();
    }
  });
});

describe('A3 por sync real: el escritor anota las carpetas privadas antes de cada ronda', () => {
  let mcp: McpDevice | undefined;

  afterEach(() => {
    mcp?.port.close();
    mcp = undefined;
  });

  it('sin ninguna llamada de herramienta entre medias, la ronda que trae la carpeta movida no la destapa', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config: PrivacyConfig = { privateFolders: [['diario']], privateTags: [] };
    const relay = new InMemoryLibraryRelay();
    mcp = await mcpDevice(relay, {
      beforeRound: async (port) => {
        await privacyWithMemory(port, config);
      }
    });
    const app = await appDevice(relay);
    const diario = await app.port.folderCreate(null, 'Diario');
    const historial = await app.port.folderCreate(null, 'Historial');
    const noteId = await appCreate(app, `# Privada\n${BAIT_FOLDER}\n`);
    await app.port.noteMove(noteId, diario.id);
    await app.sync.runRound();
    await mcp.runner.requestRound();

    // En la app: archivar `Diario` dentro de `Historial` y crear otra `Diario`.
    await app.port.folderMove(diario.id, historial.id);
    await app.port.folderCreate(null, 'Diario');
    await app.sync.runRound();
    await mcp.runner.requestRound();

    const server = new McpServer({ name: 'hebra-mcp-a3', version: '0.0.0' });
    registerTools(server, { port: mcp.port, privacyConfig: config, status: new UnlinkedStatusSource() });
    const client = new Client({ name: 'hebra-mcp-a3-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const read = (await client.callTool({ name: 'hebra_read_note', arguments: { id: noteId } })) as CallToolResult;
      expect(read.isError).toBe(true);
      expect(JSON.parse((read.content[0] as { text: string }).text)).toEqual(NOT_FOUND);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
