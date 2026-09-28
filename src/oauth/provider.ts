/** OAuth público de Hebra: el SDK conserva clientes, PKCE y tokens; Lumbre aprueba al propietario. */
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
import { BackchannelError, LumbreBackchannel, type ActiveGrant, type Binding, type Grant, sameBinding } from './backchannel';
import { CLAUDE_CALLBACK, ClaudeClientsStore } from './clients';
import { GrantSecrets } from './grants';
import { RevocationFile } from './owner';
import { TokenStore, type IssuedTokens } from './token-store';

export const OAUTH_SCOPE = 'hebra:mcp';
const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const MAX_PENDING = 64;
const MAX_PENDING_PER_IP = 4;
const MAX_PENDING_PER_CLIENT = 16;
const MAX_CODES = 64;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface PendingAuthorization extends Binding {
  requestId: string | null;
  transactionId: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state?: string;
  ip: string;
  createdAt: number;
  expiresAt: number;
  claimed: boolean;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  grant: Grant;
  issuedAt: number;
  expiresAt: number;
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function s256(value: string): string { return createHash('sha256').update(value, 'ascii').digest('base64url'); }
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
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
    if (params.redirectUri !== CLAUDE_CALLBACK) throw new InvalidRequestError('redirect_uri no admitido.');
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
    const current = [...this.pending.values()];
    if (current.length >= MAX_PENDING || current.filter((entry) => entry.ip === ip).length >= MAX_PENDING_PER_IP ||
      current.filter((entry) => entry.clientId === client.client_id).length >= MAX_PENDING_PER_CLIENT) {
      res.status(429).json({ error: 'rate_limited' }); return;
    }
    const pending: PendingAuthorization = {
      ...binding, requestId: null, transactionId, clientId: client.client_id,
      redirectUri: params.redirectUri, challenge: params.codeChallenge, state: params.state,
      ip, createdAt: this.now(), expiresAt: this.now() + PENDING_TTL_MS, claimed: false
    };
    // El insert ocurre antes de la primera llamada remota.
    this.pending.set(transactionId, pending);
    try {
      const requested = await this.backchannel.request({ ...binding, transactionId, clientId: client.client_id, clientName: (client.client_name || 'Claude').slice(0, 120) });
      if (this.pending.get(transactionId) !== pending || !sameBinding(binding, (await this.currentBinding()) ?? { pairedCredentialId: '', syncVaultId: '', opaqueDeviceId: '' })) {
        this.pending.delete(transactionId); res.status(400).json({ error: 'invalid_request' }); return;
      }
      pending.requestId = requested.requestId;
      pending.expiresAt = Math.min(pending.expiresAt, Date.parse(requested.expiresAt));
      if (pending.expiresAt <= this.now()) { this.pending.delete(transactionId); res.status(400).json({ error: 'invalid_request' }); return; }
      logEvent({ event: 'oauth.authorize', result: 'lumbre' });
      res.redirect(302, requested.authorizationUrl);
    } catch {
      this.pending.delete(transactionId);
      logEvent({ event: 'oauth.authorize', result: 'unavailable' });
      res.status(503).json({ error: 'temporarily_unavailable' });
    }
  }

  /** `denied` público no consume una solicitud legítima; `approved` solo abre el canje autenticado. */
  async handleLumbreCallback(req: Request, res: Response): Promise<void> {
    this.prune();
    const keys = Object.keys(req.query);
    const requestId = req.query.request;
    const decision = req.query.decision;
    if (keys.length !== 2 || typeof requestId !== 'string' || !UUID.test(requestId) ||
      (decision !== 'approved' && decision !== 'denied')) { res.status(400).json({ error: 'invalid_request' }); return; }
    const entry = [...this.pending].find(([, value]) => value.requestId === requestId);
    if (!entry || entry[1].expiresAt <= this.now()) { res.status(400).json({ error: 'invalid_grant' }); return; }
    const [key, pending] = entry;
    if (pending.createdAt <= await this.revocations.current()) {
      this.pending.delete(key); res.status(400).json({ error: 'invalid_grant' }); return;
    }
    if (decision === 'denied') { res.status(400).json({ error: 'authorization_unavailable' }); return; }
    if (pending.claimed || this.codes.size >= MAX_CODES) { res.status(409).json({ error: 'authorization_unavailable' }); return; }
    pending.claimed = true;
    let grant: Grant | null = null;
    try {
      grant = await this.backchannel.exchange(requestId, pending.transactionId);
      const current = await this.currentBinding();
      if (pending.createdAt <= await this.revocations.current() || !current ||
        !sameBinding(grant, pending) || !sameBinding(grant, current) ||
        grant.clientId !== pending.clientId || grant.resource !== this.resource || Date.parse(grant.expiresAt) <= this.now()) {
        throw new Error('binding');
      }
      const code = randomBytes(32).toString('base64url');
      const hash = sha256(code);
      await this.grants.stage(hash, grant.accessToken);
      this.pending.delete(key);
      this.codes.set(hash, { clientId: pending.clientId, redirectUri: pending.redirectUri, challenge: pending.challenge,
        resource: this.resource, grant, issuedAt: this.now(), expiresAt: this.now() + CODE_TTL_MS });
      const target = new URL(pending.redirectUri);
      target.searchParams.set('code', code);
      if (pending.state !== undefined) target.searchParams.set('state', pending.state);
      target.searchParams.set('iss', this.issuer);
      logEvent({ event: 'oauth.consent', result: 'approved' });
      res.redirect(302, target.href);
    } catch {
      this.pending.delete(key);
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

  private async active(familyId: string, grant: ActiveGrant): Promise<boolean> {
    const current = await this.currentBinding();
    if (!current || !sameBinding(current, grant)) { await this.tokens.dropFamily(familyId); await this.grants.delete(familyId); return false; }
    const bearer = this.grants.get(familyId);
    if (!bearer) return false;
    const inspected = await this.backchannel.introspect(bearer);
    if (!inspected) { await this.tokens.dropFamily(familyId); await this.grants.delete(familyId); return false; }
    if (inspected.credentialId !== grant.credentialId || inspected.clientId !== grant.clientId ||
      inspected.accountId !== grant.accountId || inspected.expiresAt !== grant.expiresAt || !sameBinding(inspected, grant)) {
      await this.tokens.dropFamily(familyId); await this.grants.delete(familyId); return false;
    }
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
    if (entry.clientId !== client.client_id || (redirectUri !== undefined && redirectUri !== entry.redirectUri) ||
      verifier === undefined || !VERIFIER.test(verifier) || !equal(s256(verifier), entry.challenge) || !this.sameResource(resource)) {
      await cleanup(); return fail();
    }
    const revokedBefore = await this.revocations.current();
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
        grant: { ...metadata, active: true }, authorizedAt: entry.issuedAt }, await this.revocations.current(),
      async (familyId, ids) => { await this.grants.markPromoting(hash, familyId); await this.grants.set(familyId, grant.accessToken, ids); });
      await this.grants.unstage(hash).catch(() => logEvent({ event: 'oauth.grant.cleanup', result: 'failed' }));
      logEvent({ event: 'oauth.token', grant: 'authorization_code', result: 'issued' });
      return this.tokensResponse(issued);
    } catch { await cleanup(); throw new ServerError('No se pudo guardar la autorización.'); }
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.checkScopes(scopes);
    if (!this.sameResource(resource)) throw new InvalidTargetError(`El resource debe ser ${this.resource}.`);
    const revokedBefore = await this.revocations.current();
    const candidate = this.tokens.lookupRefresh(refreshToken, client.client_id, revokedBefore);
    if (!candidate) {
      const replay = await this.tokens.rotateRefresh(refreshToken, client.client_id, revokedBefore);
      if (replay.ok) throw new ServerError('Estado OAuth inconsistente.');
      throw new InvalidGrantError('Refresh token no válido.');
    }
    try { if (!await this.active(candidate.familyId, candidate.grant)) throw new InvalidGrantError('Refresh token no válido.'); }
    catch (error) { if (error instanceof InvalidGrantError) throw error; throw new ServerError('Consentimiento temporalmente no disponible.'); }
    const outcome = await this.tokens.rotateRefresh(refreshToken, client.client_id, revokedBefore);
    if (!outcome.ok) throw new InvalidGrantError('Refresh token no válido.');
    return this.tokensResponse(outcome.tokens);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const verified = this.tokens.verifyAccess(token, await this.revocations.current());
    if (!verified) throw new InvalidTokenError('Token no válido.');
    try { if (!await this.active(verified.familyId, verified.grant)) throw new InvalidTokenError('Token no válido.'); }
    catch (error) {
      if (error instanceof InvalidTokenError || error instanceof BackchannelError) throw error;
      throw new BackchannelError('unavailable');
    }
    return { token, clientId: verified.clientId, scopes: verified.scope.split(' '), expiresAt: verified.expiresAt,
      resource: new URL(verified.resource) };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const before = await this.revocations.current();
    const family = this.tokens.lookupRefresh(request.token, client.client_id, before) ??
      this.tokens.verifyAccess(request.token, before);
    const result = await this.tokens.revoke(request.token, client.client_id);
    if (result === 'family' && family) {
      const bearer = this.grants.get(family.familyId);
      await this.grants.delete(family.familyId);
      if (bearer) await this.backchannel.revoke(bearer).catch(() => logEvent({ event: 'oauth.grant.revoke', result: 'unavailable' }));
    }
    logEvent({ event: 'oauth.revoke', result });
  }
}
