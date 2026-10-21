/**
 * `POST /oauth/sumego/backchannel-logout` (OIDC Back-Channel Logout 1.0; SPEC.md §12.9): de
 * servidor a servidor, formulario con `logout_token`, sin CORS ni cookies.
 *
 * Sumego hace UN solo intento por cliente: un 429, un 503 o un fallo de red no se repiten.
 * Por eso un `logout_token` con firma válida nunca consume cupo ni recibe 429, y las
 * verificaciones esperan en una cola corta en vez de dar 503 en el acto. La red de seguridad
 * si aun así se pierde es la renovación horaria con Sumego en `/token` (`provider.ts`).
 *
 * - El `logout_token` lo valida `SumegoOidc.verifyLogoutToken` (ES256 con `kid` del JWKS, `iss`,
 *   `aud`, `iat`, `exp`, `events`, sin `nonce`, y `sid` o `sub`; el de un cierre por `sub` no
 *   trae `sid`).
 * - Cupo: 60 FALLOS por minuto y dirección (las IPv6 por /64). Con el cupo agotado, solo pasa a
 *   verificar un token que por su forma (sin verificar aún) podría ser de Sumego: `alg` ES256
 *   con `kid`, `iss` y `aud` correctos y el evento de logout. Una dirección nueva con la tabla
 *   llena expulsa la más antigua.
 * - Como mucho 8 verificaciones de firma a la vez; las siguientes esperan en una cola de 32
 *   durante 5 s como mucho, y solo entonces 503.
 * - `jti` de un solo uso (`LogoutJtiStore`), apuntado DESPUÉS de cortar en local: si el corte
 *   falla, 500. Dos entregas a la vez del mismo `jti`: la segunda es un 400, como una repetida.
 * - Con `sid`, las familias de esa sesión (y de ese `sub`, si viene); con solo `sub`, todas
 *   las suyas, y también las solicitudes y códigos en vuelo (`revokeByLogout`).
 * - 200 sin cuerpo, o 400 si el token no vale. Con Sumego o su JWKS caídos, 503.
 *
 * Nunca se registra ni se devuelve el `logout_token`, su `jti`, su `sid` ni su `sub`.
 */
import { createHash } from 'node:crypto';
import { isIPv6 } from 'node:net';
import type { Request, Response } from 'express';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { logEvent } from '../log/logger';
import type { LogoutJtiStore } from './logout-jtis';
import { BACKCHANNEL_LOGOUT_EVENT, MAX_JWT_LENGTH, SumegoError, type LogoutClaims, type SumegoOidc } from './sumego';
import type { LogoutSelector } from './token-store';

export const LOGOUT_RATE_LIMIT = 60;
export const LOGOUT_RATE_WINDOW_MS = 60_000;
export const MAX_CONCURRENT_LOGOUT_VERIFICATIONS = 8;
export const MAX_QUEUED_LOGOUT_VERIFICATIONS = 32;
export const LOGOUT_QUEUE_WAIT_MS = 5_000;
/** Direcciones distintas que se recuerdan a la vez para el cupo. */
export const MAX_TRACKED_ADDRESSES = 1024;

export interface BackchannelLogoutOptions {
  oidc: SumegoOidc;
  jtis: LogoutJtiStore;
  /** Cierra la identidad, corta en local (persistido) y pide la revocación upstream; lanza si no pudo cortar. */
  revoke(selector: LogoutSelector, iat: number, until: number): Promise<number>;
  now?: () => number;
}

