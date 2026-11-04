/**
 * `hebra-mcp serve-http` (SPEC.md §12.1): el conector remoto de claude.ai. Un único
 * proceso atiende a todas las sesiones y cada contexto abierto es el escritor único de su
 * cuenta. Si otro proceso tiene su `writer.lock`, esa apertura espera y al agotar el plazo
 * responde 503 `lock_held` (§12.10). Nunca reenvía por `writer.sock` (`openServeContext({ writerOnly: true })`).
 *
 * Orden de arranque: preflight de configuración, OAuth/registro global y listener. Los
 * contextos se abren bajo demanda después de autenticar la cuenta; cualquier fallo de
 * arranque cierra los que se hubieran adquirido.
 */
import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { logEvent } from '../log/logger';
import { acquireServerLock, type ServerLock } from '../lock';
import { openFileSecretStore, readPairedSecrets, type SecretStore } from '../secrets';
import { AccountContexts, AccountRegistry, AccountRemovalService, accountDataDir, openRemotePairing,
  accountControlDir, openAccountControlServer, type AccountControlServer, type RemotePairingRuntime } from '../accounts';
import { readCapacityConfig } from '../accounts/capacity';
import { revokeRemoteCredential } from '../pair/remote/revoke';
import type { OAuthHttpAuth } from '../oauth/http-auth';
import { PairingRevocation, PairingStatusSource } from '../status/pairing-revocation';
import { openServeContext, WriterRequiredError, type OpenServeOptions, type ServeContext } from '../server/serve';
import { AWAIT_ROUND_TIMEOUT_MS } from '../server/write-context';
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
 * el reintento del agente duplicaba un `hebra_append_to_note`.
 *
 * Al empezar el apagado, las esperas de ronda de las escrituras en curso se cortan
 * (`LibraryInstance.beginShutdown`), así que una petición ya no espera su ronda: le queda
 * su turno en la cola del almacén. Aun así el plazo queda POR ENCIMA de la espera de ronda
 * (`AWAIT_ROUND_TIMEOUT_MS`, 10 s), por si alguna espera de dentro de una petición no
 * pasara por ese corte. Las dos esperas no se suman: la de ronda va dentro de esta.
 * Después, `serve.close()` espera a la ronda en vuelo (hasta unos 30 s con el relé
 * colgado) y vacía la cola: 12 + 30 caben en el `stop_grace_period` del contenedor
 * (`deploy/compose.yml`, 50 s).
 */
export const HTTP_DRAIN_TIMEOUT_MS = AWAIT_ROUND_TIMEOUT_MS + 2_000;

export interface StartServeHttpOptions
  extends Pick<OpenServeOptions, 'fetcher' | 'instance' | 'syncIntervalMs'> {
  dataDir: string;
  secrets: SecretStore | null;
  config: HttpConfig;
  version: string;
  /** Tests: espera más corta a las peticiones en curso (`HTTP_DRAIN_TIMEOUT_MS`). */
  drainTimeoutMs?: number;
  /** Producción remota: difiere la apertura hasta conocer la cuenta autenticada. */
  multiuser?: boolean;
  /** Operación administrativa offline: adquiere control pero no abre listener. */
  maintenance?: boolean;
  /** Comprobación pura: nunca lee ni escribe el almacén ni llama al broker. */
  authConfigured(): boolean;
  /**
   * La autenticación de `/mcp`, o `null` si no está configurada (y entonces no arranca).
   * `pairing` es el estado de emparejado revocado que comparte con `hebra_status` (SPEC.md §12.9).
   */
  loadAuth(dataDir: string, config: HttpConfig, secrets: SecretStore | null, pairing: PairingRevocation): Promise<HttpAuth | null>;
}

