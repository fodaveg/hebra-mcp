import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountRegistry } from '../../src/accounts/registry';
import type { ActiveGrant } from '../../src/oauth/backchannel';

const dirs: string[] = [];
const grant = (accountId: string, suffix: string): ActiveGrant => ({
  active: true,
  credentialId: `00000000-0000-4000-8000-0000000000${suffix}`,
  clientId: 'hebra-mcp-claude', resource: 'https://mcp.hebra.pro/mcp', scope: 'hebra:mcp',
  accountId, expiresAt: '2026-12-01T00:00:00.000Z',
  pairedCredentialId: `10000000-0000-4000-8000-0000000000${suffix}`,
  syncVaultId: suffix.padStart(32, '1'), opaqueDeviceId: suffix.padStart(32, '2')
});

afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true }); });
async function registry(): Promise<AccountRegistry> {
  const dir = await mkdtemp(join(tmpdir(), 'hebra-accounts-'));
  dirs.push(dir);
  return AccountRegistry.open(dir);
}

describe('AccountRegistry', () => {
  it('el legado solo se reclama por el mismo sub, accountId y binding', async () => {
    const store = await registry();
    const original = grant('a'.repeat(64), '01');
    const record = await store.claimLegacy({ sub: 'david', grant: original });
    expect(record).toMatchObject({ id: 'legacy', sub: 'david', storage: 'legacy-root', state: 'active' });
    expect(store.authorize(original, 'david')).toMatchObject({ id: 'legacy', generation: 1 });
    expect(store.authorize(original, 'mikel')).toBeNull();
    await expect(store.claimLegacy({ sub: 'mikel', grant: original })).rejects.toThrow('legacy_owner_conflict');
    await expect(store.claimLegacy({ sub: 'david', grant: grant('b'.repeat(64), '02') }))
      .rejects.toThrow('legacy_owner_conflict');
  });

  it('dos cuentas con una organización común siguen resolviendo contextos personales distintos', async () => {
    const store = await registry();
    const davidGrant = grant('a'.repeat(64), '01');
    const mikelGrant = grant('b'.repeat(64), '02');
    await store.claimLegacy({ sub: 'david', grant: davidGrant });
    const mikel = await store.commitAccount({ sub: 'mikel', grant: mikelGrant });
    expect(store.authorize(davidGrant, 'mikel')).toBeNull();
    expect(store.authorize(mikelGrant, 'david')).toBeNull();
    expect(store.authorize(mikelGrant, 'mikel')).toMatchObject({ id: mikel.id, storage: 'account-dir' });
  });

  it('el tombstone persiste antes del drenaje y no se reactiva al reabrir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hebra-accounts-'));
    dirs.push(dir);
    const store = await AccountRegistry.open(dir);
    const current = await store.claimLegacy({ sub: 'david', grant: grant('a'.repeat(64), '01') });
    const removing = await store.beginRemoval(current);
    expect(removing).toMatchObject({ state: 'removing', generation: 2 });
    expect(store.authorize(grant('a'.repeat(64), '01'), 'david')).toBeNull();
    const reopened = await AccountRegistry.open(dir);
    expect(reopened.findBySub('david')).toMatchObject({ state: 'removing', generation: 2 });
    await expect(reopened.claimLegacy({ sub: 'david', grant: grant('a'.repeat(64), '01') }))
      .rejects.toThrow('legacy_owner_conflict');
    const raw = JSON.parse(await readFile(join(dir, 'accounts-v1.json'), 'utf8')) as { accounts: unknown[] };
    expect(raw.accounts).toHaveLength(1);
  });
});

