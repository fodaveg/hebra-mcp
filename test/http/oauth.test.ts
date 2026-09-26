/**
 * OAuth de un solo dueño de `serve-http` (SPEC.md §12.2, lote C3), por HTTP real contra
 * la app en un puerto efímero:
 *
 * - Positivo: el flujo completo autorización → token → herramienta con el cliente del
 *   SDK (`StreamableHTTPClientTransport` con `authProvider`), por DCR y por CIMD.
 * - Negativos: sin token 401 con `resource_metadata`; token en la URL; secreto,
 *   `redirect_uri`, `client_id` o `code_verifier` erróneos; código reutilizado; refresh
 *   reutilizado (revoca la familia); `/revoke`; `oauth-revoke-all`; límite de intentos.
 * - Almacenamiento: solo hashes, 0600, y los tokens sobreviven a un reinicio.
 * - Logs: ni secreto, ni códigos, ni tokens en stderr.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CLAUDE_CALLBACK,
  DCR_CLIENT_ID,
  loadOAuthHttpAuth,
  OAUTH_OWNER_FILE,
  OAUTH_TOKENS_FILE,
  OAuthCliError,
  readOwnerRecord,
  runOAuthRevokeAll,
  runOAuthSetSecret,
  setOwnerSecret
} from '../../src/oauth';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { startTestHttpApp, textOf, type TestHttpApp } from '../fixtures/http-app';

const SECRET = 'secreto-del-dueño-de-prueba-0123456789-abcdef';
const CIMD_CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;
let test: TestContext | undefined;
const apps: TestHttpApp[] = [];
const clients: Client[] = [];
let cimdFetch: ReturnType<typeof vi.fn>;

function stderrText(): string {
  return (stderrSpy!.mock.calls as unknown as [string][]).map(([line]) => String(line)).join('');
}

function cimdDocument(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      client_id: CIMD_CLIENT_ID,
      client_name: 'Claude',
      redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...overrides
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  cimdFetch = vi.fn(async (input: string | URL) =>
    String(input) === CIMD_CLIENT_ID ? cimdDocument() : new Response('no', { status: 404 })
  );
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const app of apps.splice(0)) await app.close();
  await test?.close();
  test = undefined;
  stderrSpy?.mockRestore();
  stderrSpy = undefined;
});

async function startApp(): Promise<TestHttpApp> {
  test ??= await buildTestContext();
  if (!(await readOwnerRecord(test.dataDir))) await setOwnerSecret(test.dataDir, SECRET);
  const app = await startTestHttpApp(test.serverContext, async (config) => {
    const auth = await loadOAuthHttpAuth(test!.dataDir, config, { fetch: cimdFetch as never });
    if (!auth) throw new Error('sin auth');
    return auth;
  });
  apps.push(app);
  return app;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function authorizePage(
  app: TestHttpApp,
  params: Record<string, string>
): Promise<globalThis.Response> {
  const url = new URL(`${app.origin}/authorize`);
  const all: Record<string, string> = {
    response_type: 'code',
    client_id: DCR_CLIENT_ID,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge_method: 'S256',
    state: 'estado-de-prueba',
    scope: 'hebra:mcp',
    resource: app.config.resourceUrl,
    ...params
  };
  for (const [key, value] of Object.entries(all)) url.searchParams.set(key, value);
  return fetch(url, { redirect: 'manual' });
}

function requestIdOf(html: string): string {
  const match = /name="request" value="([^"]+)"/.exec(html);
  if (!match) throw new Error('la página no trae solicitud');
  return match[1]!;
}

async function consent(app: TestHttpApp, requestId: string, secret: string): Promise<globalThis.Response> {
  return fetch(`${app.origin}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request: requestId, secret }).toString()
  });
}

/** Autoriza con el secreto y devuelve el código (y el verifier que lo acompaña). */
async function obtainCode(
  app: TestHttpApp,
  clientId = DCR_CLIENT_ID
): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const page = await authorizePage(app, { client_id: clientId, code_challenge: challenge });
  expect(page.status).toBe(200);
  const response = await consent(app, requestIdOf(await page.text()), SECRET);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_CALLBACK);
  expect(location.searchParams.get('state')).toBe('estado-de-prueba');
  expect(location.searchParams.get('iss')).toBe(app.origin);
  return { code: location.searchParams.get('code')!, verifier };
}

