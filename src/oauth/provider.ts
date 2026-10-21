/**
 * OAuth público de Hebra: el SDK conserva clientes, PKCE y tokens; Lumbre aprueba al propietario.
 * Quién identifica a la persona lo decide `HEBRA_MCP_LOGIN_PROVIDER` (D20, SPEC.md §12.9): con
 * `lumbre`, el login y el consentimiento de Lumbre de §12.2; con `sumego`, el cliente OIDC
 * propio de hebra-mcp en Sumego y la página de consentimiento de aquí, y Lumbre emite la
 * concesión a partir del ID token. Desde la concesión, el camino es el mismo.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTargetError, InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { decodeRecoveryCode } from '../hebra';
import { logEvent } from '../log/logger';
import { readPairedSecrets, type SecretStore } from '../secrets';
import { PairingRevocation } from '../status/pairing-revocation';
import { BackchannelError, LumbreBackchannel, type ActiveGrant, type Binding, type Grant, sameBinding } from './backchannel';
import { ClaudeClientsStore, isAllowedRedirectUri } from './clients';
import { GrantSecrets } from './grants';
import type { LoginProvider } from './login-config';
import { RevocationFile } from './owner';
import { sendConsentPage, sendDeniedPage, sendPairingRevokedPage, sendUnavailablePage } from './pages';
import { SumegoError, type SumegoOidc } from './sumego';
import { TokenStore, type FamilyIdentity, type IssuedTokens, type LogoutSelector } from './token-store';

export const OAUTH_SCOPE = 'hebra:mcp';
const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const MAX_PENDING = 64;
const MAX_PENDING_PER_IP = 4;
const MAX_PENDING_PER_CLIENT = 16;
const MAX_CODES = 64;
/**
 * Vigencia en memoria de una introspección POSITIVA, por familia. Revocar la concesión en
 * Lumbre puede tardar hasta este plazo en cortar `/mcp`; el emparejado local, el bearer de la
 * familia, `revokeToken` y `oauth-revoke-all` se comprueban en cada petición y cortan al momento.
 */
export const INTROSPECTION_CACHE_MS = 30_000;
/** Techo defensivo: las familias vivas son como mucho 32 y cada una tiene una sola entrada. */
const MAX_INTROSPECTIONS = 64;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Cookie del login con Sumego: ata el navegador que empezó `/authorize` al callback y al consentimiento. */
export const LOGIN_COOKIE = '__Host-hebra_mcp_login';
const LOGIN_COOKIE_MAX_AGE_S = 600;
const RANDOM_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SUMEGO_CALLBACK_KEYS = new Set(['code', 'state', 'iss', 'error', 'error_description', 'error_uri']);
/** Errores de Lumbre en `sumego/exchange` que el navegador ve como «acceso denegado». */
const DENIED_EXCHANGE_STATUS = new Set([400, 403, 404, 409]);

/**
 * Lo que el login con Sumego guarda en la solicitud pendiente, solo en memoria y de un uso:
 * `state`, `nonce` y `code_verifier` hasta el callback; el ID token hasta el consentimiento.
 */
interface SumegoLogin {
  state: string;
  nonce: string;
  verifier: string;
  cookieHash: string;
  phase: 'login' | 'exchanging' | 'consent';
  idToken: string | null;
  email: string | null;
  identity: FamilyIdentity | null;
  formTokenHash: string | null;
}

interface PendingAuthorization extends Binding {
  requestId: string | null;
  transactionId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  challenge: string;
  state?: string;
  ip: string;
  createdAt: number;
  expiresAt: number;
  claimed: boolean;
  /** Solo en modo `sumego`. */
  sumego?: SumegoLogin;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  grant: Grant;
  issuedAt: number;
  expiresAt: number;
  /** `sub`/`sid` del ID token de Sumego; `null` con el login de Lumbre. */
  identity: FamilyIdentity | null;
}

/** Introspección positiva y coherente de una familia, atada a la concesión con la que se comparó. */
interface CachedIntrospection {
  grant: string;
  checkedAt: number;
  monotonicCheckedAt: number;
  expiresAt: number;
}

interface IntrospectionAttempt { invalidated: boolean }

