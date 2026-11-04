/**
 * D22, SPEC.md §12.10, por el arranque real: un volumen como lo deja la imagen anterior, con
 * el almacén de fichero de producción, pasa por `startServeHttp` y `loadOAuthHttpAuth`. Solo
 * son sintéticos Lumbre y Sumego. Ninguna persona vuelve a emparejar, los refresh de Sumego
 * ya emitidos se descifran, y retirar a David no le quita nada a la otra cuenta.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRegistry, accountDataDir, openControlSecretStore, type AccountRecord } from '../../src/accounts';
import { encodeRecoveryCode } from '../../src/hebra';
import { httpConfigFor } from '../../src/http/config';
import { startServeHttp, type ServeHttpHandle } from '../../src/http/serve-http';
import { DCR_CLIENT_ID, loadOAuthHttpAuth, type OAuthHttpAuth } from '../../src/oauth';
import type { ActiveGrant } from '../../src/oauth/backchannel';
import { GrantSecrets } from '../../src/oauth/grants';
import { RefreshSealer } from '../../src/oauth/sumego-refresh';
import { TokenStore, type IssuedTokens } from '../../src/oauth/token-store';
import { CONTROL_SECRET_KEYS, openFileSecretStore, writePairedSecrets, type SecretStore } from '../../src/secrets';

const RESOURCE = 'http://127.0.0.1/mcp';
const ISSUER = 'https://id.sumego.es';
const HOUR = 60 * 60_000;
const CLIENT = { client_id: DCR_CLIENT_ID, redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } as OAuthClientInformationFull;

type Principal = 'david' | 'mikel';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (body: object, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});
const bearerOf = (who: Principal) => hash(`upstream-${who}`);
const sumegoRefreshOf = (who: Principal) => `rt-sumego-sintetico-${who}`;

let root: string;
let grants: Record<Principal, ActiveGrant>;
let records: Partial<Record<Principal, AccountRecord>>;
let tokens: Record<Principal, IssuedTokens>;
let handle: ServeHttpHandle | undefined;
let auth: OAuthHttpAuth | undefined;
let revoked: string[];
let renewed: string[];
let sumegoRefreshes: string[];
let stderr: string[];

async function pairedFor(who: Principal, index: number): Promise<Parameters<typeof writePairedSecrets>[1]> {
  const suffix = String(index + 1).padStart(12, '0');
  return {
    connection: { credentialId: grants[who].pairedCredentialId, readToken: 'read-sintetico', writeToken: 'write-sintetico',
      apiOrigin: 'https://app.lumbre.pro', connectedAt: '2026-11-01T00:00:00.000Z' },
    recoveryCode: await encodeRecoveryCode({ relayOrigin: 'https://app.lumbre.pro', syncVaultId: grants[who].syncVaultId,
      keyEpoch: 1, vaultKey: randomBytes(32) }),
    device: { opaqueDeviceId: grants[who].opaqueDeviceId, lumbreDeviceId: `30000000-0000-4000-8000-${suffix}` }
  };
}

/** Disposición anterior a D22: todo lo global dentro del `secrets.json` de la raíz. */
async function seedOldVolume(options: { registerLegacy: boolean }): Promise<void> {
  const registry = await AccountRegistry.open(root);
  if (options.registerLegacy) records.david = await registry.claimLegacy({ sub: 'david', grant: grants.david });
  records.mikel = await registry.commitAccount({ sub: 'mikel', grant: grants.mikel });
  const legacy = openFileSecretStore(root);
  await writePairedSecrets(legacy, await pairedFor('david', 0));
  const mikelDir = accountDataDir(root, records.mikel);
  await mkdir(mikelDir, { recursive: true });
  await writePairedSecrets(openFileSecretStore(mikelDir), await pairedFor('mikel', 1));
  const tokenStore = await TokenStore.open(root);
  const grantSecrets = await GrantSecrets.open(legacy, []);
  const sealer = await RefreshSealer.open(legacy);
  for (const who of ['david', 'mikel'] as const) {
    tokens[who] = await tokenStore.issueFamily({ clientId: DCR_CLIENT_ID, scope: 'hebra:mcp', resource: RESOURCE,
      grant: grants[who], authorizedAt: Date.now(), identity: { sub: who, sid: `sid-${who}` },
      sumego: { sealedRefresh: sealer.seal(sumegoRefreshOf(who)), renewedAt: Date.now() - 2 * HOUR }
    }, 0, (id, live) => grantSecrets.set(id, bearerOf(who), live));
  }
}

