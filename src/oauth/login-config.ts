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
 * Con `sumego`, el cliente es obligatorio: una variable que falte o no valga lanza
 * `HttpConfigError` y `serve-http` no arranca; nunca vuelve en silencio a `lumbre`. Con
 * `lumbre`, el cliente es opcional: si hay secreto, se valida igual y monta el back-channel
 * logout (que funciona con cualquier valor del interruptor); si no lo hay, no cambia nada.
 * El mensaje de error nombra la variable, nunca su valor.
 */
import { HttpConfigError, parsePublicOrigin } from '../http/config';

export const DEFAULT_OIDC_ISSUER = 'https://id.lumbre.pro';
export const DEFAULT_OIDC_CLIENT_ID = 'hebra-mcp';
const CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;

export type LoginProvider = 'lumbre' | 'sumego';

/** Cliente confidencial de hebra-mcp en Sumego. El secreto nunca sale de aquí a un log. */
export interface OidcClientConfig {
  /** Origen del issuer, sin barra final: el `iss` exacto de discovery, ID token y logout. */
  issuer: string;
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

function readOidcClient(env: NodeJS.ProcessEnv): OidcClientConfig {
  const issuer = parsePublicOrigin(env.HEBRA_MCP_OIDC_ISSUER || DEFAULT_OIDC_ISSUER, 'HEBRA_MCP_OIDC_ISSUER').origin;
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
