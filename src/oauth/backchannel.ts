/** Contrato cerrado del consentimiento Hebra MCP con Lumbre. */
import { DCR_CLIENT_ID, isAcceptableCimdClientId } from './clients';
import { OAUTH_SCOPE } from './provider';

export const LUMBRE_APP_ORIGIN = 'https://app.lumbre.pro';
export const LUMBRE_CALLBACK = 'https://mcp.hebra.pro/oauth/lumbre/callback';
const API = `${LUMBRE_APP_ORIGIN}/api/integrations/hebra-mcp`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEVICE = /^[0-9a-f]{32}$/;
const VAULT = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface Binding {
  pairedCredentialId: string;
  syncVaultId: string;
  opaqueDeviceId: string;
}

export interface Grant extends Binding {
  credentialId: string;
  accessToken: string;
  clientId: string;
  resource: string;
  scope: string;
  accountId: string;
  expiresAt: string;
}

export type ActiveGrant = Omit<Grant, 'accessToken'> & { active: true };

function object(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key)) ? record : null;
}

function validBinding(record: Record<string, unknown>): boolean {
  return typeof record.pairedCredentialId === 'string' && UUID.test(record.pairedCredentialId) &&
    typeof record.syncVaultId === 'string' && VAULT.test(record.syncVaultId) &&
    typeof record.opaqueDeviceId === 'string' && DEVICE.test(record.opaqueDeviceId);
}

function validGrant(record: Record<string, unknown>, resource: string): boolean {
  return validBinding(record) && typeof record.credentialId === 'string' && UUID.test(record.credentialId) &&
    typeof record.clientId === 'string' && (record.clientId === DCR_CLIENT_ID || isAcceptableCimdClientId(record.clientId)) &&
    record.resource === resource && record.scope === OAUTH_SCOPE &&
    typeof record.accountId === 'string' && HEX64.test(record.accountId) &&
    typeof record.expiresAt === 'string' && Number.isFinite(Date.parse(record.expiresAt)) &&
    new Date(record.expiresAt).toISOString() === record.expiresAt;
}

/** Una respuesta inesperada no autoriza nada; nunca se devuelve su cuerpo en errores. */
export class BackchannelError extends Error {
  constructor(readonly kind: 'inactive' | 'unavailable' | 'invalid') {
    super(kind);
  }
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class LumbreBackchannel {
  constructor(
    private readonly secret: string,
    private readonly resource: string,
    private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis)
  ) {
    if (secret.length < 32 || secret.length > 512 || /[\r\n]/.test(secret)) throw new BackchannelError('unavailable');
  }

  private async post(path: string, body: object): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${API}/${path}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(3000),
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body)
      });
    } catch { throw new BackchannelError('unavailable'); }
    if (response.status !== 200) throw new BackchannelError(response.status >= 500 ? 'unavailable' : 'invalid');
    if ((response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim() !== 'application/json') throw new BackchannelError('invalid');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 65536) throw new BackchannelError('invalid');
    if (!response.body) throw new BackchannelError('invalid');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 65536) throw new BackchannelError('invalid');
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof BackchannelError) throw error;
      throw new BackchannelError('invalid');
    } finally { reader.releaseLock(); }
  }

  async request(input: Binding & { transactionId: string; clientId: string; clientName: string }): Promise<{ requestId: string; authorizationUrl: string; expiresAt: string }> {
    const value = object(await this.post('requests', { ...input, resource: this.resource, scope: OAUTH_SCOPE, callbackUri: LUMBRE_CALLBACK }), ['requestId', 'authorizationUrl', 'expiresAt']);
    if (!value || typeof value.requestId !== 'string' || !UUID.test(value.requestId) ||
      typeof value.authorizationUrl !== 'string' || typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt))) throw new BackchannelError('invalid');
    const url = new URL(value.authorizationUrl);
    if (url.origin !== LUMBRE_APP_ORIGIN || url.pathname !== '/integrations/hebra-mcp' ||
      url.searchParams.size !== 1 || url.searchParams.get('request') !== value.requestId || url.hash) throw new BackchannelError('invalid');
    return value as unknown as { requestId: string; authorizationUrl: string; expiresAt: string };
  }

  async exchange(requestId: string, transactionId: string): Promise<Grant> {
    const value = object(await this.post('exchange', { requestId, transactionId }), ['credentialId', 'accessToken', 'tokenType', 'clientId', 'resource', 'scope', 'accountId', 'pairedCredentialId', 'syncVaultId', 'opaqueDeviceId', 'expiresAt']);
    if (!value || !validGrant(value, this.resource) || value.tokenType !== 'Bearer' ||
      typeof value.accessToken !== 'string' || !HEX64.test(value.accessToken)) throw new BackchannelError('invalid');
    return value as unknown as Grant;
  }

  async introspect(accessToken: string): Promise<ActiveGrant | null> {
    const raw = await this.post('introspect', { accessToken });
    if (object(raw, ['active'])?.active === false) return null;
    const value = object(raw, ['active', 'credentialId', 'clientId', 'resource', 'scope', 'accountId', 'pairedCredentialId', 'syncVaultId', 'opaqueDeviceId', 'expiresAt']);
    if (!value || value.active !== true || !validGrant(value, this.resource)) throw new BackchannelError('invalid');
    return value as unknown as ActiveGrant;
  }

  async revoke(accessToken: string): Promise<void> {
    if (object(await this.post('revoke', { accessToken }), ['revoked'])?.revoked !== true) throw new BackchannelError('invalid');
  }
}

export function sameBinding(a: Binding, b: Binding): boolean {
  return a.pairedCredentialId === b.pairedCredentialId && a.syncVaultId === b.syncVaultId && a.opaqueDeviceId === b.opaqueDeviceId;
}
