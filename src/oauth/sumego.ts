/**
 * Cliente OIDC de hebra-mcp en Sumego (D20, SPEC.md §12.9): confidencial, `client_secret_basic`,
 * scopes `openid email`, PKCE S256 y `redirect_uri` exacta `<origen público>/oauth/sumego/callback`.
 *
 * - Discovery: `<issuer>/.well-known/openid-configuration`, nunca copiada a mano. Se guarda
 *   10 min; un fallo se recuerda 30 s (igual que Lumbre). Se exige el `issuer` exacto y que
 *   `authorization_endpoint`, `token_endpoint` y `jwks_uri` sean del mismo origen que el
 *   issuer: así el único destino de redirección fuera de los callbacks de hoy es una URL de
 *   la discovery validada.
 * - JWKS: `jwks_uri` de la discovery, 10 min en caché. Un `kid` desconocido vuelve a pedirlo
 *   como mucho cada 30 s (rotación de claves sin abrir la puerta a una ráfaga de peticiones), y
 *   un fallo de descarga también se recuerda 30 s. Solo claves EC P-256 de firma.
 * - `token_endpoint`: canje del código (ID token y refresh) y renovación horaria con el refresh,
 *   que Sumego rota en cada uso. Scopes `openid email`: Sumego da refresh a sus clientes propios
 *   sin `offline_access`.
 * - Firmas: solo ES256 (`jose`). `alg: none`, HS* y cualquier otro algoritmo se rechazan antes
 *   de buscar clave.
 * - Toda llamada a Sumego (discovery, JWKS, `token_endpoint`) va al issuer configurado y sin
 *   seguir redirecciones (`redirect: 'manual'`), con timeout de 5 s y tope de 64 KiB. Un 3xx es
 *   `unavailable`, nunca `invalid`: tras la transición de §13.6 de Sumego, `id.lumbre.pro`
 *   responde 308 y eso no puede cortar familias que siguen vivas en el otro issuer.
 *
 * Nada de lo que pasa por aquí (código, `code_verifier`, ID token, `logout_token`, secreto del
 * cliente) se registra ni se devuelve en un error: `SumegoError` solo lleva un código cerrado.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK, type JWTPayload } from 'jose';
import { isLoopbackHostname } from '../http/config';
import type { OidcClientConfig } from './login-config';

export const SUMEGO_CALLBACK_PATH = '/oauth/sumego/callback';
export const SUMEGO_CONSENT_PATH = '/oauth/sumego/consent';
export const SUMEGO_LOGOUT_PATH = '/oauth/sumego/backchannel-logout';
export const SUMEGO_SCOPES = 'openid email';
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
export const DISCOVERY_TTL_MS = 10 * 60_000;
export const DISCOVERY_FAILURE_TTL_MS = 30_000;
export const JWKS_TTL_MS = 10 * 60_000;
/** Intervalo mínimo entre dos descargas del JWKS por un `kid` desconocido. */
export const JWKS_REFETCH_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_DOCUMENT_BYTES = 64 * 1024;
/** Un ID token o `logout_token` más largo no es de Sumego. */
export const MAX_JWT_LENGTH = 8 * 1024;
/** `iat` del ID token: 5 min como mucho, con 60 s de margen. */
const ID_TOKEN_MAX_AGE_S = 300;
/** `iat` del `logout_token`: 10 min como mucho, con 60 s de margen. */
const LOGOUT_TOKEN_MAX_AGE_S = 600;
export const CLOCK_TOLERANCE_S = 60;
const MAX_CLAIM_LENGTH = 255;

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * `unavailable`: Sumego no responde o responde mal (red, 5xx, discovery o JWKS caídos).
 * `invalid`: la respuesta o el token no valen (firma, claims, código rechazado).
 */
export class SumegoError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid') {
    super(kind);
    this.name = 'SumegoError';
  }
}

interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

/** Lo que hebra-mcp se queda del ID token: identidad y el email para la página. */
export interface IdTokenClaims {
  sub: string;
  sid: string;
  email: string | null;
  /** `iat` en segundos: el consentimiento caduca a `iat` + 5 min − 30 s. */
  iat: number;
}

/** `logout_token` validado (OIDC Back-Channel Logout 1.0 §2.4). */
export interface LogoutClaims {
  jti: string;
  sub: string | null;
  sid: string | null;
  /** `iat` en segundos: una autorización con ID token anterior o igual queda cerrada. */
  iat: number;
  /** Hasta cuándo hay que recordar el `jti` (y los `sid`/`sub` cerrados), en ms. */
  rememberUntil: number;
}

