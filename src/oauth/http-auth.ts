/**
 * OAuth de Hebra con consentimiento Lumbre montado sobre `serve-http`.
 * `null` si falta la credencial de backchannel o el almacén de secretos:
 * entonces `serve-http` no arranca (SPEC.md §12.2).
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
 * - `GET /oauth/lumbre/callback`: recibe la vuelta del consentimiento y
 *   confirma la aprobación por backchannel antes de emitir código.
 *
 * `requireAuth` es `requireBearerAuth` del SDK: solo la cabecera `Authorization` (nunca un
 * token en la URL), scope `hebra:mcp`, y el 401 con `WWW-Authenticate` que incluye
 * `resource_metadata`.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { HttpAuth } from '../http/app';
import type { HttpConfig } from '../http/config';
import { logEvent } from '../log/logger';
import type { SecretStore } from '../secrets';
import { BackchannelError, LumbreBackchannel } from './backchannel';
import { CLAUDE_CALLBACK, ClaudeClientsStore, isCodexCallback } from './clients';
import { GrantSecrets } from './grants';
import { RevocationFile } from './owner';
import { HebraOAuthProvider, OAUTH_SCOPE } from './provider';
import { TokenStore } from './token-store';

export interface OAuthHttpAuthOptions {
  /** Tests: el `fetch` con el que se descargan los documentos CIMD. */
  fetch?: (input: string | URL, init?: RequestInit) => Promise<globalThis.Response>;
  /** Tests: reloj de tokens y códigos. */
  now?: () => number;
  /** Tests: broker HTTPS simulado, sin exponer el secreto. */
  backchannelFetch?: (input: string | URL, init?: RequestInit) => Promise<globalThis.Response>;
  env?: NodeJS.ProcessEnv;
}

export interface OAuthHttpAuth extends HttpAuth {
  provider: HebraOAuthProvider;
}

export function protectedResourceMetadataUrl(config: HttpConfig): string {
  return `${config.publicOrigin}/.well-known/oauth-protected-resource/mcp`;
}

/** Validación sin E/S para no tocar concesiones antes de tomar writer.lock. */
export function oauthHttpAuthConfigured(secrets: SecretStore | null, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.HEBRA_MCP_BACKCHANNEL_SECRET;
  return secrets !== null && value !== undefined && value.length >= 32 && value.length <= 512 && !/[\r\n]/.test(value);
}

export async function loadOAuthHttpAuth(
  dataDir: string,
  config: HttpConfig,
  secrets: SecretStore | null,
  options: OAuthHttpAuthOptions = {}
): Promise<OAuthHttpAuth | null> {
  if (!oauthHttpAuthConfigured(secrets, options.env)) return null;
  const rawSecret = (options.env ?? process.env).HEBRA_MCP_BACKCHANNEL_SECRET!;
  const backchannel = new LumbreBackchannel(rawSecret, config.resourceUrl, options.backchannelFetch);
  const now = options.now ?? Date.now;
  const tokens = await TokenStore.open(dataDir, now);
  const revocations = new RevocationFile(dataDir);
  const grants = await GrantSecrets.open(secrets!, tokens.familyIds());
  await GrantSecrets.recoverPending(secrets!, tokens.familyIds(), grants, (token) => backchannel.revoke(token));
  await grants.recoverOrphans(tokens.familyIds(), (token) => backchannel.revoke(token));
  logEvent({ event: 'oauth.start', families: tokens.liveFamilyCount(await revocations.current()) });
  const provider = new HebraOAuthProvider({
    issuer: config.publicOrigin,
    resource: config.resourceUrl,
    revocations,
    tokens,
    grants,
    secrets: secrets!,
    backchannel,
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
      // Antes del SDK: URL() normaliza aliases y su matcher ignora userinfo/hash.
      // También los errores de parámetros deben evitar redirects a esas URI.
      app.use('/authorize', express.urlencoded({ extended: false }), (req: Request, res: Response, next: NextFunction) => {
        if (req.method !== 'GET' && req.method !== 'POST') { next(); return; }
        const redirect = (req.method === 'POST' ? req.body : req.query)?.redirect_uri;
        if (redirect !== undefined && (typeof redirect !== 'string' ||
          (redirect !== CLAUDE_CALLBACK && !isCodexCallback(redirect)))) {
          res.status(400).json({ error: 'invalid_request' }); return;
        }
        next();
      });
      app.get('/.well-known/oauth-protected-resource', sendMetadata(protectedResource));
      app.get('/.well-known/oauth-protected-resource/mcp', sendMetadata(protectedResource));
      app.get('/.well-known/oauth-authorization-server', sendMetadata(authorizationServer));
      app.get('/oauth/lumbre/callback', (req: Request, res: Response) => {
        void provider.handleLumbreCallback(req, res).catch(() => {
          logEvent({ event: 'oauth.consent', result: 'error' });
          if (!res.headersSent) res.status(503).json({ error: 'temporarily_unavailable' });
        });
      });
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
    // El middleware del SDK traduce una caída temporal del verificador a 500 o
    // invalid_token. Aquí preservamos su challenge para tokens inválidos y 503
    // recuperable para introspección indisponible, sin provocar un nuevo login.
    requireAuth(req: Request, res: Response, next: NextFunction) {
      const raw = req.headers.authorization;
      const token = raw?.startsWith('Bearer ') ? raw.slice(7) : null;
      if (!token || token.includes(' ')) {
        res.setHeader('WWW-Authenticate', `Bearer error="invalid_token", scope="${OAUTH_SCOPE}", resource_metadata="${protectedResourceMetadataUrl(config)}"`);
        res.status(401).json({ error: 'invalid_token' }); return;
      }
      void provider.verifyAccessToken(token).then((auth) => {
        if (!auth.scopes.includes(OAUTH_SCOPE) || auth.expiresAt === undefined || auth.expiresAt < Date.now() / 1000) {
          res.setHeader('WWW-Authenticate', `Bearer error="invalid_token", scope="${OAUTH_SCOPE}", resource_metadata="${protectedResourceMetadataUrl(config)}"`);
          res.status(401).json({ error: 'invalid_token' }); return;
        }
        Object.assign(req, { auth });
        next();
      }).catch((error: unknown) => {
        if (error instanceof BackchannelError) {
          res.status(503).json({ error: 'temporarily_unavailable' }); return;
        }
        if (error instanceof InvalidTokenError) {
          res.setHeader('WWW-Authenticate', `Bearer error="invalid_token", scope="${OAUTH_SCOPE}", resource_metadata="${protectedResourceMetadataUrl(config)}"`);
          res.status(401).json({ error: 'invalid_token' }); return;
        }
        res.status(503).json({ error: 'temporarily_unavailable' });
      });
    }
  };
}
