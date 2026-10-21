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

/**
 * Código de error cerrado de un cuerpo de Lumbre, venga en `error` o en `code`. Solo cuerpos
 * con esas claves (una o las dos); si traen las dos y no coinciden, no hay código.
 */
function errorCode(value: unknown): string | null {
  const record = object(value, ['error']) ?? object(value, ['code']) ?? object(value, ['error', 'code']);
  if (!record) return null;
  const codes = [record.error, record.code].filter((entry) => entry !== undefined);
  if (!codes.every((entry) => typeof entry === 'string' && entry === codes[0])) return null;
  return codes[0] as string;
}

/** Una fecha que `Date.parse` entiende: la misma tolerancia que `request` da a `expiresAt`. */
function isoInstantOrDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
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
 * `pairing_revoked` es el `410 {"error":"pairing_revoked"}` de Lumbre (emparejado revocado o
 * vínculo Blob V2 inactivo; contrato del 21 oct 2026, SPEC.md §12.9). `status` es el código
 * HTTP de la respuesta, si la hubo: el canje con Sumego distingue «acceso denegado» de «no
 * disponible» por él.
 */
export class BackchannelError extends Error {
  constructor(
    readonly kind: 'inactive' | 'unavailable' | 'invalid' | 'rate_limited' | 'pairing_revoked',
    readonly retryAfter?: number,
    readonly status?: number
  ) {
    super(kind);
  }
}

/** Entrada del canje con Sumego (`sumego/exchange`); el ID token solo viaja aquí. */
export interface SumegoExchangeInput {
  requestId: string;
  transactionId: string;
  idToken: string;
  clientId: string;
}

/** Tope del cuerpo del canje con Sumego (SPEC.md §12.9). */
export const MAX_SUMEGO_EXCHANGE_BODY_BYTES = 16 * 1024;

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

  private async post(path: string, body: object, maxBodyBytes?: number): Promise<unknown> {
    const payload = JSON.stringify(body);
    if (maxBodyBytes !== undefined && Buffer.byteLength(payload) > maxBodyBytes) throw new BackchannelError('invalid');
    let response: Response;
    try {
      response = await this.fetcher(`${this.api}/${path}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(3000),
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json', accept: 'application/json' },
        body: payload
      });
    } catch { throw new BackchannelError('unavailable'); }
    if (response.status === 429) {
      throw new BackchannelError('rate_limited', retryAfterSeconds(response.headers.get('retry-after'), Date.now()), 429);
    }
    if (response.status === 410) {
      // Solo el error cerrado de Lumbre es una revocación; otro 410 es una respuesta inesperada.
      // `/requests` responde `{error}` y `sumego/exchange` `{error, code}`: se leen los dos campos.
      const gone = await this.readJson(response).catch(() => null);
      throw new BackchannelError(errorCode(gone) === 'pairing_revoked' ? 'pairing_revoked' : 'invalid', undefined, 410);
    }
    if (response.status !== 200) throw new BackchannelError(response.status >= 500 ? 'unavailable' : 'invalid', undefined, response.status);
    return this.readJson(response);
  }

  /** Cuerpo JSON con tope de 64 KiB; cualquier otra cosa es `invalid`. */
  private async readJson(response: Response): Promise<unknown> {
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

  /**
   * `/requests` en modo `sumego` (SPEC.md §12.9): el de hoy más `identityProvider` y el
   * sha256 del `nonce` de Sumego en base64url. Lumbre guarda el nonce con la transacción y
   * responde exactamente `{requestId, expiresAt}`, sin `authorizationUrl`.
   */
  async requestSumego(input: Binding & { transactionId: string; clientId: string; clientName: string; sumegoNonceSha256: string }): Promise<{ requestId: string; expiresAt: string }> {
    const raw = await this.post('requests', { ...input, resource: this.resource, scope: OAUTH_SCOPE, callbackUri: LUMBRE_CALLBACK, identityProvider: 'sumego' });
    const value = object(raw, ['requestId', 'expiresAt']);
    if (!value || typeof value.requestId !== 'string' || !UUID.test(value.requestId) ||
      !isoInstantOrDate(value.expiresAt)) throw new BackchannelError('invalid');
    return { requestId: value.requestId, expiresAt: value.expiresAt };
  }

  async exchange(requestId: string, transactionId: string): Promise<Grant> {
    return this.grantFrom(await this.post('exchange', { requestId, transactionId }));
  }

  /**
   * Canje con el ID token de Sumego (`sumego/exchange`, ruta hermana de la de lumbre-mcp).
   * Lumbre valida el ID token por su cuenta y responde la misma concesión que `exchange`.
   * El cuerpo no pasa de 16 KiB; si pasaría, no se envía.
   */
  async sumegoExchange(input: SumegoExchangeInput): Promise<Grant> {
    return this.grantFrom(await this.post('sumego/exchange',
      { ...input, resource: this.resource, scope: OAUTH_SCOPE }, MAX_SUMEGO_EXCHANGE_BODY_BYTES));
  }

  /** La concesión de `exchange` y `sumego/exchange`: mismas claves, misma validación. */
  private grantFrom(raw: unknown): Grant {
    const value = object(raw, ['credentialId', 'accessToken', 'tokenType', 'clientId', 'resource', 'scope', 'accountId', 'pairedCredentialId', 'syncVaultId', 'opaqueDeviceId', 'expiresAt']);
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