async function start(): Promise<void> {
  handle = await startServeHttp({ dataDir: root, secrets: openFileSecretStore(root), multiuser: true, maintenance: true,
    config: httpConfigFor('http://127.0.0.1', 0), version: '0.0.0-test', authConfigured: () => true,
    syncIntervalMs: null, instance: { checkIntervalMs: null, lock: { releaseOnExit: false } },
    fetcher: async () => json({ ok: true }),
    loadAuth: async (dataDir, config, secrets, pairing) => {
      auth = (await loadOAuthHttpAuth(dataDir, config, secrets, { pairing, multiuser: true,
        env: { HEBRA_MCP_BACKCHANNEL_SECRET: 'b'.repeat(40), HEBRA_MCP_LOGIN_PROVIDER: 'sumego',
          HEBRA_MCP_OIDC_ISSUER: ISSUER, HEBRA_MCP_OIDC_CLIENT_ID: 'hebra-mcp', HEBRA_MCP_OIDC_CLIENT_SECRET: 's'.repeat(40) },
        backchannelFetch: async (input, init) => {
          const body = JSON.parse(String(init?.body)) as { accessToken: string };
          const path = new URL(String(input)).pathname;
          const who = (['david', 'mikel'] as const).find((name) => bearerOf(name) === body.accessToken);
          if (path.endsWith('/introspect')) return json(who ? grants[who] : { active: false });
          if (path.endsWith('/renew')) { renewed.push(body.accessToken); return json({ active: true, expiresAt: grants.david.expiresAt }); }
          if (path.endsWith('/revoke')) { revoked.push(body.accessToken); return json({ revoked: true }); }
          throw new Error('unexpected_backchannel_route');
        },
        sumegoFetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname === '/.well-known/openid-configuration') {
            return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
              jwks_uri: `${ISSUER}/jwks`, id_token_signing_alg_values_supported: ['ES256'] });
          }
          if (url.pathname === '/token') {
            const presented = new URLSearchParams(String(init?.body)).get('refresh_token')!;
            sumegoRefreshes.push(presented);
            return json({ access_token: 'acceso-sintetico', token_type: 'Bearer', refresh_token: `${presented}-rotado`, id_token: 'no-se-usa' });
          }
          throw new Error('unexpected_sumego_route');
        }
      })) as OAuthHttpAuth;
      return auth;
    } });
}

async function stored(store: SecretStore): Promise<Record<string, string | null>> {
  return Object.fromEntries(await Promise.all(CONTROL_SECRET_KEYS.map(async (key) => [key, await store.get(key)])));
}

async function refresh(who: Principal): Promise<{ refresh_token?: string; access_token: string }> {
  return auth!.provider.exchangeRefreshToken(CLIENT, tokens[who].refreshToken, undefined, new URL(RESOURCE));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hmcp-control-'));
  grants = {} as typeof grants;
  for (const [index, who] of (['david', 'mikel'] as const).entries()) {
    grants[who] = { active: true, credentialId: `20000000-0000-4000-8000-00000000000${index + 1}`, clientId: DCR_CLIENT_ID,
      resource: RESOURCE, scope: 'hebra:mcp', accountId: hash(`hebra-account:${who}`),
      pairedCredentialId: `10000000-0000-4000-8000-00000000000${index + 1}`, syncVaultId: hash(`vault-${who}`).slice(0, 32),
      opaqueDeviceId: hash(`device-${who}`).slice(0, 32), expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  }
  records = {};
  tokens = {} as typeof tokens;
  revoked = []; renewed = []; sumegoRefreshes = []; stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
});

