/**
 * Punto de entrada del binario `hebra-mcp` (SPEC.md §7.5, §10 L1). Único subcomando de
 * L1: `serve`, que arranca el servidor MCP por stdio. Stdout es EXCLUSIVO del protocolo
 * MCP (§6.4): cualquier aviso va a stderr.
 *
 * Sin emparejado (L2) todavía no hay biblioteca real que abrir: `serve` abre (o crea,
 * vacía) la SQLite del directorio de datos. Con la biblioteca vacía, las herramientas
 * responden vacías y `hebra_status` dice `linked: false`, que es justo L1 (SPEC.md §10).
 */
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pkg from '../../package.json';
import { openNodeLibraryPort } from '../store';
import { loadPrivacyConfig, resolveDataDir, PrivacyFilter } from '../privacy';
import { UnlinkedStatusSource } from '../status/status-source';
import { buildMcpServer } from './build-server';
import type { ServerContext } from './context';

const LIBRARY_FILENAME = 'library.sqlite';

async function serve(): Promise<void> {
  const dataDir = resolveDataDir();
  const [port, privacyConfig] = await Promise.all([
    openNodeLibraryPort({ sqlitePath: join(dataDir, LIBRARY_FILENAME), dataDir }),
    loadPrivacyConfig(dataDir)
  ]);
  const privacy = await PrivacyFilter.build(port, privacyConfig);
  const ctx: ServerContext = { port, privacy, status: new UnlinkedStatusSource() };

  const server: McpServer = buildMcpServer(ctx, pkg.version);
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    await server.close();
    port.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await server.connect(transport);
}

async function main(): Promise<void> {
  const [subcommand] = process.argv.slice(2);
  if (subcommand !== 'serve') {
    process.stderr.write('uso: hebra-mcp serve\n');
    process.exit(1);
    return;
  }
  await serve();
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ event: 'fatal', message: String(error) })}\n`);
  process.exit(1);
});
