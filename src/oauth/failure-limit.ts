/**
 * Cupos por dirección de `/authorize`, `/token`, `/revoke` y `/register` (D22, SPEC.md §12.10):
 * solo cuentan los fallos. Varias personas salen de la misma IP (la de un cliente web, un NAT),
 * así que un refresh o un login correcto no puede gastar cupo de nadie.
 *
 * Sustituye a los limitadores del SDK (`rateLimit: false`), con sus mismos números. Con
 * `skipSuccessfulRequests`, `express-rate-limit` suma al ENTRAR y resta al terminar bien: 51
 * refresh correctos en vuelo desde una IP dan 429 sin que nadie haya fallado. Aquí se cuenta
 * al terminar, y solo lo que el cliente ha hecho mal:
 *
 * - Fallo = 4xx. Un 5xx es de este servidor o de Lumbre: durante una caída los clientes reintentan,
 *   y contarlo dejaría a toda una IP fuera 15 minutos más después de volver el servicio.
 * - Un 429 tampoco cuenta: ni el propio, ni el ritmo por `sub` (`guardFamilyRate` en `./provider.ts`).
 * - Sin nada que guardar por una dirección que no falla; con la tabla llena, una dirección nueva
 *   expulsa la más antigua, como el cupo del back-channel logout (`./backchannel-logout.ts`).
 *
 * Una vez agotado, la dirección recibe 429 con `Retry-After`, salvo la petición que presenta una
 * credencial correcta (`isCorrect`): un refresh vigente o un código vigente. Esas no se adivinan
 * (256 y 192 bits, el código se quema al primer uso), así que dejarlas pasar no ayuda a la fuerza
 * bruta, y un cliente roto en un NAT de oficina no deja fuera a los demás. La comprobación va
 * después de agotar el cupo y no antes, y solo mira memoria: cuesta lo mismo que `verifyAccess`.
 * En `/authorize`, `/revoke` y `/register` no hay credencial que comprobar y el freno es total.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { TooManyRequestsError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { logEvent } from '../log/logger';
import { rateKey } from './backchannel-logout';

interface FailurePolicy {
  limit: number;
  windowMs: number;
}

/** Los números por defecto del SDK (`handlers/*.js`, versión 1.30). */
export const FAILURE_POLICIES: Readonly<Record<'/authorize' | '/token' | '/revoke' | '/register', FailurePolicy>> = {
  '/authorize': { limit: 100, windowMs: 15 * 60_000 },
  '/token': { limit: 50, windowMs: 15 * 60_000 },
  '/revoke': { limit: 50, windowMs: 15 * 60_000 },
  '/register': { limit: 20, windowMs: 60 * 60_000 }
};
/** Direcciones con fallos que se recuerdan a la vez, por punto. Solo acota memoria. */
export const MAX_TRACKED_FAILURES = 4096;

/**
 * Responde 429 con `Retry-After`, igual que `TooManyRequestsError` en el SDK. El
 * `Access-Control-Allow-Origin` es el de sus handlers, que aquí aún no han corrido: sin él, un
 * cliente web vería un fallo de CORS en vez del 429.
 */
export function sendTooManyRequests(res: Response, retryAfterSeconds: number, description: string): void {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(429).json(new TooManyRequestsError(description).toResponseObject());
}

export class FailureLimiter {
  private readonly windows = new Map<string, { start: number; failures: number }>();

  constructor(
    private readonly policy: FailurePolicy,
    private readonly now: () => number = Date.now,
    /** Con el cupo agotado, la petición que devuelve `true` pasa igual. Un error cuenta como `false`. */
    private readonly isCorrect?: (req: Request) => boolean | Promise<boolean>
  ) {}

  /** Ventana viva de la dirección; una vencida, o un reloj que retrocede, empieza de cero. */
  private live(key: string): { start: number; failures: number } | null {
    const window = this.windows.get(key);
    if (!window) return null;
    const now = this.now();
    if (now - window.start < this.policy.windowMs && now >= window.start) return window;
    this.windows.delete(key);
    return null;
  }

  private countFailure(key: string): void {
    const window = this.live(key);
    if (window) { window.failures += 1; return; }
    while (this.windows.size >= MAX_TRACKED_FAILURES) this.windows.delete(this.windows.keys().next().value!);
    this.windows.set(key, { start: this.now(), failures: 1 });
  }

  readonly handle = (req: Request, res: Response, next: NextFunction): void => {
    void this.admit(req, res, next);
  };

  private async admit(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Una comprobación previa de CORS no es un intento: la responde el handler del SDK.
    if (req.method === 'OPTIONS') { next(); return; }
    const key = rateKey(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    const window = this.live(key);
    if (window && window.failures >= this.policy.limit) {
      let correct = false;
      if (this.isCorrect) { try { correct = await this.isCorrect(req); } catch { correct = false; } }
      if (correct) { this.watch(key, res); next(); return; }
      logEvent({ event: 'oauth.rate_limited', scope: 'address' });
      const left = window.start + this.policy.windowMs - this.now();
      sendTooManyRequests(res, Math.max(1, Math.ceil(left / 1000)), 'Demasiados intentos fallidos desde esta dirección.');
      return;
    }
    this.watch(key, res);
    next();
  }

  /** Al terminar la respuesta, suma el intento si fue un fallo del cliente. */
  private watch(key: string, res: Response): void {
    res.once('finish', () => {
      if (res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429) this.countFailure(key);
    });
  }
}

/** Un cupo por punto, delante del router del SDK. */
export function installFailureLimits(
  app: Express,
  now?: () => number,
  /** Por punto, quién presenta una credencial correcta (solo `/token` la tiene). */
  correct: Partial<Record<keyof typeof FAILURE_POLICIES, (req: Request) => boolean | Promise<boolean>>> = {}
): void {
  for (const [path, policy] of Object.entries(FAILURE_POLICIES) as Array<[keyof typeof FAILURE_POLICIES, FailurePolicy]>) {
    const isCorrect = correct[path];
    // La comprobación lee el cuerpo del formulario, que el SDK analizaría después igual.
    if (isCorrect) app.use(path, express.urlencoded({ extended: false }));
    app.use(path, new FailureLimiter(policy, now, isCorrect).handle);
  }
}
