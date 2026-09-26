/**
 * Proveedor OAuth de un solo dueño (SPEC.md §12.2, D7) para el router del SDK de MCP
 * (`mcpAuthRouter`, `requireBearerAuth`).
 *
 * Flujo:
 * 1. `GET /authorize` (handler del SDK): valida `client_id` y `redirect_uri` contra
 *    `./clients.ts` y llama a `authorize`, que comprueba scope, `resource` y el reto PKCE
 *    y guarda una solicitud PENDIENTE (en memoria, 10 min) con id aleatorio. Responde la
 *    página que pide el secreto (`./consent-page.ts`).
 * 2. `POST /oauth/consent` (`handleConsent`): con el secreto correcto, borra la solicitud
 *    pendiente, crea un código de un solo uso (60 s, guardado como hash) y redirige al
 *    callback de claude.ai con `code`, `state` e `iss`.
 * 3. `POST /token` (handler del SDK): `exchangeAuthorizationCode` consume el código ANTES
 *    de comprobar nada, y después exige mismo cliente, mismo `redirect_uri`, PKCE S256 y
 *    mismo `resource`. Por eso `skipLocalPkceValidation`: el SDK validaría el PKCE sin
 *    consumir el código, y un `code_verifier` erróneo lo dejaría vivo para reintentar;
 *    aquí un fallo lo quema.
 * 4. `refresh_token`: rotatorio, con revocación de la familia al reutilizarlo
 *    (`./token-store.ts`).
 *
 * Intentos del secreto (revisados tras la auditoría de seguridad de C3):
 * - 5 por solicitud pendiente y 5 por IP (la que da Caddy) en 15 min, reservados antes
 *   del primer `await` (`handleConsent`), y scrypt de uno en uno.
 * - No hay bloqueo global: cualquiera puede abrir solicitudes y fallar desde muchas IP, y
 *   un bloqueo global le dejaría dejar a David sin reconectar. A partir de 50 fallos en la
 *   ventana solo se registra `oauth.consent.global_threshold`; el coste lo acotan el
 *   límite por IP y el semáforo, y un secreto de 32 caracteres o más no se adivina así.
 * - Como mucho 4 solicitudes pendientes por IP: una IP solo desaloja las suyas.
 *
 * Logs (§6.4): eventos `oauth.*` con resultados cerrados. Nunca códigos, tokens, secretos,
 * `state`, `client_id` ni direcciones IP.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { logEvent } from '../log/logger';
import { CLAUDE_CALLBACK, ClaudeClientsStore } from './clients';
import { sendConsentPage } from './consent-page';
import { OwnerFile, verifyOwnerSecret, type OwnerRecord } from './owner';
import { TokenStore, type IssuedTokens } from './token-store';

/** El único scope. Se concede aunque el cliente no pida ninguno. */
export const OAUTH_SCOPE = 'hebra:mcp';

const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const MAX_PENDING = 64;
const MAX_PENDING_PER_IP = 4;
const MAX_CODES = 64;
const MAX_FAILURES_PER_REQUEST = 5;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_IP = 5;
/** Fallos en la ventana a partir de los cuales se registra `oauth.consent.global_threshold`. */
const GLOBAL_FAILURE_ALERT = 50;

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  state?: string;
  expiresAt: number;
  /** IP que la abrió (la que da Caddy): el tope de pendientes es por IP. */
  ip: string;
  /** Fallos y reservas en curso contra esta solicitud. */
  attempts: number;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  issuedAt: number;
  expiresAt: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function equalText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function takeOldestWhileOver<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) map.delete(map.keys().next().value!);
}

export interface HebraOAuthProviderOptions {
  /** Origen público (`https://mcp.hebra.pro`): el `issuer`. */
  issuer: string;
  /** `<origen>/mcp`: el único `resource`. */
  resource: string;
  owner: OwnerFile;
  tokens: TokenStore;
  clients?: ClaudeClientsStore;
  now?: () => number;
  /** Tests: la verificación del secreto (por defecto, scrypt de `./owner.ts`). */
  verifySecret?: (record: OwnerRecord, candidate: string) => Promise<boolean>;
}

