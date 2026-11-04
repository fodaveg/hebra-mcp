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
  DEVICE_RESPONSE_MAX_BYTES,
  publicKeySchema,
  registrationSchema,
  deviceKeyId,
  type AgentPublicKey,
  type AgentRegistration,
  type AgentSpaceAccess
} from './protocol';

type Fetcher = typeof globalThis.fetch;

/** El JSON de la respuesta, leído por trozos para cortar en cuanto pase del tope. Lanza si pasa. */
async function readLimitedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > DEVICE_RESPONSE_MAX_BYTES) throw new Error();
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const read = await reader?.read();
    if (!read || read.done) break;
    size += read.value.byteLength;
    if (size > DEVICE_RESPONSE_MAX_BYTES) {
      await reader?.cancel();
      throw new Error();
    }
    chunks.push(read.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

interface StoredAgentKey {
  binding: string;
  privateKey: JsonWebKey;
  accountId?: string;
}
/**
 * Lumbre responde 404 a `PUT /agent-device-key` cuando `HEBRA_SPACES_2B` está apagado, la
 * credencial no existe o el agente se desactivó entre la autenticación y la transacción. No
 * dice cuál de las tres, y NO significa "agente desactivado". Hacia fuera sigue siendo
 * `space_access_denied`; el alta lo distingue por la clase para seguir sin espacios.
 */
export class AgentKeyNotFoundError extends ToolError {
  constructor() { super('space_access_denied'); }
}
/**
 * 401 `credential_revoked` al registrar la clave de agente. Lumbre responde igual a una
 * credencial revocada y a un agente desactivado (docs/80 §8g.1): no se pueden distinguir.
 */
export class AgentKeyUnauthorizedError extends ToolError {
  constructor() { super('space_access_denied'); }
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
 * queda solo en memoria hasta la confirmación; cancelar no modifica el llavero anterior.
 * `existingKey`: al renovar, una credencial que sobrevive (caducada o desactivada) conserva su
 * pública y Lumbre rechaza otra con `version_conflict`. */
export async function prepareAgentDevice(
  connection: LumbreConnection,
  deviceId: string,
  fetcher: Fetcher,
  existingKey?: JsonWebKey
): Promise<PreparedAgentDevice> {
  const privateKey = existingKey ?? await generatePrivateKey();
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
    if (response.status === 404) throw new AgentKeyNotFoundError();
    if (response.status === 401) throw new AgentKeyUnauthorizedError();
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
  } catch (error) {
    if (error instanceof AgentKeyNotFoundError || error instanceof AgentKeyUnauthorizedError) throw error;
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
    private readonly dataDir?: string,
    private readonly assertAccountActive?: () => void
  ) {}

  /** Ningún proceso ya abierto sigue sirviendo la caché después de cambiar de vínculo. */
  async assertPairing(): Promise<void> {
    this.assertAccountActive?.();
    const current = await readPairedSecrets(this.secrets);
    this.assertAccountActive?.();
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
            // Todo método que cambia datos lleva `Content-Type: application/json`, con o sin
            // cuerpo: sin él SvelteKit lo rechaza como formulario cross-site (403).
            ...(body === undefined && method === 'GET' ? {} : { 'Content-Type': 'application/json' })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }
      );
      if (!response.ok) throw new Error();
      const value = await readLimitedJson(response);
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
    this.assertAccountActive?.();
    const directory = join(this.dataDir, 'agent-key-lock');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.assertAccountActive?.();
    const lock = new WriterLock({ dataDir: directory, releaseOnExit: false });
    const deadline = Date.now() + 15_000;
    while (true) {
      this.assertAccountActive?.();
      if (lock.tryAcquire()) break;
      if (Date.now() >= deadline) throw new ToolError('space_access_denied');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      this.assertAccountActive?.();
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
    this.assertAccountActive?.();
    if (stored) {
      try {
        raw = JSON.parse(stored);
      } catch {
        throw new ToolError('space_access_denied');
      }
    }
    if (!raw || raw.binding !== binding) {
      raw = { binding, privateKey: await generatePrivateKey() };
      this.assertAccountActive?.();
      await this.secrets.set('agent-device-key', JSON.stringify(raw));
      this.assertAccountActive?.();
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
      this.assertAccountActive?.();
      const registration = await validateRegistration(
        await this.request('/agent-device-key', 'PUT', { publicKey }),
        this.paired.connection,
        this.paired.device.lumbreDeviceId,
        publicKey
      );
      this.assertAccountActive?.();
      if (raw.accountId && registration.accountId !== raw.accountId) throw new Error();
      await this.secrets.set(
        'agent-device-key',
        JSON.stringify({ ...raw, accountId: registration.accountId })
      );
      this.assertAccountActive?.();
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
      const key = new Uint8Array(
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
      try { this.assertAccountActive?.(); }
      catch (error) { key.fill(0); throw error; }
      return key;
    } catch {
      throw new ToolError('space_access_denied');
    }
  }
}
