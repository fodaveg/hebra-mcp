import { rm } from 'node:fs/promises';
import type { AccountContexts } from './contexts';
import { accountDataDir, type AccountRegistry } from './registry';
import { eraseLegacyAccountData } from './legacy-inventory';
import type { AccountRecord, AccountRef } from './types';
import type { SecretStore } from '../secrets';

export interface AccountOAuthInvalidator {
  invalidateAccount(account: AccountRecord): Promise<number>;
}

export interface AccountRemovalOptions {
  dataDir: string;
  registry: AccountRegistry;
  contexts: AccountContexts;
  oauth: AccountOAuthInvalidator;
  /** Debe confirmar en Lumbre la revocación de la credencial de esta instalación. */
  revokeDevice(account: AccountRecord): Promise<void>;
  /** Store mixto de la raíz: se borran solo las claves personales del inventario. */
  legacySecrets: SecretStore;
  /** Diarios/filas personales de módulos que comparten un store global. */
  cleanupLegacyShared?(account: AccountRecord): Promise<void>;
}

/** Retirada reiniciable: lápida, OAuth, drenaje, revocación remota y solo entonces datos. */
export class AccountRemovalService {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly options: AccountRemovalOptions) {}

  remove(ref: AccountRef): Promise<void> {
    const current = this.running.get(ref.id);
    if (current) return current;
    const operation = this.run(ref).finally(() => { this.running.delete(ref.id); });
    this.running.set(ref.id, operation);
    return operation;
  }

  async resumePending(): Promise<void> {
    await Promise.allSettled(this.options.registry.removingAccounts().map((account) => this.remove(account)));
  }

  private async run(ref: AccountRef): Promise<void> {
    let account = this.options.registry.findById(ref.id);
    if (!account) throw new Error('account_not_found');
    if (account.state === 'removed') return;
    if (account.state === 'active') {
      if (account.generation !== ref.generation) throw new Error('account_inactive');
      account = await this.options.registry.beginRemoval(ref);
    } else if (account.state !== 'removing') {
      throw new Error('account_inactive');
    }

    await this.options.oauth.invalidateAccount(account);
    await this.options.contexts.drainAndClose(account);
    if (account.removalPhase !== 'remote-revoked' && account.removalPhase !== 'data-erased') {
      await this.options.revokeDevice(account);
      account = await this.options.registry.advanceRemoval(account, 'remote-revoked');
    }
    if (account.removalPhase !== 'data-erased') {
      if (account.storage === 'legacy-root') {
        await eraseLegacyAccountData({ dataDir: this.options.dataDir, secrets: this.options.legacySecrets,
          cleanupShared: this.options.cleanupLegacyShared
            ? () => this.options.cleanupLegacyShared!(account!)
            : undefined });
      } else {
        await rm(accountDataDir(this.options.dataDir, account), { recursive: true, force: true });
      }
      account = await this.options.registry.advanceRemoval(account, 'data-erased');
    }
    await this.options.registry.finishRemoval(account);
  }
}