export interface ServeHttpHandle {
  /** Puerto real de escucha (con `config.port` 0, el que eligió el sistema). */
  port: number;
  /** Contexto raíz del modo monousuario; multiusuario abre cada cuenta bajo demanda. */
  serve: ServeContext | null;
  server: Server;
  contexts: AccountContexts | null;
  /** Retirada administrativa por id opaco, bajo el lock global de este proceso. */
  removeAccount(id: string): Promise<void>;
  /**
   * Apagado ordenado: corta las esperas de ronda de las escrituras en curso
   * (`beginShutdown`), deja de aceptar conexiones, espera hasta `HTTP_DRAIN_TIMEOUT_MS` a
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

/**
 * El contexto heredado se cierra por inactividad: su `revoked` no puede depender de una
 * instancia cerrada, ni volver a `false` porque ya no haya runner. Al cerrar se queda en la
 * marca de `PairingRevocation`, atada a la credencial, que olvida un emparejado nuevo.
 * `onClosed` suelta la referencia a la instancia.
 */
export function rememberRevocationOnClose(
  opened: ServeContext,
  pairing: PairingRevocation,
  credentialId: string,
  onClosed: () => void
): ServeContext {
  const runner = opened.instance.syncRunner;
  const remember = (): void => {
    if (runner?.revoked) pairing.markRevoked(credentialId);
  };
  return { ...opened, close: async () => {
    remember();
    try {
      await opened.close();
    } finally {
      remember();
      onClosed();
    }
  } };
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
  let serve: ServeContext | null = null;
  let server: Server;
  let inFlight: ReturnType<typeof trackInFlight>;
  let contexts: AccountContexts | null = null;
  let removal: AccountRemovalService | null = null;
  let registry: AccountRegistry | null = null;
  let remotePairing: RemotePairingRuntime | null = null;
  let serverLock: ServerLock | null = null;
  let controlServer: AccountControlServer | null = null;
  let acceptingRemovals = true;
  const removalJobs = new Set<Promise<void>>();
  const removeById = (id: string): Promise<void> => {
    if (!acceptingRemovals) return Promise.reject(new Error('removal_shutdown'));
    const job = (async () => {
      if (!removal) throw new Error('multiuser_not_configured');
      const account = registry?.findById(id);
      if (!account) throw new Error('account_not_found');
      await removal.remove(account);
    })();
    removalJobs.add(job);
    void job.finally(() => removalJobs.delete(job)).catch(() => undefined);
    return job;
  };
  const drainRemovalJobs = async (): Promise<void> => {
    while (removalJobs.size > 0) await Promise.allSettled([...removalJobs]);
  };
  try {
    // El modo monousuario conserva el orden de robustez histórico: toma el writer lock
    // antes de recuperar OAuth. Producción multiusuario difiere la apertura de cada cuenta
    // y toma antes `control/server.lock`, que registra este arranque (D22, §12.10).
    if (!options.multiuser) {
      serve = await openServeContext({ dataDir: options.dataDir, secrets: options.secrets,
        fetcher: options.fetcher, instance: options.instance, syncIntervalMs: options.syncIntervalMs,
        writerOnly: true });
    } else {
      const controlDir = accountControlDir(options.dataDir);
      await mkdir(controlDir, { recursive: true, mode: 0o700 });
      serverLock = acquireServerLock(options.dataDir, controlDir);
      if (!serverLock) throw new WriterRequiredError();
    }
    // Emparejado revocado (SPEC.md §12.9): el `revoked` del relé o el `410 pairing_revoked` de
    // Lumbre que vea el OAuth; `hebra_status` dice lo mismo que la página de `/authorize`.
    const pairing = new PairingRevocation(() => serve?.instance.syncRunner?.revoked ?? false);
    const auth = await options.loadAuth(options.dataDir, options.config, options.secrets, pairing);
    if (!auth) throw new ServeHttpError(
      'auth_not_configured',
      'serve-http requiere emparejado y HEBRA_MCP_BACKCHANNEL_SECRET válido para el consentimiento de Lumbre.'
    );
    registry = options.multiuser && 'accounts' in auth && auth.accounts instanceof AccountRegistry ? auth.accounts : null;
    if (registry) {
      const activeRegistry = registry;
      contexts = new AccountContexts(activeRegistry, async (account) => {
        const dataDir = accountDataDir(options.dataDir, account);
        const secrets = account.storage === 'legacy-root' ? options.secrets : openFileSecretStore(dataDir);
        const opened = await openServeContext({ dataDir, secrets,
          fetcher: options.fetcher, instance: options.instance, syncIntervalMs: options.syncIntervalMs,
          writerOnly: true, authorize: async () => { activeRegistry.assertActive(account); },
          assertActive: () => { activeRegistry.assertActive(account); } });
        opened.instance.deferSignalRelease();
        const accountPairing = account.storage === 'legacy-root' ? pairing :
          new PairingRevocation(() => opened.instance.syncRunner?.revoked ?? false);
        opened.ctx.status = new PairingStatusSource(opened.ctx.status, accountPairing);
        if (account.storage !== 'legacy-root') return opened;
        const legacy = rememberRevocationOnClose(opened, pairing, account.binding.pairedCredentialId, () => {
          if (serve === legacy) serve = null;
        });
        serve = legacy;
        return legacy;
      }, readCapacityConfig());
      const oauth = 'provider' in auth && 'lumbreOrigin' in auth ? auth as OAuthHttpAuth : null;
      if (!oauth) throw new ServeHttpError('auth_not_configured', 'La autenticación multiusuario no está disponible.');
      remotePairing = await openRemotePairing({ dataDir: options.dataDir, registry: activeRegistry, provider: oauth.provider,
        lumbreOrigin: oauth.lumbreOrigin, fetcher: options.fetcher });
      removal = new AccountRemovalService({ dataDir: options.dataDir, registry: activeRegistry, contexts,
        oauth: oauth.provider, legacySecrets: options.secrets!,
        cleanupLegacyShared: (account) => remotePairing!.cleanupForSub(account.sub),
        revokeDevice: async (account) => {
          const dataDir = accountDataDir(options.dataDir, account);
          const store = account.storage === 'legacy-root' ? options.secrets : openFileSecretStore(dataDir);
          if (!store) throw new Error('account_secrets_unavailable');
          const paired = await readPairedSecrets(store);
          if (!paired) throw new Error('account_pairing_unavailable');
          await revokeRemoteCredential(paired.connection, options.fetcher);
        } });
      await removal.resumePending();
      if (!options.maintenance) {
        controlServer = await openAccountControlServer(options.dataDir, removeById);
      }
    } else {
      if (!serve) throw new ServeHttpError('auth_not_configured', 'El modo multiusuario requiere autenticación por cuenta.');
      serve.ctx.status = new PairingStatusSource(serve.ctx.status, pairing);
    }
    const app = createHttpApp({ ctx: serve?.ctx, contexts: contexts ?? undefined,
      remotePairing: remotePairing?.router,
      version: options.version, config: options.config, auth });
    server = createServer(app);
    inFlight = trackInFlight(server);
    if (!options.maintenance) await listen(server, options.config.port, options.config.listenHost);
  } catch (error) {
    acceptingRemovals = false;
    await controlServer?.close();
    await drainRemovalJobs();
    if (contexts) await contexts.close();
    else await serve?.close();
    serverLock?.release();
    throw error;
  }
  const port = server.listening ? (server.address() as AddressInfo).port : 0;
  if (server.listening) logEvent({ event: 'serve_http.listening', port });

  let closing: Promise<void> | null = null;
  return {
    port,
    serve,
    server,
    contexts,
    removeAccount(id) {
      return removeById(id);
    },
    close() {
      closing ??= (async () => {
        acceptingRemovals = false;
        // Primero, que ninguna escritura en curso siga esperando su ronda: la respuesta
        // sale ya (con `sync: "pending"` donde lo haya).
        if (contexts) contexts.beginShutdown();
        else serve?.instance.beginShutdown();
        // `close` deja de aceptar conexiones y cierra las ociosas; las que tienen una
        // petición a medias siguen hasta responder (o hasta el plazo).
        const wasListening = server.listening;
        const closed = wasListening
          ? new Promise<void>((resolve) => server.close(() => resolve()))
          : Promise.resolve();
        const drained = await inFlight.idle(options.drainTimeoutMs ?? HTTP_DRAIN_TIMEOUT_MS);
        if (wasListening) server.closeAllConnections();
        await closed;
        logEvent({ event: 'serve_http.closed', drained });
        await controlServer?.close();
        await drainRemovalJobs();
        if (contexts) await contexts.close();
        else await serve?.close();
        serverLock?.release();
      })();
      return closing;
    }
  };
}
