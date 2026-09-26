/**
 * El OAuth de un solo dueño montado sobre la app de `serve-http` (`HttpAuth`,
 * `src/http/app.ts`). `null` si no hay secreto del dueño: entonces `serve-http` no
 * arranca (SPEC.md §12.2).
 *
 * Rutas, todas en la raíz del host (la metadata OAuth tiene que ir ahí):
 * - `/.well-known/oauth-protected-resource` y `/.well-known/oauth-protected-resource/mcp`
 *   (RFC 9728): `resource` = `<origen>/mcp`, servidor de autorización = el origen.
 * - `/.well-known/oauth-authorization-server` (RFC 8414): propia y no la del SDK, porque
 *   hay que anunciar `client_id_metadata_document_supported` (CIMD, lo que usa claude.ai
 *   con lumbre-mcp), `authorization_response_iss_parameter_supported`, solo clientes
 *   públicos (`none`) y un `issuer` SIN barra final, igual que lumbre-mcp (el SDK usaría
 *   `URL.href`, con barra). Se monta ANTES del router del SDK, que también las sirve.
 * - `/authorize`, `/token`, `/register`, `/revoke`: el router del SDK (`mcpAuthRouter`)
 *   con el proveedor de `./provider.ts`, con sus limitadores por IP.
 * - `POST /oauth/consent`: el formulario de la página de autorización.
 *
 * `requireAuth` es `requireBearerAuth` del SDK: solo la cabecera `Authorization` (nunca un
 * token en la URL), scope `hebra:mcp`, y el 401 con `WWW-Authenticate` que incluye
 * `resource_metadata`.
 */
import express, { type Express, type Request, type Response } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { HttpAuth } from '../http/app';
import type { HttpConfig } from '../http/config';
import { logEvent } from '../log/logger';
import { ClaudeClientsStore } from './clients';
import { OwnerFile } from './owner';
import { HebraOAuthProvider, OAUTH_SCOPE } from './provider';
import { TokenStore } from './token-store';

export interface OAuthHttpAuthOptions {
  /** Tests: el `fetch` con el que se descargan los documentos CIMD. */
  fetch?: (input: string | URL, init?: RequestInit) => Promise<globalThis.Response>;
  /** Tests: reloj de tokens y códigos. */
  now?: () => number;
}

export interface OAuthHttpAuth extends HttpAuth {
  provider: HebraOAuthProvider;
}

export function protectedResourceMetadataUrl(config: HttpConfig): string {
  return `${config.publicOrigin}/.well-known/oauth-protected-resource/mcp`;
}

export async function loadOAuthHttpAuth(
  dataDir: string,
  config: HttpConfig,
  options: OAuthHttpAuthOptions = {}
): Promise<OAuthHttpAuth | null> {
  const owner = new OwnerFile(dataDir);
  const record = await owner.current();
  if (!record) return null;
  const now = options.now ?? Date.now;
  const tokens = await TokenStore.open(dataDir, now);
  logEvent({ event: 'oauth.start', families: tokens.liveFamilyCount(record.revokedBefore) });
  const provider = new HebraOAuthProvider({
    issuer: config.publicOrigin,
    resource: config.resourceUrl,
    owner,
    tokens,
    clients: new ClaudeClientsStore({ fetch: options.fetch, now }),
    now
  });

  const protectedResource = {
    resource: config.resourceUrl,
    authorization_servers: [config.publicOrigin],
    bearer_methods_supported: ['header'],
    scopes_supported: [OAUTH_SCOPE],
    resource_name: 'Hebra'
  };
  const origin = config.publicOrigin;
  const authorizationServer = {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    revocation_endpoint: `${origin}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [OAUTH_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true
  };

  const sendMetadata = (body: object) => (_req: Request, res: Response) => {
    res.setHeader('cache-control', 'public, max-age=300');
    res.json(body);
  };

  return {
    provider,
    install(app: Express) {
      app.get('/.well-known/oauth-protected-resource', sendMetadata(protectedResource));
      app.get('/.well-known/oauth-protected-resource/mcp', sendMetadata(protectedResource));
      app.get('/.well-known/oauth-authorization-server', sendMetadata(authorizationServer));
      app.post(
        '/oauth/consent',
        express.urlencoded({ extended: false, limit: '8kb' }),
        (req: Request, res: Response) => {
          void provider.handleConsent(req, res).catch(() => {
            logEvent({ event: 'oauth.consent', result: 'error' });
            if (!res.headersSent) res.status(500).type('text/plain').send('Error interno.');
          });
        }
      );
      app.use(
        mcpAuthRouter({
          provider,
          issuerUrl: new URL(origin),
          resourceServerUrl: new URL(config.resourceUrl),
          scopesSupported: [OAUTH_SCOPE],
          resourceName: 'Hebra',
          clientRegistrationOptions: { clientIdGeneration: false }
        })
      );
    },
    requireAuth: requireBearerAuth({
      verifier: provider,
      requiredScopes: [OAUTH_SCOPE],
      resourceMetadataUrl: protectedResourceMetadataUrl(config)
    })
  };
}