afterEach(async () => {
  await handle?.close(); handle = undefined;
  auth = undefined;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('arrancar sobre un volumen anterior a D22', () => {
  it('migra antes de atender y las dos cuentas siguen con sus access y sus refresh, sin reemparejar', async () => {
    await seedOldVolume({ registerLegacy: true });
    const before = await stored(openFileSecretStore(root));
    const pairedBefore = await openFileSecretStore(root).get('recovery-code');

    await start();

    expect(await stored(openFileSecretStore(root))).toEqual(
      Object.fromEntries(CONTROL_SECRET_KEYS.map((key) => [key, null])));
    expect((await stored(openControlSecretStore(root)))['hebra-mcp-sumego-refresh-key'])
      .toBe(before['hebra-mcp-sumego-refresh-key']);
    expect(await openFileSecretStore(root).get('recovery-code')).toBe(pairedBefore);

    for (const who of ['david', 'mikel'] as const) {
      const verified = await auth!.provider.verifyAccessToken(tokens[who].accessToken) as { account?: { id: string } };
      expect(verified.account?.id).toBe(records[who]!.id);
      await expect(refresh(who)).resolves.toMatchObject({ access_token: expect.any(String) });
    }
    // El bearer llega sin cambios a Lumbre y el refresh de Sumego se descifra con la clave migrada.
    expect(renewed).toEqual([bearerOf('david'), bearerOf('mikel')]);
    expect(sumegoRefreshes).toEqual([sumegoRefreshOf('david'), sumegoRefreshOf('mikel')]);
    expect(revoked).toEqual([]);
    const log = stderr.join('');
    for (const secret of [bearerOf('david'), bearerOf('mikel'), before['hebra-mcp-sumego-refresh-key']!]) {
      expect(log).not.toContain(secret);
    }
  });

  it('el vínculo heredado de David se asocia con el bearer ya migrado, sin emparejar otra vez', async () => {
    await seedOldVolume({ registerLegacy: false });

    await start();

    expect(auth!.accounts.legacyAccount()).toMatchObject({ sub: 'david', storage: 'legacy-root' });
    expect(await openFileSecretStore(root).get('hebra-mcp-oauth-grants')).toBeNull();
  });

  it('retirar a David no le quita a la otra cuenta sus bearers, tampoco tras reiniciar', async () => {
    await seedOldVolume({ registerLegacy: true });
    await start();

    await handle!.removeAccount(records.david!.id);

    expect(revoked).toEqual([bearerOf('david')]);
    const control = openControlSecretStore(root);
    const grantsAfter = await control.get('hebra-mcp-oauth-grants');
    expect(grantsAfter).toContain(bearerOf('mikel'));
    expect(grantsAfter).not.toContain(bearerOf('david'));
    expect(await control.get('hebra-mcp-sumego-refresh-key')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8'))).toEqual({});
    await expect(auth!.provider.verifyAccessToken(tokens.david.accessToken)).rejects.toThrow();
    await expect(auth!.provider.verifyAccessToken(tokens.mikel.accessToken)).resolves.toBeTruthy();

    await handle!.close(); handle = undefined;
    await start();

    await expect(auth!.provider.verifyAccessToken(tokens.mikel.accessToken)).resolves.toBeTruthy();
    await expect(refresh('mikel')).resolves.toMatchObject({ access_token: expect.any(String) });
    expect(sumegoRefreshes).toEqual([sumegoRefreshOf('mikel')]);
    expect(renewed).toEqual([bearerOf('mikel')]);
  });

  it('un conflicto de secretos no llega a escuchar y conserva las dos fuentes', async () => {
    await seedOldVolume({ registerLegacy: true });
    await start();
    await handle!.close(); handle = undefined;
    await openFileSecretStore(root).set('hebra-mcp-oauth-grants', '{}');
    const controlBefore = await readFile(join(root, 'control', 'secrets.json'), 'utf8');

    await expect(start()).rejects.toMatchObject({ code: 'control_secrets_conflict' });

    expect(await readFile(join(root, 'control', 'secrets.json'), 'utf8')).toBe(controlBefore);
    expect(await openFileSecretStore(root).get('hebra-mcp-oauth-grants')).toBe('{}');
  });
});
