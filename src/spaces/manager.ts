/** Catálogo y bibliotecas aisladas para espacios autorizados al agente H-L7.
 * La caché nunca concede autoridad: cada llamada, mutación y petición al relé la revalida. */
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerContext, SpaceRouter } from '../server/context';
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
import { AgentDevice } from './device';
import { catalogueSchema, type AgentSpaceAccess } from './protocol';

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
  opening?: Promise<ServerContext>;
  instance?: LibraryInstance;
  vaultKey?: Uint8Array;
}

export class AgentSpaceManager implements SpaceRouter {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(
    readonly device: AgentDevice,
    private readonly dataDir: string,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly intervalMs?: number | null,
    private readonly instanceOptions?: Pick<OpenLibraryInstanceOptions, 'lock' | 'checkIntervalMs'>
  ) {}

  private async catalogue(): Promise<AgentSpaceAccess[]> {
    if (this.closed) throw new ToolError('space_access_denied');
    await this.device.ensureRegistered();
    try {
      const result = catalogueSchema.parse(await this.device.request('/spaces/agent-access'));
      const ids = new Set<string>();
      const registration = await this.device.ensureRegistered();
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
    entry.denied = true;
    // stop() cancela el temporizador inmediatamente, sin esperar aquí la ronda que
    // quizá nos llamó. El puerto queda abierto hasta close para no cortar lectores.
    void entry.instance?.syncRunner
      ?.stop()
      .then(() => entry.vaultKey?.fill(0))
      .catch(() => {});
    await mkdir(entry.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(entry.directory, 'access-denied'), '', { mode: 0o600 });
  }

  async list(): Promise<Array<{ spaceId: string }>> {
    const before = await this.catalogue();
    const after = new Set((await this.catalogue()).map((s) => s.spaceId));
    return before.filter((s) => after.has(s.spaceId)).map(({ spaceId }) => ({ spaceId }));
  }

  async resolve(spaceId: string): Promise<ServerContext> {
    const item = (await this.catalogue()).find((space) => space.spaceId === spaceId);
    if (!item) throw new ToolError('space_access_denied');
    const key = hash([this.device.paired.connection.apiOrigin, grantHash(item)]);
    let entry = this.entries.get(key);
    if (!entry) {
      const directory = join(this.dataDir, 'spaces', key);
      entry = {
        access: item,
        directory,
        denied: false
      };
      this.entries.set(key, entry);
      const openingEntry = entry;
      entry.opening = this.open(entry).catch(async (error: unknown) => {
        await openingEntry.instance?.close();
        openingEntry.vaultKey?.fill(0);
        this.entries.delete(key);
        throw error;
      });
    }
    if (entry.denied) throw new ToolError('space_access_denied');
    return entry.opening!;
  }

  private async authorize(entry: Entry): Promise<void> {
    if (entry.denied || this.closed) throw new ToolError('space_access_denied');
    try {
      await access(join(entry.directory, 'access-denied'));
      entry.denied = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new ToolError('space_access_denied');
    }
    if (entry.denied) throw new ToolError('space_access_denied');
    const spaces = await this.catalogue();
    if (!spaces.some((item) => grantHash(item) === grantHash(entry.access))) {
      await this.deny(entry);
      throw new ToolError('space_access_denied');
    }
  }

  private async open(entry: Entry): Promise<ServerContext> {
    await this.authorize(entry);
    const vaultKey = await this.device.openGrant(entry.access);
    entry.vaultKey = vaultKey;
    const { accountId } = await this.device.ensureRegistered();
    const { apiOrigin, readToken, writeToken } = this.device.paired.connection;
    const authorize = () => this.authorize(entry);
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
        spaceAccess: {
          spaceId: entry.access.spaceId,
          scope: hash([apiOrigin, grantHash(entry.access)]),
          authorize: async () => {
            try {
              await authorize();
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
        writerSocket: (opened) =>
          writerSocketHandlers(localWriteContext(opened, authorize), {
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
    if (this.closed) {
      await instance.close();
      throw new ToolError('space_access_denied');
    }
    await instance.whenReady();
    await authorize();
    return {
      port: instance.port,
      privacyConfig: privacySource.initial,
      privacyConfigSource: privacySource,
      spaceId: entry.access.spaceId,
      authorize,
      status: new RoutedStatusSource(instance, true),
      write: buildRoutedWriteContext(instance, localWriteContext(instance, authorize))
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => {
        await entry.opening?.catch(() => {});
        await entry.instance?.close();
        entry.vaultKey?.fill(0);
      })
    );
  }
}
