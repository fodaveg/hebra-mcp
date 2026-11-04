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
import { InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTargetError, InvalidTokenError, ServerError, TooManyRequestsError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { AccountRegistry, type AccountRecord, type AuthorizedAccount } from '../accounts';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { decodeRecoveryCode } from '../hebra';
import { logEvent } from '../log/logger';
import { readPairedSecrets, type SecretStore } from '../secrets';
import { PairingRevocation } from '../status/pairing-revocation';
import { BackchannelError, LumbreBackchannel, type ActiveGrant, type Binding, type Grant, sameBinding } from './backchannel';
import { rateKey } from './backchannel-logout';
import { ClaudeClientsStore, isAllowedRedirectUri } from './clients';
import { sendTooManyRequests } from './failure-limit';
import { GrantSecrets } from './grants';
import type { LoginProvider } from './login-config';
import { RevocationFile } from './owner';
import { sendConsentExpiredPage, sendConsentPage, sendDeniedPage, sendPairingRevokedPage, sendUnavailablePage } from './pages';
import { SumegoError, type SumegoOidc } from './sumego';
import type { RefreshSealer } from './sumego-refresh';
import { familyRateKey, FamilyRateLimitedError, logoutMatches, TokenStore, type FamilyIdentity, type IssuedTokens, type LogoutSelector, type SumegoRefreshState } from './token-store';

export const OAUTH_SCOPE = 'hebra:mcp';
const FAMILY_RATE_MESSAGE = 'Demasiadas conexiones nuevas en la última hora.';
const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
/**
 * Solicitudes anónimas, las que aún no han vuelto del login, que se conservan a la vez (D22,
 * SPEC.md §12.10). Solo acotan memoria: pasado el tope cae la más antigua, nunca se rechaza la
 * nueva. Una solicitud ocupa pocos KiB, así que el total son unos 10 MiB como mucho.
 */
export const MAX_PENDING = 4096;
export const MAX_PENDING_PER_IP = 32;
/**
 * Vigencia en memoria de una introspección POSITIVA, por familia. Revocar la concesión en
 * Lumbre puede tardar hasta este plazo en cortar `/mcp`; el emparejado local, el bearer de la
 * familia, `revokeToken` y `oauth-revoke-all` se comprueban en cada petición y cortan al momento.
 */
export const INTROSPECTION_CACHE_MS = 30_000;
/**
 * Solo acota memoria: una entrada por familia en uso, de menos de 1 KiB y que vence a los 30 s.
 * Expulsar una no niega nada: su siguiente petición repite la introspección en Lumbre.
 */
export const MAX_INTROSPECTIONS = 4096;
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
  stateHash: string;
  nonce: string;
  nonceHash: string;
  verifier: string;
  cookieHash: string;
  phase: 'login' | 'exchanging' | 'consent';
  idToken: string | null;
  email: string | null;
  identity: FamilyIdentity | null;
  /** `iat` del ID token, en segundos (para los logout cerrados). */
  idTokenIat: number | null;
  /** Refresh de Sumego del canje, en claro solo en memoria hasta cifrarlo en la familia. */
  refreshToken: string | null;
  /** Cuándo se obtuvo ese refresh: cuenta como la primera renovación. */
  refreshedAt: number | null;
  /** Lumbre acepta el ID token hasta `iat` + 5 min (+60 s): el «Permitir» vale hasta `iat` + 5 min − 30 s. */
  consentDeadline: number | null;
  formTokenHash: string | null;
  /** Reautenticación de una alta remota que perdió el ID token. */
  remotePairingId?: string;
  expectedSub?: string;
}

/** Lo que una autorización con Sumego lleva hasta su familia. */
interface SumegoAuthorization {
  identity: FamilyIdentity;
  idTokenIat: number;
  refreshToken: string;
  refreshedAt: number;
}

/** `sid`/`sub` cerrados por un back-channel logout, hasta `until` (el mismo plazo que su `jti`). */
interface ClosedLogout {
  selector: LogoutSelector;
  /** `iat` del `logout_token`, en segundos: solo cierra autorizaciones con ID token anterior o igual. */
  iat: number;
  until: number;
}

/** Cada cuánto se renueva el refresh de Sumego al refrescar en `/token` (SPEC.md §12.9). */
export const SUMEGO_RENEW_INTERVAL_MS = 60 * 60_000;
/** Margen del «Permitir» respecto a los 5 min de vida del ID token en Lumbre. */
const CONSENT_MARGIN_S = 30;
const ID_TOKEN_ACCEPTED_S = 300;
const MAX_CLOSED_LOGOUTS = 1024;

