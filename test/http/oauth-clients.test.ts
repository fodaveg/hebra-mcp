/** Allowlist de clientes públicos: la metadata remota no amplía los callbacks. */
import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeClientsStore, CLAUDE_CALLBACK, CLAUDE_CODE_CIMD_CLIENT_ID, CODEX_CIMD_CLIENT_ID, isAcceptableCimdClientId, isAcceptableOAuthClientId,
  isAllowedRedirectUri, isCodexCallback, isVibeCallback, LECHAT_CALLBACK, LECHAT_CLIENT_NAME, LECHAT_DCR_CLIENT_ID, VIBE_CLIENT_NAME, VIBE_DCR_CLIENT_ID
} from '../../src/oauth/clients';

const callbacks = ['http://127.0.0.1/callback', 'http://localhost/callback'];
const metadata = (redirects = callbacks) => ({ client_id: CODEX_CIMD_CLIENT_ID,
  client_name: 'Codex', application_type: 'native', redirect_uris: redirects, token_endpoint_auth_method: 'none' });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('clientes OAuth Codex', () => {
  it('solo descarga la URL oficial exacta, sin redirects y con caché acotada en tiempo', async () => {
    let now = 0;
    const fetch = vi.fn(async () => json(metadata()));
    const store = new ClaudeClientsStore({ fetch, now: () => now });
    for (const id of [
      'https://chatgpt.com/oauth/other.json', `${CODEX_CIMD_CLIENT_ID}?extra=1`, `${CODEX_CIMD_CLIENT_ID}#`,
      'https://user@chatgpt.com/oauth/codex/client.json', 'https://chatgpt.com:443/oauth/codex/client.json',
      'https://chatgpt.com/oauth/other/../codex/client.json', 'https://CHATGPT.com/oauth/codex/client.json'
    ]) {
      expect(isAcceptableCimdClientId(id)).toBe(false);
      expect(await store.getClient(id)).toBeUndefined();
    }
    expect(fetch).not.toHaveBeenCalled();
    const client = await store.getClient(CODEX_CIMD_CLIENT_ID);
    expect(client).toMatchObject({ client_id: CODEX_CIMD_CLIENT_ID, redirect_uris: callbacks,
      application_type: 'native', token_endpoint_auth_method: 'none' });
    expect(fetch).toHaveBeenCalledWith(CODEX_CIMD_CLIENT_ID, expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }));
    expect(await store.getClient(CODEX_CIMD_CLIENT_ID)).toEqual(client);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 300_000;
    await store.getClient(CODEX_CIMD_CLIENT_ID);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [], ['https://evil.example/callback'], [...callbacks, 'https://evil.example/callback'],
    ['http://127.0.0.1/callback#'], ['http://user@localhost/callback'], ['http://127.1/callback'],
    ['http://localhost/else/../callback'], ['http://localhost/callback?'], ['http://localhost:0/callback'],
    ['http://localhost:65536/callback']
  ].map((redirects) => [redirects]))('rechaza metadata Codex con callbacks ajenos %j', async (redirects) => {
    const store = new ClaudeClientsStore({ fetch: async () => json(metadata(redirects)) });
    expect(await store.getClient(CODEX_CIMD_CLIENT_ID)).toBeUndefined();
  });

  it('rechaza metadata de otro cliente, auth privada, redirects y exceso de tamaño', async () => {
    for (const fetch of [
      async () => json({ ...metadata(), client_id: 'otro' }),
      async () => json({ ...metadata(), token_endpoint_auth_method: 'client_secret_basic' }),
      async () => new Response('', { status: 302, headers: { location: 'https://evil.example' } }),
      async () => json({ ...metadata(), client_name: 'x'.repeat(65536) })
    ]) expect(await new ClaudeClientsStore({ fetch }).getClient(CODEX_CIMD_CLIENT_ID)).toBeUndefined();
  });

  it('DCR conserva cada conjunto de hosts y nunca equipara localhost con 127.0.0.1', async () => {
    const store = new ClaudeClientsStore();
    for (const redirects of [[callbacks[0]!], [callbacks[1]!], callbacks]) {
      const client = await store.registerClient({ redirect_uris: redirects });
      expect((await store.getClient(client.client_id))?.redirect_uris).toEqual(redirects);
      for (const uri of callbacks) expect(isAllowedRedirectUri(client, uri.replace('/callback', ':54321/callback'))).toBe(redirects.includes(uri));
    }
    const client = await store.registerClient({ redirect_uris: ['http://localhost:54322/callback'] });
    expect(client.redirect_uris).toEqual([callbacks[1]]);
    expect(isAllowedRedirectUri(client, 'http://localhost:54323/callback')).toBe(true);
    expect(isAllowedRedirectUri(client, 'http://127.0.0.1:54323/callback')).toBe(false);
    await expect(store.registerClient({ redirect_uris: [...callbacks, 'http://evil.example/callback'] })).rejects.toThrow();
    expect(await store.getClient('hebra-mcp-codex-evil')).toBeUndefined();
  });

  it('puertos válidos y ruta exacta; aliases, userinfo y sufijos se rechazan antes del matcher SDK', () => {
    for (const uri of ['http://localhost:1/callback', 'http://127.0.0.1:65535/callback', ...callbacks]) expect(isCodexCallback(uri)).toBe(true);
    for (const uri of ['http://127.0.0.1:54321/callback#', 'http://localhost/callback?',
      'http://user@localhost/callback', 'http://localhost:00080/callback', 'http://2130706433/callback',
      'http://localhost./callback', 'http://[::1]/callback', 'http://localhost/call%62ack',
      'http://localhost/callback\n', 'http://localhost/callback\r']) expect(isCodexCallback(uri)).toBe(false);
  });
});