/** Refresh de Sumego tal como llega; el tope evita guardar algo desmesurado. */
function refreshTokenValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

function sameString(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

function shortString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CLAIM_LENGTH;
}

/** URL de la discovery: https (http solo en loopback, para tests), del origen del issuer. */
function endpoint(value: unknown, issuer: string): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname));
  if (!secure || url.origin !== issuer || url.hash !== '' || url.username !== '' || url.password !== '') return null;
  return url.href;
}

/** Clave pública EC P-256 de firma, sin parte privada. */
function signingKey(value: unknown): value is JWK & { kid: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return key.kty === 'EC' && key.crv === 'P-256' && typeof key.kid === 'string' && key.kid.length > 0 &&
    typeof key.x === 'string' && typeof key.y === 'string' && key.d === undefined &&
    (key.use === undefined || key.use === 'sig') && (key.alg === undefined || key.alg === 'ES256');
}

export class SumegoOidc {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  private readonly basic: string;
  private discovered: { value: Discovery; at: number } | null = null;
  private discoveryFailedAt: number | null = null;
  private discovering: Promise<Discovery> | null = null;
  private jwks: { keys: Array<JWK & { kid: string }>; at: number } | null = null;
  private jwksFetching: Promise<Array<JWK & { kid: string }>> | null = null;
  private jwksFailedAt: number | null = null;

