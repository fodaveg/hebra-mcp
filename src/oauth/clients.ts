/**
 * Clientes OAuth que acepta el conector (SPEC.md §12.2): Claude y Codex, siempre
 * públicos (sin `client_secret`, PKCE S256 obligatorio).
 *
 * Dos formas de registrarse, porque el SDK de MCP del cliente elige según la metadata del
 * servidor de autorización:
 *
 * 1. **CIMD** (Client ID Metadata Document): el `client_id` es una URL HTTPS de claude.ai
 *    que sirve el documento del cliente. Es lo que usa lumbre-mcp en producción con
 *    claude.ai (anuncia `client_id_metadata_document_supported` y NO anuncia
 *    `registration_endpoint`, `src/oauth.ts:808-822`), así que es el mecanismo medido. El
 *    documento se descarga sin redirecciones, con tope de tiempo y de tamaño, solo de
 *    `claude.ai` o la URL oficial exacta de Codex, y se cachea 5 minutos.
 * 2. **DCR** (registro dinámico, RFC 7591, el `/register` del SDK): por si un cliente no
 *    usa CIMD. Los registros se reducen a clientes fijos: Claude y los tres conjuntos
 *    de hosts loopback de Codex; no hay estado que guardar ni que crezca. Si el registro
 *    pide un `client_secret`, se sustituye por un cliente público
 *    (RFC 7591 §3.2.1 permite al servidor reemplazar los metadatos pedidos).
 *
 * Ninguno de los dos da acceso por sí solo: la aprobación llega del consentimiento de Lumbre.
 */
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { logEvent } from '../log/logger';

/** Callback web de Claude: coincidencia exacta, sin relajación de puerto. */
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
/** `client_id` fijo de los clientes registrados por DCR. */
export const DCR_CLIENT_ID = 'hebra-mcp-claude-ai';
export const CODEX_CIMD_CLIENT_ID = 'https://chatgpt.com/oauth/codex/client.json';
const CODEX_CALLBACKS = ['http://127.0.0.1/callback', 'http://localhost/callback'];
const CODEX_DCR_CLIENTS: Record<string, string[]> = {
  'hebra-mcp-codex-127': [CODEX_CALLBACKS[0]!],
  'hebra-mcp-codex-localhost': [CODEX_CALLBACKS[1]!],
  'hebra-mcp-codex-loopback': CODEX_CALLBACKS
};

const CIMD_HOSTNAME = 'claude.ai';
const CIMD_TIMEOUT_MS = 5_000;
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_CACHE_MS = 5 * 60_000;
const CIMD_CACHE_MAX = 16;

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const GRANT_TYPES = ['authorization_code', 'refresh_token'];

function publicClient(clientId: string, clientName: string, redirects = [CLAUDE_CALLBACK]): OAuthClientInformationFull {
  return {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: [...redirects],
    ...(redirects[0] !== CLAUDE_CALLBACK ? { application_type: 'native' as const } : {}),
    token_endpoint_auth_method: 'none',
    grant_types: GRANT_TYPES,
    response_types: ['code']
  };
}

/** Callback nativo sin aliases normalizados por URL(), credenciales ni sufijos. */
export function isCodexCallback(uri: string): boolean {
  const match = /^http:\/\/(127\.0\.0\.1|localhost)(?::([1-9][0-9]{0,4}))?\/callback$/.exec(uri);
  return match !== null && (match[2] === undefined || Number(match[2]) <= 65535);
}

/** Codex conserva los hosts publicados/registrados; RFC 8252 solo relaja el puerto. */
export function isAllowedRedirectUri(client: OAuthClientInformationFull, uri: string): boolean {
  if (uri === CLAUDE_CALLBACK) return client.redirect_uris.includes(CLAUDE_CALLBACK);
  if (client.client_id !== CODEX_CIMD_CLIENT_ID && !Object.hasOwn(CODEX_DCR_CLIENTS, client.client_id)) return false;
  return isCodexCallback(uri) && client.redirect_uris.some((registered) =>
    isCodexCallback(registered) && redirectUriMatches(uri, registered));
}

/** Identidades cerradas aceptadas también en las concesiones autenticadas de Lumbre. */
export function isAcceptableOAuthClientId(clientId: string): boolean {
  return clientId === DCR_CLIENT_ID || Object.hasOwn(CODEX_DCR_CLIENTS, clientId) || isAcceptableCimdClientId(clientId);
}

