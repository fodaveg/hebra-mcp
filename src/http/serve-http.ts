/**
 * `hebra-mcp serve-http` (SPEC.md §12.1): el conector remoto de claude.ai. Un único
 * proceso atiende a todas las sesiones y SIEMPRE es el escritor: toma `writer.lock` como
 * `serve` y, si otro proceso vivo lo tiene, no arranca (`writer_lock_held`). Nunca
 * reenvía por `writer.sock` (`openServeContext({ writerOnly: true })`).
 *
 * Orden de arranque: preflight de configuración sin efectos; después el contexto
 * adquiere el bloqueo de escritor; solo entonces se abre el OAuth mutable y el listener.
 * Cualquier fallo posterior cierra el contexto y suelta el bloqueo.
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

/**
 * Cuánto espera `close()` a las peticiones HTTP en curso antes de cortar las conexiones
 * (A1 del audit de robustez, 10 oct 2026). Antes las cortaba en el acto: la escritura que
 * ya estaba en la cola se guardaba igual (`closeWhenIdle`), pero su respuesta se perdía y
 * el reintento del agente duplicaba un `hebra_append_to_note`. Cabe en el
 * `stop_grace_period` del contenedor (`deploy/compose.yml`, 40 s) junto con los 10 s de
 * espera de la ronda de una escritura y el vaciado de `serve.close()`.
 */
export const HTTP_DRAIN_TIMEOUT_MS = 8_000;

export interface StartServeHttpOptions
  extends Pick<OpenServeOptions, 'fetcher' | 'instance' | 'syncIntervalMs'> {
  dataDir: string;
  secrets: SecretStore | null;
  config: HttpConfig;
  version: string;
  /** Tests: espera más corta a las peticiones en curso (`HTTP_DRAIN_TIMEOUT_MS`). */
  drainTimeoutMs?: number;
  /** Comprobación pura: nunca lee ni escribe el almacén ni llama al broker. */
  authConfigured(): boolean;
  /** La autenticación de `/mcp`, o `null` si no está configurada (y entonces no arranca). */
  loadAuth(dataDir: string, config: HttpConfig, secrets: SecretStore | null): Promise<HttpAuth | null>;
}

export interface ServeHttpHandle {
  /** Puerto real de escucha (con `config.port` 0, el que eligió el sistema). */
  port: number;
  serve: ServeContext;
  server: Server;
  /**
   * Apagado ordenado: deja de aceptar conexiones, espera hasta `HTTP_DRAIN_TIMEOUT_MS` a
   * que respondan las peticiones en curso, corta lo que quede y después cierra el
   * contexto (vacía la cola del almacén, para el sync y suelta el bloqueo).
   */
  close(): Promise<void>;
}

/**
 * Cuenta las peticiones que aún no han terminado de responder, para que `close()` pueda
 * esperarlas. Una respuesta termina con `close` (enviada o cortada). `idle` resuelve
 * `true` si no queda ninguna en curso y `false` si se acabó el plazo antes.
 */
function trackInFlight(server: Server): { idle(timeoutMs: number): Promise<boolean> } {
  let inFlight = 0;
  const waiters = new Set<() => void>();
  server.on('request', (_req, res) => {
    inFlight += 1;
    res.once('close', () => {
      inFlight -= 1;
      if (inFlight === 0) for (const wake of [...waiters]) wake();
    });
  });
  return {
    idle(timeoutMs) {
      if (inFlight === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const finish = (drained: boolean): void => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve(drained);
        };
        const wake = (): void => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        waiters.add(wake);
      });
    }
  };
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
  if (!options.authConfigured()) {
    throw new ServeHttpError(
      'auth_not_configured',
      'serve-http requiere emparejado y HEBRA_MCP_BACKCHANNEL_SECRET válido para el consentimiento de Lumbre.'
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
  let server: Server;
  let inFlight: ReturnType<typeof trackInFlight>;
  try {
    const auth = await options.loadAuth(options.dataDir, options.config, options.secrets);
    if (!auth) throw new ServeHttpError(
      'auth_not_configured',
      'serve-http requiere emparejado y HEBRA_MCP_BACKCHANNEL_SECRET válido para el consentimiento de Lumbre.'
    );
    const app = createHttpApp({ ctx: serve.ctx, version: options.version, config: options.config, auth });
    server = createServer(app);
    inFlight = trackInFlight(server);
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
        // `close` deja de aceptar conexiones y cierra las ociosas; las que tienen una
        // petición a medias siguen hasta responder (o hasta el plazo).
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        const drained = await inFlight.idle(options.drainTimeoutMs ?? HTTP_DRAIN_TIMEOUT_MS);
        server.closeAllConnections();
        await closed;
        logEvent({ event: 'serve_http.closed', drained });
        await serve.close();
      })();
      return closing;
    }
  };
}
