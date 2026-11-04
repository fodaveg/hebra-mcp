/**
 * El índice de hash a familia de `TokenStore` (D22) da lo mismo que recorrer las familias: ningún
 * cambio (rotar, revocar, cortar, caducar) deja un token que ya no vale resolviendo.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_MS, TokenStore } from '../../src/oauth/token-store';

const CLIENT = 'hebra-mcp-claude-ai';
const RESOURCE = 'https://mcp.hebra.pro/mcp';
const NOW = Date.parse('2026-11-04T08:00:00.000Z');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function open(clock: { now: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-token-index-'));
  dirs.push(dir);
  return TokenStore.open(dir, () => clock.now);
}

function issue(store: TokenStore, sub: string) {
  return store.issueFamily({ clientId: CLIENT, scope: 'hebra:mcp', resource: RESOURCE, authorizedAt: NOW,
    grant: { active: true, credentialId: randomUUID(), clientId: CLIENT, resource: RESOURCE, scope: 'hebra:mcp',
      accountId: sub, pairedCredentialId: randomUUID(), syncVaultId: 'ab'.repeat(16), opaqueDeviceId: 'cd'.repeat(16),
      expiresAt: new Date(NOW + 30 * 86400_000).toISOString() },
    identity: { sub, sid: null } }, 0, async () => undefined);
}

describe('índice de familias', () => {
  it('verifica por hash, y rotar, cortar y revocar se ven al instante', async () => {
    const clock = { now: NOW };
    const store = await open(clock);
    const a = await issue(store, 'sumego|a');
    const b = await issue(store, 'sumego|b');
    expect(store.verifyAccess(a.accessToken, 0)?.identity?.sub).toBe('sumego|a');
    expect(store.verifyAccess(b.accessToken, 0)?.identity?.sub).toBe('sumego|b');

    const rotated = await store.rotateRefresh(a.refreshToken, CLIENT, 0);
    if (!rotated.ok) throw new Error(rotated.reason);
    expect(store.verifyAccess(rotated.tokens.accessToken, 0)?.identity?.sub).toBe('sumego|a');

    expect(await store.revoke(b.accessToken, CLIENT)).toBe('family');
    expect(store.verifyAccess(b.accessToken, 0)).toBeNull();
    expect(await store.revoke(a.accessToken, 'otro-cliente')).toBe('none');
    expect(store.verifyAccess(a.accessToken, 0)).not.toBeNull();

    const familyId = store.verifyAccess(rotated.tokens.accessToken, 0)!.familyId;
    await store.dropFamily(familyId);
    expect(store.verifyAccess(rotated.tokens.accessToken, 0)).toBeNull();
    expect(store.verifyAccess(a.accessToken, 0)).toBeNull();
    expect(await store.rotateRefresh(rotated.tokens.refreshToken, CLIENT, 0)).toMatchObject({ ok: false });
  });

  it('un access caducado no resuelve, y una revocación global anterior tampoco', async () => {
    const clock = { now: NOW };
    const store = await open(clock);
    const a = await issue(store, 'sumego|a');
    expect(store.verifyAccess(a.accessToken, NOW + 1)).toBeNull();
    clock.now = NOW + ACCESS_TOKEN_TTL_MS + 1;
    expect(store.verifyAccess(a.accessToken, 0)).toBeNull();
  });

  it('abrir de nuevo desde el fichero indexa las mismas familias', async () => {
    const clock = { now: NOW };
    const store = await open(clock);
    const a = await issue(store, 'sumego|a');
    const reopened = await TokenStore.open(dirs[0]!, () => clock.now);
    expect(reopened.verifyAccess(a.accessToken, 0)?.identity?.sub).toBe('sumego|a');
  });
});
