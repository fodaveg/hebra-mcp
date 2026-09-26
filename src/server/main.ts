/**
 * Punto de entrada del binario `hebra-mcp` (SPEC.md §7, §10 L1-L2). Subcomandos:
 *
 * - `serve`: el servidor MCP por stdio (`./serve.ts`). Stdout es EXCLUSIVO del protocolo
 *   MCP (§6.4): cualquier aviso va a stderr. Con los secretos de `pair` en el llavero,
 *   sincroniza; sin ellos, sirve la SQLite local sin sync (`linked: false`).
 * - `pair [--lumbre <origen>] [--label <etiqueta>]`: emparejado interactivo
 *   (`../pair/pair.ts`). Aquí stdout es la terminal de David; stderr, solo eventos cerrados.
 * - `unpair`: borra los secretos y el directorio de datos, tras confirmar
 *   (`../pair/unpair.ts`).
 *
 * `main()` solo se ejecuta cuando este fichero es el módulo que arrancó Node (no al
 * importarlo): `scripts/check-bundle.mjs` importa dinámicamente CADA fichero de `dist/`
 * para su prueba de humo, y arrancar el servidor ahí (esperando stdio que no existe) lo
 * colgaría.
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// Solo `version`: esbuild recorta un JSON importado por nombre, y el `package.json`
// entero metería en `dist/` los nombres de las devDependencies (entre ellas
// `@tauri-apps/api`, solo por tipos: `src/vendor-types.d.ts`).
import { version } from '../../package.json';
import { logEvent } from '../log/logger';
import { PairError } from '../pair/errors';
import { DEFAULT_LUMBRE_ORIGIN } from '../pair/lumbre';
import { DEFAULT_PAIR_LABEL, runPair } from '../pair/pair';
import { openInBrowser, stdioTerminal } from '../pair/terminal';
import { runUnpair } from '../pair/unpair';
import { resolveDataDir } from '../privacy';
import { openKeyringSecretStore, type SecretStore } from '../secrets';
import { buildMcpServer } from './build-server';
import { openServeContext } from './serve';

const USAGE = [
  'uso:',
  '  hebra-mcp serve',
  `  hebra-mcp pair [--lumbre ${DEFAULT_LUMBRE_ORIGIN}] [--label "${DEFAULT_PAIR_LABEL}"]`,
  '  hebra-mcp unpair'
].join('\n');

/** El llavero, o `null` si el módulo nativo no carga en esta plataforma. */
async function keyringOrNull(): Promise<SecretStore | null> {
  try {
    return await openKeyringSecretStore();
  } catch {
    logEvent({ event: 'secrets.keyring', result: 'unavailable' });
    return null;
  }
}

async function serve(): Promise<void> {
  const { ctx, close } = await openServeContext({
    dataDir: resolveDataDir(),
    secrets: await keyringOrNull()
  });
  const server: McpServer = buildMcpServer(ctx, version);
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    await server.close();
    await close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await server.connect(transport);
}

/** `pair` y `unpair` necesitan el llavero: sin él no hay dónde guardar ni qué borrar. */
async function interactive(
  run: (secrets: SecretStore, terminal: ReturnType<typeof stdioTerminal>) => Promise<void>
): Promise<void> {
  const secrets = await openKeyringSecretStore();
  const terminal = stdioTerminal();
  try {
    await run(secrets, terminal);
  } catch (error) {
    if (!(error instanceof PairError)) throw error;
    terminal.print(error.message);
    logEvent({ event: 'pair.failed', code: error.code });
    process.exitCode = 1;
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  switch (subcommand) {
    case 'serve':
      await serve();
      return;
    case 'pair': {
      const { values } = parseArgs({
        args: rest,
        options: { lumbre: { type: 'string' }, label: { type: 'string' } },
        strict: true
      });
      await interactive(async (secrets, terminal) => {
        await runPair({
          dataDir: resolveDataDir(),
          secrets,
          terminal,
          lumbreOrigin: values.lumbre,
          label: values.label,
          openUrl: openInBrowser
        });
      });
      // El sync y los temporizadores ya se cerraron; lo que quede (keep-alive de fetch)
      // no debe dejar la terminal colgada.
      process.exit(process.exitCode ?? 0);
      return;
    }
    case 'unpair':
      await interactive(async (secrets, terminal) => {
        await runUnpair({ dataDir: resolveDataDir(), secrets, terminal });
      });
      process.exit(process.exitCode ?? 0);
      return;
    default:
      process.stderr.write(`${USAGE}\n`);
      process.exit(1);
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error: unknown) => {
    // Nombre y `code` del error, no su mensaje: desde L2 aquí pueden llegar errores de red,
    // del llavero o de un `JSON.parse` de una respuesta de Lumbre, y el mensaje de este
    // último cita el texto recibido (que podría llevar un token).
    const name = error instanceof Error ? error.name : 'unknown';
    const code = (error as { code?: unknown } | null)?.code;
    process.stderr.write(
      `${JSON.stringify({ event: 'fatal', error: name, ...(typeof code === 'string' ? { code } : {}) })}\n`
    );
    process.exit(1);
  });
}