/** Huella por valor de la concesión guardada: otra concesión en la misma familia no reutiliza la entrada. */
function grantFingerprint(grant: ActiveGrant): string {
  return JSON.stringify([grant.credentialId, grant.clientId, grant.accountId, grant.expiresAt, grant.resource,
    grant.scope, grant.pairedCredentialId, grant.syncVaultId, grant.opaqueDeviceId]);
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function s256(value: string): string { return createHash('sha256').update(value, 'ascii').digest('base64url'); }
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** El valor de una cookie de la cabecera `Cookie`, o `null`. Sin decodificar: es base64url. */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function loginCookie(value: string, maxAge: number): string {
  return `${LOGIN_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export interface HebraOAuthProviderOptions {
  issuer: string;
  resource: string;
  revocations: RevocationFile;
  tokens: TokenStore;
  grants: GrantSecrets;
  secrets: SecretStore;
  backchannel: LumbreBackchannel;
  clients?: ClaudeClientsStore;
  now?: () => number;
  /** `HEBRA_MCP_LOGIN_PROVIDER`; por defecto `lumbre`. Con `sumego`, hace falta `sumego`. */
  loginProvider?: LoginProvider;
  /** Cliente OIDC de Sumego, si está configurado. */
  sumego?: SumegoOidc | null;
  /** Emparejado revocado (SPEC.md §12.9); `serve-http` comparte el suyo con `hebra_status`. */
  pairing?: PairingRevocation;
}

export class HebraOAuthProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = true;
  private readonly issuer: string;
  private readonly resource: string;
  private readonly revocations: RevocationFile;
  private readonly tokens: TokenStore;
  private readonly grants: GrantSecrets;
  private readonly secrets: SecretStore;
  private readonly backchannel: LumbreBackchannel;
  private readonly clients: ClaudeClientsStore;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  /** Una entrada por familia viva; solo en memoria, nunca se persiste ni se registra. */
  private readonly introspections = new Map<string, CachedIntrospection>();
  /** Sube con oauth-revoke-all: ninguna introspección anterior puede dar acceso ni reponer caché. */
  private introspectionEpoch = 0;
  private readonly inFlightIntrospections = new Map<string, Set<IntrospectionAttempt>>();
  private seenRevokedBefore: number | null = null;
  /** Cola de refresh por familia: dos refresh de la misma familia nunca renuevan a la vez. */
  private readonly refreshQueues = new Map<string, Promise<void>>();
  /**
   * Familias entre la llamada a `/renew` y la escritura de su fecha nueva. En ese hueco
   * Lumbre ya puede introspeccionar con la fecha nueva: no es un desajuste que corte la familia.
   */
  private readonly renewing = new Set<string>();
  private readonly loginProvider: LoginProvider;
  private readonly sumego: SumegoOidc | null;
  readonly pairing: PairingRevocation;

  constructor(options: HebraOAuthProviderOptions) {
    this.issuer = options.issuer;
    this.resource = options.resource;
    this.revocations = options.revocations;
    this.tokens = options.tokens;
    this.grants = options.grants;
    this.secrets = options.secrets;
    this.backchannel = options.backchannel;
    this.clients = options.clients ?? new ClaudeClientsStore({ now: options.now });
    this.now = options.now ?? Date.now;
    this.loginProvider = options.loginProvider ?? 'lumbre';
    this.sumego = options.sumego ?? null;
    if (this.loginProvider === 'sumego' && !this.sumego) throw new Error('sumego_not_configured');
    this.pairing = options.pairing ?? new PairingRevocation();
    this.tokens.onFamiliesRemoved((ids) => {
      const removed = ids.map((id) => {
        this.forgetIntrospection(id);
        return { id, bearer: this.grants.get(id) };
      });
      return async () => {
        for (const { id, bearer } of removed) {
          if (!bearer) continue;
          try { await this.backchannel.revoke(bearer); }
          catch { logEvent({ event: 'oauth.grant.revoke', result: 'unavailable' }); continue; }
          await this.grants.delete(id).catch(() => logEvent({ event: 'oauth.grant.cleanup', result: 'failed' }));
        }
      };
    });
  }

  get clientsStore(): OAuthRegisteredClientsStore { return this.clients; }

  private sameResource(resource: URL | string | undefined): boolean {
    if (resource === undefined) return true;
    try { return new URL(String(resource)).href === new URL(this.resource).href; } catch { return false; }
  }

  private checkScopes(scopes: readonly string[] | undefined): void {
    if ((scopes ?? []).some((scope) => scope !== '' && scope !== OAUTH_SCOPE)) throw new InvalidScopeError(`El único scope es ${OAUTH_SCOPE}.`);
  }

  /** Solo la identidad emparejada actual. El código de recuperación se decodifica sin exportar la clave. */
  private async currentBinding(): Promise<Binding | null> {
    try {
      const paired = await readPairedSecrets(this.secrets);
      if (!paired) return null;
      const recovered = await decodeRecoveryCode(paired.recoveryCode);
      if (paired.connection.apiOrigin !== recovered.relayOrigin) return null;
      return {
        pairedCredentialId: paired.connection.credentialId,
        syncVaultId: recovered.syncVaultId,
        opaqueDeviceId: paired.device.opaqueDeviceId
      };
    } catch { return null; }
  }

  /** Caducados en memoria: la concesión remota se revoca y el secreto staged se retira. */
  private prune(): void {
    const now = this.now();
    for (const [id, pending] of this.pending) if (pending.expiresAt <= now) this.pending.delete(id);
    for (const [hash, code] of this.codes) {
      if (code.expiresAt > now) continue;
      this.codes.delete(hash);
      void this.backchannel.revoke(code.grant.accessToken)
        .then(() => this.grants.unstage(hash))
        .catch(() => logEvent({ event: 'oauth.grant.revoke', result: 'unavailable' }));
    }
  }

  /** Reserva cupos antes de llamar al broker para evitar ráfagas concurrentes. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // El SDK relaja puertos, pero ignora userinfo/hash: ningún error vuelve a una URI ajena.
    if (!isAllowedRedirectUri(client, params.redirectUri)) {
      res.status(400).json({ error: 'invalid_request' }); return;
    }
    this.checkScopes(params.scopes);
    if (!this.sameResource(params.resource)) throw new InvalidTargetError(`El resource debe ser ${this.resource}.`);
    if (!CHALLENGE.test(params.codeChallenge)) throw new InvalidRequestError('Se requiere PKCE S256.');
    if (params.state !== undefined && params.state.length > 1024) throw new InvalidRequestError('state demasiado largo.');
    this.prune();
    const ip = res.req.ip ?? res.req.socket.remoteAddress ?? 'unknown';
    const all = [...this.pending.values()];
    if (all.length >= MAX_PENDING || all.filter((entry) => entry.ip === ip).length >= MAX_PENDING_PER_IP ||
      all.filter((entry) => entry.clientId === client.client_id).length >= MAX_PENDING_PER_CLIENT) {
      res.status(429).json({ error: 'rate_limited' }); return;
    }
    const transactionId = randomBytes(32).toString('base64url');
    const binding = await this.currentBinding();
    if (!binding) { res.status(503).json({ error: 'temporarily_unavailable' }); return; }
    // Emparejado revocado (SPEC.md §12.9): una página que dice cómo reemparejar, no un 503 JSON.
    if (this.pairing.isRevoked(binding.pairedCredentialId)) { sendPairingRevokedPage(res); return; }
    const current = [...this.pending.values()];
    if (current.length >= MAX_PENDING || current.filter((entry) => entry.ip === ip).length >= MAX_PENDING_PER_IP ||
      current.filter((entry) => entry.clientId === client.client_id).length >= MAX_PENDING_PER_CLIENT) {
      res.status(429).json({ error: 'rate_limited' }); return;
    }
    const clientName = (client.client_name || 'Claude').slice(0, 120);
    const pending: PendingAuthorization = {
      ...binding, requestId: null, transactionId, clientId: client.client_id, clientName,
      redirectUri: params.redirectUri, challenge: params.codeChallenge, state: params.state,
      ip, createdAt: this.now(), expiresAt: this.now() + PENDING_TTL_MS, claimed: false
    };
    // El insert ocurre antes de la primera llamada remota.
    this.pending.set(transactionId, pending);
    if (this.loginProvider === 'sumego') { await this.authorizeWithSumego(pending, binding, res); return; }
    try {
      const requested = await this.backchannel.request({ ...binding, transactionId, clientId: client.client_id, clientName });
      if (this.pending.get(transactionId) !== pending || !sameBinding(binding, (await this.currentBinding()) ?? { pairedCredentialId: '', syncVaultId: '', opaqueDeviceId: '' })) {
        this.pending.delete(transactionId); res.status(400).json({ error: 'invalid_request' }); return;
      }
      pending.requestId = requested.requestId;
      pending.expiresAt = Math.min(pending.expiresAt, Date.parse(requested.expiresAt));
      if (pending.expiresAt <= this.now()) { this.pending.delete(transactionId); res.status(400).json({ error: 'invalid_request' }); return; }
      logEvent({ event: 'oauth.authorize', result: 'lumbre' });
      res.redirect(302, requested.authorizationUrl);
    } catch (error) {
      this.pending.delete(transactionId);
      if (this.pairingRevokedBy(error, binding)) { sendPairingRevokedPage(res); return; }
      logEvent({ event: 'oauth.authorize', result: 'unavailable' });
      res.status(503).json({ error: 'temporarily_unavailable' });
    }
  }

  /**
   * `410 pairing_revoked` de Lumbre: se anota (y `pairing.revoked` sale una vez). Cualquier
   * otro error, también un 400, no es una revocación.
   */
  private pairingRevokedBy(error: unknown, binding: Binding): boolean {
    if (!(error instanceof BackchannelError) || error.kind !== 'pairing_revoked') return false;
    this.pairing.markRevoked(binding.pairedCredentialId);
    return true;
  }

  /**
   * `/authorize` en modo `sumego` (SPEC.md §12.9, paso 1): `state`, `nonce` y `code_verifier`
   * propios, solo en la solicitud; la solicitud se registra en Lumbre con el sha256 del `nonce`;
   * cookie `__Host-hebra_mcp_login` con su sha256 en la solicitud, y 302 al
   * `authorization_endpoint` de la discovery. La discovery va antes que Lumbre: si Sumego está
   * caído, no queda una solicitud huérfana allí.
   */
  private async authorizeWithSumego(pending: PendingAuthorization, binding: Binding, res: Response): Promise<void> {
    const sumego = this.sumego!;
    const { transactionId } = pending;
    const random = () => randomBytes(32).toString('base64url');
    const login: SumegoLogin = { state: random(), nonce: random(), verifier: random(), cookieHash: '', phase: 'login',
      idToken: null, email: null, identity: null, formTokenHash: null };
    const cookie = random();
    login.cookieHash = sha256(cookie);
    pending.sumego = login;
    try {
      const authorizationUrl = await sumego.authorizationUrl({ state: login.state, nonce: login.nonce, codeChallenge: s256(login.verifier) });
      const requested = await this.backchannel.requestSumego({ ...binding, transactionId, clientId: pending.clientId,
        clientName: pending.clientName, sumegoNonceSha256: s256(login.nonce) });
      if (this.pending.get(transactionId) !== pending || !sameBinding(binding, (await this.currentBinding()) ?? { pairedCredentialId: '', syncVaultId: '', opaqueDeviceId: '' })) {
        this.pending.delete(transactionId); res.status(400).json({ error: 'invalid_request' }); return;
      }
      pending.requestId = requested.requestId;
      pending.expiresAt = Math.min(pending.expiresAt, Date.parse(requested.expiresAt));
      if (pending.expiresAt <= this.now()) { this.pending.delete(transactionId); res.status(400).json({ error: 'invalid_request' }); return; }
      res.setHeader('set-cookie', loginCookie(cookie, LOGIN_COOKIE_MAX_AGE_S));
      logEvent({ event: 'oauth.authorize', result: 'sumego' });
      res.redirect(302, authorizationUrl);
    } catch (error) {
      this.pending.delete(transactionId);
      if (this.pairingRevokedBy(error, binding)) { sendPairingRevokedPage(res); return; }
      logEvent({ event: 'oauth.authorize', result: 'unavailable' });
      res.status(503).json({ error: 'temporarily_unavailable' });
    }
  }

  /** La solicitud del login con Sumego cuyo `state` es este, comparado en tiempo constante. */
  private pendingByState(state: string): [string, PendingAuthorization] | null {
    let found: [string, PendingAuthorization] | null = null;
    for (const [key, value] of this.pending) {
      if (value.sumego && equal(sha256(value.sumego.state), sha256(state))) found = [key, value];
    }
    return found;
  }

  /** La solicitud cuyo token de formulario es este (sha256, en tiempo constante). */
  private pendingByFormToken(token: string): [string, PendingAuthorization] | null {
    const hash = sha256(token);
    let found: [string, PendingAuthorization] | null = null;
    for (const [key, value] of this.pending) {
      if (value.sumego?.formTokenHash && equal(value.sumego.formTokenHash, hash)) found = [key, value];
    }
    return found;
  }

  /** ¿Trae este navegador la cookie de esta solicitud? */
  private sameBrowser(req: Request, login: SumegoLogin): boolean {
    const cookie = readCookie(req, LOGIN_COOKIE);
    return cookie !== null && RANDOM_TOKEN.test(cookie) && equal(sha256(cookie), login.cookieHash);
  }

  /**
   * `GET /oauth/sumego/callback` (SPEC.md §12.9, paso 2). Sin la cookie de la solicitud, no se
   * consume nada (un tercero con el `state` no puede tumbar el login legítimo). Con ella: el
   * `state` es de un uso, `iss` tiene que ser exactamente el issuer (RFC 9207) y un `error=`
   * descarta la solicitud. El código se canjea con `client_secret_basic` y el ID token se valida;
   * si vale, la página de consentimiento. Nunca redirige al cliente desde aquí.
   */
  async handleSumegoCallback(req: Request, res: Response): Promise<void> {
    this.prune();
    const sumego = this.sumego;
    if (!sumego) { res.status(404).type('text/plain').send('No encontrado.'); return; }
    const { code, state, iss, error } = req.query;
    if (Object.keys(req.query).some((key) => !SUMEGO_CALLBACK_KEYS.has(key)) || typeof state !== 'string' || state.length > 128 ||
      (iss !== undefined && typeof iss !== 'string') || (code !== undefined && typeof code !== 'string') ||
      (error !== undefined && typeof error !== 'string') || (code === undefined) === (error === undefined)) {
      sendDeniedPage(res, 400); return;
    }
    const entry = this.pendingByState(state);
    if (!entry || entry[1].expiresAt <= this.now()) { sendDeniedPage(res, 400); return; }
    const [key, pending] = entry;
    const login = pending.sumego!;
    if (!this.sameBrowser(req, login)) { sendDeniedPage(res, 400); return; }
    const reject = (result: string) => {
      this.pending.delete(key);
      logEvent({ event: 'oauth.sumego.callback', result });
      sendDeniedPage(res, 400);
    };
    // Un `state` ya usado: la solicitud se descarta entera.
    if (login.phase !== 'login') { reject('reused'); return; }
    login.phase = 'exchanging';
    if (iss !== sumego.issuer) { reject('issuer'); return; }
    if (error !== undefined) { reject('error'); return; }
    if (pending.createdAt <= await this.revokedBefore()) { reject('revoked'); return; }
    if (code!.length === 0 || code!.length > 4096) { reject('invalid'); return; }
    const { verifier, nonce } = login;
    login.verifier = ''; login.nonce = '';
    let idToken: string;
    let claims: Awaited<ReturnType<SumegoOidc['verifyIdToken']>>;
    try {
      idToken = await sumego.exchangeCode(code!, verifier);
      claims = await sumego.verifyIdToken(idToken, nonce);
    } catch (failure) {
      this.pending.delete(key);
      const unavailable = !(failure instanceof SumegoError) || failure.kind === 'unavailable';
      logEvent({ event: 'oauth.sumego.callback', result: unavailable ? 'unavailable' : 'invalid' });
      if (unavailable) sendUnavailablePage(res); else sendDeniedPage(res, 400);
      return;
    }
    if (this.pending.get(key) !== pending || pending.expiresAt <= this.now()) { reject('expired'); return; }
    const formToken = randomBytes(32).toString('base64url');
    login.phase = 'consent';
    login.idToken = idToken;
    login.email = claims.email;
    login.identity = { sub: claims.sub, sid: claims.sid };
    login.formTokenHash = sha256(formToken);
    logEvent({ event: 'oauth.sumego.callback', result: 'consent' });
    sendConsentPage(res, { clientName: pending.clientName, email: claims.email, scope: OAUTH_SCOPE, formToken, redirectUri: pending.redirectUri });
  }

  /**
   * `POST /oauth/sumego/consent` (SPEC.md §12.9, pasos 3 y 4): el «Permitir». El token de
   * formulario es de un uso y va con la cookie de la solicitud. Canjea en Lumbre
   * (`sumego/exchange`) con el ID token; desde la concesión, el camino de hoy. Los errores de
   * Lumbre, según la tabla de §12.9: siempre se descarta la solicitud y nunca se redirige.
   */
  async handleSumegoConsent(req: Request, res: Response): Promise<void> {
    this.prune();
    if (!this.sumego) { res.status(404).type('text/plain').send('No encontrado.'); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = body.form_token;
    if (Object.keys(body).length !== 1 || typeof token !== 'string' || !RANDOM_TOKEN.test(token)) { sendDeniedPage(res, 400); return; }
    const entry = this.pendingByFormToken(token);
    if (!entry || entry[1].expiresAt <= this.now()) { sendDeniedPage(res, 400); return; }
    const [key, pending] = entry;
    const login = pending.sumego!;
    if (!this.sameBrowser(req, login)) { sendDeniedPage(res, 400); return; }
    // Un uso: desde aquí el mismo token ya no encuentra la solicitud.
    login.formTokenHash = null;
    const idToken = login.idToken;
    const identity = login.identity;
    login.idToken = null;
    res.setHeader('set-cookie', loginCookie('', 0));
    if (!idToken || !identity || !pending.requestId || pending.createdAt <= await this.revokedBefore()) {
      this.pending.delete(key); sendDeniedPage(res, 400); return;
    }
    if (pending.claimed || this.codes.size >= MAX_CODES) { this.pending.delete(key); sendUnavailablePage(res); return; }
    pending.claimed = true;
    let grant: Grant;
    try {
      grant = await this.backchannel.sumegoExchange({ requestId: pending.requestId, transactionId: pending.transactionId, idToken, clientId: pending.clientId });
    } catch (error) {
      this.pending.delete(key);
      if (this.pairingRevokedBy(error, pending)) { sendPairingRevokedPage(res); return; }
      const status = error instanceof BackchannelError ? error.status : undefined;
      // Un 401 es que el secreto de backchannel no coincide con el de Lumbre.
      if (status === 401) logEvent({ event: 'oauth.sumego.exchange', result: 'unauthorized' });
      if (status !== undefined && DENIED_EXCHANGE_STATUS.has(status)) {
        logEvent({ event: 'oauth.sumego.exchange', result: 'denied', status });
        sendDeniedPage(res);
      } else {
        logEvent({ event: 'oauth.sumego.exchange', result: 'unavailable' });
        sendUnavailablePage(res);
      }
      return;
    }
    try {
      const target = await this.issueCode(key, pending, grant, identity);
      logEvent({ event: 'oauth.consent', result: 'approved' });
      res.redirect(302, target);
    } catch {
      this.pending.delete(key);
      await this.backchannel.revoke(grant.accessToken).catch(() => logEvent({ event: 'oauth.grant.revoke', result: 'unavailable' }));
      logEvent({ event: 'oauth.consent', result: 'rejected' });
      sendDeniedPage(res);
    }
  }

  /**
   * Concesión ya canjeada en Lumbre: comprueba vínculo, cliente, recurso y caducidad contra la
   * solicitud y el emparejado actual, y emite el código OAuth de un uso. Devuelve la URL del
   * callback del cliente; lanza si algo no casa (quien llama revoca la concesión).
   */
  private async issueCode(key: string, pending: PendingAuthorization, grant: Grant, identity: FamilyIdentity | null): Promise<string> {
    const current = await this.currentBinding();
    if (pending.createdAt <= await this.revokedBefore() || !current ||
      !sameBinding(grant, pending) || !sameBinding(grant, current) ||
      grant.clientId !== pending.clientId || grant.resource !== this.resource || Date.parse(grant.expiresAt) <= this.now()) {
      throw new Error('binding');
    }
    const code = randomBytes(32).toString('base64url');
    const hash = sha256(code);
    await this.grants.stage(hash, grant.accessToken);
    this.pending.delete(key);
    this.codes.set(hash, { clientId: pending.clientId, redirectUri: pending.redirectUri, challenge: pending.challenge,
      resource: this.resource, grant, issuedAt: this.now(), expiresAt: this.now() + CODE_TTL_MS, identity });
    const target = new URL(pending.redirectUri);
    target.searchParams.set('code', code);
    if (pending.state !== undefined) target.searchParams.set('state', pending.state);
    target.searchParams.set('iss', this.issuer);
    return target.href;
  }

  /**
   * Back-channel logout de Sumego ya validado: corta en local las familias de esa sesión o de
   * ese `sub` (persistido antes de resolver) y el observador de `TokenStore` pide después la
   * revocación upstream. Lanza si la baja local no se pudo guardar.
   */
  async revokeByLogout(selector: LogoutSelector): Promise<number> {
    const dropped = await this.tokens.dropFamiliesByLogout(selector);
    for (const id of dropped) this.forgetIntrospection(id);
    return dropped.length;
  }

  /** `denied` público no consume una solicitud legítima; `approved` solo abre el canje autenticado. */
  async handleLumbreCallback(req: Request, res: Response): Promise<void> {
    this.prune();
    const keys = Object.keys(req.query);
    const requestId = req.query.request;
    const decision = req.query.decision;
    if (keys.length !== 2 || typeof requestId !== 'string' || !UUID.test(requestId) ||
      (decision !== 'approved' && decision !== 'denied')) { res.status(400).json({ error: 'invalid_request' }); return; }
    // Una solicitud del login con Sumego solo se cierra por su propio callback.
    const entry = [...this.pending].find(([, value]) => value.requestId === requestId && !value.sumego);
    if (!entry || entry[1].expiresAt <= this.now()) { res.status(400).json({ error: 'invalid_grant' }); return; }
    const [key, pending] = entry;
    if (pending.createdAt <= await this.revokedBefore()) {
      this.pending.delete(key); res.status(400).json({ error: 'invalid_grant' }); return;
    }
    if (decision === 'denied') { res.status(400).json({ error: 'authorization_unavailable' }); return; }
    if (pending.claimed || this.codes.size >= MAX_CODES) { res.status(409).json({ error: 'authorization_unavailable' }); return; }
    pending.claimed = true;
    let grant: Grant | null = null;
    try {
      grant = await this.backchannel.exchange(requestId, pending.transactionId);
      const target = await this.issueCode(key, pending, grant, null);
      logEvent({ event: 'oauth.consent', result: 'approved' });
      res.redirect(302, target);
    } catch (error) {
      this.pending.delete(key);
      this.pairingRevokedBy(error, pending);
      if (grant) await this.backchannel.revoke(grant.accessToken).catch(() => logEvent({ event: 'oauth.grant.revoke', result: 'unavailable' }));
      logEvent({ event: 'oauth.consent', result: 'rejected' });
      res.status(400).json({ error: 'invalid_grant' });
    }
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string): Promise<string> {
    const entry = this.codes.get(sha256(code));
    if (!entry || entry.expiresAt <= this.now()) throw new InvalidGrantError('Código no válido.');
    return entry.challenge;
  }

  private tokensResponse(issued: IssuedTokens): OAuthTokens {
    return { access_token: issued.accessToken, token_type: 'Bearer', expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken, scope: issued.scope };
  }

  /** Marca de `oauth-revoke-all`. Si cambia, ninguna introspección guardada sigue valiendo. */
  private async revokedBefore(): Promise<number> {
    const value = await this.revocations.current();
    if (value !== this.seenRevokedBefore) {
      this.seenRevokedBefore = value;
      this.introspections.clear();
      this.introspectionEpoch += 1;
    }
    return value;
  }

  /** Olvida la introspección de una familia; va antes de cualquier espera del camino que la invalida. */
  private forgetIntrospection(familyId: string): void {
    this.introspections.delete(familyId);
    for (const attempt of this.inFlightIntrospections.get(familyId) ?? []) attempt.invalidated = true;
  }

  /** Corta una familia; el observador de TokenStore revoca y retira el bearer. */
  private async dropFamily(familyId: string): Promise<void> {
    this.forgetIntrospection(familyId);
    await this.tokens.dropFamily(familyId);
  }

  /** Entrada vigente y de esta misma concesión. Una caducada se borra y nunca se alarga. */
  private cachedIntrospection(familyId: string, grant: string): boolean {
    const entry = this.introspections.get(familyId);
    if (!entry) return false;
    const now = this.now();
    const monotonicNow = performance.now();
    if (entry.grant === grant && now >= entry.checkedAt && now < entry.expiresAt &&
      monotonicNow >= entry.monotonicCheckedAt && monotonicNow - entry.monotonicCheckedAt < INTROSPECTION_CACHE_MS) return true;
    this.introspections.delete(familyId);
    return false;
  }

  /** Guarda un resultado positivo ya comparado con `grant`; caduca a los 30 s o con la concesión. */
  private rememberIntrospection(familyId: string, grant: ActiveGrant, checkedAt: number, monotonicCheckedAt: number, epoch: number): void {
    if (epoch !== this.introspectionEpoch) return;
    const now = this.now();
    const monotonicNow = performance.now();
    for (const [id, entry] of this.introspections) {
      if (entry.expiresAt <= now || now < entry.checkedAt || monotonicNow < entry.monotonicCheckedAt ||
        monotonicNow - entry.monotonicCheckedAt >= INTROSPECTION_CACHE_MS) this.introspections.delete(id);
    }
    const expiresAt = Math.min(checkedAt + INTROSPECTION_CACHE_MS, Date.parse(grant.expiresAt));
    if (!(expiresAt > now) || monotonicNow < monotonicCheckedAt ||
      monotonicNow - monotonicCheckedAt >= INTROSPECTION_CACHE_MS) { this.introspections.delete(familyId); return; }
    if (!this.introspections.has(familyId) && this.introspections.size >= MAX_INTROSPECTIONS) {
      const oldest = this.introspections.keys().next();
      if (!oldest.done) this.introspections.delete(oldest.value);
    }
    this.introspections.set(familyId, { grant: grantFingerprint(grant), checkedAt, monotonicCheckedAt, expiresAt });
  }

  /**
   * Emparejado local y bearer de la familia se comprueban siempre. Con `useCache`, una
   * introspección positiva de hace menos de `INTROSPECTION_CACHE_MS` evita la ida a Lumbre.
   * Un `null`, un desajuste o un error del backchannel nunca se guardan.
   */
  private async active(familyId: string, grant: ActiveGrant, useCache: boolean): Promise<boolean> {
    const current = await this.currentBinding();
    if (!current || !sameBinding(current, grant)) { await this.dropFamily(familyId); return false; }
    const bearer = this.grants.get(familyId);
    if (!bearer) { this.forgetIntrospection(familyId); return false; }
    if (useCache && this.cachedIntrospection(familyId, grantFingerprint(grant))) return true;
    const epoch = this.introspectionEpoch;
    const checkedAt = this.now();
    const monotonicCheckedAt = performance.now();
    const attempt: IntrospectionAttempt = { invalidated: false };
    const attempts = this.inFlightIntrospections.get(familyId) ?? new Set<IntrospectionAttempt>();
    attempts.add(attempt);
    this.inFlightIntrospections.set(familyId, attempts);
    let inspected: ActiveGrant | null;
    try { inspected = await this.backchannel.introspect(bearer); }
    finally {
      attempts.delete(attempt);
      if (attempts.size === 0) this.inFlightIntrospections.delete(familyId);
    }
    if (!inspected) { await this.dropFamily(familyId); return false; }
    // Otra petición pudo invalidar la familia mientras Lumbre respondía.
    if (attempt.invalidated || epoch !== this.introspectionEpoch) return false;
    const sameGrant = inspected.credentialId === grant.credentialId && inspected.clientId === grant.clientId &&
      inspected.accountId === grant.accountId && sameBinding(inspected, grant);
    if (!sameGrant || inspected.expiresAt !== grant.expiresAt) {
      // Solo la fecha, con una renovación a medio guardar: transitorio, no se corta la familia.
      if (sameGrant && this.renewing.has(familyId)) throw new BackchannelError('unavailable');
      await this.dropFamily(familyId); return false;
    }
    this.rememberIntrospection(familyId, grant, checkedAt, monotonicCheckedAt, epoch);
    return true;
  }

  /** El código se quema antes de comprobar cliente, PKCE, recurso e introspección. */
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const hash = sha256(code);
    const entry = this.codes.get(hash);
    this.codes.delete(hash);
    const fail = (): never => { throw new InvalidGrantError('Código de autorización no válido.'); };
    if (!entry || entry.expiresAt <= this.now()) return fail();
    const { grant } = entry;
    const cleanup = async () => {
      try {
        await this.backchannel.revoke(grant.accessToken);
        await this.grants.unstage(hash);
      } catch { logEvent({ event: 'oauth.grant.revoke', result: 'unavailable' }); }
    };
    if (entry.clientId !== client.client_id || redirectUri !== entry.redirectUri ||
      verifier === undefined || !VERIFIER.test(verifier) || !equal(s256(verifier), entry.challenge) || !this.sameResource(resource)) {
      await cleanup(); return fail();
    }
    const revokedBefore = await this.revokedBefore();
    if (entry.issuedAt <= revokedBefore) { await cleanup(); return fail(); }
    const current = await this.currentBinding();
    if (!current || !sameBinding(current, grant)) { await cleanup(); return fail(); }
    let inspected: ActiveGrant | null;
    try { inspected = await this.backchannel.introspect(grant.accessToken); }
    catch { throw new ServerError('Consentimiento temporalmente no disponible.'); }
    if (!inspected || inspected.credentialId !== grant.credentialId || !sameBinding(inspected, grant)) { await cleanup(); return fail(); }
    try {
      const { accessToken: _unused, ...metadata } = grant;
      const issued = await this.tokens.issueFamily({ clientId: entry.clientId, scope: OAUTH_SCOPE, resource: entry.resource,
        grant: { ...metadata, active: true }, authorizedAt: entry.issuedAt, identity: entry.identity }, await this.revokedBefore(),
      async (familyId, ids) => { await this.grants.markPromoting(hash, familyId); await this.grants.set(familyId, grant.accessToken, ids); });
      await this.grants.unstage(hash).catch(() => logEvent({ event: 'oauth.grant.cleanup', result: 'failed' }));
      logEvent({ event: 'oauth.token', grant: 'authorization_code', result: 'issued' });
      return this.tokensResponse(issued);
    } catch { await cleanup(); throw new ServerError('No se pudo guardar la autorización.'); }
  }

  /** Un refresh que no es el vigente de una familia viva: replay, rotación reciente o caducada. Nunca renueva. */
  private async rejectRefresh(refreshToken: string, clientId: string, revokedBefore: number): Promise<never> {
    const replay = await this.tokens.rotateRefresh(refreshToken, clientId, revokedBefore);
    if (replay.ok) throw new ServerError('Estado OAuth inconsistente.');
    throw new InvalidGrantError('Refresh token no válido.');
  }

  /** Ejecuta `run` después de los refresh anteriores de la misma familia. */
  private async serializeRefresh<T>(familyId: string, run: () => Promise<T>): Promise<T> {
    const current = (this.refreshQueues.get(familyId) ?? Promise.resolve()).then(run);
    const tail = current.then(() => undefined, () => undefined);
    this.refreshQueues.set(familyId, tail);
    try { return await current; }
    finally { if (this.refreshQueues.get(familyId) === tail) this.refreshQueues.delete(familyId); }
  }

  /**
   * Refresh con renovación en Lumbre (`/renew`, contrato H-dec4/H31 del 17 oct 2026): antes de
   * entregar tokens se renueva la concesión y su fecha nueva se guarda en la familia en la
   * misma escritura que rota el refresh. `active: false` exige consentimiento nuevo
   * (`invalid_grant` y familia cortada); red, 5xx o 429 dan un error temporal sin tocar la
   * familia, para que el cliente reintente con el mismo refresh. El handler del SDK no deja
   * fijar cabeceras desde el proveedor, así que el `Retry-After` de Lumbre no llega al cliente.
   */
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.checkScopes(scopes);
    if (!this.sameResource(resource)) throw new InvalidTargetError(`El resource debe ser ${this.resource}.`);
    const revokedBefore = await this.revokedBefore();
    const found = this.tokens.lookupRefresh(refreshToken, client.client_id, revokedBefore);
    if (!found) return this.rejectRefresh(refreshToken, client.client_id, revokedBefore);
    return this.serializeRefresh(found.familyId, async () => {
      // Otro refresh de la familia pudo rotar este token mientras esperaba su turno.
      const candidate = this.tokens.lookupRefresh(refreshToken, client.client_id, revokedBefore);
      if (!candidate) return this.rejectRefresh(refreshToken, client.client_id, revokedBefore);
      const { familyId } = candidate;
      // Emitir tokens nuevos exige una introspección fresca: la caché solo ahorra la de `/mcp`.
      try { if (!await this.active(familyId, candidate.grant, false)) throw new InvalidGrantError('Refresh token no válido.'); }
      catch (error) { if (error instanceof InvalidGrantError) throw error; throw new ServerError('Consentimiento temporalmente no disponible.'); }
      const bearer = this.grants.get(familyId);
      if (!bearer) { this.forgetIntrospection(familyId); throw new InvalidGrantError('Refresh token no válido.'); }
      this.renewing.add(familyId);
      try {
        let renewed: string | null;
        try { renewed = await this.backchannel.renew(bearer); }
        catch {
          logEvent({ event: 'oauth.renew', result: 'unavailable' });
          throw new ServerError('temporarily_unavailable');
        }
        if (renewed === null) {
          logEvent({ event: 'oauth.renew', result: 'inactive' });
          await this.dropFamily(familyId);
          throw new InvalidGrantError('La autorización caducó: hay que volver a conectar.');
        }
        // «Activa» con una fecha ya pasada no es una renovación: no se toca la familia.
        if (Date.parse(renewed) <= this.now()) {
          logEvent({ event: 'oauth.renew', result: 'invalid' });
          throw new ServerError('temporarily_unavailable');
        }
        const outcome = await this.tokens.rotateRefresh(refreshToken, client.client_id, revokedBefore, renewed);
        // La caché y las introspecciones en vuelo eran de la fecha anterior.
        this.forgetIntrospection(familyId);
        // Un replay o una familia caducada la quitan del almacén; una rotación reciente solo fuerza otra consulta.
        if (!outcome.ok) throw new InvalidGrantError('Refresh token no válido.');
        logEvent({ event: 'oauth.renew', result: 'renewed' });
        return this.tokensResponse(outcome.tokens);
      } finally { this.renewing.delete(familyId); }
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const verified = this.tokens.verifyAccess(token, await this.revokedBefore());
    if (!verified) throw new InvalidTokenError('Token no válido.');
    try { if (!await this.active(verified.familyId, verified.grant, true)) throw new InvalidTokenError('Token no válido.'); }
    catch (error) {
      if (error instanceof InvalidTokenError || error instanceof BackchannelError) throw error;
      throw new BackchannelError('unavailable');
    }
    return { token, clientId: verified.clientId, scopes: verified.scope.split(' '), expiresAt: verified.expiresAt,
      resource: new URL(verified.resource) };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const before = await this.revokedBefore();
    const access = this.tokens.verifyAccess(request.token, before);
    const family = this.tokens.lookupRefresh(request.token, client.client_id, before) ??
      (access?.clientId === client.client_id ? access : null);
    // Antes de esperar nada: una petición concurrente no entra con la introspección guardada.
    if (family) this.forgetIntrospection(family.familyId);
    const result = await this.tokens.revoke(request.token, client.client_id);
    logEvent({ event: 'oauth.revoke', result });
  }
}
