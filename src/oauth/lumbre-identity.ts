/**
 * Identidad del servidor ante Lumbre (lote P14 de Lumbre): las peticiones de una cuenta a
 * `/exchange`, al relé y al resto de la API de Lumbre llevan `X-Hebra-Mcp-Backchannel` (el
 * secreto compartido) y `X-Hebra-Mcp-Subject` (el `sub` de esa cuenta en minúsculas), para que
 * Lumbre reparta sus límites por persona y no por la IP única de `mcp.hebra.pro`.
 *
 * Este es el ÚNICO sitio que las pone. Garantías:
 * - Solo al origen exacto de Lumbre (`new URL(url).origin`, sin prefijos); a cualquier otro
 *   no viaja ninguna de las dos, y las que traiga el llamador se descartan.
 * - Las pone el envoltorio y manda sobre lo que ya traiga la petición.
 * - `redirect: 'error'`: ninguna redirección puede llevar el secreto a otro origen.
 * - Sin secreto, sin origen o sin `sub` conocido, no se envuelve nada (el fetcher base tal cual).
 * - Una `Request` como entrada no recibe la identidad (nadie la usa así): falla cerrado.
 * - Nunca se registra nada aquí; el secreto y el `sub` no entran en ningún mensaje de error.
 */
import { parsePublicOrigin } from '../http/config';
import { DEFAULT_LUMBRE_APP_ORIGIN } from './backchannel';

export type LumbreFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const BACKCHANNEL_HEADER = 'X-Hebra-Mcp-Backchannel';
export const SUBJECT_HEADER = 'X-Hebra-Mcp-Subject';

/** Secreto y origen de Lumbre ya validados; el `sub` se pasa al envolver cada cuenta. */
export interface LumbreIdentity {
  readonly secret: string;
  readonly origin: string;
}

/** Misma validación del secreto que `oauthHttpAuthConfigured`; `null` si no hay identidad. */
export function lumbreIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): LumbreIdentity | null {
  const secret = env.HEBRA_MCP_BACKCHANNEL_SECRET;
  if (secret === undefined || secret.length < 32 || secret.length > 512 || /[\r\n]/.test(secret)) return null;
  return { secret, origin: parsePublicOrigin(env.LUMBRE_APP_ORIGIN || DEFAULT_LUMBRE_APP_ORIGIN, 'LUMBRE_APP_ORIGIN').origin };
}

function originOf(input: unknown): string | null {
  try {
    if (typeof input === 'string' || input instanceof URL) return new URL(input).origin;
  } catch { /* URL ilegible: no es Lumbre */ }
  return null;
}

/** La forma exacta que Lumbre acepta en `X-Hebra-Mcp-Subject` (sin exigir versión del UUID). */
const LUMBRE_SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Envuelve `base` para la cuenta de `sub`. Sin identidad, devuelve `base` sin tocar.
 * El `sub` va en minúsculas, igual que `hebraAccountIdOf`, y solo si tiene la forma que valida
 * Lumbre en `X-Hebra-Mcp-Subject` (UUID en minúsculas; cualquier otra cosa da 400). Un `sub`
 * que no la tiene, como el `__legacy_unclaimed__` de un vínculo heredado sin reclamar, no manda
 * NINGUNA de las dos cabeceras: Lumbre trata esa petición como la de antes de la identidad.
 */
export function withLumbreIdentity(
  base: LumbreFetcher | undefined,
  identity: LumbreIdentity | null | undefined,
  sub: string | null | undefined
): LumbreFetcher {
  const inner: LumbreFetcher = base ?? globalThis.fetch.bind(globalThis);
  if (!identity) return inner;
  const lowered = typeof sub === 'string' ? sub.toLowerCase() : '';
  const subject = LUMBRE_SUBJECT.test(lowered) ? lowered : null;
  return (input, init) => {
    const headers = new Headers(init?.headers);
    // Lo que traiga el llamador nunca se reenvía: ni a Lumbre (manda el envoltorio) ni a otros.
    headers.delete(BACKCHANNEL_HEADER);
    headers.delete(SUBJECT_HEADER);
    if (!subject || originOf(input) !== identity.origin) return inner(input, { ...init, headers });
    headers.set(BACKCHANNEL_HEADER, identity.secret);
    headers.set(SUBJECT_HEADER, subject);
    return inner(input, { ...init, headers, redirect: 'error' });
  };
}