async function tokenRequest(app: TestHttpApp, params: Record<string, string>): Promise<globalThis.Response> {
  return fetch(`${app.origin}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: DCR_CLIENT_ID, ...params }).toString()
  });
}

async function exchange(app: TestHttpApp, code: string, verifier: string): Promise<globalThis.Response> {
  return tokenRequest(app, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: CLAUDE_CALLBACK,
    resource: app.config.resourceUrl
  });
}

async function obtainTokens(app: TestHttpApp): Promise<OAuthTokens> {
  const { code, verifier } = await obtainCode(app);
  const response = await exchange(app, code, verifier);
  expect(response.status).toBe(200);
  return (await response.json()) as OAuthTokens;
}

/** `initialize` por `POST /mcp` con el bearer: el estado HTTP dice si pasó la auth. */
async function mcpStatus(app: TestHttpApp, accessToken: string | null, path = '/mcp'): Promise<globalThis.Response> {
  return fetch(`${app.origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }
    })
  });
}

/** `OAuthClientProvider` en memoria, como el de claude.ai: el callback de claude.ai y
 *  la URL de autorización capturada en vez de abrir un navegador. */
class MemoryOAuthClient implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authorizationUrl: URL | undefined;

  constructor(readonly clientMetadataUrl?: string) {}

  get redirectUrl(): string {
    return CLAUDE_CALLBACK;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Claude',
      redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    };
  }

  state(): string {
    return 'estado-de-prueba';
  }

  clientInformation() {
    return this.info;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.info = info;
  }

  tokens() {
    return this.saved;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.saved = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }
}

