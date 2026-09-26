/**
 * La app de `serve-http` (`src/http/app.ts`) en un puerto efímero de `127.0.0.1`, con su
 * origen público real (`http://127.0.0.1:<puerto>`): primero se escucha y después se
 * construye la app, porque la metadata OAuth y el `resource` dependen del puerto.
 *
 * `staticBearerAuth` es una `HttpAuth` de prueba (un token fijo, sin OAuth) para los tests
 * del transporte (C2); los de OAuth (C3) usan la de verdad.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHttpApp, type HttpAuth } from '../../src/http/app';
import { httpConfigFor, type HttpConfig } from '../../src/http/config';
import type { ServerContext } from '../../src/server/context';

export interface TestHttpApp {
  origin: string;
  config: HttpConfig;
  server: Server;
  close(): Promise<void>;
}

export async function startTestHttpApp(
  ctx: ServerContext,
  auth: HttpAuth | ((config: HttpConfig) => HttpAuth | Promise<HttpAuth>)
): Promise<TestHttpApp> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const config = httpConfigFor(`http://127.0.0.1:${port}`, port);
  const resolved = typeof auth === 'function' ? await auth(config) : auth;
  server.on('request', createHttpApp({ ctx, version: '0.0.0-test', config, auth: resolved }));
  return {
    origin: config.publicOrigin,
    config,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })
  };
}

/** Un token fijo: `Authorization: Bearer <token>` o 401. */
export function staticBearerAuth(token: string): HttpAuth {
  return {
    install() {},
    requireAuth(req: Request, res: Response, next: NextFunction) {
      if (req.headers.authorization === `Bearer ${token}`) {
        next();
        return;
      }
      res.status(401).json({ error: 'invalid_token' });
    }
  };
}

/** Cliente MCP del SDK por Streamable HTTP, con un bearer fijo. */
export async function connectHttpClient(origin: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  });
  const client = new Client({ name: 'hebra-mcp-http-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

export function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
