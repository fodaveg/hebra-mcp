import type { ServerContext } from '../server/context';
import type { ServeContext } from '../server/serve';
import type { AccountRef, AuthorizedAccount } from './types';
import type { AccountRegistry } from './registry';

export interface AccountContextLease {
  ctx: ServerContext;
  release(): void;
}

type OpenAccount = (account: AuthorizedAccount) => Promise<ServeContext>;

interface Entry {
  account: AuthorizedAccount;
  opening: Promise<ServeContext>;
  context: ServeContext | null;
  leases: number;
  draining: boolean;
  idle: Array<() => void>;
}

function guardedContext(ctx: ServerContext, registry: AccountRegistry, account: AuthorizedAccount): ServerContext {
  const accountActive = async (): Promise<void> => { registry.assertActive(account); };
  const authorize = async (): Promise<void> => {
    await accountActive();
    await ctx.authorize?.();
    await accountActive();
  };
  const spaces = ctx.spaces ? {
    list: async () => {
      await accountActive();
      const result = await ctx.spaces!.list();
      await accountActive();
      return result;
    },
    resolve: async (spaceId: string) => {
      await accountActive();
      const selected = await ctx.spaces!.resolve(spaceId);
      await accountActive();
      return guardedContext(selected, registry, account);
    }
  } : undefined;
  return { ...ctx, spaces, authorize };
}

/** Una apertura compartida por cuenta; una retirada impide adquirir y espera los leases vivos. */
export class AccountContexts {
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  constructor(private readonly registry: AccountRegistry, private readonly open: OpenAccount,
    private readonly maxOpen = 2) {}

  async acquire(account: AuthorizedAccount): Promise<AccountContextLease> {
    if (this.closed) throw new Error('contexts_closed');
    this.registry.assertActive(account);
    let entry = this.entries.get(account.id);
    if (!entry) {
      if (this.entries.size >= this.maxOpen) throw new Error('too_many_open_accounts');
      const opening = this.open(account);
      entry = { account, opening, context: null, leases: 0, draining: false, idle: [] };
      this.entries.set(account.id, entry);
      try { entry.context = await opening; }
      catch (error) { this.entries.delete(account.id); throw error; }
    } else {
      await entry.opening;
    }
    this.registry.assertActive(account);
    if (entry.draining || entry.account.generation !== account.generation || !entry.context) {
      throw new Error('account_inactive');
    }
    entry.leases += 1;
    let released = false;
    return { ctx: guardedContext(entry.context.ctx, this.registry, account), release: () => {
      if (released) return;
      released = true;
      entry!.leases -= 1;
      if (entry!.leases === 0) for (const wake of entry!.idle.splice(0)) wake();
    } };
  }

  async drainAndClose(ref: AccountRef): Promise<void> {
    const entry = this.entries.get(ref.id);
    if (!entry) return;
    entry.draining = true;
    if (entry.leases > 0) await new Promise<void>((resolve) => entry.idle.push(resolve));
    const context = await entry.opening;
    this.entries.delete(ref.id);
    await context.close();
  }

  async close(): Promise<void> {
    this.closed = true;
    const refs = [...this.entries.values()].map((entry) => entry.account);
    await Promise.all(refs.map((ref) => this.drainAndClose(ref)));
  }

  beginShutdown(): void {
    this.closed = true;
    for (const entry of this.entries.values()) entry.context?.instance.beginShutdown();
  }
}

