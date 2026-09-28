/**
 * Configuración de `hebra-mcp serve-http` (SPEC.md §12.1), leída del entorno. Nada de
 * esto es secreto: puerto, interfaz de escucha y URL pública. La credencial de
 * backchannel (§12.2) se configura aparte mediante HEBRA_MCP_BACKCHANNEL_SECRET.
 *
 * - `HEBRA_MCP_HTTP_PORT`: puerto de escucha (por defecto 8787).
 * - `HEBRA_MCP_HTTP_LISTEN`: interfaz de escucha (por defecto `127.0.0.1`; en el
 *   contenedor, `0.0.0.0`, detrás de Caddy en la red `edge`).
 * - `HEBRA_MCP_PUBLIC_URL`: origen público, que es a la vez el `issuer` OAuth y la base del
 *   recurso protegido (`<origen>/mcp`). Por defecto `https://mcp.hebra.pro` (§12.5). Solo
 *   un origen: sin ruta, query ni fragmento, porque la metadata OAuth va en la raíz del
 *   host. `http://` solo se admite con un host de loopback (tests y desarrollo local).
 */

export const DEFAULT_HTTP_PORT = 8787;
export const DEFAULT_HTTP_LISTEN = '127.0.0.1';
export const DEFAULT_PUBLIC_URL = 'https://mcp.hebra.pro';

/** Ruta del endpoint MCP. El recurso protegido es `<origen público>/mcp`. */
export const MCP_PATH = '/mcp';

export interface HttpConfig {
  port: number;
  listenHost: string;
  /** Origen público, sin barra final (`https://mcp.hebra.pro`). */
  publicOrigin: string;
  /** `<origen público>/mcp`: el `resource` de OAuth (RFC 8707/9728). */
  resourceUrl: string;
  /** Hostname que debe traer la cabecera `Host` (protección de DNS rebinding). */
  publicHostname: string;
}

/** Configuración inválida: el mensaje nombra la variable, nunca un valor. */
export class HttpConfigError extends Error {
  readonly code = 'http_config_invalid';
  constructor(readonly variable: string) {
    super(`serve-http: ${variable} no es válida`);
    this.name = 'HttpConfigError';
  }
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/** Valida un origen público y lo normaliza (sin barra final). */
export function parsePublicOrigin(raw: string, variable = 'HEBRA_MCP_PUBLIC_URL'): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpConfigError(variable);
  }
  const secure = url.protocol === 'https:';
  const localHttp = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if (
    (!secure && !localHttp) ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new HttpConfigError(variable);
  }
  return url;
}

/** La configuración para un origen público dado (también la usan los tests). */
export function httpConfigFor(
  publicOrigin: string,
  port = DEFAULT_HTTP_PORT,
  listenHost = DEFAULT_HTTP_LISTEN
): HttpConfig {
  const url = parsePublicOrigin(publicOrigin);
  const origin = url.origin;
  return {
    port,
    listenHost,
    publicOrigin: origin,
    resourceUrl: `${origin}${MCP_PATH}`,
    publicHostname: url.hostname
  };
}

export function readHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const rawPort = env.HEBRA_MCP_HTTP_PORT;
  let port = DEFAULT_HTTP_PORT;
  if (rawPort !== undefined && rawPort !== '') {
    if (!/^\d{1,5}$/.test(rawPort)) throw new HttpConfigError('HEBRA_MCP_HTTP_PORT');
    port = Number(rawPort);
    if (port < 1 || port > 65_535) throw new HttpConfigError('HEBRA_MCP_HTTP_PORT');
  }
  const listenHost = env.HEBRA_MCP_HTTP_LISTEN || DEFAULT_HTTP_LISTEN;
  return httpConfigFor(env.HEBRA_MCP_PUBLIC_URL || DEFAULT_PUBLIC_URL, port, listenHost);
}
