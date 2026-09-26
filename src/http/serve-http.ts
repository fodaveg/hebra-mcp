/**
 * `hebra-mcp serve-http` (SPEC.md §12.1): el conector remoto de claude.ai. Un único
 * proceso atiende a todas las sesiones y SIEMPRE es el escritor: toma `writer.lock` como
 * `serve` y, si otro proceso vivo lo tiene, no arranca (`writer_lock_held`). Nunca
 * reenvía por `writer.sock` (`openServeContext({ writerOnly: true })`).
 *
 * Orden de arranque: primero la autenticación (sin ella no se abre ni la biblioteca ni el
 * sync: `auth_not_configured`), después el contexto (llavero o almacén de secretos,
 * bloqueo, sync), y por último el listener. Si el listener falla, se cierra el contexto y
 * se suelta el bloqueo.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { logEvent } from '../log/logger';
import type { SecretStore } from '../secrets';
import { openServeContext, type OpenServeOptions, type ServeContext } from '../server/serve';
import { createHttpApp, type HttpAuth } from './app';
import type { HttpConfig } from './config';

/** No arranca: sin autenticación configurada. El mensaje dice qué hacer, sin valores. */
export class ServeHttpError extends Error {
  constructor(
    readonly code: 'auth_not_configured',
    message: string
  ) {
    super(message);
    this.name = 'ServeHttpError';
  }
}

export interface StartServeHttpOptions
  extends Pick<OpenServeOptions, 'fetcher' | 'instance' | 'syncIntervalMs'> {
  dataDir: string;
  secrets: SecretStore | null;
  config: HttpConfig;
  version: string;
  /** La autenticación de `/mcp`, o `null` si no está configurada (y entonces no arranca). */
  loadAuth(dataDir: string, config: HttpConfig): Promise<HttpAuth | null>;
}

export interface ServeHttpHandle {
  /** Puerto real de escucha (con `config.port` 0, el que eligió el sistema). */
  port: number;
  serve: ServeContext;
  server: Server;
  close(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

export async function startServeHttp(options: StartServeHttpOptions): Promise<ServeHttpHandle> {
  const auth = await options.loadAuth(options.dataDir, options.config);
  if (!auth) {
    throw new ServeHttpError(
      'auth_not_configured',
      'serve-http no arranca sin el secreto del dueño: fíjalo con `hebra-mcp oauth-set-secret`.'
    );
  }
  const serve = await openServeContext({
    dataDir: options.dataDir,
    secrets: options.secrets,
    fetcher: options.fetcher,
    instance: options.instance,
    syncIntervalMs: options.syncIntervalMs,
    writerOnly: true
  });
  const app = createHttpApp({ ctx: serve.ctx, version: options.version, config: options.config, auth });
  const server = createServer(app);
  try {
    await listen(server, options.config.port, options.config.listenHost);
  } catch (error) {
    await serve.close();
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  logEvent({ event: 'serve_http.listening', port });

  let closing: Promise<void> | null = null;
  return {
    port,
    serve,
    server,
    close() {
      closing ??= (async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await serve.close();
      })();
      return closing;
    }
  };
}
