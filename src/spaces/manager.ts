/** Catálogo y bibliotecas aisladas para espacios autorizados al agente H-L7.
 * La caché nunca concede autoridad. Cada invocación de herramienta consulta el catálogo
 * fresco dos veces (al resolver el selector y al aceptar la respuesta), y nunca reutiliza
 * esa consulta en otra invocación; cada petición del sync compartido y cada escritura que
 * llega por `writer.sock` también lo consultan. Dentro del turno FIFO solo se mira lo ya
 * sabido en local (`assertActive`): una revocación ya vista no deja escribir, y una
 * latencia del relé no bloquea las escrituras de los demás. */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContextUnavailableError, type AdmissionTicket } from '../accounts/capacity';
import { realClock, ResourceLifecycle, type Clock } from '../accounts/lifecycle';
import { logEvent } from '../log/logger';
import type { DirectoryView, ServerContext, SpaceLease, SpaceLifecycleControl, SpaceRouter } from '../server/context';
import { ToolError } from '../server/errors';
import { LibraryInstance, type OpenLibraryInstanceOptions } from '../sync/library-instance';
import { registerLinkedDevice } from '../sync/linked';
import { PrivacyConfigSource } from '../privacy/config-source';
import { StoreError } from '../store/errors';
import { localWriteContext } from '../server/serve';
import {
  buildRoutedWriteContext,
  RoutedStatusSource,
  writerSocketHandlers
} from '../server/forward';
import { HttpLibraryTransport, readSpaceMeta } from '../hebra';
import { AgentDevice } from './device';
import { fetchAgentDirectory } from './directory';
import { catalogueSchema, type AgentSpaceAccess } from './protocol';

/** Cuánto vale un nombre leído, y cuánto un fallo o un meta ausente. */
const NAME_TTL_MS = 10 * 60_000;
const NAME_FAILURE_TTL_MS = 60_000;

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** JSONB puede reordenar las propiedades; eso no cambia la concesión ni su caché. */
function grantHash(item: AgentSpaceAccess): string {
  const g = item.grant;
  return hash([
    item.spaceId,
    item.syncVaultId,
    g.v,
    g.spaceId,
    g.syncVaultId,
    g.accountId,
    g.credentialId,
    g.deviceId,
    g.keyId,
    g.ephemeralPublicKey.kty,
    g.ephemeralPublicKey.crv,
    g.ephemeralPublicKey.x,
    g.ephemeralPublicKey.y,
    g.salt,
    g.iv,
    g.ciphertext
  ]);
}

interface Entry {
  access: AgentSpaceAccess;
  directory: string;
  denied: boolean;
  /** Una sola instancia por directorio (`ResourceLifecycle`, SPEC.md §12.10). */
  life: ResourceLifecycle<ServerContext>;
  /** `resolve` no sabe cuándo termina su uso: retiene el espacio hasta `close`. */
  pin?: SpaceLease;
  instance?: LibraryInstance;
  vaultKey?: Uint8Array;
}

export class AgentSpaceManager implements SpaceRouter {
  private readonly entries = new Map<string, Entry>();
  /** `serve-http` activa con `configure` el cierre por uso y la admisión por memoria. */
  private idleMs: number | null = null;
  private clock: Clock = realClock;
  private admit?: (signal: AbortSignal) => Promise<AdmissionTicket>;
  private onClosed?: () => void;
  private shuttingDown = false;
  /** Nombre de cada espacio por origen y hash del grant. Es contenido del usuario: nunca
   * se loguea. `value` vale hasta `until` (10 min un nombre leído, 60 s un fallo o un meta
   * ausente, para no repetir el sondeo en cada listado); `last` es el último nombre leído,
   * que el bloque de origen sigue dando sin red aunque haya caducado. */
  private readonly names = new Map<
    string,
    { value: string | null; until: number; last: string | null }
  >();
  /** Deja de abrir y adquirir; hasta `closed`, la ronda final de un cierre sigue autorizada. */
  private accepting = true;
  private closed = false;
  readonly lifecycle: SpaceLifecycleControl = {
    configure: ({ idleMs, clock, admit, onClosed }) => {
      this.idleMs = idleMs;
      this.clock = clock;
      this.admit = admit;
      this.onClosed = onClosed;
    },
    acquire: async (spaceId) => (await this.leaseFor(spaceId)).lease,
    prepare: async (spaceId) => {
      const open = [...this.entries.values()].find(
        (entry) => entry.access.spaceId === spaceId && !entry.denied && entry.life.state === 'abierto'
      );
      try {
        return open ? await open.life.acquire() : (await this.leaseFor(spaceId)).lease;
      } catch (error) {
        if (error instanceof ContextUnavailableError) throw error;
        return null;
      }
    },
    reclaimIdle: async () => {
      await Promise.allSettled([...this.entries.values()].map(async (entry) => {
        if (!entry.life.idle) return;
        const status = await entry.instance?.status().catch(() => null);
        if (status && status.pendingUpload > 0 && !status.revoked) return;
        void entry.life.closeIfIdle().catch(() => undefined);
      }));
    },
    beginShutdown: () => {
      this.shuttingDown = true;
      for (const entry of this.entries.values()) entry.instance?.beginShutdown();
    }
  };
  constructor(
    readonly device: AgentDevice,
    private readonly dataDir: string,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly intervalMs?: number | null,
    private readonly instanceOptions?: Pick<OpenLibraryInstanceOptions, 'lock' | 'checkIntervalMs'>,
    private readonly assertAccountActive?: () => void,
    private readonly now: () => number = () => Date.now()
  ) {}