/** El flujo entero con el cliente del SDK; devuelve un cliente MCP ya autorizado. */
async function sdkFlow(app: TestHttpApp, provider: MemoryOAuthClient): Promise<Client> {
  const mcpUrl = new URL(`${app.origin}/mcp`);
  const first = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
  const unauthorized = new Client({ name: 'claude-de-prueba', version: '0.0.0' });
  await expect(unauthorized.connect(first)).rejects.toThrow();
  expect(provider.authorizationUrl).toBeDefined();

  const page = await fetch(provider.authorizationUrl!, { redirect: 'manual' });
  expect(page.status).toBe(200);
  expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
  const approved = await consent(app, requestIdOf(await page.text()), SECRET);
  expect(approved.status).toBe(302);
  const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
  await first.finishAuth(code);
  expect(provider.saved?.access_token).toMatch(/^hmcp_at_/);

  const client = new Client({ name: 'claude-de-prueba', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
  clients.push(client);
  return client;
}

describe('metadata', () => {
  it('PRM en la raíz y en /mcp, AS con CIMD y registro, issuer sin barra final', async () => {
    const app = await startApp();
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const prm = (await (await fetch(`${app.origin}${path}`)).json()) as Record<string, unknown>;
      expect(prm).toMatchObject({
        resource: `${app.origin}/mcp`,
        authorization_servers: [app.origin],
        scopes_supported: ['hebra:mcp']
      });
    }
    const as = (await (await fetch(`${app.origin}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      unknown
    >;
    expect(as).toMatchObject({
      issuer: app.origin,
      authorization_endpoint: `${app.origin}/authorize`,
      token_endpoint: `${app.origin}/token`,
      registration_endpoint: `${app.origin}/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true
    });
  });
});

describe('flujo completo con el cliente del SDK', () => {
  it('por registro dinámico: autorización → token → herramienta', async () => {
    const app = await startApp();
    const provider = new MemoryOAuthClient();
    const client = await sdkFlow(app, provider);
    expect(provider.info?.client_id).toBe(DCR_CLIENT_ID);
    const result = (await client.callTool({ name: 'hebra_status', arguments: {} })) as CallToolResult;
    expect(JSON.parse(textOf(result))).toMatchObject({ linked: false });
  });

  it('por CIMD (lo que usa claude.ai con lumbre-mcp): el documento se descarga de claude.ai', async () => {
    const app = await startApp();
    const provider = new MemoryOAuthClient(CIMD_CLIENT_ID);
    const client = await sdkFlow(app, provider);
    expect(provider.info?.client_id).toBe(CIMD_CLIENT_ID);
    expect(cimdFetch).toHaveBeenCalledWith(CIMD_CLIENT_ID, expect.objectContaining({ redirect: 'manual' }));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(9);
  });

  it('ningún secreto, código ni token llega a stderr', async () => {
    const app = await startApp();
    const provider = new MemoryOAuthClient();
    await sdkFlow(app, provider);
    const logged = stderrText();
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(provider.saved!.access_token);
    expect(logged).not.toContain(provider.saved!.refresh_token!);
    expect(logged).not.toContain('estado-de-prueba');
  });
});

describe('negativos', () => {
  it('sin token: 401 con resource_metadata; el token en la URL no vale', async () => {
    const app = await startApp();
    const response = await mcpStatus(app, null);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${app.origin}/.well-known/oauth-protected-resource/mcp"`
    );
    const tokens = await obtainTokens(app);
    expect((await mcpStatus(app, tokens.access_token)).status).toBe(200);
    expect((await mcpStatus(app, null, `/mcp?access_token=${tokens.access_token}`)).status).toBe(401);
    expect((await mcpStatus(app, 'hmcp_at_inventado')).status).toBe(401);
  });

  it('secreto erróneo: 401 sin código; a los 5 fallos la solicitud deja de valer', async () => {
    const app = await startApp();
    const { challenge } = pkce();
    const requestId = requestIdOf(await (await authorizePage(app, { code_challenge: challenge })).text());
    const wrong = await consent(app, requestId, `${SECRET}x`);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('location')).toBeNull();
    // Todavía vale con el secreto bueno.
    expect((await consent(app, requestId, SECRET)).status).toBe(302);

    // Otra app sobre el mismo directorio: su propio contador de fallos por IP.
    const fresh = await startApp();
    const again = requestIdOf(await (await authorizePage(fresh, { code_challenge: challenge })).text());
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await consent(fresh, again, 'no-es-el-secreto')).status).toBe(401);
    }
    // El quinto fallo agota la IP: 429, y ya ni el secreto bueno pasa.
    expect((await consent(fresh, again, 'no-es-el-secreto')).status).toBe(429);
    expect((await consent(fresh, again, SECRET)).status).toBe(429);
  });

  it('redirect_uri o client_id ajenos: rechazados sin redirigir', async () => {
    const app = await startApp();
    const { challenge } = pkce();
    const evilRedirect = await authorizePage(app, {
      code_challenge: challenge,
      redirect_uri: 'https://evil.example/callback'
    });
    expect(evilRedirect.status).toBe(400);
    expect(evilRedirect.headers.get('location')).toBeNull();

    const register = await fetch(`${app.origin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.example/callback'], token_endpoint_auth_method: 'none' })
    });
    expect(register.status).toBe(400);

    for (const clientId of ['https://evil.example/client.json', 'https://claude.ai/', 'otro-cliente']) {
      const response = await authorizePage(app, { code_challenge: challenge, client_id: clientId });
      expect(response.status).toBe(400);
    }
    // Un documento CIMD de claude.ai que no registra el callback tampoco vale.
    cimdFetch.mockImplementation(async () => cimdDocument({ redirect_uris: ['https://claude.ai/otro'] }));
    expect((await authorizePage(app, { code_challenge: challenge, client_id: CIMD_CLIENT_ID })).status).toBe(400);
  });

  it('code_verifier erróneo: invalid_grant, y el código queda quemado', async () => {
    const app = await startApp();
    const { code, verifier } = await obtainCode(app);
    const wrong = await exchange(app, code, pkce().verifier);
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe('invalid_grant');
    expect((await exchange(app, code, verifier)).status).toBe(400);
  });

  it('código reutilizado: el segundo canje falla', async () => {
    const app = await startApp();
    const { code, verifier } = await obtainCode(app);
    expect((await exchange(app, code, verifier)).status).toBe(200);
    const reused = await exchange(app, code, verifier);
    expect(reused.status).toBe(400);
    expect(((await reused.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('refresh reutilizado: revoca la familia entera', async () => {
    const app = await startApp();
    const first = await obtainTokens(app);
    const rotated = await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: first.refresh_token! });
    expect(rotated.status).toBe(200);
    const second = (await rotated.json()) as OAuthTokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await mcpStatus(app, second.access_token)).status).toBe(200);

    const replay = await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: first.refresh_token! });
    expect(replay.status).toBe(400);
    // La familia cayó entera: ni el refresh vigente ni sus access valen ya.
    expect((await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: second.refresh_token! })).status).toBe(
      400
    );
    expect((await mcpStatus(app, second.access_token)).status).toBe(401);
    expect((await mcpStatus(app, first.access_token)).status).toBe(401);
  });

  it('token revocado por /revoke: 401', async () => {
    const app = await startApp();
    const tokens = await obtainTokens(app);
    const revoked = await fetch(`${app.origin}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DCR_CLIENT_ID, token: tokens.access_token }).toString()
    });
    expect(revoked.status).toBe(200);
    expect((await mcpStatus(app, tokens.access_token)).status).toBe(401);
  });

  it('oauth-revoke-all corta al momento, con el servidor en marcha', async () => {
    const app = await startApp();
    const tokens = await obtainTokens(app);
    expect((await mcpStatus(app, tokens.access_token)).status).toBe(200);
    const printed: string[] = [];
    await runOAuthRevokeAll(test!.dataDir, { print: (line) => printed.push(line) }, Date.now() + 1);
    expect(printed).toHaveLength(1);
    expect((await mcpStatus(app, tokens.access_token)).status).toBe(401);
    expect((await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token! })).status).toBe(
      400
    );
    // Una autorización nueva vuelve a funcionar.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await mcpStatus(app, (await obtainTokens(app)).access_token)).status).toBe(200);
  });
});

