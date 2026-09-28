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
 * - Escritor único (SPEC.md §8): la instancia que tiene `writer.lock` escucha en
 *   `writer.sock`; las demás le reenvían las escrituras y le preguntan el estado de sync
 *   (`./forward.ts`), y toman el relevo si ya no responde.
 */
import { LibraryInstance, type OpenLibraryInstanceOptions } from '../sync/library-instance';
import { linkedSyncFrom, registerLinkedDevice } from '../sync/linked';
import { loadPrivacyConfig } from '../privacy';
import { logEvent } from '../log/logger';
import { readPairedSecrets, type SecretStore } from '../secrets';
import { LibraryInstanceStatusSource } from '../status/status-source';
import type { ServerContext } from './context';
import {
  buildRoutedWriteContext,
  RoutedStatusSource,
  writerSocketHandlers,
  type ForwardOptions
} from './forward';
import { buildWriteContext, type WriteContext } from './write-context';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OpenServeOptions {
  dataDir: string;
  /** `null`: no hay llavero en esta plataforma (arranca sin emparejar). */
  secrets: SecretStore | null;
  fetcher?: Fetcher;
  /** Tests: bloqueo, revisión del bloqueo y ritmo de sync. */
  instance?: Pick<OpenLibraryInstanceOptions, 'lock' | 'checkIntervalMs'>;
  syncIntervalMs?: number | null;
  /** Tests: tiempos de espera del reenvío al escritor. */
  forward?: ForwardOptions;
  /**
   * `serve-http` (SPEC.md §12.1): el proceso tiene que ser el escritor. Si otro proceso ya
   * tiene `writer.lock`, falla con `WriterRequiredError` en vez de arrancar como lector, y
   * sus escrituras y su `hebra_status` son siempre los locales: nunca reenvía por
   * `writer.sock`. Sigue escuchando en `writer.sock` como cualquier escritor, para que un
   * `serve` por stdio en la misma máquina le reenvíe las suyas (§8).
   */
  writerOnly?: boolean;
}

/** `writerOnly` y el bloqueo es de otro proceso vivo. */
export class WriterRequiredError extends Error {
  readonly code = 'writer_lock_held';
  constructor() {
    super('writer_lock_held');
    this.name = 'WriterRequiredError';
  }
}

export interface ServeContext {
  ctx: ServerContext;
  instance: LibraryInstance;
  linked: boolean;
  close(): Promise<void>;
}

/**
 * Las escrituras sobre esta instancia, sin reenvío: las del escritor.
 *
 * `requestRound`: sin runner (sin emparejar), `null` (`not_linked`). Con runner, su
 * resultado; si el runner no hizo ronda (revocado o parado), un código en su lugar, para
 * que la herramienta diga `error` y no `not_linked`.
 */
export function localWriteContext(instance: LibraryInstance): WriteContext {
  return buildWriteContext({
    createNote: (input) => instance.createNote(input),
    appendToNote: (input) => instance.appendToNote(input),
    editNote: (input) => instance.editNote(input),
    recordEditConflict: (operationId, id, copyId) =>
      instance.recordEditConflict(operationId, id, copyId),
    organize: (input) => instance.organize(input),
    noteRead: (id) => instance.port.noteRead(id),
    onConflictCopy: (listener) => instance.onConflictCopy(listener),
    requestRound: () => {
      const runner = instance.syncRunner;
      if (!runner) return Promise.resolve(null);
      return runner
        .requestRound()
        .then((round) => round ?? { result: runner.revoked ? 'revoked' : 'unknown' });
    }
  });
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
      deviceLabel: 'Claude',
      sync: linked?.config ?? null,
      // Mientras esta instancia sea el escritor, atiende en `writer.sock` las escrituras
      // que le reenvían las demás sesiones (`./forward.ts`, SPEC.md §8).
      writerSocket: (opened) => writerSocketHandlers(localWriteContext(opened), opened),
      ...options.instance
    }),
    loadPrivacyConfig(dataDir)
  ]);
  if (options.writerOnly) {
    if (instance.role !== 'this') {
      await instance.close();
      throw new WriterRequiredError();
    }
    // Sin reenvío: si el bloqueo se perdiera (otro proceso lo robó), las escrituras
    // rechazan con `busy_other_instance` en vez de saltar a `writer.sock`.
    const ctx: ServerContext = {
      port: instance.port,
      privacyConfig,
      status: new LibraryInstanceStatusSource(instance, linked !== null),
      write: localWriteContext(instance)
    };
    return { ctx, instance, linked: linked !== null, close: () => instance.close() };
  }
  // `privacyConfig` sin resolver a `PrivacyFilter` aquí: `register-tools.ts` lo hace en
  // CADA llamada, con el almacén tal como esté en ese momento (un filtro construido una
  // vez al arrancar se queda obsoleto en cuanto el sync mueve una nota a una carpeta
  // privada, o al revés). Sin sync, `instance.syncRunner` es `null`, `requestRound`
  // resuelve ya y las escrituras siguen funcionando sobre la SQLite local.
  // En un lector, las escrituras se reenvían al escritor (o toman el relevo si ya no
  // está), y `hebra_status` le pregunta a él por el sync.
  const write = buildRoutedWriteContext(instance, localWriteContext(instance), options.forward);
  const ctx: ServerContext = {
    port: instance.port,
    privacyConfig,
    status: new RoutedStatusSource(instance, linked !== null, options.forward),
    write
  };
  return { ctx, instance, linked: linked !== null, close: () => instance.close() };
}