  private async catalogue(): Promise<AgentSpaceAccess[]> {
    this.assertAccountActive?.();
    if (this.closed) throw new ToolError('space_access_denied');
    const registration = await this.device.ensureRegistered();
    try {
      const result = catalogueSchema.parse(await this.device.request('/spaces/agent-access'));
      this.assertAccountActive?.();
      const ids = new Set<string>();
      for (const item of result.spaces) {
        const g = item.grant;
        if (
          ids.has(item.spaceId) ||
          g.spaceId !== item.spaceId ||
          g.syncVaultId !== item.syncVaultId ||
          g.accountId !== registration.accountId ||
          g.credentialId !== registration.credentialId ||
          g.deviceId !== registration.deviceId ||
          g.keyId !== registration.keyId
        )
          throw new Error();
        ids.add(item.spaceId);
      }
      // Invalidar también entradas que no eran la seleccionada. No borra contenido ni
      // espera stop() desde una ronda: el siguiente acceso falla antes de usar la caché.
      for (const entry of this.entries.values()) {
        if (!result.spaces.some((item) => grantHash(item) === grantHash(entry.access)))
          await this.deny(entry);
      }
      return result.spaces;
    } catch {
      throw new ToolError('space_access_denied');
    }
  }

  private async deny(entry: Entry): Promise<void> {
    if (entry.denied) return;
    this.retireDenied(entry);
    await mkdir(entry.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(entry.directory, 'access-denied'), '', { mode: 0o600 });
  }

  /** Síncrono y sin esperar el cierre: quizá nos llamó una ronda, y `close` espera a esa
   * ronda. stop() cancela el temporizador en el acto. El puerto se cierra al terminar lo que
   * el espacio tenga en curso, para no cortar lectores. */
  private retireDenied(entry: Entry): void {
    entry.denied = true;
    void entry.instance?.syncRunner
      ?.stop()
      .then(() => entry.vaultKey?.fill(0))
      .catch(() => {});
    void entry.life.retire().catch(() => {});
  }

  private nameKey(item: AgentSpaceAccess): string {
    return hash([this.device.paired.connection.apiOrigin, grantHash(item)]);
  }

  /** El nombre del espacio, de la caché o leído del registro de alta con la clave `key`
   * (la de una entrada ya abierta) o con la que abre el grant, que se borra al acabar.
   * Pasa por la misma comprobación fresca del grant que el `fetch` de `open()`. Cualquier
   * fallo (meta ausente, relé que rechaza el sondeo, sobre que no abre) deja `null`, sin
   * detalle. */
  private async readName(item: AgentSpaceAccess, key?: Uint8Array): Promise<string | null> {
    const cacheKey = this.nameKey(item);
    const cached = this.names.get(cacheKey);
    if (cached && this.now() < cached.until) return cached.value;
    const remember = (value: string | null) => {
      this.names.set(cacheKey, {
        value,
        until: this.now() + (value === null ? NAME_FAILURE_TTL_MS : NAME_TTL_MS),
        last: value ?? cached?.last ?? null
      });
      return value;
    };
    let own: Uint8Array | undefined;
    try {
      const vaultKey = key ?? (own = await this.device.openGrant(item));
      const { apiOrigin, readToken, writeToken } = this.device.paired.connection;
      const check = async () => {
        const fresh = await this.catalogue();
        if (!fresh.some((s) => grantHash(s) === grantHash(item))) throw new Error();
      };
      const guardedFetch: typeof fetch = async (input, init) => {
        await check();
        const response = await this.fetcher(input, { ...init, redirect: 'error' });
        await check();
        return response;
      };
      const transport = new HttpLibraryTransport(
        async () => ({ apiOrigin, readToken, writeToken }),
        guardedFetch
      );
      const meta = await readSpaceMeta(transport, {
        syncVaultId: item.syncVaultId,
        keyEpoch: 1,
        vaultKey
      });
      return remember(meta?.name ?? null);
    } catch {
      return remember(null);
    } finally {
      own?.fill(0);
    }
  }

