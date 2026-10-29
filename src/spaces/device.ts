/** Clave ECDH propia del agente, estable por credencial y guardada solo en SecretStore. */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WriterLock } from '../lock/writer-lock';
import { openAgentSpaceGrant } from '../hebra';
import type { LumbreConnection } from '../hebra';
import type { SecretStore, PairedSecrets } from '../secrets';
import { readPairedSecrets } from '../secrets';
import { ToolError } from '../server/errors';
import {
  publicKeySchema,
  registrationSchema,
  deviceKeyId,
  type AgentPublicKey,
  type AgentRegistration,
  type AgentSpaceAccess
} from './protocol';

type Fetcher = typeof globalThis.fetch;
interface StoredAgentKey {
  binding: string;
  privateKey: JsonWebKey;
  accountId?: string;
}
export interface PreparedAgentDevice {
  privateKey: JsonWebKey;
  registration: AgentRegistration;
}
function keyBinding(p: Pick<PairedSecrets, 'connection' | 'device'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([p.connection.apiOrigin, p.connection.credentialId, p.device.lumbreDeviceId])
    )
    .digest('hex');
}
async function generatePrivateKey(): Promise<JsonWebKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits'
  ]);
  return crypto.subtle.exportKey('jwk', pair.privateKey);
}
async function validateRegistration(
  raw: unknown,
  connection: LumbreConnection,
  deviceId: string,
  publicKey: AgentPublicKey
): Promise<AgentRegistration> {
  const r = registrationSchema.parse(raw);
  if (
    r.credentialId !== connection.credentialId ||
    r.deviceId !== deviceId ||
    r.keyId !== (await deviceKeyId(publicKey)) ||
    (await deviceKeyId(r.publicKey)) !== r.keyId
  )
    throw new ToolError('space_access_denied');
  return r;
}
/** Pair registra el dispositivo ANTES de consultar biblioteca o pedir preview. Su privada
 * queda solo en memoria hasta la confirmación; cancelar no modifica el llavero anterior. */
export async function prepareAgentDevice(
  connection: LumbreConnection,
  deviceId: string,
  fetcher: Fetcher
): Promise<PreparedAgentDevice> {
  const privateKey = await generatePrivateKey();
  const { kty, crv, x, y } = privateKey;
  const publicKey = publicKeySchema.parse({ kty, crv, x, y });
  try {
    const response = await fetcher(
      `${connection.apiOrigin}/api/integrations/hebra/agent-device-key`,
      {
        method: 'PUT',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${connection.writeToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ publicKey })
      }
    );
    if (!response.ok) throw new Error();
    return {
      privateKey,
      registration: await validateRegistration(
        await response.json(),
        connection,
        deviceId,
        publicKey
      )
    };
  } catch {
    throw new ToolError('space_access_denied');
  }
}
export async function savePreparedAgentDevice(
  store: SecretStore,
  paired: PairedSecrets,
  prepared: PreparedAgentDevice
): Promise<void> {
  if (
    prepared.registration.credentialId !== paired.connection.credentialId ||
    prepared.registration.deviceId !== paired.device.lumbreDeviceId
  ) {
    throw new ToolError('space_access_denied');
  }
  await store.set(
    'agent-device-key',
    JSON.stringify({
      binding: keyBinding(paired),
      privateKey: prepared.privateKey,
      accountId: prepared.registration.accountId
    })
  );
}