interface PendingAuthorization {
  binding: Binding | null;
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
  pairingGrant?: Grant;
  pairingStageHash?: string;
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
  /** Solo con el login de Sumego. */
  sumego: SumegoAuthorization | null;
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

/**
 * ¿Ha pasado ya por el login? Desde el callback de Sumego (o la aprobación de Lumbre), o con
 * una alta remota en curso aunque esté repitiendo el login. Una solicitud así ya no es anónima
 * y ninguna anónima la expulsa.
 */
function pastLogin(pending: PendingAuthorization): boolean {
  const login = pending.sumego;
  return pending.claimed || pending.pairingGrant !== undefined ||
    (login !== undefined && (login.phase !== 'login' || login.remotePairingId !== undefined));
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function s256(value: string): string { return createHash('sha256').update(value, 'ascii').digest('base64url'); }
/**
 * Motivo cerrado de un fallo para el log: clase y `kind`/`code`/`reason` de los errores propios
 * (`SumegoError:unavailable`, `RemotePairingError:unavailable:cleanup_revoke_failed`). Nunca el
 * mensaje, que podría arrastrar un token, un `sub` o un email.
 */
function failureReason(failure: unknown): string {
  if (!(failure instanceof Error)) return 'unknown';
  const detail = (failure as { kind?: unknown; code?: unknown; reason?: unknown });
  const parts = [failure.name, detail.kind, detail.code, detail.reason]
    .filter((part): part is string => typeof part === 'string' && /^[\w:.-]{1,80}$/.test(part));
  return parts.join(':') || 'unknown';
}

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
  /** Cifra los refresh de Sumego de las familias; obligatorio con `sumego`. */
  sealer?: RefreshSealer | null;
  /** Registro multiusuario. Sin él no se puede convertir una familia en biblioteca. */
  accounts: AccountRegistry;
  /** Activa selección obligatoria por cuenta; `false` conserva el servidor legado. */
  multiuser?: boolean;
}

export interface RemotePairingOAuthHooks {
  start(input: { oauthRequestId: string; sub: string; identityExpiresAt: string }, res: Response): Promise<string>;
  resumeIdentity(input: { pairingSessionId: string; sub: string; identityExpiresAt: string }): Promise<void>;
  abandon(pairingSessionId: string, oauthRequestId: string): Promise<void>;
}

export interface AccountAuthInfo extends AuthInfo { account: AuthorizedAccount }

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
  /** Canjes de código admitidos y sin terminar, por persona (`guardFamilyRate`). */
  private readonly familyExchanges = new Map<string, number>();
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
  private readonly sealer: RefreshSealer | null;
  private readonly accounts: AccountRegistry;
  private readonly multiuser: boolean;
  private remotePairing: RemotePairingOAuthHooks | null = null;
  readonly pairing: PairingRevocation;
  /** Logout recientes: alcanzan a solicitudes y códigos en vuelo y a la familia que aún no existe. */
  private closedLogouts: ClosedLogout[] = [];
  /**
   * Refresh de Sumego ya rotado en Sumego y aún sin guardar (si `/renew` o la escritura
   * fallaron después). El reintento lo usa en vez del viejo, que Sumego ya no acepta.
   */
  private readonly sumegoRotations = new Map<string, SumegoRefreshState>();

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
    this.sealer = options.sealer ?? null;
    this.accounts = options.accounts;
    this.multiuser = options.multiuser ?? false;
    if (this.loginProvider === 'sumego' && (!this.sumego || !this.sealer)) throw new Error('sumego_not_configured');
    this.pairing = options.pairing ?? new PairingRevocation();
    this.tokens.onFamiliesRemoved((ids) => {
      const removed = ids.map((id) => {
        this.forgetIntrospection(id);
        this.sumegoRotations.delete(id);
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

  attachRemotePairing(hooks: RemotePairingOAuthHooks): void {
    if (this.remotePairing) throw new Error('remote_pairing_already_attached');
    this.remotePairing = hooks;
  }

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

  /** El legado sin sub solo puede probar el vínculo local exacto, nunca uno elegido por el login. */
  private async unclaimedLegacyBinding(): Promise<Binding | null> {
    const legacy = this.accounts.legacyAccount();
    if (legacy && (legacy.state !== 'active' || legacy.sub !== '__legacy_unclaimed__')) return null;
    const current = await this.currentBinding();
    return current && (!legacy || sameBinding(legacy.binding, current)) ? current : null;
  }

  /** Compatibilidad monousuario: el vínculo local sigue siendo la autoridad del contexto fijo. */
  private async legacySingleUser(grant: Binding): Promise<AuthorizedAccount | null> {
    if (this.multiuser) return null;
    const current = await this.currentBinding();
    return current && sameBinding(current, grant)
      ? { id: 'legacy-single-user', generation: 1, binding: current, storage: 'legacy-root' }
      : null;
  }

  private async assertAccountActive(account: AuthorizedAccount): Promise<void> {
    if (account.id !== 'legacy-single-user') { this.accounts.assertActive(account); return; }
    if (!await this.legacySingleUser(account.binding)) throw new Error('account_inactive');
  }

  /** Caducados en memoria: la concesión remota se revoca y el secreto staged se retira. */
  private prune(): void {
    const now = this.now();
    for (const [id, pending] of this.pending) if (pending.expiresAt <= now) this.discardPending(id, pending);
    for (const [hash, code] of this.codes) {
      if (code.expiresAt > now) continue;
      this.discardCode(hash, code);
    }
    this.closedLogouts = this.closedLogouts.filter((entry) => entry.until > now);
  }

  private discardPending(id: string, pending: PendingAuthorization): void {
    this.pending.delete(id);
    if (!pending.pairingGrant || !pending.pairingStageHash) return;
    void this.backchannel.revoke(pending.pairingGrant.accessToken)
      .then(() => this.grants.unstage(pending.pairingStageHash!))
      .catch(() => logEvent({ event: 'oauth.grant.revoke', result: 'unavailable' }));
  }

  async cancelRemoteAuthorization(oauthRequestId: string): Promise<void> {
    const pending = this.pending.get(oauthRequestId);
    if (!pending) return;
    this.pending.delete(oauthRequestId);
    if (!pending.pairingGrant || !pending.pairingStageHash) return;
    await this.backchannel.revoke(pending.pairingGrant.accessToken);
    await this.grants.unstage(pending.pairingStageHash);
  }

  async reauthenticateRemote(input: { oauthRequestId: string; expectedSub: string; pairingSessionId: string },
    res: Response): Promise<string> {
    const pending = this.pending.get(input.oauthRequestId);
    if (!pending?.sumego?.identity || pending.sumego.identity.sub !== input.expectedSub || !this.sumego ||
      pending.expiresAt <= this.now()) throw new Error('remote_pairing_reauth_invalid');
    const random = () => randomBytes(32).toString('base64url');
    const nonce = random();
    const state = random();
    const login: SumegoLogin = { state, stateHash: sha256(state), nonce, nonceHash: s256(nonce), verifier: random(), cookieHash: '',
      phase: 'login', idToken: null, email: null, identity: null, idTokenIat: null, refreshToken: null,
      refreshedAt: null, consentDeadline: null, formTokenHash: null,
      remotePairingId: input.pairingSessionId, expectedSub: input.expectedSub };
    const cookie = random();
    login.cookieHash = sha256(cookie);
    pending.sumego = login;
    const location = await this.sumego.authorizationUrl({ state: login.state, nonce,
      codeChallenge: s256(login.verifier) });
    res.append('set-cookie', loginCookie(cookie, LOGIN_COOKIE_MAX_AGE_S));
    return location;
  }

  /** Quita un código no canjeado y revoca su concesión upstream, sin esperar. */
  private discardCode(hash: string, code: AuthorizationCode): void {
    this.codes.delete(hash);
    void this.backchannel.revoke(code.grant.accessToken)
      .then(() => this.grants.unstage(hash))
      .catch(() => logEvent({ event: 'oauth.grant.revoke', result: 'unavailable' }));
  }

  /**
   * ¿Cerró un back-channel logout reciente esta identidad? Solo cuenta si el ID token es
   * anterior o igual al `logout_token`: un login nuevo después de «cerrar en todas partes»
   * no queda bloqueado (cerrado ante la duda en el mismo segundo).
   */
  private loggedOut(identity: FamilyIdentity | null, idTokenIat: number | null): boolean {
    if (identity === null) return false;
    const now = this.now();
    return this.closedLogouts.some((entry) => entry.until > now && logoutMatches(entry.selector, identity) &&
      (idTokenIat === null || idTokenIat <= entry.iat));
  }

  /**
   * Hace sitio a una solicitud nueva de `ip`, sin rechazarla (D22): si esa dirección o el total de
   * anónimas está en el tope, cae la anónima más antigua de esa dirección o del total. El orden
   * del Map es el de llegada. Las que ya pasaron el login ni cuentan ni caen: las acota su propia
   * caducidad, porque cada una ha costado un login real.
   */
  private makeRoomForPending(ip: string): void {
    const anonymous = [...this.pending].filter(([, entry]) => !pastLogin(entry));
    const fromIp = anonymous.filter(([, entry]) => entry.ip === ip);
    const evicted = fromIp.length >= MAX_PENDING_PER_IP ? fromIp[0]
      : anonymous.length >= MAX_PENDING ? anonymous[0] : undefined;
    if (!evicted) return;
    this.discardPending(evicted[0], evicted[1]);
    logEvent({ event: 'oauth.authorize', result: 'evicted', scope: evicted === fromIp[0] ? 'address' : 'total' });
  }

  /** La solicitud ocupa su sitio antes de llamar al broker. */
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
    // Las IPv6 cuentan por /64: quien controla una red entera no multiplica su cupo.
    const ip = rateKey(res.req.ip ?? res.req.socket.remoteAddress ?? 'unknown');
    const transactionId = randomBytes(32).toString('base64url');
    // En remoto solo el sub validado elige el vínculo: un legado aún sin reclamar
    // puede coexistir con cuentas activas. El modo fijo conserva su solicitud histórica.
    const binding = this.loginProvider === 'sumego'
      ? (this.multiuser ? null : await this.unclaimedLegacyBinding())
      : await this.currentBinding();
    if (this.loginProvider !== 'sumego' && !binding) {
      res.status(503).json({ error: 'temporarily_unavailable' }); return;
    }
    if (binding && this.pairing.isRevoked(binding.pairedCredentialId)) {
      sendPairingRevokedPage(res); return;
    }
    this.makeRoomForPending(ip);
    const clientName = (client.client_name || 'Claude').slice(0, 120);
    const pending: PendingAuthorization = {
      binding, requestId: null, transactionId, clientId: client.client_id, clientName,
      redirectUri: params.redirectUri, challenge: params.codeChallenge, state: params.state,
      ip, createdAt: this.now(), expiresAt: this.now() + PENDING_TTL_MS, claimed: false
    };
    // El insert ocurre antes de la primera llamada remota.
    this.pending.set(transactionId, pending);
    if (this.loginProvider === 'sumego') { await this.authorizeWithSumego(pending, res); return; }
    try {
      const requested = await this.backchannel.request({ ...binding!, transactionId, clientId: client.client_id, clientName });
      if (this.pending.get(transactionId) !== pending || !sameBinding(binding!, (await this.currentBinding()) ?? { pairedCredentialId: '', syncVaultId: '', opaqueDeviceId: '' })) {
        this.pending.delete(transactionId); res.status(400).json({ error: 'invalid_request' }); return;
      }
      pending.requestId = requested.requestId;
      pending.expiresAt = Math.min(pending.expiresAt, Date.parse(requested.expiresAt));
      if (pending.expiresAt <= this.now()) { this.pending.delete(transactionId); res.status(400).json({ error: 'invalid_request' }); return; }
      logEvent({ event: 'oauth.authorize', result: 'lumbre' });
      res.redirect(302, requested.authorizationUrl);
    } catch (error) {
      this.pending.delete(transactionId);
      if (this.pairingRevokedBy(error, binding!)) { sendPairingRevokedPage(res); return; }
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
   * `/authorize` en modo `sumego`: primero autentica a la persona, sin elegir biblioteca.
   * Tras el callback, el `sub` decide si se registra en Lumbre el vínculo de su cuenta o si
   * empieza un alta remota. `state`, `nonce`, PKCE y la cookie siguen atando el navegador.
   */
  private async authorizeWithSumego(pending: PendingAuthorization, res: Response): Promise<void> {
    const sumego = this.sumego!;
    const { transactionId } = pending;
    const random = () => randomBytes(32).toString('base64url');
    const nonce = random();
    const state = random();
    const login: SumegoLogin = { state, stateHash: sha256(state), nonce, nonceHash: s256(nonce), verifier: random(), cookieHash: '', phase: 'login',
      idToken: null, email: null, identity: null, idTokenIat: null, refreshToken: null, refreshedAt: null,
      consentDeadline: null, formTokenHash: null };
    const cookie = random();
    login.cookieHash = sha256(cookie);
    pending.sumego = login;
    try {
      const authorizationUrl = await sumego.authorizationUrl({ state: login.state, nonce: login.nonce, codeChallenge: s256(login.verifier) });
      // Valida primero discovery/JWKS del proveedor: un login inválido no debe dejar
      // solicitudes huérfanas en Lumbre.
      if (pending.binding) await this.requestSumegoFor(pending, pending.binding);
      res.setHeader('set-cookie', loginCookie(cookie, LOGIN_COOKIE_MAX_AGE_S));
      logEvent({ event: 'oauth.authorize', result: 'sumego' });
      res.redirect(302, authorizationUrl);
    } catch (error) {
      this.pending.delete(transactionId);
      if (pending.binding && this.pairingRevokedBy(error, pending.binding)) {
        sendPairingRevokedPage(res); return;
      }
      logEvent({ event: 'oauth.authorize', result: 'unavailable' });
      res.status(503).json({ error: 'temporarily_unavailable' });
    }
  }

  private async requestSumegoFor(pending: PendingAuthorization, binding: Binding): Promise<void> {
    const login = pending.sumego;
    if (!login) throw new Error('sumego_login_missing');
    const requested = await this.backchannel.requestSumego({ ...binding, transactionId: pending.transactionId,
      clientId: pending.clientId, clientName: pending.clientName, sumegoNonceSha256: login.nonceHash });
    if (this.pending.get(pending.transactionId) !== pending) throw new Error('authorization_expired');
    pending.binding = binding;
    pending.requestId = requested.requestId;
    pending.expiresAt = Math.min(pending.expiresAt, Date.parse(requested.expiresAt));
    if (pending.expiresAt <= this.now()) throw new Error('authorization_expired');
  }

  /**
   * La solicitud del login con Sumego cuyo `state` es este. Compara la huella guardada, sin
   * recalcular una por solicitud: esta ruta es pública y no tiene cupo, y con miles de pendientes
   * eso sería trabajo gratis para quien la golpee. Un `===` entre huellas SHA-256 de un valor
   * aleatorio de 256 bits no revela nada aprovechable: quien llama no controla la huella.
   */
  private pendingByState(state: string): [string, PendingAuthorization] | null {
    const wanted = sha256(state);
    for (const [key, value] of this.pending) {
      if (value.sumego?.stateHash === wanted) return [key, value];
    }
    return null;
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
    // Desde aquí, con la cookie de la solicitud, todo final quema la transacción y la cookie se
    // borra; antes (sin cookie, `state` desconocido) no se toca, porque no es de este navegador.
    const burn = () => { this.pending.delete(key); res.setHeader('set-cookie', loginCookie('', 0)); };
    const reject = (result: string, reason?: string) => {
      burn();
      logEvent(reason === undefined ? { event: 'oauth.sumego.callback', result }
        : { event: 'oauth.sumego.callback', result, reason });
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
    let tokens: Awaited<ReturnType<SumegoOidc['exchangeCode']>>;
    let claims: Awaited<ReturnType<SumegoOidc['verifyIdToken']>>;
    try {
      tokens = await sumego.exchangeCode(code!, verifier);
      claims = await sumego.verifyIdToken(tokens.idToken, nonce);
    } catch (failure) {
      burn();
      const unavailable = !(failure instanceof SumegoError) || failure.kind === 'unavailable';
      logEvent({ event: 'oauth.sumego.callback', result: unavailable ? 'unavailable' : 'invalid',
        reason: failureReason(failure) });
      if (unavailable) sendUnavailablePage(res); else sendDeniedPage(res, 400);
      return;
    }
    if (this.pending.get(key) !== pending || pending.expiresAt <= this.now()) { reject('expired'); return; }
    const identity = { sub: claims.sub, sid: claims.sid };
    if (this.loggedOut(identity, claims.iat)) { reject('logged_out'); return; }
    const formToken = randomBytes(32).toString('base64url');
    login.phase = 'consent';
    login.idToken = tokens.idToken;
    login.email = claims.email;
    login.identity = identity;
    login.idTokenIat = claims.iat;
    login.refreshToken = tokens.refreshToken;
    login.refreshedAt = this.now();
    login.consentDeadline = (claims.iat + ID_TOKEN_ACCEPTED_S - CONSENT_MARGIN_S) * 1000;
    if (login.consentDeadline <= this.now()) {
      burn(); logEvent({ event: 'oauth.sumego.callback', result: 'expired' }); sendConsentExpiredPage(res); return;
    }

    const identityExpiresAt = new Date(login.consentDeadline).toISOString();
    if (login.remotePairingId) {
      if (!this.remotePairing) { reject('unavailable'); return; }
      if (!login.expectedSub || claims.sub !== login.expectedSub) {
        // La identidad nueva no puede conservar la credencial preparada para otra persona.
        // El diario valida también la transacción OAuth original antes de limpiar.
        try { await this.remotePairing.abandon(login.remotePairingId, pending.transactionId); }
        catch { /* El servicio conserva cualquier revocación pendiente y bloquea el runtime. */ }
        await this.cancelRemoteAuthorization(pending.transactionId).catch(() =>
          logEvent({ event: 'oauth.grant.revoke', result: 'unavailable' }));
        reject('wrong_account'); return;
      }
      try {
        await this.remotePairing.resumeIdentity({ pairingSessionId: login.remotePairingId,
          sub: claims.sub, identityExpiresAt });
        res.append('set-cookie', loginCookie('', 0));
        res.redirect(303, '/lumbre/pairing/resume');
      } catch (failure) {
        reject('unavailable', failureReason(failure));
      }
      return;
    }

    const account = this.accounts.findBySub(claims.sub);
    if (account?.state === 'removing') { reject('account_removing'); return; }
    let binding: Binding | null = account?.state === 'active' ? account.binding : null;
    // Migración explícita del único legado: solo se prueba su vínculo si aún no tiene dueño.
    if (!binding) binding = await this.unclaimedLegacyBinding();
    if (binding && pending.requestId) {
      if (!pending.binding || !sameBinding(binding, pending.binding)) { reject('binding_changed'); return; }
    } else if (binding) {
      try { await this.requestSumegoFor(pending, binding); }
      catch (failure) {
        if (this.pairingRevokedBy(failure, binding)) { burn(); sendPairingRevokedPage(res); return; }
        reject('unavailable', failureReason(failure)); return;
      }
    } else {
      if (!this.remotePairing) { reject('unavailable', 'remote_pairing_not_attached'); return; }
      try {
        const location = await this.remotePairing.start({ oauthRequestId: pending.transactionId,
          sub: claims.sub, identityExpiresAt }, res);
        res.append('set-cookie', loginCookie('', 0));
        res.redirect(303, location);
      } catch (failure) {
        reject('unavailable', failureReason(failure));
      }
      return;
    }
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
    // Un uso: desde aquí el mismo token ya no encuentra la solicitud, y la transacción se quema
    // pase lo que pase (por eso se borra la cookie).
    login.formTokenHash = null;
    const idToken = login.idToken;
    const identity = login.identity;
    const authorization: SumegoAuthorization | null = identity && login.idTokenIat !== null && login.refreshToken && login.refreshedAt !== null
      ? { identity, idTokenIat: login.idTokenIat, refreshToken: login.refreshToken, refreshedAt: login.refreshedAt } : null;
    login.idToken = null;
    login.refreshToken = null;
    res.setHeader('set-cookie', loginCookie('', 0));
    if (!idToken || !authorization || !pending.requestId || pending.createdAt <= await this.revokedBefore()) {
      this.pending.delete(key); sendDeniedPage(res, 400); return;
    }
    // Lumbre ya no aceptaría este ID token: «no disponible» y volver a conectar.
    if (login.consentDeadline === null || login.consentDeadline <= this.now()) {
      this.pending.delete(key); logEvent({ event: 'oauth.consent', result: 'expired' }); sendConsentExpiredPage(res); return;
    }
    if (this.loggedOut(authorization.identity, authorization.idTokenIat)) {
      this.pending.delete(key); logEvent({ event: 'oauth.consent', result: 'logged_out' }); sendDeniedPage(res); return;
    }
    if (pending.claimed) { this.pending.delete(key); sendUnavailablePage(res); return; }
    pending.claimed = true;
    let grant: Grant;
    try {
      grant = await this.backchannel.sumegoExchange({ requestId: pending.requestId, transactionId: pending.transactionId, idToken, clientId: pending.clientId });
    } catch (error) {
      this.pending.delete(key);
      if (pending.binding && this.pairingRevokedBy(error, pending.binding)) { sendPairingRevokedPage(res); return; }
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
      // Un logout pudo llegar mientras Lumbre canjeaba.
      if (this.loggedOut(authorization.identity, authorization.idTokenIat)) throw new Error('logged_out');
      const target = await this.issueCode(key, pending, grant, authorization);
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
  private async issueCode(key: string, pending: PendingAuthorization, grant: Grant, sumego: SumegoAuthorization | null): Promise<string> {
    if (pending.createdAt <= await this.revokedBefore() || !pending.binding ||
      !sameBinding(grant, pending.binding) ||
      grant.clientId !== pending.clientId || grant.resource !== this.resource || Date.parse(grant.expiresAt) <= this.now()) {
      throw new Error('binding');
    }
    const { accessToken: _bearer, ...activeFields } = grant;
    const active: ActiveGrant = { ...activeFields, active: true };
    let account = this.accounts.authorize(active, sumego?.identity.sub ?? null);
    if (!account && sumego) {
      const current = await this.unclaimedLegacyBinding();
      if (current && sameBinding(current, grant)) {
        account = await this.accounts.claimLegacy({ sub: sumego.identity.sub, grant: active });
      }
    }
    account ??= await this.legacySingleUser(grant);
    if (!account) throw new Error('account_inactive');
    await this.assertAccountActive(account);
    const code = randomBytes(32).toString('base64url');
    const hash = sha256(code);
    await this.grants.stage(hash, grant.accessToken);
    try { await this.assertAccountActive(account); }
    catch (error) { await this.grants.unstage(hash).catch(() => undefined); throw error; }
    this.pending.delete(key);
    this.codes.set(hash, { clientId: pending.clientId, redirectUri: pending.redirectUri, challenge: pending.challenge,
      resource: this.resource, grant, issuedAt: this.now(), expiresAt: this.now() + CODE_TTL_MS,
      identity: sumego?.identity ?? null, sumego });
    const target = new URL(pending.redirectUri);
    target.searchParams.set('code', code);
    if (pending.state !== undefined) target.searchParams.set('state', pending.state);
    target.searchParams.set('iss', this.issuer);
    return target.href;
  }

  /**
   * Back-channel logout de Sumego ya validado (`iat` del `logout_token` en segundos, `until`
   * el mismo plazo que su `jti`, en ms):
   * 1. Apunta el `sid`/`sub` cerrado hasta `until`: el consentimiento, el canje del código y
   *    `issueFamily` rechazan una identidad cerrada cuyo ID token es anterior o igual.
   * 2. Descarta las solicitudes y los códigos en vuelo de esa identidad, revocando su
   *    concesión upstream como `prune`.
   * 3. Corta en local las familias (persistido antes de resolver); el observador de
   *    `TokenStore` pide después la revocación upstream. Lanza si la baja no se pudo guardar.
   */
  async revokeByLogout(selector: LogoutSelector, iat: number, until: number): Promise<number> {
    this.closedLogouts.push({ selector, iat, until });
    while (this.closedLogouts.length > MAX_CLOSED_LOGOUTS) this.closedLogouts.shift();
    for (const [key, pending] of this.pending) {
      const login = pending.sumego;
      if (login?.identity && logoutMatches(selector, login.identity) && (login.idTokenIat === null || login.idTokenIat <= iat)) {
        this.pending.delete(key);
      }
    }
    for (const [hash, code] of this.codes) {
      if (code.sumego && logoutMatches(selector, code.sumego.identity) && code.sumego.idTokenIat <= iat) this.discardCode(hash, code);
    }
    const dropped = await this.tokens.dropFamiliesByLogout(selector);
    for (const id of dropped) this.forgetIntrospection(id);
    return dropped.length;
  }

  /**
   * Primera fase OAuth de la retirada de una persona. Invalida memoria y familias locales
   * antes de drenar su contexto; el observador de `TokenStore` revoca después los bearers.
   */
  async invalidateAccount(account: AccountRecord): Promise<number> {
    for (const [key, pending] of this.pending) {
      if (pending.binding && sameBinding(pending.binding, account.binding)) this.discardPending(key, pending);
    }
    for (const [hash, code] of this.codes) {
      const sameIdentity = code.identity?.sub === account.sub ||
        (account.storage === 'legacy-root' && code.identity === null);
      if (sameIdentity && code.grant.accountId === account.accountId && sameBinding(code.grant, account.binding)) {
        this.discardCode(hash, code);
      }
    }
    this.closedLogouts = this.closedLogouts.filter((entry) =>
      entry.selector.sub !== account.sub);
    const dropped = await this.tokens.dropFamiliesForAccount({ ...account.binding, sub: account.sub,
      accountId: account.accountId, includeLegacyWithoutSub: account.storage === 'legacy-root' });
    for (const id of dropped) this.forgetIntrospection(id);
    return dropped.length;
  }

  /** El broker demuestra que el `sub` vigente es dueño del vínculo recién emparejado. */
  async verifyRemoteOwnership(input: { sub: string; binding: Binding; oauthRequestId: string }): Promise<{
    sub: string; grant: ActiveGrant;
  }> {
    const pending = this.pending.get(input.oauthRequestId);
    const login = pending?.sumego;
    if (!pending || !login?.identity || login.identity.sub !== input.sub || !login.idToken ||
      login.consentDeadline === null || login.consentDeadline <= this.now() || pending.pairingGrant) {
      throw new Error('remote_pairing_identity_invalid');
    }
    await this.requestSumegoFor(pending, input.binding);
    const grant = await this.backchannel.sumegoExchange({ requestId: pending.requestId!,
      transactionId: pending.transactionId, idToken: login.idToken, clientId: pending.clientId });
    if (!sameBinding(grant, input.binding)) {
      await this.backchannel.revoke(grant.accessToken).catch(() => undefined);
      throw new Error('remote_pairing_binding_mismatch');
    }
    const stage = sha256(`remote-pairing:${pending.transactionId}`);
    try { await this.grants.stage(stage, grant.accessToken); }
    catch {
      await this.backchannel.revoke(grant.accessToken).catch(() => undefined);
      throw new BackchannelError('unavailable');
    }
    pending.pairingGrant = grant;
    pending.pairingStageHash = stage;
    const { accessToken: _bearer, ...metadata } = grant;
    return { sub: input.sub, grant: { ...metadata, active: true } };
  }

  /** Publicada la cuenta, convierte el grant de propiedad en el código OAuth original. */
  async resumeRemoteAuthorization(input: { oauthRequestId: string; account: { id: string; generation: number } }): Promise<string> {
    const pending = this.pending.get(input.oauthRequestId);
    const login = pending?.sumego;
    const record = this.accounts.findById(input.account.id);
    if (!pending || !login?.identity || !login.refreshToken || login.idTokenIat === null ||
      login.refreshedAt === null || !pending.pairingGrant || !pending.pairingStageHash ||
      !record || record.state !== 'active' || record.generation !== input.account.generation ||
      record.sub !== login.identity.sub || !pending.binding || !sameBinding(record.binding, pending.binding)) {
      throw new Error('remote_pairing_resume_invalid');
    }
    const authorization: SumegoAuthorization = { identity: login.identity, idTokenIat: login.idTokenIat,
      refreshToken: login.refreshToken, refreshedAt: login.refreshedAt };
    if (this.loggedOut(authorization.identity, authorization.idTokenIat)) throw new Error('logged_out');
    const stage = pending.pairingStageHash;
    const target = await this.issueCode(pending.transactionId, pending, pending.pairingGrant, authorization);
    await this.grants.unstage(stage).catch(() => logEvent({ event: 'oauth.grant.cleanup', result: 'failed' }));
    login.idToken = null;
    login.refreshToken = null;
    return target;
  }

  /**
   * Renovación horaria con Sumego dentro de un refresh de `/token` (SPEC.md §12.9), ya en la
   * cola de la familia. Sin refresh de Sumego (login de Lumbre o v2), nada. Si la última
   * renovación es de hace menos de `SUMEGO_RENEW_INTERVAL_MS`, nada salvo devolver una
   * rotación aún sin guardar. Si toca, canjea el refresh en el `token_endpoint`:
   * - un 4xx que no es 429 (cuenta suspendida, grant revocado, refresh ya usado) corta la
   *   familia como un `active:false` (`InvalidGrantError`);
   * - red, 5xx, 429 o fuera de contrato no tocan nada (`ServerError`, el cliente reintenta);
   * - si vale, el refresh nuevo (Sumego rota siempre) queda en memoria y se devuelve para la
   *   escritura atómica que rota el refresh de Hebra.
   */
  private async renewSumego(familyId: string): Promise<SumegoRefreshState | undefined> {
    const stored = this.tokens.sumegoRefreshOf(familyId);
    if (!stored) return undefined;
    const rotated = this.sumegoRotations.get(familyId);
    const current = rotated ?? stored;
    const now = this.now();
    if (now >= current.renewedAt && now - current.renewedAt < SUMEGO_RENEW_INTERVAL_MS) return rotated;
    const refreshToken = this.sealer?.open(current.sealedRefresh) ?? null;
    if (!this.sumego || refreshToken === null) {
      // Sin cliente o sin poder descifrarlo no hay segunda barrera: cerrado ante la duda.
      logEvent({ event: 'oauth.sumego.refresh', result: 'unusable' });
      await this.dropFamily(familyId);
      throw new InvalidGrantError('La sesión de Sumego no se puede renovar: hay que volver a conectar.');
    }
    let next: string;
    try { next = await this.sumego.refresh(refreshToken); }
    catch (error) {
      if (error instanceof SumegoError && error.kind === 'invalid') {
        logEvent({ event: 'oauth.sumego.refresh', result: 'denied' });
        await this.dropFamily(familyId);
        throw new InvalidGrantError('La sesión de Sumego se cerró: hay que volver a conectar.');
      }
      logEvent({ event: 'oauth.sumego.refresh', result: 'unavailable' });
      throw new ServerError('temporarily_unavailable');
    }
    const update = { sealedRefresh: this.sealer!.seal(next), renewedAt: this.now() };
    this.sumegoRotations.set(familyId, update);
    logEvent({ event: 'oauth.sumego.refresh', result: 'renewed' });
    return update;
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
    if (pending.claimed) { res.status(409).json({ error: 'authorization_unavailable' }); return; }
    pending.claimed = true;
    let grant: Grant | null = null;
    try {
      grant = await this.backchannel.exchange(requestId, pending.transactionId);
      const target = await this.issueCode(key, pending, grant, null);
      logEvent({ event: 'oauth.consent', result: 'approved' });
      res.redirect(302, target);
    } catch (error) {
      this.pending.delete(key);
      if (pending.binding) this.pairingRevokedBy(error, pending.binding);
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
  private async active(familyId: string, grant: ActiveGrant, identity: FamilyIdentity | null,
    useCache: boolean): Promise<AuthorizedAccount | null> {
    let account = this.accounts.authorize(grant, identity?.sub ?? null);
    let legacyCandidate = false;
    if (!account) {
      const current = await this.currentBinding();
      if (!this.multiuser && current !== null && sameBinding(current, grant)) {
        account = await this.legacySingleUser(grant);
      }
      // Una familia v2 del legado no conoce `sub`: se conserva hasta que la migración
      // explícita publique al dueño. Nunca se usa para reclamar la raíz ni otra cuenta.
      if (!account && identity === null && current !== null && sameBinding(current, grant)) {
        throw new BackchannelError('unavailable');
      }
      legacyCandidate = !account && identity !== null && current !== null && sameBinding(current, grant);
      if (!account && !legacyCandidate) { await this.dropFamily(familyId); return null; }
    }
    const bearer = this.grants.get(familyId);
    if (!bearer) { this.forgetIntrospection(familyId); return null; }
    if (account && useCache && this.cachedIntrospection(familyId, grantFingerprint(grant))) return account;
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
    if (!inspected) { await this.dropFamily(familyId); return null; }
    // Otra petición pudo invalidar la familia mientras Lumbre respondía.
    if (attempt.invalidated || epoch !== this.introspectionEpoch) return null;
    const sameGrant = inspected.credentialId === grant.credentialId && inspected.clientId === grant.clientId &&
      inspected.accountId === grant.accountId && sameBinding(inspected, grant);
    if (!sameGrant || inspected.expiresAt !== grant.expiresAt) {
      // Solo la fecha, con una renovación a medio guardar: transitorio, no se corta la familia.
      if (sameGrant && this.renewing.has(familyId)) throw new BackchannelError('unavailable');
      await this.dropFamily(familyId); return null;
    }
    if (legacyCandidate) {
      try { account = await this.accounts.claimLegacy({ sub: identity!.sub, grant: inspected }); }
      catch { await this.dropFamily(familyId); return null; }
    } else if (!account) {
      await this.dropFamily(familyId); return null;
    }
    try { await this.assertAccountActive(account); } catch { await this.dropFamily(familyId); return null; }
    this.rememberIntrospection(familyId, grant, checkedAt, monotonicCheckedAt, epoch);
    return account;
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
    let inspected: ActiveGrant | null;
    try { inspected = await this.backchannel.introspect(grant.accessToken); }
    catch { throw new ServerError('Consentimiento temporalmente no disponible.'); }
    if (!inspected || inspected.credentialId !== grant.credentialId || !sameBinding(inspected, grant)) { await cleanup(); return fail(); }
    let account = this.accounts.authorize(inspected, entry.identity?.sub ?? null);
    if (!account && entry.identity !== null) {
      const current = await this.currentBinding();
      if (current && sameBinding(current, inspected)) {
        try { account = await this.accounts.claimLegacy({ sub: entry.identity.sub, grant: inspected }); }
        catch { /* La raíz pertenece a otra identidad o mantiene una lápida. */ }
      }
    }
    account ??= await this.legacySingleUser(inspected);
    if (!account) { await cleanup(); return fail(); }
    try { await this.assertAccountActive(account); } catch { await cleanup(); return fail(); }
    // Back-channel logout de esa sesión o persona mientras el código esperaba su canje.
    const sumego = entry.sumego;
    const loggedOut = () => sumego !== null && this.loggedOut(sumego.identity, sumego.idTokenIat);
    if (loggedOut()) { await cleanup(); return fail(); }
    if (sumego && !this.sealer) { await cleanup(); return fail(); }
    try {
      const { accessToken: _unused, ...metadata } = grant;
      const issued = await this.tokens.issueFamily({ clientId: entry.clientId, scope: OAUTH_SCOPE, resource: entry.resource,
        grant: { ...metadata, active: true }, authorizedAt: entry.issuedAt, identity: entry.identity,
        sumego: sumego ? { sealedRefresh: this.sealer!.seal(sumego.refreshToken), renewedAt: sumego.refreshedAt } : null,
        loggedOut, authorize: () => this.assertAccountActive(account!) }, await this.revokedBefore(),
      async (familyId, ids) => { await this.grants.markPromoting(hash, familyId); await this.grants.set(familyId, grant.accessToken, ids); });
      await this.assertAccountActive(account);
      await this.grants.unstage(hash).catch(() => logEvent({ event: 'oauth.grant.cleanup', result: 'failed' }));
      logEvent({ event: 'oauth.token', grant: 'authorization_code', result: 'issued' });
      return this.tokensResponse(issued);
    } catch (error) {
      await cleanup();
      if (error instanceof Error && error.message === 'logged_out') return fail();
      if (error instanceof FamilyRateLimitedError) throw new TooManyRequestsError(FAMILY_RATE_MESSAGE);
      throw new ServerError('No se pudo guardar la autorización.');
    }
  }

  /**
   * Ritmo de familias por persona (D22, SPEC.md §12.10), delante del `/token` del SDK, cuyo handler
   * responde 400 a todo error de un proveedor y no deja poner cabeceras. Con 429 y `Retry-After`,
   * sin quemar el código: a los 60 s caduca solo y `prune` revoca su concesión.
   *
   * Solo responde quien presenta un código vigente, que no se adivina: esto no dice nada de
   * si una cuenta existe, y el `sub` sale de un login ya validado, así que nadie gasta el ritmo
   * de otro. Los canjes admitidos y sin terminar cuentan, para que una ráfaga no pase de golpe
   * esta comprobación y acabe en el error de `issueFamily`.
   */
  guardFamilyRate(req: Request, res: Response, next: () => void): void {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const entry = req.method === 'POST' && body.grant_type === 'authorization_code' && typeof body.code === 'string'
      ? this.codes.get(sha256(body.code)) : undefined;
    if (!entry || entry.expiresAt <= this.now()) { next(); return; }
    const key = familyRateKey(entry.identity, entry.grant.accountId);
    const inFlight = this.familyExchanges.get(key) ?? 0;
    const retryAfter = this.tokens.familyRetryAfter(key, inFlight);
    if (retryAfter !== null) {
      logEvent({ event: 'oauth.rate_limited', scope: 'family' });
      sendTooManyRequests(res, retryAfter, FAMILY_RATE_MESSAGE);
      return;
    }
    this.familyExchanges.set(key, inFlight + 1);
    res.once('close', () => {
      const left = (this.familyExchanges.get(key) ?? 1) - 1;
      if (left > 0) this.familyExchanges.set(key, left); else this.familyExchanges.delete(key);
    });
    next();
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
   * Con login de Sumego, además, la renovación horaria del refresh de Sumego (`renewSumego`).
   *
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
      let account: AuthorizedAccount;
      try {
        const active = await this.active(familyId, candidate.grant, candidate.identity, false);
        if (!active) throw new InvalidGrantError('Refresh token no válido.');
        account = active;
      }
      catch (error) { if (error instanceof InvalidGrantError) throw error; throw new ServerError('Consentimiento temporalmente no disponible.'); }
      const bearer = this.grants.get(familyId);
      if (!bearer) { this.forgetIntrospection(familyId); throw new InvalidGrantError('Refresh token no válido.'); }
      // Orden (SPEC.md §12.9): introspección fresca en Lumbre (arriba), renovación horaria con
      // Sumego y, solo si la sesión de Sumego sigue viva, `/renew`, para que una sesión cerrada
      // no alargue 30 días la concesión. El refresh rotado de Sumego se guarda en la misma
      // escritura que rota el de Hebra; si algo falla antes, queda en memoria para el reintento.
      const sumegoUpdate = await this.renewSumego(familyId);
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
        const outcome = await this.tokens.rotateRefresh(refreshToken, client.client_id, revokedBefore, renewed,
          sumegoUpdate, () => this.assertAccountActive(account));
        // Guardada (o la familia ya no existe): la rotación en memoria ya no hace falta.
        if (sumegoUpdate) this.sumegoRotations.delete(familyId);
        // La caché y las introspecciones en vuelo eran de la fecha anterior.
        this.forgetIntrospection(familyId);
        // Un replay o una familia caducada la quitan del almacén; una rotación reciente solo fuerza otra consulta.
        if (!outcome.ok) throw new InvalidGrantError('Refresh token no válido.');
        await this.assertAccountActive(account);
        logEvent({ event: 'oauth.renew', result: 'renewed' });
        return this.tokensResponse(outcome.tokens);
      } finally { this.renewing.delete(familyId); }
    });
  }

  async verifyAccessToken(token: string): Promise<AccountAuthInfo> {
    const verified = this.tokens.verifyAccess(token, await this.revokedBefore());
    if (!verified) throw new InvalidTokenError('Token no válido.');
    let account: AuthorizedAccount;
    try {
      const active = await this.active(verified.familyId, verified.grant, verified.identity, true);
      if (!active) throw new InvalidTokenError('Token no válido.');
      account = active;
    }
    catch (error) {
      if (error instanceof InvalidTokenError || error instanceof BackchannelError) throw error;
      throw new BackchannelError('unavailable');
    }
    return { token, clientId: verified.clientId, scopes: verified.scope.split(' '), expiresAt: verified.expiresAt,
      resource: new URL(verified.resource), account };
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