export class HebraOAuthProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = true;
  private readonly issuer: string;
  private readonly resource: string;
  private readonly owner: OwnerFile;
  private readonly tokens: TokenStore;
  private readonly clients: ClaudeClientsStore;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private failures: Array<{ at: number; ip: string }> = [];
  private globalAlertAt: number | null = null;
  private verifyQueue: Promise<unknown> = Promise.resolve();
  private readonly verifySecret: (record: OwnerRecord, candidate: string) => Promise<boolean>;

  constructor(options: HebraOAuthProviderOptions) {
    this.verifySecret = options.verifySecret ?? verifyOwnerSecret;
    this.issuer = options.issuer;
    this.resource = options.resource;
    this.owner = options.owner;
    this.tokens = options.tokens;
    this.clients = options.clients ?? new ClaudeClientsStore({ now: options.now });
    this.now = options.now ?? Date.now;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.clients;
  }

  private sameResource(resource: URL | string | undefined): boolean {
    if (resource === undefined) return true;
    try {
      return new URL(String(resource)).href === new URL(this.resource).href;
    } catch {
      return false;
    }
  }

  private checkScopes(scopes: readonly string[] | undefined): void {
    const requested = (scopes ?? []).filter((scope) => scope !== '');
    if (requested.some((scope) => scope !== OAUTH_SCOPE)) {
      throw new InvalidScopeError(`El único scope es ${OAUTH_SCOPE}.`);
    }
  }

  private prune(now: number): void {
    for (const [id, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(id);
    for (const [hash, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(hash);
    this.failures = this.failures.filter((failure) => failure.at > now - FAILURE_WINDOW_MS);
  }

  /** Fallos (y reservas en curso) de esta IP en la ventana. */
  private ipFailures(ip: string): number {
    return this.failures.filter((failure) => failure.ip === ip).length;
  }

  /** Paso 1: la página que pide el secreto. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.redirectUri !== CLAUDE_CALLBACK) throw new InvalidRequestError('redirect_uri no admitido.');
    this.checkScopes(params.scopes);
    if (!this.sameResource(params.resource)) throw new InvalidTargetError(`El resource debe ser ${this.resource}.`);
    if (!CHALLENGE_PATTERN.test(params.codeChallenge)) throw new InvalidRequestError('Se requiere PKCE S256.');
    if (params.state !== undefined && params.state.length > 1024) throw new InvalidRequestError('state demasiado largo.');
    const now = this.now();
    this.prune(now);
    const ip = res.req.ip ?? res.req.socket.remoteAddress ?? 'unknown';
    // Hallazgo M2: una IP solo desaloja SUS solicitudes más viejas, nunca las de otra. El
    // tope global solo lo alcanza quien reparte la ráfaga entre muchas IP.
    const own = [...this.pending].filter(([, entry]) => entry.ip === ip);
    for (const [id] of own.slice(0, Math.max(0, own.length - MAX_PENDING_PER_IP + 1))) this.pending.delete(id);
    const requestId = randomBytes(32).toString('base64url');
    this.pending.set(requestId, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      challenge: params.codeChallenge,
      resource: this.resource,
      state: params.state,
      expiresAt: now + PENDING_TTL_MS,
      ip,
      attempts: 0
    });
    takeOldestWhileOver(this.pending, MAX_PENDING);
    logEvent({ event: 'oauth.authorize', result: 'consent_page' });
    sendConsentPage(res, 200, { requestId, notice: null });
  }

  /** Evaluaciones del secreto de una en una: scrypt pide 32 MiB y ocupa un hilo del pool
   *  de libuv; una ráfaga en paralelo lo saturaría (hallazgo M1 de la auditoría). */
  private verifyExclusive(record: OwnerRecord, secret: string): Promise<boolean> {
    const run = this.verifyQueue.then(() => this.verifySecret(record, secret));
    this.verifyQueue = run.catch(() => undefined);
    return run;
  }

  /** Deja constancia (una vez por ventana) de que el umbral global de fallos se superó. No
   *  bloquea a nadie: con él activo, el secreto bueno sigue pasando (hallazgo M2). */
  private noteGlobalThreshold(now: number): void {
    if (this.failures.length < GLOBAL_FAILURE_ALERT) return;
    if (this.globalAlertAt !== null && this.globalAlertAt > now - FAILURE_WINDOW_MS) return;
    this.globalAlertAt = now;
    logEvent({ event: 'oauth.consent.global_threshold', failures: this.failures.length });
  }

  /**
   * Paso 2: `POST /oauth/consent` con `request` y `secret` (formulario).
   *
   * Hallazgo M1 de la auditoría: el intento se RESERVA (fallo apuntado a la IP y a la
   * solicitud) de forma síncrona, antes del primer `await`, y se devuelve solo si el
   * secreto acierta. Así N envíos simultáneos no pasan todos la comprobación antes de que
   * ninguno apunte su fallo: como mucho se evalúan 5 por IP y 5 por solicitud. Todo lo que
   * se rechaza sin evaluar (IP bloqueada, solicitud agotada, consumida o caducada) responde
   * lo mismo con el secreto bueno que con uno malo.
   */
  async handleConsent(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestId = typeof body.request === 'string' && REQUEST_ID_PATTERN.test(body.request) ? body.request : null;
    const secret = typeof body.secret === 'string' ? body.secret : '';
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = this.now();
    this.prune(now);

    if (this.ipFailures(ip) >= MAX_FAILURES_PER_IP) {
      logEvent({ event: 'oauth.consent', result: 'locked' });
      sendConsentPage(res, 429, { requestId: null, notice: 'locked' });
      return;
    }
    const pending = requestId ? this.pending.get(requestId) : undefined;
    if (!requestId || !pending || pending.attempts >= MAX_FAILURES_PER_REQUEST) {
      logEvent({ event: 'oauth.consent', result: 'expired' });
      sendConsentPage(res, 400, { requestId: null, notice: 'expired' });
      return;
    }
    // Reserva síncrona del intento (ni un `await` antes de esto).
    const reservation = { at: now, ip };
    this.failures.push(reservation);
    pending.attempts += 1;
    const release = () => {
      this.failures = this.failures.filter((failure) => failure !== reservation);
      pending.attempts -= 1;
    };

    let accepted: boolean;
    try {
      const owner = await this.owner.current();
      if (!owner) {
        release();
        logEvent({ event: 'oauth.consent', result: 'not_configured' });
        sendConsentPage(res, 503, { requestId: null, notice: 'not_configured' });
        return;
      }
      accepted = await this.verifyExclusive(owner, secret);
    } catch (error) {
      release();
      throw error;
    }
    // Consumida por otro envío que acertó, caducada o desalojada mientras se evaluaba: la
    // misma respuesta acierte o no este.
    if (this.pending.get(requestId) !== pending) {
      if (accepted) release();
      logEvent({ event: 'oauth.consent', result: 'expired' });
      sendConsentPage(res, 400, { requestId: null, notice: 'expired' });
      return;
    }
    if (!accepted) {
      logEvent({ event: 'oauth.consent', result: 'wrong_secret' });
      this.noteGlobalThreshold(now);
      const lockedNow = this.ipFailures(ip) >= MAX_FAILURES_PER_IP;
      const exhausted = pending.attempts >= MAX_FAILURES_PER_REQUEST;
      sendConsentPage(res, lockedNow ? 429 : 401, {
        requestId: exhausted || lockedNow ? null : requestId,
        notice: lockedNow ? 'locked' : exhausted ? 'expired' : 'wrong_secret'
      });
      return;
    }
    release();
    // Una sola vez: dos envíos simultáneos que aciertan no crean dos códigos.
    this.pending.delete(requestId);
    const code = randomBytes(32).toString('base64url');
    this.codes.set(sha256(code), {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      challenge: pending.challenge,
      resource: pending.resource,
      issuedAt: now,
      expiresAt: now + CODE_TTL_MS
    });
    takeOldestWhileOver(this.codes, MAX_CODES);
    const target = new URL(pending.redirectUri);
    target.searchParams.set('code', code);
    if (pending.state !== undefined) target.searchParams.set('state', pending.state);
    target.searchParams.set('iss', this.issuer);
    logEvent({ event: 'oauth.consent', result: 'approved' });
    res.redirect(302, target.href);
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string): Promise<string> {
    const entry = this.codes.get(sha256(code));
    if (!entry || entry.expiresAt <= this.now()) throw new InvalidGrantError('Código no válido.');
    return entry.challenge;
  }

  private tokensResponse(issued: IssuedTokens): OAuthTokens {
    return {
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken,
      scope: issued.scope
    };
  }

  /** Paso 3. El código se consume antes de cualquier comprobación. */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const hash = sha256(authorizationCode);
    const entry = this.codes.get(hash);
    this.codes.delete(hash);
    const now = this.now();
    const owner = await this.owner.current();
    const fail = (reason: string): never => {
      logEvent({ event: 'oauth.token', grant: 'authorization_code', result: 'rejected', reason });
      throw new InvalidGrantError('Código de autorización no válido.');
    };
    if (!entry || entry.expiresAt <= now) return fail('code');
    if (!owner) throw new ServerError('Sin secreto del dueño configurado.');
    if (entry.issuedAt <= owner.revokedBefore) return fail('revoked');
    if (entry.clientId !== client.client_id) return fail('client');
    if (redirectUri !== undefined && redirectUri !== entry.redirectUri) return fail('redirect_uri');
    if (
      codeVerifier === undefined ||
      !VERIFIER_PATTERN.test(codeVerifier) ||
      !equalText(s256(codeVerifier), entry.challenge)
    ) {
      return fail('pkce');
    }
    if (!this.sameResource(resource)) {
      logEvent({ event: 'oauth.token', grant: 'authorization_code', result: 'rejected', reason: 'resource' });
      throw new InvalidTargetError(`El resource debe ser ${this.resource}.`);
    }
    const issued = await this.tokens.issueFamily(
      { clientId: client.client_id, scope: OAUTH_SCOPE, resource: entry.resource },
      owner.revokedBefore
    );
    logEvent({ event: 'oauth.token', grant: 'authorization_code', result: 'issued' });
    return this.tokensResponse(issued);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    this.checkScopes(scopes);
    if (!this.sameResource(resource)) throw new InvalidTargetError(`El resource debe ser ${this.resource}.`);
    const owner = await this.owner.current();
    if (!owner) throw new ServerError('Sin secreto del dueño configurado.');
    const outcome = await this.tokens.rotateRefresh(refreshToken, client.client_id, owner.revokedBefore);
    if (!outcome.ok) {
      logEvent({ event: 'oauth.token', grant: 'refresh_token', result: 'rejected', reason: outcome.reason });
      throw new InvalidGrantError('Refresh token no válido.');
    }
    logEvent({ event: 'oauth.token', grant: 'refresh_token', result: 'issued' });
    return this.tokensResponse(outcome.tokens);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const owner = await this.owner.current();
    const verified = owner ? this.tokens.verifyAccess(token, owner.revokedBefore) : null;
    if (!verified) throw new InvalidTokenError('Token no válido.');
    return {
      token,
      clientId: verified.clientId,
      scopes: verified.scope.split(' '),
      expiresAt: verified.expiresAt,
      resource: new URL(verified.resource)
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const result = await this.tokens.revoke(request.token, client.client_id);
    logEvent({ event: 'oauth.revoke', result });
  }
}