export function pairingFingerprint(p: PairedSecrets): string {
  const c = p.connection;
  return createHash('sha256')
    .update(
      JSON.stringify([
        c.apiOrigin,
        c.credentialId,
        c.readToken,
        c.writeToken,
        c.connectedAt,
        p.recoveryCode,
        p.device.opaqueDeviceId,
        p.device.lumbreDeviceId
      ])
    )
    .digest('hex');
}
export class AgentDevice {
  private registration: AgentRegistration | null = null;
  private privateKey: CryptoKey | null = null;
  private registering: Promise<AgentRegistration> | null = null;
  constructor(
    readonly paired: PairedSecrets,
    private readonly secrets: SecretStore,
    private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis),
    private readonly dataDir?: string
  ) {}

  /** Ningún proceso ya abierto sigue sirviendo la caché después de cambiar de vínculo. */
  async assertPairing(): Promise<void> {
    const current = await readPairedSecrets(this.secrets);
    if (!current || pairingFingerprint(current) !== pairingFingerprint(this.paired))
      throw new ToolError('space_access_denied');
  }

  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    await this.assertPairing();
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.paired.connection.apiOrigin}/api/integrations/hebra${path}`,
        {
          method,
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(15_000),
          headers: {
            Authorization: `Bearer ${method === 'GET' ? this.paired.connection.readToken : this.paired.connection.writeToken}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }
      );
      if (!response.ok) throw new Error();
      const value: unknown = await response.json();
      await this.assertPairing();
      return value;
    } catch {
      throw new ToolError('space_access_denied');
    }
  }

  async ensureRegistered(): Promise<AgentRegistration> {
    await this.assertPairing();
    if (this.registration) return this.registration;
    this.registering ??= this.withKeyLock().finally(() => {
      this.registering = null;
    });
    return this.registering;
  }

  private async withKeyLock(): Promise<AgentRegistration> {
    if (!this.dataDir) throw new ToolError('space_access_denied');
    const directory = join(this.dataDir, 'agent-key-lock');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = new WriterLock({ dataDir: directory, releaseOnExit: false });
    const deadline = Date.now() + 15_000;
    while (!lock.tryAcquire()) {
      if (Date.now() >= deadline) throw new ToolError('space_access_denied');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      return await this.register();
    } finally {
      lock.release();
    }
  }

  private async register(): Promise<AgentRegistration> {
    // El escritor de la biblioteca crea esta entrada antes de abrir sync. Los lectores
    // solo reutilizan la misma entrada; el bloqueo de arranque lo proporciona el manager.
    const binding = keyBinding(this.paired);
    let raw: StoredAgentKey | null = null;
    const stored = await this.secrets.get('agent-device-key');
    if (stored) {
      try {
        raw = JSON.parse(stored);
      } catch {
        throw new ToolError('space_access_denied');
      }
    }
    if (!raw || raw.binding !== binding) {
      raw = { binding, privateKey: await generatePrivateKey() };
      await this.secrets.set('agent-device-key', JSON.stringify(raw));
    }
    try {
      const { kty, crv, x, y } = raw.privateKey;
      const publicKey = publicKeySchema.parse({ kty, crv, x, y });
      this.privateKey = await crypto.subtle.importKey(
        'jwk',
        raw.privateKey,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits']
      );
      const registration = await validateRegistration(
        await this.request('/agent-device-key', 'PUT', { publicKey }),
        this.paired.connection,
        this.paired.device.lumbreDeviceId,
        publicKey
      );
      if (raw.accountId && registration.accountId !== raw.accountId) throw new Error();
      await this.secrets.set(
        'agent-device-key',
        JSON.stringify({ ...raw, accountId: registration.accountId })
      );
      this.registration = registration;
      return registration;
    } catch {
      throw new ToolError('space_access_denied');
    }
  }

  /** Abre únicamente los 32 bytes de la clave DEL ESPACIO, con todos sus bindings. */
  async openGrant(access: AgentSpaceAccess): Promise<Uint8Array<ArrayBuffer>> {
    const r = await this.ensureRegistered();
    const g = access.grant;
    if (
      g.spaceId !== access.spaceId ||
      g.syncVaultId !== access.syncVaultId ||
      g.accountId !== r.accountId ||
      g.credentialId !== r.credentialId ||
      g.deviceId !== r.deviceId ||
      g.keyId !== r.keyId
    )
      throw new ToolError('space_access_denied');
    try {
      return new Uint8Array(
        await openAgentSpaceGrant({
          grant: g,
          privateKey: this.privateKey!,
          expected: {
            spaceId: access.spaceId,
            syncVaultId: access.syncVaultId,
            accountId: r.accountId,
            credentialId: r.credentialId,
            deviceId: r.deviceId,
            keyId: r.keyId
          }
        })
      );
    } catch {
      throw new ToolError('space_access_denied');
    }
  }
}
