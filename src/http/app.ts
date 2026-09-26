/**
 * La aplicación HTTP de `hebra-mcp serve-http` (SPEC.md §12.1): Streamable HTTP SIN
 * estado, como lumbre-mcp (`src/http.ts`): un `McpServer` y un transporte NUEVOS por
 * petición, sobre el MISMO `ServerContext` de todo el proceso (almacén, configuración de
 * privados, estado y escrituras). No hay sesiones MCP que atar a un token ni que expirar.
 *
 * Rutas:
 * - `POST /mcp`: el protocolo MCP, solo con credencial (`HttpAuth.requireAuth`, que va
 *   ANTES de leer el cuerpo: sin token no se lee ni un byte). `GET`/`DELETE /mcp`
 *   responden 405 (en modo sin estado no hay stream de servidor ni sesión que borrar),
 *   como lumbre-mcp. Nada bajo `/mcp/…`: el token nunca va en la URL.
 * - `GET /healthz`: 204 sin cuerpo y sin autenticación, para el healthcheck del
 *   contenedor. No dice nada del estado de la biblioteca.
 * - Lo que monte `HttpAuth.install` (OAuth, C3): metadata en la raíz del host,
 *   `/authorize`, `/token`…
 *
 * Defensas comunes a toda respuesta:
 * - `Host` (y `Origin`, si viene) tiene que ser el host público; un host de loopback
 *   solo vale si la CONEXIÓN viene de loopback (healthcheck, tests), igual que en
 *   lumbre-mcp: nadie que llegue por la red `edge` puede saltarse la comprobación con un
 *   `Host: localhost`. El SDK trae `hostHeaderValidation`, pero no mira la IP del peer.
 * - Tope de cuerpo (`MAX_MCP_BODY_BYTES`) con 413, `cache-control: no-store`,
 *   `nosniff` y `no-referrer`.
 * - Logs (§6.4): `http.request` con método, una etiqueta de ruta de un conjunto CERRADO y
 *   el estado HTTP. Nunca la ruta real (una ruta desconocida podría llevar un token), la
 *   query, las cabeceras ni el cuerpo; tampoco el mensaje de un error de parseo, que cita
 *   el texto recibido. El manejador de errores por defecto de Express imprime la pila en
 *   stderr: se sustituye por uno propio que no imprime nada.
 */
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response
} from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logEvent } from '../log/logger';
import { buildMcpServer } from '../server/build-server';
import type { ServerContext } from '../server/context';
import { CREATE_BODY_MAX_LENGTH } from '../store/writes';
import { isLoopbackHostname, MCP_PATH, type HttpConfig } from './config';

/**
 * Tope del cuerpo de `POST /mcp`, en bytes. El cuerpo legítimo más grande es un
 * `hebra_create_note` con el cuerpo máximo de §5 (100 000 caracteres), que en JSON
 * ocupa como mucho 6 bytes por unidad UTF-16 (`\uXXXX` de un carácter de control), más
 * el sobre JSON-RPC: el mismo cálculo que `MAX_MESSAGE_BYTES` de `writer.sock`.
 */
export const MAX_MCP_BODY_BYTES = CREATE_BODY_MAX_LENGTH * 6 + 64 * 1024;

/** Código JSON-RPC del 413 (rango de errores de servidor), el mismo que lumbre-mcp. */
const JSON_RPC_PAYLOAD_TOO_LARGE = -32002;

/**
 * La autenticación de `/mcp`. `serve-http` no arranca sin una (SPEC.md §12.2). La
 * implementación de verdad es el OAuth de un solo dueño (`src/oauth/`).
 */
export interface HttpAuth {
  /** Monta en la raíz las rutas propias (metadata, `/authorize`, `/token`…). */
  install(app: Express): void;
  /** Deja pasar a `POST /mcp` solo con credencial válida; si no, 401. */
  requireAuth: RequestHandler;
}

export interface CreateHttpAppOptions {
  ctx: ServerContext;
  /** Versión que ve el cliente MCP en `initialize`. */
  version: string;
  config: HttpConfig;
  auth: HttpAuth;
}

