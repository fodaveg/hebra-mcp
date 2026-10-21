/**
 * `POST /oauth/sumego/backchannel-logout` (OIDC Back-Channel Logout 1.0; SPEC.md §12.9): de
 * servidor a servidor, formulario con `logout_token`, sin CORS ni cookies.
 *
 * - El `logout_token` lo valida `SumegoOidc.verifyLogoutToken` (ES256 con `kid` del JWKS, `iss`,
 *   `aud`, `iat`, `exp`, `events`, sin `nonce`, y `sid` o `sub`).
 * - `jti` de un solo uso (`LogoutJtiStore`). Se apunta DESPUÉS de cortar en local: si el corte
 *   falla, 500 y el reintento de Sumego vale. Dos entregas a la vez del mismo `jti`: la segunda
 *   es un 400, como una repetida.
 * - Con `sid`, las familias de esa sesión (y de ese `sub`, si viene); con solo `sub`, todas
 *   las suyas. Revocar es lo mismo que revocar una familia por OAuth: primero en local y
 *   después la revocación upstream en Lumbre.
 * - 200 sin cuerpo, o 400 si el token no vale. Cupo de 60 por minuto y dirección (429) y como
 *   mucho 8 verificaciones de firma a la vez (la siguiente, 503). Con Sumego o su JWKS caídos,
 *   503: no es un token malo y Sumego reintenta.
 *
 * Nunca se registra ni se devuelve el `logout_token`, su `jti`, su `sid` ni su `sub`.
 */
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { logEvent } from '../log/logger';
import type { LogoutJtiStore } from './logout-jtis';
import { MAX_JWT_LENGTH, SumegoError, type LogoutClaims, type SumegoOidc } from './sumego';
import type { LogoutSelector } from './token-store';

export const LOGOUT_RATE_LIMIT = 60;
export const LOGOUT_RATE_WINDOW_MS = 60_000;
export const MAX_CONCURRENT_LOGOUT_VERIFICATIONS = 8;
/** Direcciones distintas que se recuerdan a la vez para el cupo. */
const MAX_TRACKED_ADDRESSES = 1024;

export interface BackchannelLogoutOptions {
  oidc: SumegoOidc;
  jtis: LogoutJtiStore;
  /** Corta en local (persistido) y pide la revocación upstream; lanza si no pudo cortar. */
  revoke(selector: LogoutSelector): Promise<number>;
  now?: () => number;
}

export class BackchannelLogout {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private verifying = 0;
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: BackchannelLogoutOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Fija ventana de un minuto por dirección; un reloj que retrocede abre ventana nueva. */
  private allowed(ip: string): boolean {
    const now = this.now();
    let window = this.windows.get(ip);
    if (!window || now - window.start >= LOGOUT_RATE_WINDOW_MS || now < window.start) {
      if (!window && this.windows.size >= MAX_TRACKED_ADDRESSES) {
        for (const [key, value] of this.windows) {
          if (now - value.start >= LOGOUT_RATE_WINDOW_MS || now < value.start) this.windows.delete(key);
        }
        if (this.windows.size >= MAX_TRACKED_ADDRESSES) return false;
      }
      window = { start: now, count: 0 };
      this.windows.set(ip, window);
    }
    window.count += 1;
    return window.count <= LOGOUT_RATE_LIMIT;
  }

  async handle(req: Request, res: Response): Promise<void> {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (!this.allowed(ip)) {
      logEvent({ event: 'oauth.logout', result: 'rate_limited' });
      res.status(429).end(); return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = body.logout_token;
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_JWT_LENGTH) {
      logEvent({ event: 'oauth.logout', result: 'invalid' });
      res.status(400).end(); return;
    }
    if (this.verifying >= MAX_CONCURRENT_LOGOUT_VERIFICATIONS) {
      logEvent({ event: 'oauth.logout', result: 'busy' });
      res.status(503).end(); return;
    }
    this.verifying += 1;
    let claims: LogoutClaims;
    try { claims = await this.options.oidc.verifyLogoutToken(token); }
    catch (error) {
      const unavailable = !(error instanceof SumegoError) || error.kind === 'unavailable';
      logEvent({ event: 'oauth.logout', result: unavailable ? 'unavailable' : 'invalid' });
      res.status(unavailable ? 503 : 400).end(); return;
    } finally { this.verifying -= 1; }

    const jtiKey = createHash('sha256').update(claims.jti).digest('hex');
    if (this.inFlight.has(jtiKey) || this.options.jtis.has(claims.jti)) {
      logEvent({ event: 'oauth.logout', result: 'replayed' });
      res.status(400).end(); return;
    }
    this.inFlight.add(jtiKey);
    try {
      const selector: LogoutSelector = claims.sid !== null
        ? (claims.sub !== null ? { sid: claims.sid, sub: claims.sub } : { sid: claims.sid })
        : { sub: claims.sub! };
      let families: number;
      try { families = await this.options.revoke(selector); }
      catch {
        // Sin corte local no se apunta el `jti`: el reintento de Sumego vale.
        logEvent({ event: 'oauth.logout', result: 'failed' });
        res.status(500).end(); return;
      }
      try { await this.options.jtis.remember(claims.jti, claims.rememberUntil); }
      catch {
        // Cortado en local pero sin apuntar el `jti`: 500 para que Sumego reintente y quede
        // apuntado (repetido, el token podría cortar una sesión abierta después).
        logEvent({ event: 'oauth.logout_jtis', result: 'write_failed' });
        res.status(500).end(); return;
      }
      logEvent({ event: 'oauth.logout', result: 'revoked', by: claims.sid !== null ? 'sid' : 'sub', families });
      res.status(200).end();
    } finally { this.inFlight.delete(jtiKey); }
  }
}