  async list(): Promise<Array<{ spaceId: string; name: string | null }>> {
    const before = await this.catalogue();
    const after = new Set((await this.catalogue()).map((s) => s.spaceId));
    const items = before.filter((s) => after.has(s.spaceId));
    const out: Array<{ spaceId: string; name: string | null }> = [];
    for (const item of items) out.push({ spaceId: item.spaceId, name: await this.readName(item) });
    return out;
  }

  /** El directorio de la persona (D22), fresco. Solo lectura: no abre ninguna biblioteca. */
  async directory(): Promise<DirectoryView> {
    this.assertAccountActive?.();
    if (this.closed) throw new ToolError('space_access_denied');
    const { accountId } = await this.device.ensureRegistered();
    const directory = await fetchAgentDirectory(this.device, this.fetcher);
    this.assertAccountActive?.();
    return { selfAccountId: accountId, directory };
  }

  /** La primera validación fresca de la invocación: el catálogo de ahora mismo. Un UUID
   * ausente, apagado, malformado o con otra grafía responde igual que uno inexistente. */
  async resolve(spaceId: string): Promise<ServerContext> {
    const { entry, lease } = await this.leaseFor(spaceId);
    if (entry.pin) lease.release();
    else entry.pin = lease;
    return lease.value;
  }

  private async leaseFor(spaceId: string): Promise<{ entry: Entry; lease: SpaceLease }> {
    const item = (await this.catalogue()).find((space) => space.spaceId === spaceId);
    if (!item || !this.accepting) throw new ToolError('space_access_denied');
    const key = this.nameKey(item);
    const existing = this.entries.get(key);
    // El catálogo de arriba ya retiró la entrada si su grant cambió; otro proceso puede
    // haberla retirado en disco.
    if (existing) this.assertActive(existing);
    const entry = existing ?? this.createEntry(key, item);
    return { entry, lease: await entry.life.acquire() };
  }

