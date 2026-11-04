import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountRegistry, accountAccessGuard, accountDataDir } from '../../src/accounts/registry';
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
  it.each(['legacy-root', 'account-dir'] as const)('relee la lápida %s sin depender del registro en memoria', async (storage) => {
    const store = await registry();
    const directory = dirs.at(-1)!;
    const account = storage === 'legacy-root'
      ? await store.claimLegacy({ sub: 'owner', grant: grant('a'.repeat(64), '01') })
      : await store.commitAccount({ sub: 'owner', grant: grant('a'.repeat(64), '01') });
    const guard = accountAccessGuard(accountDataDir(directory, account));
    expect(guard).not.toThrow();
    const remover = await AccountRegistry.open(directory);
    const removing = await remover.beginRemoval(account);
    expect(() => store.assertActive(account)).not.toThrow();
    expect(guard).toThrow('account_inactive');
    await remover.advanceRemoval(removing, 'data-erased');
    await remover.finishRemoval(removing);
    expect(accountAccessGuard(accountDataDir(directory, account))).toThrow('account_inactive');
    await rm(join(directory, 'accounts-v1.json'));
    expect(guard).toThrow('account_inactive');
  });

  it('una biblioteca standalone sigue permitida sin registro multiusuario', async () => {
    await registry();
    expect(accountAccessGuard(dirs.at(-1)!)).not.toThrow();
  });

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

  describe('renovación', () => {
    it('bloquea, publica vínculo y generación en una sola escritura y sobrevive a reabrir', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'hebra-accounts-'));
      dirs.push(dir);
      const store = await AccountRegistry.open(dir);
      const oldGrant = grant('a'.repeat(64), '01');
      const account = await store.commitAccount({ sub: 'david', grant: oldGrant });
      const held = await store.beginRenewal(account, 'diario-1');
      expect(held).toMatchObject({ generation: account.generation + 1, renewing: 'diario-1' });
      expect(store.authorize(oldGrant, 'david')).toBeNull();
      expect(() => store.assertActive(held)).toThrow('account_inactive');
      await expect(store.beginRenewal(held, 'diario-2')).rejects.toThrow('account_inactive');
      const fresh = { ...oldGrant, pairedCredentialId: 'nueva-credencial' };
      const committed = await store.commitRenewal(held, 'diario-1', { sub: 'david', grant: fresh });
      expect(committed).toMatchObject({ generation: held.generation + 1, renewedBy: 'diario-1',
        binding: { pairedCredentialId: 'nueva-credencial' } });
      expect(committed.renewing).toBeUndefined();
      expect(() => store.assertActive(account)).toThrow('account_inactive');
      const reopened = await AccountRegistry.open(dir);
      expect(reopened.authorize(fresh, 'david')).toMatchObject({ id: account.id, generation: committed.generation });
      expect(reopened.authorize(oldGrant, 'david')).toBeNull();
    });

    it('una persona no renueva sobre la cuenta de otra ni cambia de bóveda', async () => {
      const store = await registry();
      const oldGrant = grant('a'.repeat(64), '01');
      const account = await store.commitAccount({ sub: 'david', grant: oldGrant });
      const held = await store.beginRenewal(account, 'diario-1');
      await expect(store.commitRenewal(held, 'diario-1', { sub: 'mikel', grant: oldGrant }))
        .rejects.toThrow('renewal_owner_conflict');
      await expect(store.commitRenewal(held, 'diario-1', { sub: 'david', grant: { ...oldGrant, accountId: 'b'.repeat(64) } }))
        .rejects.toThrow('renewal_owner_conflict');
      await expect(store.commitRenewal(held, 'diario-1', { sub: 'david', grant: { ...oldGrant, syncVaultId: 'otra-boveda' } }))
        .rejects.toThrow('renewal_owner_conflict');
      await expect(store.commitRenewal(held, 'diario-ajeno', { sub: 'david', grant: oldGrant }))
        .rejects.toThrow('account_inactive');
      expect(store.findById(account.id)).toMatchObject({ sub: 'david', renewing: 'diario-1' });
    });

    it('un vínculo de otra cuenta no se puede publicar encima', async () => {
      const store = await registry();
      const davidGrant = grant('a'.repeat(64), '01');
      const account = await store.commitAccount({ sub: 'david', grant: davidGrant });
      const twin = { ...davidGrant, pairedCredentialId: 'gemela' };
      await store.commitAccount({ sub: 'mikel', grant: twin });
      const held = await store.beginRenewal(account, 'diario-1');
      await expect(store.commitRenewal(held, 'diario-1', { sub: 'david', grant: twin })).rejects.toThrow('account_exists');
    });

    it('soltarla sube la generación, y sin bloqueo de ese diario no hace nada', async () => {
      const store = await registry();
      const oldGrant = grant('a'.repeat(64), '01');
      const account = await store.commitAccount({ sub: 'david', grant: oldGrant });
      const held = await store.beginRenewal(account, 'diario-1');
      await store.abortRenewal(account.id, 'diario-ajeno');
      expect(store.findById(account.id)?.renewing).toBe('diario-1');
      await store.abortRenewal(account.id, 'diario-1');
      const after = store.findById(account.id)!;
      expect(after.renewing).toBeUndefined();
      expect(after.generation).toBe(held.generation + 1);
      expect(store.authorize(oldGrant, 'david')).toMatchObject({ generation: after.generation });
      await store.abortRenewal(account.id, 'diario-1');
      expect(store.findById(account.id)?.generation).toBe(after.generation);
    });

    it('el legado sin reclamar lo renueva quien tiene su accountId, y solo entonces se le asigna', async () => {
      const store = await registry();
      const legacyGrant = grant('a'.repeat(64), '01');
      const legacy = await store.bootstrapLegacy({ sub: null, grant: legacyGrant });
      expect(store.unclaimedLegacyOf('b'.repeat(64))).toBeNull();
      expect(store.unclaimedLegacyOf('a'.repeat(64))).toMatchObject({ id: 'legacy' });
      const held = await store.beginRenewal(legacy, 'diario-1');
      await expect(store.commitRenewal(held, 'diario-1', { sub: 'mikel', grant: { ...legacyGrant, accountId: 'b'.repeat(64) } }))
        .rejects.toThrow('renewal_owner_conflict');
      const committed = await store.commitRenewal(held, 'diario-1', { sub: 'david', grant: legacyGrant });
      expect(committed.sub).toBe('david');
      expect(store.unclaimedLegacyOf('a'.repeat(64))).toBeNull();
    });
  });
});

