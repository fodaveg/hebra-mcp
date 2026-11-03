import { lstat, mkdir, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WriterLock } from '../lock/writer-lock';
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
    const exclusive = await lockAccountLibraries(accountDataDir(this.options.dataDir, account));
    let erased = false;
    try {
      if (account.removalPhase !== 'remote-revoked' && account.removalPhase !== 'data-erased') {
        await this.options.revokeDevice(account);
        account = await this.options.registry.advanceRemoval(account, 'remote-revoked');
      }
      if (account.removalPhase !== 'data-erased') {
        if (account.storage === 'legacy-root') {
          await eraseLegacyAccountData({ dataDir: this.options.dataDir, secrets: this.options.legacySecrets,
            eraseEntry: exclusive.erase,
            cleanupShared: this.options.cleanupLegacyShared
              ? () => this.options.cleanupLegacyShared!(account!)
              : undefined });
        } else {
          await exclusive.erase(accountDataDir(this.options.dataDir, account));
        }
        account = await this.options.registry.advanceRemoval(account, 'data-erased');
      }
      await this.options.registry.finishRemoval(account);
      erased = true;
    } finally {
      await exclusive.release(erased, account.storage === 'account-dir');
    }
  }
}

/** Own every existing writer mutex before revoking or deleting. New library openings
 * consult the durable registry first, so a reader cannot create a cache after this scan.
 * Mutex files stay in place throughout deletion and the final durable state transition.
 */
async function lockAccountLibraries(directory: string): Promise<{
  erase(path: string): Promise<void>;
  release(erased: boolean, eraseRoot: boolean): Promise<void>;
}> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const locks: WriterLock[] = [];
  const protectedPaths = new Set<string>();
  const directories = new Set<string>();
  const acquire = async (path: string): Promise<void> => {
    // WriterLock permits replacement by the same PID for restart fixtures. Removal
    // must also respect a library still owned by another context in this process.
    try {
      const current = JSON.parse(await readFile(join(path, 'writer.lock'), 'utf8')) as { pid?: unknown };
      if (current.pid === process.pid) throw new Error('account_writer_busy');
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const lock = new WriterLock({ dataDir: path });
    if (!lock.tryAcquire()) throw new Error('account_writer_busy');
    locks.push(lock);
    protectedPaths.add(lock.path);
    if (path !== directory) directories.add(path);
  };
  try {
    await acquire(directory);
    const spaces = join(directory, 'spaces');
    let entries;
    try { entries = await readdir(spaces, { withFileTypes: true }); directories.add(spaces); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const entry of entries ?? []) {
      if (entry.isDirectory()) await acquire(join(spaces, entry.name));
    }
  } catch (error) {
    for (const lock of locks.reverse()) lock.release();
    throw error;
  }
  const erase = async (path: string): Promise<void> => {
    if (protectedPaths.has(path)) return;
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory()) { await rm(path, { force: true }); return; }
    directories.add(path);
    for (const entry of await readdir(path)) await erase(join(path, entry));
    // Keep directories containing a held mutex; remove empty scaffolding after release.
  };
  return { erase, async release(erased, eraseRoot) {
    for (const lock of locks.reverse()) lock.release();
    if (!erased) return;
    if (eraseRoot) directories.add(directory);
    for (const path of [...directories].sort((a, b) => b.length - a.length)) {
      try { await rmdir(path); }
      catch (error) {
        // Non-recursive: never delete data if a new owner appeared after releasing.
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
  } };
}
