/**
 * Quién identifica a la persona en `/authorize` (D20, SPEC.md §12.9), leído del entorno al
 * arrancar `serve-http`:
 *
 * - `HEBRA_MCP_LOGIN_PROVIDER`: `lumbre` (por defecto; el login y el consentimiento de
 *   Lumbre de §12.2) o `sumego` (cliente OIDC propio de hebra-mcp en Sumego).
 * - `HEBRA_MCP_OIDC_ISSUER` (por defecto `https://id.lumbre.pro`), `HEBRA_MCP_OIDC_CLIENT_ID`
 *   (por defecto `hebra-mcp`) y `HEBRA_MCP_OIDC_CLIENT_SECRET` (32–512 caracteres, sin
 *   CR/LF; vive en `deploy/.env`). Los nombres son los de lumbre-mcp.
 *
 * Transición de Sumego (SPEC.md §12.9 y §13.6 de Sumego): el issuer es exactamente uno de
 * `SUMEGO_ISSUERS`, `https://id.lumbre.pro` o `https://id.sumego.es`, comparado como cadena
 * cruda, sin normalizar: una barra final, mayúsculas, un puerto, una ruta, `http:` o cualquier
 * otro host no arrancan. Cuál de los dos está activo lo decide la variable, no el código; el
 * servidor solo acepta el configurado (discovery, endpoints, `iss` del callback, del ID token y
 * del `logout_token`) y el otro se rechaza como cualquier issuer ajeno. Los dos son el mismo
 * proveedor con los mismos `sub`, y las familias guardan solo `sub` y `sid`, sin issuer: al
 * pasar de uno a otro cada persona sigue en su misma identidad.
 *
 * Con `sumego`, el cliente es obligatorio: una variable que falte o no valga lanza
 * `HttpConfigError` y `serve-http` no arranca; nunca vuelve en silencio a `lumbre`. Con
 * `lumbre`, el cliente es opcional: si hay secreto, se valida igual y monta el back-channel
 * logout (que funciona con cualquier valor del interruptor); si no lo hay, no cambia nada.
 * El mensaje de error nombra la variable, nunca su valor.
 */
import { HttpConfigError } from '../http/config';

/** Los dos únicos issuers de Sumego que admite la configuración, tal cual. */
export const SUMEGO_ISSUERS = ['https://id.lumbre.pro', 'https://id.sumego.es'] as const;
export type SumegoIssuer = (typeof SUMEGO_ISSUERS)[number];
export const DEFAULT_OIDC_ISSUER: SumegoIssuer = 'https://id.lumbre.pro';
export const DEFAULT_OIDC_CLIENT_ID = 'hebra-mcp';
const CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;

export type LoginProvider = 'lumbre' | 'sumego';

/** Cliente confidencial de hebra-mcp en Sumego. El secreto nunca sale de aquí a un log. */
export interface OidcClientConfig {
  /** Uno de `SUMEGO_ISSUERS`, sin barra final: el `iss` exacto de discovery, ID token y logout. */
  issuer: SumegoIssuer;
  clientId: string;
  clientSecret: string;
}

export interface LoginConfig {
  provider: LoginProvider;
  /** `null` solo con `lumbre` y sin secreto configurado. */
  oidc: OidcClientConfig | null;
}

/** El secreto del cliente: 32–512 caracteres y sin saltos de línea. */
export function validClientSecret(value: string): boolean {
  return value.length >= 32 && value.length <= 512 && !/[\r\n]/.test(value);
}

/** ¿Es exactamente uno de los dos issuers? Sin recortar ni normalizar nada. */
export function isSumegoIssuer(value: string): value is SumegoIssuer {
  return (SUMEGO_ISSUERS as readonly string[]).includes(value);
}

function readOidcClient(env: NodeJS.ProcessEnv): OidcClientConfig {
  // Vacía o ausente es el defecto, como hasta ahora; cualquier otra cosa, uno de los dos tal cual.
  const issuer = env.HEBRA_MCP_OIDC_ISSUER || DEFAULT_OIDC_ISSUER;
  if (!isSumegoIssuer(issuer)) throw new HttpConfigError('HEBRA_MCP_OIDC_ISSUER');
  const clientId = env.HEBRA_MCP_OIDC_CLIENT_ID || DEFAULT_OIDC_CLIENT_ID;
  if (!CLIENT_ID.test(clientId)) throw new HttpConfigError('HEBRA_MCP_OIDC_CLIENT_ID');
  const clientSecret = env.HEBRA_MCP_OIDC_CLIENT_SECRET;
  if (clientSecret === undefined || !validClientSecret(clientSecret)) throw new HttpConfigError('HEBRA_MCP_OIDC_CLIENT_SECRET');
  return { issuer, clientId, clientSecret };
}

/** Sin E/S: se puede llamar antes de tomar `writer.lock`. */
export function readLoginConfig(env: NodeJS.ProcessEnv = process.env): LoginConfig {
  const raw = env.HEBRA_MCP_LOGIN_PROVIDER;
  const provider = raw === undefined || raw === '' ? 'lumbre' : raw;
  if (provider !== 'lumbre' && provider !== 'sumego') throw new HttpConfigError('HEBRA_MCP_LOGIN_PROVIDER');
  if (provider === 'sumego') return { provider, oidc: readOidcClient(env) };
  const secret = env.HEBRA_MCP_OIDC_CLIENT_SECRET;
  return { provider, oidc: secret === undefined || secret === '' ? null : readOidcClient(env) };
}
