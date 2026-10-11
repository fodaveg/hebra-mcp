/**
 * M5 del audit de privacidad adversarial (10 oct 2026, deducido sin sonda): `config.json`
 * solo se leía al arrancar, así que un proceso arrancado antes de configurar una carpeta
 * privada seguía sirviéndola (y el escritor aplica la configuración que le manda cada
 * lector). Decisión de la sesión principal (11 oct 2026): en `serve` se relee cuando cambia,
 * mirando en cada llamada el `mtime` y el tamaño del fichero, y se aplica en esa misma
 * llamada. Un fichero que no se puede leer o no es JSON válido deja todas las herramientas
 * en `privacy_config_unresolved` hasta que se arregle (cerrado ante la duda).
 *
 * Por `openServeContext`, como lo monta `hebra-mcp serve` (sin secretos: nunca el llavero).
 */
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../../src/server/register-tools';
import { openServeContext } from '../../src/server/serve';
import { buildTestLibrary } from '../fixtures/test-library';
import { removeTempDirs, tempDir } from '../workdir/helpers';

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirs();
});

/** Escribe `config.json` y le pone un `mtime` distinto cada vez (sin depender del reloj). */
let tick = 1_800_000_000;
function writeConfig(dataDir: string, text: string): void {
  const path = join(dataDir, 'config.json');
  writeFileSync(path, text);
  tick += 10;
  utimesSync(path, tick, tick);
}

describe('M5: serve relee config.json cuando cambia', () => {
  it('una carpeta privada añadida con el proceso vivo se oculta en la llamada siguiente', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const dataDir = tempDir();
    const library = await buildTestLibrary(join(dataDir, 'library.sqlite'));
    writeConfig(dataDir, JSON.stringify({ privateFolders: [], privateTags: [] }));
    const served = await openServeContext({
      dataDir,
      secrets: null,
      instance: { lock: { releaseOnExit: false }, checkIntervalMs: null }
    });
    const server = new McpServer({ name: 'hebra-mcp-m5', version: '0.0.0' });
    registerTools(server, served.ctx);
    const client = new Client({ name: 'hebra-mcp-m5-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const read = async (): Promise<unknown> => {
      const result = (await client.callTool({
        name: 'hebra_read_note',
        arguments: { id: library.privateFolderNoteId }
      })) as CallToolResult;
      const parsed = JSON.parse((result.content[0] as { text: string }).text) as { error?: string; id?: string };
      return parsed.error ?? 'visible';
    };
    try {
      expect(await read()).toBe('visible');

      writeConfig(dataDir, JSON.stringify({ privateFolders: ['Diario'], privateTags: ['secreto'] }));
      expect(await read()).toBe('not_found');

      // A medio escribir o roto: cerrado ante la duda, nada sale.
      writeConfig(dataDir, '{"privateFolders": ["Diar');
      expect(await read()).toBe('privacy_config_unresolved');
      const status = (await client.callTool({ name: 'hebra_status', arguments: {} })) as CallToolResult;
      expect(JSON.parse((status.content[0] as { text: string }).text)).toEqual({ error: 'privacy_config_unresolved' });

      // Arreglado, se aplica la nueva.
      writeConfig(dataDir, JSON.stringify({ privateFolders: [], privateTags: [] }));
      expect(await read()).toBe('visible');
    } finally {
      await client.close();
      await server.close();
      await served.close();
    }
  });
});
