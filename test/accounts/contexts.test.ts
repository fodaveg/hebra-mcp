import { describe, expect, it } from 'vitest';
import { AccountContexts } from '../../src/accounts/contexts';
import type { AccountRegistry } from '../../src/accounts/registry';
import type { AuthorizedAccount } from '../../src/accounts/types';
import type { ServeContext } from '../../src/server/serve';

const account = (id: string, generation = 1): AuthorizedAccount => ({ id, generation,
  storage: id === 'legacy' ? 'legacy-root' : 'account-dir',
  binding: { pairedCredentialId: `${id}-credential`, syncVaultId: `${id}-vault`, opaqueDeviceId: `${id}-device` } });

describe('AccountContexts', () => {
  it('comparte una sola apertura por cuenta y nunca cruza contextos', async () => {
    const active = new Map([['legacy', 1], ['mikel', 1]]);
    const registry = { assertActive(ref: AuthorizedAccount) {
      if (active.get(ref.id) !== ref.generation) throw new Error('account_inactive');
    } } as AccountRegistry;
    const opened: string[] = [];
    const closed: string[] = [];
    const contexts = new AccountContexts(registry, async (entry): Promise<ServeContext> => {
      opened.push(entry.id);
      return { ctx: { account: entry.id } as never, instance: {} as never, linked: true,
        close: async () => { closed.push(entry.id); } };
    });
    const [david1, david2, mikel] = await Promise.all([
      contexts.acquire(account('legacy')), contexts.acquire(account('legacy')), contexts.acquire(account('mikel'))
    ]);
    expect(opened.sort()).toEqual(['legacy', 'mikel']);
    expect((david1.ctx as unknown as { account: string }).account).toBe('legacy');
    expect((david2.ctx as unknown as { account: string }).account).toBe('legacy');
    expect((mikel.ctx as unknown as { account: string }).account).toBe('mikel');
    david1.release(); david2.release(); mikel.release();
    await contexts.close();
    expect(closed.sort()).toEqual(['legacy', 'mikel']);
  });

  it('una retirada bloquea adquisiciones nuevas y espera el lease vivo', async () => {
    let generation = 1;
    const registry = { assertActive(ref: AuthorizedAccount) {
      if (generation !== ref.generation) throw new Error('account_inactive');
    } } as AccountRegistry;
    let closed = false;
    const contexts = new AccountContexts(registry, async (): Promise<ServeContext> => ({
      ctx: {} as never, instance: {} as never, linked: true, close: async () => { closed = true; }
    }));
    const ref = account('legacy');
    const lease = await contexts.acquire(ref);
    generation = 2;
    const draining = contexts.drainAndClose(ref);
    await expect(contexts.acquire(ref)).rejects.toThrow('account_inactive');
    expect(closed).toBe(false);
    lease.release();
    await draining;
    expect(closed).toBe(true);
  });

  it('vuelve a comprobar la generación justo antes de publicar una respuesta', async () => {
    let generation = 1;
    const registry = { assertActive(ref: AuthorizedAccount) {
      if (generation !== ref.generation) throw new Error('account_inactive');
    } } as AccountRegistry;
    const contexts = new AccountContexts(registry, async (): Promise<ServeContext> => ({
      ctx: { authorize: async () => undefined } as never, instance: {} as never,
      linked: true, close: async () => undefined
    }));
    const lease = await contexts.acquire(account('mikel'));
    generation = 2;
    await expect(lease.ctx.authorize?.()).rejects.toThrow('account_inactive');
    lease.release();
    await contexts.close();
  });

  it('una apertura fallida no deja una entrada que bloquee el reintento de retirada', async () => {
    const registry = { assertActive() {} } as unknown as AccountRegistry;
    const contexts = new AccountContexts(registry, async () => { throw new Error('open_failed'); });
    const ref = account('mikel');
    await expect(contexts.acquire(ref)).rejects.toThrow('open_failed');
    await expect(contexts.drainAndClose(ref)).resolves.toBeUndefined();
    await contexts.close();
  });

  it('mantiene como máximo dos escritores sin expulsar uno con leases', async () => {
    const registry = { assertActive() {} } as unknown as AccountRegistry;
    const contexts = new AccountContexts(registry, async (): Promise<ServeContext> => ({
      ctx: {} as never, instance: {} as never, linked: true, close: async () => undefined
    }));
    const a = await contexts.acquire(account('a'));
    const b = await contexts.acquire(account('b'));
    await expect(contexts.acquire(account('c'))).rejects.toThrow('too_many_open_accounts');
    a.release(); b.release();
    await contexts.close();
  });
});