/** Clave del cupo: la IPv4 tal cual; una IPv6, su /64. */
export function rateKey(ip: string): string {
  const address = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (!isIPv6(address)) return address;
  const [head = '', tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export class BackchannelLogout {
  private readonly windows = new Map<string, { start: number; failures: number }>();
  private verifying = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: BackchannelLogoutOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Ventana de un minuto de la dirección; uno que retrocede el reloj abre ventana nueva. */
  private window(key: string): { start: number; failures: number } {
    const now = this.now();
    let window = this.windows.get(key);
    if (window && (now - window.start >= LOGOUT_RATE_WINDOW_MS || now < window.start)) { this.windows.delete(key); window = undefined; }
    if (!window) {
      // Tabla llena: fuera la entrada más antigua (el orden de inserción del Map).
      while (this.windows.size >= MAX_TRACKED_ADDRESSES) this.windows.delete(this.windows.keys().next().value!);
      window = { start: now, failures: 0 };
      this.windows.set(key, window);
    }
    return window;
  }

  /** ¿Podría ser de Sumego, sin verificar la firma? Solo decide si pasa con el cupo agotado. */
  private plausible(token: string): boolean {
    try {
      const header = decodeProtectedHeader(token);
      const claims = decodeJwt(token);
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const events = claims.events;
      return header.alg === 'ES256' && typeof header.kid === 'string' && claims.iss === this.options.oidc.issuer &&
        audiences.includes(this.options.oidc.clientId) && !!events && typeof events === 'object' &&
        Object.hasOwn(events, BACKCHANNEL_LOGOUT_EVENT);
    } catch { return false; }
  }

  /** Turno de verificación: 8 a la vez y una cola corta; `false` si no hubo turno a tiempo. */
  private async acquire(): Promise<boolean> {
    if (this.verifying < MAX_CONCURRENT_LOGOUT_VERIFICATIONS) { this.verifying += 1; return true; }
    if (this.waiting.length >= MAX_QUEUED_LOGOUT_VERIFICATIONS) return false;
    return new Promise<boolean>((resolve) => {
      const wake = () => { clearTimeout(timer); this.verifying += 1; resolve(true); };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(wake);
        if (index >= 0) this.waiting.splice(index, 1);
        resolve(false);
      }, LOGOUT_QUEUE_WAIT_MS);
      this.waiting.push(wake);
    });
  }

  private release(): void {
    this.verifying -= 1;
    this.waiting.shift()?.();
  }

  async handle(req: Request, res: Response): Promise<void> {
    const window = this.window(rateKey(req.ip ?? req.socket.remoteAddress ?? 'unknown'));
    const fail = (result: string) => {
      window.failures += 1;
      logEvent({ event: 'oauth.logout', result });
      res.status(400).end();
    };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = body.logout_token;
    const overQuota = window.failures >= LOGOUT_RATE_LIMIT;
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_JWT_LENGTH) {
      if (overQuota) { logEvent({ event: 'oauth.logout', result: 'rate_limited' }); res.status(429).end(); return; }
      fail('invalid'); return;
    }
    if (overQuota && !this.plausible(token)) {
      logEvent({ event: 'oauth.logout', result: 'rate_limited' });
      res.status(429).end(); return;
    }
    if (!await this.acquire()) {
      logEvent({ event: 'oauth.logout', result: 'busy' });
      res.status(503).end(); return;
    }
    let claims: LogoutClaims;
    try { claims = await this.options.oidc.verifyLogoutToken(token); }
    catch (error) {
      const unavailable = !(error instanceof SumegoError) || error.kind === 'unavailable';
      if (unavailable) { logEvent({ event: 'oauth.logout', result: 'unavailable' }); res.status(503).end(); return; }
      fail('invalid'); return;
    } finally { this.release(); }

    const jtiKey = createHash('sha256').update(claims.jti).digest('hex');
    if (this.inFlight.has(jtiKey) || this.options.jtis.has(claims.jti)) { fail('replayed'); return; }
    this.inFlight.add(jtiKey);
    try {
      const selector: LogoutSelector = claims.sid !== null
        ? (claims.sub !== null ? { sid: claims.sid, sub: claims.sub } : { sid: claims.sid })
        : { sub: claims.sub! };
      let families: number;
      try { families = await this.options.revoke(selector, claims.iat, claims.rememberUntil); }
      catch {
        // Sin corte local no se apunta el `jti`: un reintento valdría.
        logEvent({ event: 'oauth.logout', result: 'failed' });
        res.status(500).end(); return;
      }
      try { await this.options.jtis.remember(claims.jti, claims.rememberUntil); }
      catch {
        // Cortado en local pero sin apuntar el `jti`: 500 (repetido, el token podría cortar
        // una sesión abierta después).
        logEvent({ event: 'oauth.logout_jtis', result: 'write_failed' });
        res.status(500).end(); return;
      }
      logEvent({ event: 'oauth.logout', result: 'revoked', by: claims.sid !== null ? 'sid' : 'sub', families });
      res.status(200).end();
    } finally { this.inFlight.delete(jtiKey); }
  }
}