  private createEntry(key: string, access: AgentSpaceAccess): Entry {
    const entry: Entry = {
      access,
      directory: join(this.dataDir, 'spaces', key),
      denied: false,
      life: new ResourceLifecycle<ServerContext>({
        clock: this.clock,
        idleMs: () => this.idleMs,
        open: (signal) => this.openAdmitted(entry, signal),
        close: async () => this.closeInstance(entry),
        retiredError: () => new ToolError('space_access_denied'),
        closeAfterUse: () => entry.denied || !this.accepting,
        onDisposable: () => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          this.onClosed?.();
        },
        resource: 'space'
      })
    };
    this.entries.set(key, entry);
    return entry;
  }

  private async openAdmitted(entry: Entry, signal: AbortSignal): Promise<ServerContext> {
    const ticket = await this.admit?.(signal);
    try {
      return await this.open(entry);
    } catch (error) {
      await this.closeInstance(entry);
      throw error;
    } finally {
      ticket?.done();
    }
  }

  private async closeInstance(entry: Entry): Promise<void> {
    const { instance, vaultKey } = entry;
    await instance?.close();
    vaultKey?.fill(0);
    entry.instance = undefined;
    entry.vaultKey = undefined;
  }

  /** Sin red: lo que este proceso o la marca en disco de otro ya saben. Síncrono, para
   * poder mirarlo dentro del turno FIFO antes de cada mutación sin cederlo. */
  private assertActive(entry: Entry): void {
    this.assertAccountActive?.();
    if (entry.denied || this.closed) throw new ToolError('space_access_denied');
    try {
      statSync(join(entry.directory, 'access-denied'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new ToolError('space_access_denied');
    }
    // La marca de otro proceso. La de este ya llevaba `denied`.
    this.retireDenied(entry);
    throw new ToolError('space_access_denied');
  }

  /** Validación fresca: catálogo del relé, sin caché. Nunca dentro del turno FIFO. */
  private async authorize(entry: Entry): Promise<void> {
    this.assertActive(entry);
    const spaces = await this.catalogue();
    if (!spaces.some((item) => grantHash(item) === grantHash(entry.access))) {
      await this.deny(entry);
      throw new ToolError('space_access_denied');
    }
    this.assertActive(entry);
  }

  /** Solo desde `resolve`, que acaba de leer el catálogo fresco: aquí basta lo local. */
  private async open(entry: Entry): Promise<ServerContext> {
    this.assertActive(entry);
    const vaultKey = await this.device.openGrant(entry.access);
    entry.vaultKey = vaultKey;
    const { accountId } = await this.device.ensureRegistered();
    const { apiOrigin, readToken, writeToken } = this.device.paired.connection;
    const authorize = () => this.authorize(entry);
    const assertActive = async () => this.assertActive(entry);
    const identity = { relayOrigin: apiOrigin, syncVaultId: entry.access.syncVaultId };
    const connection = async () => {
      await authorize();
      return { apiOrigin, readToken, writeToken };
    };
    // El cuerpo no llega al motor hasta comprobar de nuevo el grant después de fetch.
    // El relé además controla cada fragmento de un stream y las escrituras al aplicar.
    const guardedFetch: typeof fetch = async (input, init) => {
      await authorize();
      const response = await this.fetcher(input, { ...init, redirect: 'error' });
      await authorize();
      return response;
    };
    const registered = await registerLinkedDevice(
      { identity, connection, opaqueDeviceId: this.device.paired.device.opaqueDeviceId },
      guardedFetch
    );
    if (registered !== 'ok') {
      vaultKey.fill(0);
      throw new ToolError('space_access_denied');
    }
    // Unix limita la ruta del socket (~104 bytes en macOS). La SQLite conserva su
    // directorio completo; solo el IPC usa un directorio temporal privado por usuario.
    const socketDirectory = `/tmp/hebra-mcp-${process.getuid?.() ?? 'user'}`;
    await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
    const stat = await lstat(socketDirectory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new ToolError('space_access_denied');
    const socketPath = join(socketDirectory, `${hash(entry.directory).slice(0, 32)}.sock`);
    const privacySource = await PrivacyConfigSource.open(entry.directory);
    let instance: LibraryInstance;
    try {
      instance = await LibraryInstance.open({
        dataDir: entry.directory,
        socketPath,
        ...this.instanceOptions,
        assertActive: this.assertAccountActive,
        spaceAccess: {
          spaceId: entry.access.spaceId,
          scope: hash([apiOrigin, grantHash(entry.access)]),
          authorize: async () => {
            try {
              await authorize();
            } catch {
              throw new StoreError('space_access_denied');
            }
          },
          assertActive: () => {
            try {
              this.assertActive(entry);
            } catch {
              throw new StoreError('space_access_denied');
            }
          }
        },
        sync: {
          identity,
          vaultKey,
          connection,
          fetcher: guardedFetch,
          spaceEnvelope: { authorId: accountId },
          ...(this.intervalMs === undefined ? {} : { intervalMs: this.intervalMs })
        },
        // Lo que llega por writer.sock viene de otro proceso: aquí no hay una invocación
        // propia que lo haya validado, así que cada petición consulta el catálogo al
        // entrar y antes de contestar (fuera del turno FIFO).
        writerSocket: (opened) =>
          writerSocketHandlers(localWriteContext(opened, authorize, { denyJdex: true }), {
            // El IPC compartido no expone los verbos de workdir (cuerpo completo/JDex).
            status: async () => {
              await authorize();
              const status = await opened.status();
              await authorize();
              return status;
            }
          })
      });
    } catch (error) {
      vaultKey.fill(0);
      throw error;
    }
    entry.instance = instance;
    if (!this.accepting) throw new ToolError('space_access_denied');
    if (this.shuttingDown) instance.beginShutdown();
    await instance.whenReady();
    await authorize();
    // Sin red de más si el listado ya lo leyó; si falla, el bloque de origen lleva null.
    await this.readName(entry.access, vaultKey);
    const nameKey = this.nameKey(entry.access);
    return {
      port: instance.port,
      privacyConfig: privacySource.initial,
      privacyConfigSource: privacySource,
      spaceId: entry.access.spaceId,
      spaceName: () => this.names.get(nameKey)?.last ?? null,
      // La segunda validación fresca de cada invocación (`runTool`, al aceptar).
      authorize,
      status: new RoutedStatusSource(instance, true),
      // Dentro de una invocación ya validada por `resolve`: sin red, solo lo ya sabido.
      // Si esta instancia es lectora, el escritor vuelve a consultar el catálogo.
      write: buildRoutedWriteContext(
        instance,
        localWriteContext(instance, assertActive, { denyJdex: true })
      )
    };
  }

  async close(): Promise<void> {
    this.accepting = false;
    await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => {
        entry.pin?.release();
        entry.pin = undefined;
        await entry.life.retire();
      })
    );
    this.closed = true;
  }
}