describe('almacenamiento', () => {
  it('solo hashes en disco, 0600, y los tokens sobreviven a un reinicio', async () => {
    const app = await startApp();
    const tokens = await obtainTokens(app);
    const tokensFile = join(test!.dataDir, OAUTH_TOKENS_FILE);
    const ownerFile = join(test!.dataDir, OAUTH_OWNER_FILE);
    for (const file of [tokensFile, ownerFile]) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain(tokens.access_token);
      expect(text).not.toContain(tokens.refresh_token!);
      expect(text).not.toContain(SECRET);
    }
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const restarted = await startApp();
    expect((await mcpStatus(restarted, tokens.access_token)).status).toBe(200);
  });
});

describe('oauth-set-secret', () => {
  function io(answers: string[], interactive = true) {
    const printed: string[] = [];
    return {
      printed,
      io: {
        interactive,
        readSecret: async () => answers.shift() ?? '',
        print: (line: string) => printed.push(line)
      }
    };
  }

  it('rechaza un secreto corto o que no coincide, y fijar uno nuevo revoca los tokens', async () => {
    const app = await startApp();
    const tokens = await obtainTokens(app);
    await expect(runOAuthSetSecret(test!.dataDir, io(['corto', 'corto']).io)).rejects.toBeInstanceOf(OAuthCliError);
    await expect(runOAuthSetSecret(test!.dataDir, io([SECRET, `${SECRET}x`]).io)).rejects.toMatchObject({
      code: 'owner_secret_mismatch'
    });
    // Nada cambió: el token sigue valiendo.
    expect((await mcpStatus(app, tokens.access_token)).status).toBe(200);

    const next = `${SECRET}-nuevo`;
    const ok = io([next], false);
    await runOAuthSetSecret(test!.dataDir, ok.io, Date.now() + 1);
    expect(ok.printed.join('\n')).not.toContain(next);
    expect((await mcpStatus(app, tokens.access_token)).status).toBe(401);
    // El viejo ya no autoriza; el nuevo sí.
    const { challenge } = pkce();
    const requestId = requestIdOf(await (await authorizePage(app, { code_challenge: challenge })).text());
    expect((await consent(app, requestId, SECRET)).status).toBe(401);
    expect((await consent(app, requestId, next)).status).toBe(302);
  });
});
