/** Allowlist de clientes públicos: la metadata remota no amplía los callbacks. */
import { describe, expect, it, vi } from 'vitest';
import { ClaudeClientsStore, CODEX_CIMD_CLIENT_ID, isAcceptableCimdClientId, isAllowedRedirectUri, isCodexCallback } from '../../src/oauth/clients';

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
      'http://localhost./callback', 'http://[::1]/callback', 'http://localhost/call%62ack']) expect(isCodexCallback(uri)).toBe(false);
  });
});
