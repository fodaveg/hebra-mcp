/**
 * Todo lo que `hebra-mcp serve` monta antes de hablar MCP (SPEC.md §7.5, §8), aparte de
 * `main.ts` para poder probarlo sin stdio.
 *
 * - Lee los secretos de `pair` del llavero (`src/secrets/`). Si están los tres y el relé
 *   de la credencial es el de la bóveda, registra el dispositivo (idempotente) y abre la
 *   `LibraryInstance` CON sync: `hebra_status` dice `linked: true`, y un 401/403 del relé
 *   lo deja en `revoked: true` (SPEC.md §6.2): los espacios dejan de servirse y el runner
 *   reintenta solo hasta que la credencial vuelva a valer (D24).
 * - Sin secretos (o sin llavero en esta plataforma), igual que en L1: la SQLite local sin
 *   sync y `linked: false`. Lo dice en stderr con un evento cerrado, sin valores.
 * - Escritor único (SPEC.md §8): la instancia que tiene `writer.lock` escucha en
 *   `writer.sock`; las demás le reenvían las escrituras y le preguntan el estado de sync
 *   (`./forward.ts`), y toman el relevo si ya no responde.
 */
import { accountAccessGuard } from '../accounts/registry';
import { StoreError } from '../store/errors';
import { AgentDevice } from '../spaces/device';
import { AgentSpaceManager } from '../spaces/manager';
import type { AccountUploadLedger } from '../accounts/pending-sweep';
import { LibraryInstance, type OpenLibraryInstanceOptions } from '../sync/library-instance';
import { linkedSyncFrom, registerLinkedDevice } from '../sync/linked';
import type { SyncScheduler } from '../sync/runner';
import { PrivacyConfigSource } from '../privacy/config-source';
import { privacyWithMemory } from '../privacy/folder-memory';
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
  /** Tests: bloqueo, revisión del bloqueo y un sync propio (relé en memoria), que sustituye
   *  al de los secretos de `pair`. */
  instance?: Pick<OpenLibraryInstanceOptions, 'lock' | 'checkIntervalMs' | 'sync'>;
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
  /** Guardia fresca de la cuenta dueña. Se comprueba también al publicar cada resultado. */
  authorize?: () => Promise<void>;
  /** Sin red: vuelve a comprobar la cuenta dentro de cada turno y mutación. */
  assertActive?: () => void;
  /**
   * `serve-http` multiusuario (D22, §12.10): el contexto puede cerrarse con la persona aún
   * conectada, así que `close()` intenta subir lo pendiente y apunta en la lista durable lo que
   * no suba, de la biblioteca personal y de cada espacio abierto.
   */
  uploadLedger?: AccountUploadLedger;
  /**
   * `serve-http` multiusuario: la clave opaca de la cuenta (`accountTurnKey`) para el turno de los
   * topes de sync. La reciben la biblioteca personal y todos los espacios de este contexto. Sin
   * ella, la clave por defecto (stdio: una sola cuenta por proceso).
   */
  accountKey?: string;
  /**
   * `serve-http`: la marca de revocación de la credencial de esta cuenta que sobrevive a cerrar el
   * contexto (`PairingRevocation.isRevoked`). Se suma al `revoked` del runner para bloquear los
   * espacios (D24), así que una cuenta revocada que se reabre no sirve ningún espacio hasta que
   * una ronda correcta pruebe que la credencial vale.
   */
  credentialRevoked?: () => boolean;
  /** Tests: temporizadores del runner de la biblioteca personal (bucle y reintento, D24). */
  syncScheduler?: SyncScheduler;
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
 * `isLinked`: hay runner de sync; así una escritura que no escribió nada (y no pide
 * ronda) sabe distinguir `not_linked` de `uploaded`/`pending`.
 * `requestRound`: sin runner (sin emparejar), `null` (`not_linked`). Con runner, su
 * resultado; si el runner no hizo ronda (revocado o parado), un código en su lugar, para
 * que la herramienta diga `error` y no `not_linked`.
 */
