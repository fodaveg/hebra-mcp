/** Contrato cerrado del consentimiento Hebra MCP con Lumbre. */
import { parsePublicOrigin } from '../http/config';
import { isAcceptableOAuthClientId } from './clients';
import { OAUTH_SCOPE } from './provider';

/**
 * Origen de Lumbre si no se configura `LUMBRE_APP_ORIGIN` (H36 del audit del 17 oct 2026).
 * Tiene que ser el mismo origen público que Lumbre usa para construir la URL de
 * consentimiento (`ORIGIN` o `LUMBRE_PUBLIC_ORIGINS`): el broker la compara con él antes de
 * redirigir al navegador, y a él manda el backchannel.
 */
export const DEFAULT_LUMBRE_APP_ORIGIN = 'https://app.lumbre.pro';
export const LUMBRE_CALLBACK = 'https://mcp.hebra.pro/oauth/lumbre/callback';
/** Tope de `Retry-After` que se toma en serio: más allá, la cabecera no se considera válida. */
const MAX_RETRY_AFTER_S = 86_400;
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

/** Instante ISO 8601 canónico (`toISOString`), como lo emite Lumbre. */
function isoInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validGrant(record: Record<string, unknown>, resource: string): boolean {
  return validBinding(record) && typeof record.credentialId === 'string' && UUID.test(record.credentialId) &&
    typeof record.clientId === 'string' && isAcceptableOAuthClientId(record.clientId) &&
    record.resource === resource && record.scope === OAUTH_SCOPE &&
    typeof record.accountId === 'string' && HEX64.test(record.accountId) &&
    isoInstant(record.expiresAt);
}

/**
 * Segundos de `Retry-After` (RFC 9110 §10.2.3: segundos o fecha HTTP), o `undefined` si la
 * cabecera falta, no se entiende o pide esperar más de un día.
 */
function retryAfterSeconds(raw: string | null, now: number): number | undefined {
  if (raw === null) return undefined;
  const value = raw.trim();
  let seconds: number;
  if (/^\d{1,9}$/.test(value)) seconds = Number(value);
  else {
    const date = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ? Date.parse(value) : NaN;
    if (!Number.isFinite(date)) return undefined;
    seconds = Math.max(0, Math.ceil((date - now) / 1000));
  }
  return seconds <= MAX_RETRY_AFTER_S ? seconds : undefined;
}

/**
 * Una respuesta inesperada no autoriza nada; nunca se devuelve su cuerpo en errores.
 * `rate_limited` es el 429 de Lumbre, con su `Retry-After` en segundos si era válido.
 */
export class BackchannelError extends Error {
  constructor(readonly kind: 'inactive' | 'unavailable' | 'invalid' | 'rate_limited', readonly retryAfter?: number) {
    super(kind);
  }
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class LumbreBackchannel {
  private readonly api: string;
  /** Origen de Lumbre ya validado y normalizado (sin barra final). */
  readonly appOrigin: string;

  /**
   * `appOrigin` se valida como `HEBRA_MCP_PUBLIC_URL` (https, o http solo en loopback; sin
   * ruta, query, fragmento ni credenciales): un valor inválido lanza `HttpConfigError`
   * nombrando `LUMBRE_APP_ORIGIN`, sin repetir el valor.
   */
  constructor(
    private readonly secret: string,
    private readonly resource: string,
    appOrigin: string = DEFAULT_LUMBRE_APP_ORIGIN,
    private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis)
  ) {
    if (secret.length < 32 || secret.length > 512 || /[\r\n]/.test(secret)) throw new BackchannelError('unavailable');
    this.appOrigin = parsePublicOrigin(appOrigin, 'LUMBRE_APP_ORIGIN').origin;
    this.api = `${this.appOrigin}/api/integrations/hebra-mcp`;
  }

  private async post(path: string, body: object): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.api}/${path}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(3000),
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body)
      });
    } catch { throw new BackchannelError('unavailable'); }
    if (response.status === 429) {
      throw new BackchannelError('rate_limited', retryAfterSeconds(response.headers.get('retry-after'), Date.now()));
    }
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
    if (url.origin !== this.appOrigin || url.pathname !== '/integrations/hebra-mcp' ||
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

  /**
   * Renueva la concesión al procesar un refresh OAuth (`/renew`, contrato H-dec4/H31 del 17
   * oct 2026): la nueva caducidad, 30 días desde la renovación, o `null` si Lumbre ya no la
   * da por viva (caducada, revocada o desvinculada). La introspección no renueva nada.
   */
  async renew(accessToken: string): Promise<string | null> {
    const raw = await this.post('renew', { accessToken });
    if (object(raw, ['active'])?.active === false) return null;
    const value = object(raw, ['active', 'expiresAt']);
    if (!value || value.active !== true || !isoInstant(value.expiresAt)) throw new BackchannelError('invalid');
    return value.expiresAt;
  }

  async revoke(accessToken: string): Promise<void> {
    if (object(await this.post('revoke', { accessToken }), ['revoked'])?.revoked !== true) throw new BackchannelError('invalid');
  }
}

export function sameBinding(a: Binding, b: Binding): boolean {
  return a.pairedCredentialId === b.pairedCredentialId && a.syncVaultId === b.syncVaultId && a.opaqueDeviceId === b.opaqueDeviceId;
}