/** Etiquetas de ruta para el log: un conjunto cerrado, nunca la ruta recibida. */
const ROUTE_LABELS = new Set([
  MCP_PATH,
  '/healthz',
  '/authorize',
  '/token',
  '/register',
  '/revoke',
  '/oauth/consent',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server'
]);

function routeLabel(path: string): string {
  return ROUTE_LABELS.has(path) ? path : 'other';
}

function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return undefined;
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return normalized === '::1' || /^127\./.test(normalized);
}

/** ¿Vale este hostname (de `Host` u `Origin`) para una conexión desde `remoteAddress`? */
export function isAllowedHostname(
  hostname: string | undefined,
  remoteAddress: string | undefined,
  publicHostname: string
): boolean {
  if (hostname === undefined) return false;
  if (hostname === publicHostname) return true;
  return isLoopbackHostname(hostname) && isLoopbackAddress(remoteAddress);
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

export function createHttpApp(options: CreateHttpAppOptions): Express {
  const { ctx, version, config, auth } = options;
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  // Detrás de Caddy (red `edge`, direcciones privadas): `req.ip` es el cliente real para
  // los limitadores del SDK. Solo se confía en proxies de loopback o de red privada.
  app.set('trust proxy', 'loopback, uniquelocal');

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    const label = routeLabel(req.path);
    res.on('finish', () => {
      logEvent({ event: 'http.request', method: req.method, route: label, status: res.statusCode });
    });
    const remote = req.socket.remoteAddress;
    const hostOk = isAllowedHostname(hostnameOf(req.headers.host), remote, config.publicHostname);
    const origin = req.headers.origin;
    const originOk =
      origin === undefined || isAllowedHostname(hostnameOf(origin), remote, config.publicHostname);
    if (!hostOk || !originOk) {
      res.status(403).type('text/plain').send('Host u Origin no permitido.');
      return;
    }
    next();
  });

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(204).end();
  });

  auth.install(app);

  const parseBody = express.json({ limit: MAX_MCP_BODY_BYTES, type: 'application/json' });

  app.post(MCP_PATH, auth.requireAuth, parseBody, (req: Request, res: Response) => {
    // Sin cuerpo parseado (tipo que no es `application/json`), el transporte leería el
    // flujo él solo y sin tope: se corta aquí.
    if (req.body === undefined) {
      sendJsonRpcError(res, 415, -32000, 'Content-Type debe ser application/json.');
      return;
    }
    void handleMcp(ctx, version, req, res);
  });

  app.all(MCP_PATH, (_req: Request, res: Response) => {
    res.setHeader('allow', 'POST');
    sendJsonRpcError(res, 405, -32000, 'Método no permitido: este servidor no tiene estado, solo POST /mcp.');
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).type('text/plain').send('No encontrado.');
  });

  const onError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const type = (error as { type?: unknown } | null)?.type;
    const status = (error as { status?: unknown } | null)?.status;
    if (type === 'entity.too.large') {
      sendJsonRpcError(res, 413, JSON_RPC_PAYLOAD_TOO_LARGE, `El cuerpo supera ${MAX_MCP_BODY_BYTES} bytes.`);
      return;
    }
    if (type === 'entity.parse.failed') {
      sendJsonRpcError(res, 400, -32700, 'El cuerpo no es JSON válido.');
      return;
    }
    if (typeof status === 'number' && status >= 400 && status < 500) {
      sendJsonRpcError(res, status, -32000, 'Petición no válida.');
      return;
    }
    logEvent({ event: 'http.error', error: error instanceof Error ? error.name : 'unknown' });
    sendJsonRpcError(res, 500, -32603, 'Error interno.');
  };
  app.use(onError);

  return app;
}

/** Una petición MCP: servidor y transporte nuevos, cerrados al terminar la respuesta. */
async function handleMcp(ctx: ServerContext, version: string, req: Request, res: Response): Promise<void> {
  const server = buildMcpServer(ctx, version);
  // `enableJsonResponse`: una respuesta JSON por petición, sin stream SSE (lumbre-mcp
  // igual). Las herramientas de hebra-mcp no mandan notificaciones a mitad de llamada.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logEvent({ event: 'http.error', error: error instanceof Error ? error.name : 'unknown' });
    if (!res.headersSent) sendJsonRpcError(res, 500, -32603, 'Error interno.');
  }
}