export function localWriteContext(
  instance: LibraryInstance,
  authorize?: () => Promise<void>,
  options: { denyJdex?: boolean } = {}
): WriteContext {
  const context = buildWriteContext({
    createNote: (input) => instance.createNote(input),
    appendToNote: (input) => instance.appendToNote(input),
    editNote: (input) => instance.editNoteLocal(input),
    recordEditConflict: (operationId, id, copyId) =>
      instance.recordEditConflict(operationId, id, copyId),
    organize: (input) => instance.organizeLocal(input),
    restoreVersion: (input) => instance.restoreVersionLocal(input),
    fetchAttachment: (input) => instance.fetchAttachment(input),
    createFolder: (input) => instance.createFolderLocal(input),
    renameFolder: (input) => instance.renameFolderLocal(input),
    addAttachment: (input) => instance.addAttachmentLocal(input),
    organizeFile: (input) => instance.organizeFileLocal(input),
    replaceInNotes: (request) => instance.replaceInNotesLocal(request),
    fetchFile: (input) => instance.fetchFile(input),
    replaceFileText: (input) => instance.replaceFileTextLocal(input),
    looseFileWrite: (input) => instance.looseFileWriteLocal(input),
    noteState: (input) => instance.noteStateLocal(input),
    jdNewId: (request) => instance.jdNewIdLocal(request),
    jdMove: (request) => instance.jdMoveLocal(request),
    noteRead: (id) => instance.port.noteRead(id),
    folderDirty: (id) => instance.port.folderDirty(id),
    blobUploaded: (sha256) => instance.port.blobUploaded(sha256),
    looseFileDirty: (id) => instance.port.looseFileDirty(id),
    isLinked: () => instance.syncRunner !== null,
    onConflictCopy: (listener) => instance.onConflictCopy(listener),
    // Al empezar el apagado, ninguna escritura espera ya su ronda (A1).
    shuttingDown: () => instance.whenShuttingDown(),
    requestRound: () => {
      const runner = instance.syncRunner;
      if (!runner) return Promise.resolve(null);
      return runner
        .requestRound()
        .then((round) => round ?? { result: runner.revoked ? 'revoked' : 'unknown' });
    }
  });
  if (!authorize && !options.denyJdex) return context;
  return new Proxy(context, { get: (target, property) => {
    const value = Reflect.get(target, property);
    if (typeof value !== 'function' || property === 'onConflictCopy') return value;
    return async (...args: unknown[]) => {
      if (authorize) {
        try { await authorize(); } catch { throw new StoreError('space_access_denied'); }
      }
      if (options.denyJdex && (property === 'jdNewId' || property === 'jdMove'))
        throw new StoreError('space_access_denied');
      const result = await Reflect.apply(value, target, args);
      if (authorize) {
        try { await authorize(); } catch { throw new StoreError('space_access_denied'); }
      }
      return result;
    };
  } });
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
  const diskAccess = accountAccessGuard(dataDir);
  const assertActive = () => { diskAccess(); options.assertActive?.(); };
  const authorize = async () => { assertActive(); await options.authorize?.(); assertActive(); };
  assertActive();
  const paired = await readSecretsQuietly(options.secrets);
  assertActive();
  // D24: la credencial revocada (el runner de la biblioteca personal, que se abre más abajo, o la
  // marca de `serve-http`) bloquea los espacios. El 401 al registrar la clave de agente también la
  // da por revocada; sin runner (sin sync), los espacios ya caen por el catálogo del relé.
  let opened: LibraryInstance | null = null;
  const credentialRevoked = (): boolean =>
    opened?.syncRunner?.revoked === true || options.credentialRevoked?.() === true;
  const credentialRejected = (): void => opened?.syncRunner?.markRevoked('agent_key');
  // H-L7: el registro del agente y el catálogo de concesiones solo se piden al usar un
  // espacio compartido. La biblioteca personal (sin `space`) no los espera: funciona sin
  // red y con un relé sin la API de H-L7, como antes de los espacios.
  const device = paired && options.secrets
    ? new AgentDevice(paired, options.secrets, options.fetcher, dataDir, assertActive, credentialRejected)
    : null;
  const { uploadLedger, accountKey } = options;
  // El gestor abre cada espacio con estas opciones tal cual, así que la lista y la clave de cuenta
  // llegan también a sus bibliotecas sin que el gestor sepa de ellas.
  const spaceInstance = {
    ...options.instance,
    ...(uploadLedger ? { uploadLedger } : {}),
    ...(accountKey === undefined ? {} : { accountKey })
  };
  const spaces = device
    ? new AgentSpaceManager(device, dataDir, options.fetcher, options.syncIntervalMs, spaceInstance, assertActive,
        undefined, credentialRevoked)
    : undefined;
  const directory = spaces ? () => spaces.directory() : undefined;
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
  // `config.json` se lee ANTES de abrir la biblioteca: el escritor anota las carpetas
  // privadas antes de cada ronda de sync, también la primera (A3 del audit de privacidad,
  // `privacyWithMemory`), y para eso necesita la configuración. Después se relee en cada
  // llamada si cambió (M5, `PrivacyConfigSource`).
  const privacySource = await PrivacyConfigSource.open(dataDir);
  const privacyConfig = privacySource.initial;
  const instance = await LibraryInstance.open({
    dataDir,
    deviceLabel: 'Claude',
    sync: linked
      ? {
          ...linked.config,
          ...(options.syncScheduler ? { scheduler: options.syncScheduler } : {}),
          // Al recuperar la credencial, el sync de los espacios abiertos que se quedó revocado
          // reintenta ya (D24).
          onRevocationChange: (revoked) => {
            if (!revoked) spaces?.credentialRestored();
          }
        }
      : null,
    // Mientras esta instancia sea el escritor, atiende en `writer.sock` las escrituras
    // que le reenvían las demás sesiones (`./forward.ts`, SPEC.md §8).
    writerSocket: (opened) => writerSocketHandlers(localWriteContext(opened, authorize), opened),
    beforeSyncRound: async (port) => {
      assertActive();
      // Una configuración rota no anota nada (las herramientas ya responden
      // `privacy_config_unresolved`); un fallo aquí no para la ronda.
      await privacyWithMemory(port, await privacySource.current());
    },
    ...options.instance,
    ...(uploadLedger ? { uploadLedger } : {}),
    ...(accountKey === undefined ? {} : { accountKey }),
    assertActive
  });
  opened = instance;
  // §8 y §12.10: la ronda de abrir ya está en marcha, y las lecturas la esperan como mucho 10 s
  // desde aquí, no desde cada llamada. Espera la lectura y no la apertura: `serve` no retrasa el
  // saludo de MCP, y una escritura no tiene por qué pagarla.
  const firstRound = instance.whenReady();
  // Primero la ronda final de todo lo abierto: `spaces.close()` corta las guardias del relé, y
  // una ronda de un espacio ya no podría salir después.
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    // Si falla se borra, para que el reintento del ciclo de vida repita lo que quedó sin hacer
    // (cada paso es idempotente) en vez de recibir el mismo rechazo para siempre.
    closing ??= (async () => {
      await closeServeResources({
        shuttingDown: instance.processShuttingDown,
        settle: uploadLedger ? () => uploadLedger.settleAll() : undefined,
        spaces,
        instance
      });
    })().catch((error: unknown) => {
      closing = null;
      throw error;
    });
    return closing;
  };
  if (options.writerOnly) {
    if (instance.role !== 'this') {
      await instance.close();
      throw new WriterRequiredError();
    }
    // Sin reenvío: si el bloqueo se perdiera (otro proceso lo robó), las escrituras
    // rechazan con `busy_other_instance` en vez de saltar a `writer.sock`.
    const ctx: ServerContext = {
      spaces,
      directory,
      port: instance.port,
      privacyConfig,
      privacyConfigSource: privacySource,
      status: new LibraryInstanceStatusSource(instance, linked !== null),
      authorize,
      firstRound: () => firstRound,
      write: localWriteContext(instance, authorize)
    };
    return { ctx, instance, linked: linked !== null, close };
  }
  // `privacyConfig` sin resolver a `PrivacyFilter` aquí: `register-tools.ts` lo hace en
  // CADA llamada, con el almacén tal como esté en ese momento (un filtro construido una
  // vez al arrancar se queda obsoleto en cuanto el sync mueve una nota a una carpeta
  // privada, o al revés). Sin sync, `instance.syncRunner` es `null`, `requestRound`
  // resuelve ya y las escrituras siguen funcionando sobre la SQLite local.
  // En un lector, las escrituras se reenvían al escritor (o toman el relevo si ya no
  // está), y `hebra_status` le pregunta a él por el sync.
  const write = buildRoutedWriteContext(instance, localWriteContext(instance, authorize), options.forward);
  const ctx: ServerContext = {
    spaces,
    directory,
    authorize,
    port: instance.port,
    privacyConfig,
    privacyConfigSource: privacySource,
    status: new RoutedStatusSource(instance, linked !== null, options.forward),
    firstRound: () => firstRound,
    write
  };
  return { ctx, instance, linked: linked !== null, close };
}

/**
 * Cierra lo abierto de un contexto. Primero lo que debe ir antes: la ronda final de todo lo que
 * sube (`settle`). Después, en un cierre normal, los espacios y la biblioteca personal en serie.
 * Con el proceso apagándose (`beginShutdown`), a la vez: en serie, 12 s de espacios + 35 + 35 s de
 * la biblioteca no caben en los 47 s de `shutdown-budget.ts` ni en el `stop_grace_period`; en
 * paralelo dura lo del más lento. Si uno falla, el otro termina igualmente y sale el primer error.
 */
export async function closeServeResources(parts: {
  shuttingDown: boolean;
  settle?: () => Promise<void>;
  spaces?: { close(): Promise<void> };
  instance: { close(): Promise<void> };
}): Promise<void> {
  await parts.settle?.();
  if (!parts.shuttingDown) {
    await parts.spaces?.close();
    await parts.instance.close();
    return;
  }
  const results = await Promise.allSettled([parts.spaces?.close(), parts.instance.close()]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