  /**
   * `publicOrigin` es el de `HEBRA_MCP_PUBLIC_URL`: la `redirect_uri` registrada en Sumego es
   * `https://mcp.hebra.pro/oauth/sumego/callback`.
   */
  constructor(
    config: OidcClientConfig,
    publicOrigin: string,
    private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis),
    private readonly now: () => number = Date.now
  ) {
    this.issuer = config.issuer;
    this.clientId = config.clientId;
    this.redirectUri = `${publicOrigin}${SUMEGO_CALLBACK_PATH}`;
    // RFC 6749 §2.3.1: id y secreto codificados como formulario antes del base64.
    const form = (value: string) => encodeURIComponent(value).replace(/%20/g, '+');
    this.basic = Buffer.from(`${form(config.clientId)}:${form(config.clientSecret)}`).toString('base64');
  }

  /** GET de un documento JSON con los topes de arriba; nunca sigue redirecciones. */
  private async getJson(url: string, types: readonly string[]): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' } });
    } catch { throw new SumegoError('unavailable'); }
    if (response.status !== 200) throw new SumegoError('unavailable');
    return readJson(response, types, 'unavailable');
  }

  private async loadDiscovery(): Promise<Discovery> {
    const raw = await this.getJson(`${this.issuer}/.well-known/openid-configuration`, ['application/json']);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SumegoError('unavailable');
    const record = raw as Record<string, unknown>;
    const authorizationEndpoint = endpoint(record.authorization_endpoint, this.issuer);
    const tokenEndpoint = endpoint(record.token_endpoint, this.issuer);
    const jwksUri = endpoint(record.jwks_uri, this.issuer);
    if (record.issuer !== this.issuer || !authorizationEndpoint || !tokenEndpoint || !jwksUri) throw new SumegoError('unavailable');
    return { authorizationEndpoint, tokenEndpoint, jwksUri };
  }

  /** Discovery en caché (10 min); un fallo reciente (30 s) falla sin volver a pedirla. */
  async discovery(): Promise<Discovery> {
    const now = this.now();
    if (this.discovered && now - this.discovered.at >= 0 && now - this.discovered.at < DISCOVERY_TTL_MS) return this.discovered.value;
    if (this.discoveryFailedAt !== null && now - this.discoveryFailedAt >= 0 && now - this.discoveryFailedAt < DISCOVERY_FAILURE_TTL_MS) {
      throw new SumegoError('unavailable');
    }
    this.discovering ??= this.loadDiscovery().then((value) => {
      this.discovered = { value, at: this.now() };
      this.discoveryFailedAt = null;
      return value;
    }, () => {
      this.discovered = null;
      this.discoveryFailedAt = this.now();
      throw new SumegoError('unavailable');
    }).finally(() => { this.discovering = null; });
    return this.discovering;
  }

  /** URL de autorización de Sumego, con PKCE S256. Solo el `authorization_endpoint` validado. */
  async authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): Promise<string> {
    const { authorizationEndpoint } = await this.discovery();
    const url = new URL(authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', SUMEGO_SCOPES);
    url.searchParams.set('state', input.state);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.href;
  }

  /**
   * POST al `token_endpoint` con `client_secret_basic`; red, 3xx (no se siguen), 5xx y 429 son
   * `unavailable`. Un 3xx como `invalid` haría que la renovación horaria cortase la familia.
   */
  private async tokenRequest(form: Record<string, string>): Promise<Response> {
    const { tokenEndpoint } = await this.discovery();
    let response: Response;
    try {
      response = await this.fetcher(tokenEndpoint, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { authorization: `Basic ${this.basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString()
      });
    } catch { throw new SumegoError('unavailable'); }
    if ((response.status >= 300 && response.status < 400) || response.status >= 500 || response.status === 429) {
      throw new SumegoError('unavailable');
    }
    return response;
  }

  /**
   * Canjea el código en el `token_endpoint` con `client_secret_basic` y el `code_verifier`.
   * Devuelve el ID token y el refresh de Sumego (que con `openid email` Sumego emite a sus
   * clientes propios y rota en cada uso, SPEC.md §4.0.1 de Sumego); el access token de Sumego
   * no se usa ni se guarda. Sin refresh no hay renovación horaria: el login no vale.
   */
  async exchangeCode(code: string, codeVerifier: string): Promise<{ idToken: string; refreshToken: string }> {
    const response = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: codeVerifier });
    if (response.status !== 200) throw new SumegoError('invalid');
    const raw = await readJson(response, ['application/json'], 'invalid');
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const { id_token: idToken, refresh_token: refreshToken } = record;
    if (typeof idToken !== 'string' || idToken.length > MAX_JWT_LENGTH || !refreshTokenValue(refreshToken)) throw new SumegoError('invalid');
    return { idToken, refreshToken };
  }

  /**
   * Renueva la sesión de la app con el refresh de Sumego (grant `refresh_token`,
   * `client_secret_basic`) y devuelve el refresh nuevo, que rota. Un 4xx que no es 429 es
   * `invalid` (cuenta suspendida, grant revocado o refresh ya usado: Sumego da `400
   * invalid_grant`); red, 5xx, 429 o un 200 sin refresh son `unavailable`.
   */
  async refresh(refreshToken: string): Promise<string> {
    const response = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    if (response.status !== 200) throw new SumegoError('invalid');
    const raw = await readJson(response, ['application/json'], 'unavailable');
    const next = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).refresh_token : undefined;
    if (!refreshTokenValue(next)) throw new SumegoError('unavailable');
    return next;
  }

  private async loadJwks(): Promise<Array<JWK & { kid: string }>> {
    const { jwksUri } = await this.discovery();
    const raw = await this.getJson(jwksUri, ['application/json', 'application/jwk-set+json']);
    const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).keys : undefined;
    if (!Array.isArray(keys)) throw new SumegoError('unavailable');
    return keys.filter(signingKey);
  }

  /**
   * Claves del JWKS; `refresh` lo vuelve a pedir si la copia tiene más de 30 s. Un fallo de
   * descarga también se recuerda 30 s: mientras, nadie vuelve a pedirlo (ni por un `kid`
   * desconocido) y quien no tenga copia válida recibe `unavailable`.
   */
  private async signingKeys(refresh: boolean): Promise<Array<JWK & { kid: string }>> {
    const now = this.now();
    const age = this.jwks ? now - this.jwks.at : Infinity;
    const fresh = age >= 0 && age < JWKS_TTL_MS && !(refresh && age >= JWKS_REFETCH_MS);
    if (this.jwks && fresh) return this.jwks.keys;
    // Una descarga fallida hace menos de 30 s: ni se repite ni se da por bueno un `kid` ausente.
    const sinceFailure = this.jwksFailedAt === null ? Infinity : now - this.jwksFailedAt;
    if (sinceFailure >= 0 && sinceFailure < JWKS_REFETCH_MS) throw new SumegoError('unavailable');
    this.jwksFetching ??= this.loadJwks().then((keys) => {
      this.jwks = { keys, at: this.now() };
      this.jwksFailedAt = null;
      return keys;
    }, () => {
      this.jwksFailedAt = this.now();
      throw new SumegoError('unavailable');
    }).finally(() => { this.jwksFetching = null; });
    return this.jwksFetching;
  }

  /** Clave ES256 por `kid`. Sin `kid`, otro algoritmo o un `kid` que no está: `invalid`. */
  private async keyFor(token: string) {
    let header: ReturnType<typeof decodeProtectedHeader>;
    try { header = decodeProtectedHeader(token); } catch { throw new SumegoError('invalid'); }
    if (header.alg !== 'ES256' || typeof header.kid !== 'string' || header.crit !== undefined) throw new SumegoError('invalid');
    const kid = header.kid;
    let jwk = (await this.signingKeys(false)).find((key) => key.kid === kid);
    jwk ??= (await this.signingKeys(true)).find((key) => key.kid === kid);
    if (!jwk) throw new SumegoError('invalid');
    try { return await importJWK({ ...jwk, alg: 'ES256' }, 'ES256'); } catch { throw new SumegoError('invalid'); }
  }

  /** Firma y claims comunes; cualquier fallo de `jose` es `invalid`, uno de red `unavailable`. */
  private async verify(token: string, maxAgeS: number, required: string[]): Promise<JWTPayload> {
    if (token.length > MAX_JWT_LENGTH) throw new SumegoError('invalid');
    const key = await this.keyFor(token);
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['ES256'], issuer: this.issuer, audience: this.clientId,
        maxTokenAge: maxAgeS, clockTolerance: CLOCK_TOLERANCE_S, requiredClaims: required,
        currentDate: new Date(this.now())
      });
      // `azp` (OIDC Core §2): si viene, es este cliente; con varias audiencias, obligatorio.
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (payload.azp !== undefined && payload.azp !== this.clientId) throw new SumegoError('invalid');
      if (audiences.length > 1 && payload.azp === undefined) throw new SumegoError('invalid');
      return payload;
    } catch { throw new SumegoError('invalid'); }
  }

  /**
   * ID token del canje: ES256, `iss`, `aud` (y `azp`), `exp`, `iat` de 5 min como mucho con
   * 60 s de margen, `nonce` igual al de la solicitud (en tiempo constante) y `sub` presente.
   */
  async verifyIdToken(idToken: string, nonce: string): Promise<IdTokenClaims> {
    // `sid` obligatorio: Sumego lo emite siempre a hebra-mcp (`backchannel_logout_session_required`)
    // y sin él un logout por sesión no alcanzaría a la familia.
    const payload = await this.verify(idToken, ID_TOKEN_MAX_AGE_S, ['iat', 'exp', 'sub', 'nonce', 'sid']);
    if (typeof payload.nonce !== 'string' || !sameString(payload.nonce, nonce) || !shortString(payload.sub)) throw new SumegoError('invalid');
    if (!shortString(payload.sid)) throw new SumegoError('invalid');
    const email = typeof payload.email === 'string' && payload.email.length <= 320 ? payload.email : null;
    return { sub: payload.sub, sid: payload.sid, email, iat: payload.iat! };
  }

  /**
   * `logout_token` (SPEC.md §12.9): ES256 con `kid` del JWKS, `iss`, `aud`, `iat` de menos de
   * 10 min con 60 s de margen, `exp` y `jti` obligatorios, `events` con el evento de
   * back-channel logout, sin `nonce`, y `sid` o `sub`.
   */
  async verifyLogoutToken(token: string): Promise<LogoutClaims> {
    const payload = await this.verify(token, LOGOUT_TOKEN_MAX_AGE_S, ['iat', 'exp', 'jti', 'events']);
    const events = payload.events;
    if (!events || typeof events !== 'object' || Array.isArray(events)) throw new SumegoError('invalid');
    const event = (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT];
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new SumegoError('invalid');
    if (payload.nonce !== undefined) throw new SumegoError('invalid');
    if (!shortString(payload.jti)) throw new SumegoError('invalid');
    const sub = payload.sub === undefined ? null : payload.sub;
    const sid = payload.sid === undefined ? null : payload.sid;
    if ((sub !== null && !shortString(sub)) || (sid !== null && !shortString(sid)) || (sub === null && sid === null)) {
      throw new SumegoError('invalid');
    }
    // El token vale hasta `min(exp, iat + 10 min)` MÁS el margen de 60 s de `jose`: hasta ahí
    // hay que recordar el `jti`, o uno aceptado en `exp + 30 s` podría repetirse.
    const rememberUntil = (Math.min(payload.exp!, payload.iat! + LOGOUT_TOKEN_MAX_AGE_S) + CLOCK_TOLERANCE_S) * 1000;
    return { jti: payload.jti, sub: sub as string | null, sid: sid as string | null, iat: payload.iat!, rememberUntil };
  }
}

/** JSON con tipo admitido y tope de 64 KiB; si no, `kind`. */
async function readJson(response: Response, types: readonly string[], kind: SumegoError['kind']): Promise<unknown> {
  const type = (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (!types.includes(type)) throw new SumegoError(kind);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) throw new SumegoError(kind);
  if (!response.body) throw new SumegoError(kind);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_DOCUMENT_BYTES) throw new SumegoError(kind);
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch { throw new SumegoError(kind); }
  finally { reader.releaseLock(); }
}