/** ¿Es un `client_id` CIMD aceptable? Claude con ruta o la URL exacta de Codex. */
export function isAcceptableCimdClientId(clientId: string): boolean {
  if (clientId === CODEX_CIMD_CLIENT_ID) return true;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  const rawPath = clientId.slice(clientId.indexOf('/', 'https://'.length)).split(/[?#]/, 1)[0] ?? '';
  const dotSegment = rawPath.split('/').some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === '.' || decoded === '..';
    } catch {
      return true;
    }
  });
  return (
    url.protocol === 'https:' &&
    url.hostname === CIMD_HOSTNAME &&
    (url.port === '' || url.port === '443') &&
    url.pathname !== '/' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '' &&
    !clientId.includes('#') &&
    !dotSegment
  );
}

async function readLimited(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface ClaudeClientsStoreOptions {
  fetch?: Fetcher;
  now?: () => number;
}

export class ClaudeClientsStore implements OAuthRegisteredClientsStore {
  private readonly fetchFn: Fetcher;
  private readonly now: () => number;
  private readonly cache = new Map<string, { client: OAuthClientInformationFull; expiresAt: number }>();

  constructor(options: ClaudeClientsStoreOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (clientId === DCR_CLIENT_ID) return publicClient(DCR_CLIENT_ID, 'Claude');
    if (Object.hasOwn(CODEX_DCR_CLIENTS, clientId)) return publicClient(clientId, 'Codex', CODEX_DCR_CLIENTS[clientId]!);
    if (!isAcceptableCimdClientId(clientId)) return undefined;
    const cached = this.cache.get(clientId);
    if (cached && cached.expiresAt > this.now()) return cached.client;
    this.cache.delete(clientId);
    const client = await this.fetchCimd(clientId);
    if (client) {
      while (this.cache.size >= CIMD_CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(clientId, { client, expiresAt: this.now() + CIMD_CACHE_MS });
    }
    return client;
  }

  private async fetchCimd(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    let response: Response;
    try {
      response = await this.fetchFn(clientId, {
        redirect: 'manual',
        signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
        headers: { accept: 'application/json' }
      });
    } catch {
      logEvent({ event: 'oauth.cimd', result: 'fetch_failed' });
      return undefined;
    }
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
    if (response.status !== 200 || contentType !== 'application/json') {
      logEvent({ event: 'oauth.cimd', result: 'rejected', status: response.status });
      return undefined;
    }
    let document: unknown;
    try {
      const text = await readLimited(response, CIMD_MAX_BYTES);
      if (text === null) {
        logEvent({ event: 'oauth.cimd', result: 'rejected', reason: 'too_large' });
        return undefined;
      }
      document = JSON.parse(text);
    } catch {
      logEvent({ event: 'oauth.cimd', result: 'rejected', reason: 'invalid_json' });
      return undefined;
    }
    const candidate = document as Record<string, unknown> | null;
    const redirects = candidate?.redirect_uris;
    const authMethod = candidate?.token_endpoint_auth_method;
    const codex = clientId === CODEX_CIMD_CLIENT_ID;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      candidate.client_id !== clientId ||
      !Array.isArray(redirects) ||
      (codex ? redirects.length === 0 || !redirects.every((uri) => typeof uri === 'string' && isCodexCallback(uri))
        : !redirects.includes(CLAUDE_CALLBACK)) ||
      (authMethod !== undefined && authMethod !== 'none')
    ) {
      logEvent({ event: 'oauth.cimd', result: 'rejected', reason: 'metadata' });
      return undefined;
    }
    logEvent({ event: 'oauth.cimd', result: 'ok' });
    const name = typeof candidate.client_name === 'string' ? candidate.client_name.slice(0, 100) : codex ? 'Codex' : 'Claude';
    // La metadata no puede ampliar el callback: conservamos solo sus hosts admitidos.
    return publicClient(clientId, name, codex
      ? CODEX_CALLBACKS.filter((callback) => redirects.some((uri) => redirectUriMatches(uri, callback)))
      : [CLAUDE_CALLBACK]);
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>
  ): Promise<OAuthClientInformationFull> {
    let registered = publicClient(DCR_CLIENT_ID, 'Claude');
    if (!client.redirect_uris.includes(CLAUDE_CALLBACK)) {
      const redirects = client.redirect_uris;
      const callbacks = CODEX_CALLBACKS.filter((callback) => redirects.some((uri) => redirectUriMatches(uri, callback)));
      const entry = Object.entries(CODEX_DCR_CLIENTS).find(([, values]) =>
        values.length === callbacks.length && values.every((uri) => callbacks.includes(uri)));
      if (redirects.length > 0 && redirects.every(isCodexCallback) && entry) {
        registered = publicClient(entry[0], 'Codex', entry[1]);
      } else {
        logEvent({ event: 'oauth.register', result: 'rejected' });
        throw new InvalidClientMetadataError('Solo se admiten los callbacks de Claude y Codex (SPEC.md §12.2).');
      }
    }
    logEvent({ event: 'oauth.register', result: 'ok' });
    return { ...registered, client_id_issued_at: Math.floor(this.now() / 1000) };
  }
}
