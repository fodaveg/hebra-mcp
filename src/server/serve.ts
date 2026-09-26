/**
 * Todo lo que `hebra-mcp serve` monta antes de hablar MCP (SPEC.md §7.5, §8), aparte de
 * `main.ts` para poder probarlo sin stdio.
 *
 * - Lee los secretos de `pair` del llavero (`src/secrets/`). Si están los tres y el relé
 *   de la credencial es el de la bóveda, registra el dispositivo (idempotente) y abre la
 *   `LibraryInstance` CON sync: `hebra_status` dice `linked: true`, y un 401/403 del relé
 *   lo deja en `revoked: true` (SPEC.md §6.2).
 * - Sin secretos (o sin llavero en esta plataforma), igual que en L1: la SQLite local sin
 *   sync y `linked: false`. Lo dice en stderr con un evento cerrado, sin valores.
 */
import { LibraryInstance, type OpenLibraryInstanceOptions } from '../sync/library-instance';
import { linkedSyncFrom, registerLinkedDevice } from '../sync/linked';
import { loadPrivacyConfig } from '../privacy';
import { logEvent } from '../log/logger';
import { readPairedSecrets, type SecretStore } from '../secrets';
import { LibraryInstanceStatusSource } from '../status/status-source';
import type { ServerContext } from './context';
import { buildWriteContext } from './write-context';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OpenServeOptions {
  dataDir: string;
  /** `null`: no hay llavero en esta plataforma (arranca sin emparejar). */
  secrets: SecretStore | null;
  fetcher?: Fetcher;
  /** Tests: bloqueo, revisión del bloqueo y ritmo de sync. */
  instance?: Pick<OpenLibraryInstanceOptions, 'lock' | 'checkIntervalMs'>;
  syncIntervalMs?: number | null;
}

export interface ServeContext {
  ctx: ServerContext;
  instance: LibraryInstance;
  linked: boolean;
  close(): Promise<void>;
}

async function readSecretsQuietly(secrets: SecretStore | null) {
  if (!secrets) return null;
  try {
    return await readPairedSecrets(secrets);
  } catch {
    // Llavero bloqueado o inaccesible: sin emparejar, y dicho en stderr sin detalle.
    logEvent({ event: 'secrets.read', result: 'unavailable' });
    return null;
  }
}

export async function openServeContext(options: OpenServeOptions): Promise<ServeContext> {
  const { dataDir } = options;
  const paired = await readSecretsQuietly(options.secrets);
  const linked = paired
    ? await linkedSyncFrom(paired, {
        fetcher: options.fetcher,
        emit: (event, fields) => logEvent({ event, ...fields }),
        intervalMs: options.syncIntervalMs
      })
    : null;
  logEvent({ event: 'serve.start', linked: linked !== null });
  if (linked) {
    // FUGA-SYNC-02 de Hebra: sin registro, la primera ronda recibe 404. Idempotente; un
    // fallo aquí no para el arranque (la ronda lo dirá, y un 401 deja `revoked`).
    const register = await registerLinkedDevice(linked, options.fetcher);
    logEvent({ event: 'sync.register', result: register });
  }
  const [instance, privacyConfig] = await Promise.all([
    LibraryInstance.open({
      dataDir,
      deviceLabel: 'hebra-mcp',
      sync: linked?.config ?? null,
      ...options.instance
    }),
    loadPrivacyConfig(dataDir)
  ]);
  // `privacyConfig` sin resolver a `PrivacyFilter` aquí: `register-tools.ts` lo hace en
  // CADA llamada, con el almacén tal como esté en ese momento (un filtro construido una
  // vez al arrancar se queda obsoleto en cuanto el sync mueve una nota a una carpeta
  // privada, o al revés). Sin sync, `instance.syncRunner` es `null`, `requestRound`
  // resuelve ya y las escrituras siguen funcionando sobre la SQLite local.
  const write = buildWriteContext({
    createNote: (input) => instance.createNote(input),
    appendToNote: (input) => instance.appendToNote(input),
    onConflictCopy: (listener) => instance.onConflictCopy(listener),
    requestRound: () => instance.syncRunner?.requestRound() ?? Promise.resolve(null)
  });
  const ctx: ServerContext = {
    port: instance.port,
    privacyConfig,
    status: new LibraryInstanceStatusSource(instance, linked !== null),
    write
  };
  return { ctx, instance, linked: linked !== null, close: () => instance.close() };
}
