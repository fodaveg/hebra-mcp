/**
 * Punto de entrada del binario `hebra-mcp` (SPEC.md §7.5, §10 L1). Único subcomando de
 * L1: `serve`, que arranca el servidor MCP por stdio. Stdout es EXCLUSIVO del protocolo
 * MCP (§6.4): cualquier aviso va a stderr.
 *
 * Sin emparejado (L2) todavía no hay biblioteca real ni `sync` que configurar:
 * `LibraryInstance.open` sin `sync` abre (o crea, vacía) la SQLite del directorio de
 * datos con el escritor único de todos modos (SPEC.md §8: dos sesiones de Claude Code
 * ya son dos procesos, aunque ninguna esté emparejada). Con la biblioteca vacía, las
 * herramientas responden vacías y `hebra_status` dice `linked: false`, que es justo L1.
 *
 * `main()` solo se ejecuta cuando este fichero es el módulo que arrancó Node (no al
 * importarlo): `scripts/check-bundle.mjs` importa dinámicamente CADA fichero de `dist/`
 * para su prueba de humo, y arrancar el servidor ahí (esperando stdio que no existe) lo
 * colgaría.
 */
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pkg from '../../package.json';
import { LibraryInstance } from '../sync/library-instance';
import { loadPrivacyConfig, resolveDataDir } from '../privacy';
import { LibraryInstanceStatusSource } from '../status/status-source';
import { buildMcpServer } from './build-server';
import type { ServerContext } from './context';

async function serve(): Promise<void> {
  const dataDir = resolveDataDir();
  const [instance, privacyConfig] = await Promise.all([
    LibraryInstance.open({ dataDir, deviceLabel: 'hebra-mcp' }),
    loadPrivacyConfig(dataDir)
  ]);
  // `privacyConfig` sin resolver a `PrivacyFilter` aquí: `register-tools.ts` lo hace en
  // CADA llamada, con el almacén tal como esté en ese momento (§1 del hallazgo del
  // coordinador, 26 sep 2026: un filtro construido una vez al arrancar se queda
  // obsoleto en cuanto el sync mueve una nota a una carpeta privada, o al revés).
  const ctx: ServerContext = {
    port: instance.port,
    privacyConfig,
    status: new LibraryInstanceStatusSource(instance)
  };

  const server: McpServer = buildMcpServer(ctx, pkg.version);
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    await server.close();
    await instance.close();
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

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ event: 'fatal', message: String(error) })}\n`);
    process.exit(1);
  });
}
