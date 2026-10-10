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
 * - `serve-http`: el conector remoto de claude.ai (SPEC.md §12, `../http/`). Streamable
 *   HTTP sin estado, siempre escritor, y no arranca sin autenticación configurada.
 *   Configuración por entorno (`../http/config.ts`), nunca secretos.
 * - `oauth-revoke-all`: revocación local de todos los tokens de `serve-http`;
 *   `oauth-set-secret` devuelve un error de método sustituido (`../oauth/cli.ts`).
 * - `checkout`, `apply`, `undo`, `status`, `diff`: ficheros de trabajo con vuelta
 *   (SPEC.md §13, `../workdir/`). Aquí stdout es de quien lanza la orden.
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
import { openSecretStoreForMode, resolveSecretStoreMode, type SecretStore } from '../secrets';
import { HttpConfigError, readHttpConfig } from '../http/config';
import { ServeHttpError, startServeHttp, type ServeHttpHandle } from '../http/serve-http';
import {
  loadOAuthHttpAuth,
  oauthHttpAuthConfigured,
  OAuthCliError,
  runOAuthRevokeAll,
  runOAuthSetSecret
} from '../oauth';
import { isWorkdirCommand, runWorkdirCommand, WORKDIR_USAGE } from '../workdir/cli';
import { openWorkdirLibrary } from '../workdir/library';
import { buildMcpServer } from './build-server';
import { openServeContext, WriterRequiredError } from './serve';

const USAGE = [
  'uso:',
  '  hebra-mcp serve',
  `  hebra-mcp pair [--lumbre ${DEFAULT_LUMBRE_ORIGIN}] [--label "${DEFAULT_PAIR_LABEL}"]`,
  '  hebra-mcp unpair',
  '  hebra-mcp serve-http',
  '  hebra-mcp oauth-revoke-all',
  ...WORKDIR_USAGE
].join('\n');

/** El almacén del modo elegido (SPEC.md §12.3), o `null` si en modo `keychain` el
 *  módulo nativo no carga en esta plataforma: `serve` arranca igual, sin emparejar. En
 *  modo `file` no hay ese fallo posible al abrir (solo al leer/escribir). */
async function openServeSecretStore(dataDir: string): Promise<SecretStore | null> {
  // Fuera del `try`: un modo inválido tiene que fallar alto (`main().catch`, abajo), no
  // confundirse con «no hay llavero en esta plataforma» y arrancar sin emparejar.
  const mode = resolveSecretStoreMode();
  try {
    return await openSecretStoreForMode(mode, dataDir);
  } catch {
    logEvent({ event: 'secrets.keyring', result: 'unavailable' });
    return null;
  }
}

/** `pair` y `unpair` necesitan el almacén de verdad: a diferencia de `serve`, un fallo
 *  aquí no se traga (sin él no hay dónde guardar ni qué borrar). */
async function openPairingSecretStore(dataDir: string): Promise<SecretStore> {
  return openSecretStoreForMode(resolveSecretStoreMode(), dataDir);
}