describe('cliente OAuth Mistral Vibe', () => {
  it('DCR restringido: client_name exacto y callbacks solo en 127.0.0.1, reducidos al cliente fijo', async () => {
    const store = new ClaudeClientsStore();
    const client = await store.registerClient({ client_name: VIBE_CLIENT_NAME,
      redirect_uris: ['http://127.0.0.1:47823/callback'], token_endpoint_auth_method: 'none' });
    expect(client).toMatchObject({ client_id: VIBE_DCR_CLIENT_ID, client_name: VIBE_CLIENT_NAME,
      redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' });
    expect(await store.getClient(VIBE_DCR_CLIENT_ID)).toMatchObject({ redirect_uris: ['http://127.0.0.1/callback'] });
    expect(isAcceptableOAuthClientId(VIBE_DCR_CLIENT_ID)).toBe(true);
    // La metadata pedida no amplía nada: puerto relajado, nunca localhost ni otro host.
    expect(isAllowedRedirectUri(client, 'http://127.0.0.1:54321/callback')).toBe(true);
    for (const uri of ['http://localhost:54321/callback', 'http://127.0.0.1:54321/otro',
      'http://evil.example/callback', CLAUDE_CALLBACK]) expect(isAllowedRedirectUri(client, uri)).toBe(false);
  });

  it('un registro con el nombre de Vibe pero callbacks ajenos se rechaza entero', async () => {
    const store = new ClaudeClientsStore();
    for (const redirects of [[], ['http://localhost:47823/callback'], ['http://127.0.0.1:47823/callback', 'http://evil.example/callback']]) {
      await expect(store.registerClient({ client_name: VIBE_CLIENT_NAME, redirect_uris: redirects }))
        .rejects.toThrow();
    }
  });

  it('sin el nombre de Vibe, un callback loopback sigue siendo Codex', async () => {
    const store = new ClaudeClientsStore();
    const codex = await store.registerClient({ redirect_uris: ['http://127.0.0.1:54321/callback'] });
    expect(codex.client_id).toBe('hebra-mcp-codex-127');
    for (const uri of ['http://127.0.0.1:47823/callback', 'http://127.0.0.1/callback']) expect(isVibeCallback(uri)).toBe(true);
    for (const uri of ['http://localhost:47823/callback', 'http://127.0.0.1/callback?', 'https://127.0.0.1/callback']) {
      expect(isVibeCallback(uri)).toBe(false);
    }
  });
});

describe('cliente OAuth Le Chat', () => {
  it('DCR restringido: client_name y callback exactos, reducidos al cliente fijo y sin native', async () => {
    const store = new ClaudeClientsStore();
    const client = await store.registerClient({ client_name: LECHAT_CLIENT_NAME, redirect_uris: [LECHAT_CALLBACK],
      token_endpoint_auth_method: 'none', scope: 'hebra:mcp' });
    expect(client).toMatchObject({ client_id: LECHAT_DCR_CLIENT_ID, client_name: 'Le Chat',
      redirect_uris: [LECHAT_CALLBACK], token_endpoint_auth_method: 'none' });
    expect(client).not.toHaveProperty('application_type', 'native');
    expect(client).not.toHaveProperty('scope');
    expect(await store.getClient(LECHAT_DCR_CLIENT_ID)).toMatchObject({ client_name: 'Le Chat', redirect_uris: [LECHAT_CALLBACK] });
    expect(isAcceptableOAuthClientId(LECHAT_DCR_CLIENT_ID)).toBe(true);
  });

  it('el nombre de Le Chat con un redirect distinto se rechaza entero', async () => {
    const store = new ClaudeClientsStore();
    const bad = [
      'https://evil.example/v1/integrations_auth/oauth2_callback',
      'http://callback.mistral.ai/v1/integrations_auth/oauth2_callback',
      `${LECHAT_CALLBACK}?x=1`, `${LECHAT_CALLBACK}/`, `${LECHAT_CALLBACK}#f`,
      'https://callback.mistral.ai:8443/v1/integrations_auth/oauth2_callback',
      'https://CALLBACK.mistral.ai/v1/integrations_auth/oauth2_callback', 'http://127.0.0.1/callback'
    ];
    for (const uri of bad) {
      await expect(store.registerClient({ client_name: LECHAT_CLIENT_NAME, redirect_uris: [uri] })).rejects.toThrow();
    }
    await expect(store.registerClient({ client_name: LECHAT_CLIENT_NAME, redirect_uris: [] })).rejects.toThrow();
    await expect(store.registerClient({ client_name: LECHAT_CLIENT_NAME, redirect_uris: [LECHAT_CALLBACK, 'https://evil.example/cb'] }))
      .rejects.toThrow();
  });

  it('el callback de Le Chat con otro client_name se rechaza', async () => {
    const store = new ClaudeClientsStore();
    for (const client_name of [undefined, 'Claude', 'Le Chat', 'Mistral Vibe']) {
      await expect(store.registerClient({ client_name, redirect_uris: [LECHAT_CALLBACK] })).rejects.toThrow();
    }
  });

  it('isAllowedRedirectUri es exacto, sin relajación de puerto', async () => {
    const client = (await new ClaudeClientsStore().getClient(LECHAT_DCR_CLIENT_ID))!;
    expect(isAllowedRedirectUri(client, LECHAT_CALLBACK)).toBe(true);
    for (const uri of [`${LECHAT_CALLBACK}/`, `${LECHAT_CALLBACK}?a=b`, CLAUDE_CALLBACK, 'http://127.0.0.1:54321/callback',
      'https://callback.mistral.ai:443/v1/integrations_auth/oauth2_callback']) expect(isAllowedRedirectUri(client, uri)).toBe(false);
  });
});

describe('cliente OAuth Claude Code (D22)', () => {
  const doc = (redirects: unknown = callbacks, extra: object = {}) => ({ client_id: CLAUDE_CODE_CIMD_CLIENT_ID,
    client_name: 'Claude Code', redirect_uris: redirects, token_endpoint_auth_method: 'none', ...extra });

  it('acepta el CIMD oficial con ambos callbacks loopback y lo nombra Claude Code', async () => {
    const fetch = vi.fn(async () => json(doc()));
    const client = await new ClaudeClientsStore({ fetch }).getClient(CLAUDE_CODE_CIMD_CLIENT_ID);
    expect(client).toMatchObject({ client_id: CLAUDE_CODE_CIMD_CLIENT_ID, client_name: 'Claude Code',
      redirect_uris: callbacks, application_type: 'native', token_endpoint_auth_method: 'none' });
    expect(fetch).toHaveBeenCalledWith(CLAUDE_CODE_CIMD_CLIENT_ID, expect.objectContaining({ redirect: 'manual' }));
    expect(isAcceptableOAuthClientId(CLAUDE_CODE_CIMD_CLIENT_ID)).toBe(true);
  });

  it('el nombre del consentimiento no sale de la metadata remota', async () => {
    const client = await new ClaudeClientsStore({ fetch: async () => json(doc(callbacks, { client_name: 'Otro' })) })
      .getClient(CLAUDE_CODE_CIMD_CLIENT_ID);
    expect(client?.client_name).toBe('Claude Code');
  });

  it('puerto dinámico válido; sin equiparar hosts ni aceptar el callback web', async () => {
    const client = (await new ClaudeClientsStore({ fetch: async () => json(doc()) }).getClient(CLAUDE_CODE_CIMD_CLIENT_ID))!;
    for (const uri of ['http://127.0.0.1:54321/callback', 'http://localhost:1/callback', 'http://localhost:65535/callback', ...callbacks]) {
      expect(isAllowedRedirectUri(client, uri)).toBe(true);
    }
    for (const uri of ['http://localhost:0/callback', 'http://localhost:65536/callback', 'http://evil.example:54321/callback',
      'http://127.0.0.1:54321/callback?x=1', 'http://127.0.0.1:54321/callback#f', 'http://user@127.0.0.1:54321/callback',
      'http://[::1]:54321/callback', 'https://localhost:54321/callback', CLAUDE_CALLBACK]) {
      expect(isAllowedRedirectUri(client, uri)).toBe(false);
    }
    const only127 = (await new ClaudeClientsStore({ fetch: async () => json(doc([callbacks[0]])) }).getClient(CLAUDE_CODE_CIMD_CLIENT_ID))!;
    expect(isAllowedRedirectUri(only127, 'http://127.0.0.1:54321/callback')).toBe(true);
    expect(isAllowedRedirectUri(only127, 'http://localhost:54321/callback')).toBe(false);
  });

  it.each([
    [[]], [['https://evil.example/callback']], [[...callbacks, 'https://evil.example/callback']],
    [[CLAUDE_CALLBACK]], [[...callbacks, CLAUDE_CALLBACK]], [['http://localhost/callback?']], [['http://user@localhost/callback']],
    [['http://127.0.0.1/callback#']], [['http://localhost:65536/callback']]
  ])('rechaza metadata con callbacks ajenos %j', async (redirects) => {
    expect(await new ClaudeClientsStore({ fetch: async () => json(doc(redirects)) }).getClient(CLAUDE_CODE_CIMD_CLIENT_ID)).toBeUndefined();
  });

  it('rechaza otro client_id en el documento y auth privada', async () => {
    for (const body of [doc(callbacks, { client_id: 'otro' }), doc(callbacks, { token_endpoint_auth_method: 'client_secret_basic' })]) {
      expect(await new ClaudeClientsStore({ fetch: async () => json(body) }).getClient(CLAUDE_CODE_CIMD_CLIENT_ID)).toBeUndefined();
    }
  });

  it('otro CIMD de claude.ai con callbacks loopback se rechaza; el web sigue igual', async () => {
    const other = 'https://claude.ai/oauth/other-client-metadata';
    const fetch = vi.fn(async () => json({ ...doc(callbacks), client_id: other }));
    expect(await new ClaudeClientsStore({ fetch }).getClient(other)).toBeUndefined();
    const web = await new ClaudeClientsStore({ fetch: async () => json({ ...doc([CLAUDE_CALLBACK]), client_id: other }) }).getClient(other);
    expect(web?.redirect_uris).toEqual([CLAUDE_CALLBACK]);
    expect(isAllowedRedirectUri(web!, 'http://localhost:54321/callback')).toBe(false);
    for (const id of [`${CLAUDE_CODE_CIMD_CLIENT_ID}?x=1`, `${CLAUDE_CODE_CIMD_CLIENT_ID}#`, 'https://claude.ai:8443/oauth/claude-code-client-metadata',
      'http://claude.ai/oauth/claude-code-client-metadata']) expect(isAcceptableCimdClientId(id)).toBe(false);
  });
});