async function serve(): Promise<void> {
  const dataDir = resolveDataDir();
  const { ctx, instance, close } = await openServeContext({
    dataDir,
    secrets: await openServeSecretStore(dataDir)
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
  // El bloqueo lo suelta `close()` al terminar de vaciar, no la señal (M1); también si
  // esta sesión arrancó de lectora y toma el relevo después.
  instance.deferSignalRelease();

  await server.connect(transport);
}

/**
 * `serve-http`: no arranca sin autenticación, siendo lector ni con configuración inválida;
 * en esos casos lo dice en stderr (qué hacer, sin valores) y sale con 1. El almacén de
 * secretos del dispositivo es el mismo que el de `serve` (`HEBRA_MCP_SECRET_STORE`; en el
 * contenedor, `file`).
 */
async function serveHttp(): Promise<void> {
  const dataDir = resolveDataDir();
  let handle: ServeHttpHandle;
  try {
    const secrets = await openServeSecretStore(dataDir);
    handle = await startServeHttp({
      dataDir,
      secrets,
      config: readHttpConfig(),
      version,
      authConfigured: () => oauthHttpAuthConfigured(secrets),
      loadAuth: (authDataDir, config, secrets) => loadOAuthHttpAuth(authDataDir, config, secrets)
    });
  } catch (error) {
    if (
      error instanceof ServeHttpError ||
      error instanceof WriterRequiredError ||
      error instanceof HttpConfigError
    ) {
      logEvent({ event: 'serve_http.failed', code: error.code });
      process.stderr.write(`${serveHttpFailureMessage(error)}\n`);
      process.exit(1);
    }
    throw error;
  }
  // Apagado (A1 y M1 del audit de robustez, 10 oct 2026): `handle.close()` corta las
  // esperas de ronda de las escrituras en curso, espera a que respondan las peticiones HTTP
  // (`HTTP_DRAIN_TIMEOUT_MS`) y después vacía la cola, para el sync y suelta `writer.lock`
  // (`deferSignalRelease`: la señal no lo suelta). El contenedor da 50 s
  // (`stop_grace_period`).
  const shutdown = async (): Promise<void> => {
    await handle.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  handle.serve.instance.deferSignalRelease();
}

function serveHttpFailureMessage(error: ServeHttpError | WriterRequiredError | HttpConfigError): string {
  if (error instanceof WriterRequiredError) {
    return 'serve-http tiene que ser el escritor único y otro proceso de hebra-mcp tiene writer.lock.';
  }
  return error.message;
}

/** `oauth-set-secret` y `oauth-revoke-all`: un error de uso se dice en stderr y sale con 1. */
async function oauthCommand(run: (dataDir: string) => Promise<void>): Promise<void> {
  try {
    await run(resolveDataDir());
  } catch (error) {
    if (!(error instanceof OAuthCliError)) throw error;
    logEvent({ event: 'oauth.cli.failed', code: error.code });
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

async function interactive(
  dataDir: string,
  run: (secrets: SecretStore, terminal: ReturnType<typeof stdioTerminal>) => Promise<void>
): Promise<void> {
  const secrets = await openPairingSecretStore(dataDir);
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

/**
 * Ficheros de trabajo (SPEC.md §13): `checkout`, `apply`, `undo`, `status` y `diff`. La
 * biblioteca se abre como en `serve` (mismo directorio de datos, mismos secretos, mismo
 * `writer.lock`): escritor si nadie lo es, lector que reenvía si no. Sale con el código de
 * la orden; `process.exit` corta lo que quede vivo (keep-alive de fetch).
 */
async function workdir(subcommand: Parameters<typeof runWorkdirCommand>[0], rest: string[]): Promise<void> {
  const dataDir = resolveDataDir();
  const code = await runWorkdirCommand(
    subcommand,
    rest,
    {
      cwd: process.cwd(),
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`)
    },
    async () => openWorkdirLibrary({ dataDir, secrets: await openServeSecretStore(dataDir) })
  );
  process.exit(code);
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (isWorkdirCommand(subcommand)) {
    await workdir(subcommand, rest);
    return;
  }
  switch (subcommand) {
    case 'serve':
      await serve();
      return;
    case 'serve-http':
      await serveHttp();
      return;
    case 'oauth-set-secret':
      await oauthCommand(() => runOAuthSetSecret());
      return;
    case 'oauth-revoke-all':
      await oauthCommand((dataDir) => runOAuthRevokeAll(dataDir, { print: (line) => process.stdout.write(`${line}\n`) }));
      return;
    case 'pair': {
      const { values } = parseArgs({
        args: rest,
        options: { lumbre: { type: 'string' }, label: { type: 'string' } },
        strict: true
      });
      const dataDir = resolveDataDir();
      await interactive(dataDir, async (secrets, terminal) => {
        await runPair({
          dataDir,
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
    case 'unpair': {
      const dataDir = resolveDataDir();
      await interactive(dataDir, async (secrets, terminal) => {
        await runUnpair({ dataDir, secrets, terminal });
      });
      process.exit(process.exitCode ?? 0);
      return;
    }
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
