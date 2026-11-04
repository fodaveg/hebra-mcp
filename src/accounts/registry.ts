import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { ActiveGrant, Binding } from '../oauth/backchannel';
import type { AccountRecord, AccountRef, AuthorizedAccount, VerifiedOwnership } from './types';

const FILE_VERSION = 1;
const FILE_NAME = 'accounts-v1.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNCLAIMED_LEGACY_SUB = '__legacy_unclaimed__';

interface AccountsFile { version: 1; accounts: AccountRecord[] }
class AccountsPublishedError extends Error {}

function accountFile(dataDir: string): string { return join(dataDir, FILE_NAME); }
function isEnoent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function validBinding(value: unknown): value is Binding {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.pairedCredentialId === 'string' && typeof row.syncVaultId === 'string' &&
    typeof row.opaqueDeviceId === 'string';
}
function validRecord(value: unknown): value is AccountRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && typeof row.generation === 'number' && Number.isSafeInteger(row.generation) &&
    row.generation >= 1 && typeof row.sub === 'string' && row.sub.length > 0 &&
    typeof row.accountId === 'string' && validBinding(row.binding) &&
    (row.storage === 'legacy-root' || row.storage === 'account-dir') &&
    (row.state === 'active' || row.state === 'removing' || row.state === 'removed') &&
    (row.removalPhase === undefined || row.removalPhase === 'blocked' ||
      row.removalPhase === 'remote-revoked' || row.removalPhase === 'data-erased') &&
    (row.renewing === undefined || typeof row.renewing === 'string') &&
    (row.renewedBy === undefined || typeof row.renewedBy === 'string');
}
function validRecords(accounts: AccountRecord[]): boolean {
  const ids = new Set<string>();
  const bindings = new Set<string>();
  const currentSubs = new Set<string>();
  for (const account of accounts) {
    const binding = JSON.stringify([account.accountId, account.binding.pairedCredentialId,
      account.binding.syncVaultId, account.binding.opaqueDeviceId]);
    if (ids.has(account.id) || bindings.has(binding) ||
      (account.state !== 'removed' && currentSubs.has(account.sub))) return false;
    ids.add(account.id);
    bindings.add(binding);
    if (account.state !== 'removed') currentSubs.add(account.sub);
  }
  return true;
}
function authorized(record: AccountRecord): AuthorizedAccount {
  return { id: record.id, generation: record.generation, binding: record.binding, storage: record.storage };
}
function bindingOf(grant: ActiveGrant): Binding {
  return { pairedCredentialId: grant.pairedCredentialId, syncVaultId: grant.syncVaultId,
    opaqueDeviceId: grant.opaqueDeviceId };
}
function sameBinding(left: Binding, right: Binding): boolean {
  return left.pairedCredentialId === right.pairedCredentialId && left.syncVaultId === right.syncVaultId &&
    left.opaqueDeviceId === right.opaqueDeviceId;
}

/** Registro global pequeño. Serializa todas sus mutaciones y publica cada estado atómicamente. */
export class AccountRegistry {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly path: string, private accounts: AccountRecord[]) {}

  static async open(dataDir: string): Promise<AccountRegistry> {
    const path = accountFile(dataDir);
    let accounts: AccountRecord[] = [];
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<AccountsFile>;
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.accounts) ||
        !parsed.accounts.every(validRecord) || !validRecords(parsed.accounts)) {
        throw new Error('accounts_invalid');
      }
      accounts = parsed.accounts;
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    return new AccountRegistry(path, accounts);
  }

  private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    const committed = this.queue.then(async () => {
      const before = structuredClone(this.accounts);
      try {
        const result = await operation();
        await this.persist();
        return result;
      } catch (error) {
        // Tras rename, un fallo de fsync es ambiguo pero la versión nueva ya es visible.
        // Volver la memoria al estado anterior podría reabrir una cuenta tombstoneada.
        if (!(error instanceof AccountsPublishedError)) this.accounts = before;
        throw error;
      }
    });
    this.queue = committed.then(() => undefined, () => undefined);
    return committed;
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${FILE_NAME}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: FILE_VERSION, accounts: this.accounts } satisfies AccountsFile));
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await rename(temporary, this.path);
      let directoryHandle;
      try {
        directoryHandle = await open(directory, 'r');
        await directoryHandle.sync();
      } catch { throw new AccountsPublishedError('accounts_directory_sync_failed'); }
      finally { await directoryHandle?.close(); }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  findBySub(sub: string): AccountRecord | null {
    return structuredClone(this.accounts.find((entry) => entry.sub === sub && entry.state !== 'removed') ?? null);
  }

  findById(id: string): AccountRecord | null {
    return structuredClone(this.accounts.find((entry) => entry.id === id) ?? null);
  }

  legacyAccount(): AccountRecord | null {
    return structuredClone(this.accounts.find((entry) => entry.storage === 'legacy-root') ?? null);
  }

  removingAccounts(): AccountRecord[] {
    return structuredClone(this.accounts.filter((entry) => entry.state === 'removing'));
  }

  /** Solo una familia ya ligada al mismo dispositivo puede reclamar el directorio heredado. */
  claimLegacy(ownership: VerifiedOwnership): Promise<AccountRecord> {
    return this.mutate(() => {
      const existing = this.accounts.find((entry) => entry.storage === 'legacy-root');
      if (existing) {
        if (existing.sub === UNCLAIMED_LEGACY_SUB && existing.accountId === ownership.grant.accountId &&
          sameBinding(existing.binding, ownership.grant) && existing.state === 'active') {
          existing.sub = ownership.sub;
          return structuredClone(existing);
        }
        if (existing.sub !== ownership.sub || existing.accountId !== ownership.grant.accountId ||
          !sameBinding(existing.binding, ownership.grant) || existing.state !== 'active') {
          throw new Error('legacy_owner_conflict');
        }
        return structuredClone(existing);
      }
      if (this.accounts.some((entry) => entry.sub === ownership.sub)) throw new Error('account_exists');
      const record: AccountRecord = { id: 'legacy', generation: 1, sub: ownership.sub,
        accountId: ownership.grant.accountId, binding: bindingOf(ownership.grant), storage: 'legacy-root', state: 'active' };
      this.accounts.push(record);
      return structuredClone(record);
    });
  }

  /** Materializa el legado desde una familia ya autorizada, nunca desde el orden de login. */
  bootstrapLegacy(candidate: { sub: string | null; grant: ActiveGrant }): Promise<AccountRecord> {
    return this.mutate(() => {
      const existing = this.accounts.find((entry) => entry.storage === 'legacy-root');
      const sub = candidate.sub ?? UNCLAIMED_LEGACY_SUB;
      if (existing) {
        if (existing.accountId !== candidate.grant.accountId || !sameBinding(existing.binding, candidate.grant) ||
          existing.state === 'removed' || (candidate.sub !== null && existing.sub !== sub && existing.sub !== UNCLAIMED_LEGACY_SUB)) {
          throw new Error('legacy_owner_conflict');
        }
        if (candidate.sub !== null && existing.sub === UNCLAIMED_LEGACY_SUB) existing.sub = sub;
        return structuredClone(existing);
      }
      const record: AccountRecord = { id: 'legacy', generation: 1, sub,
        accountId: candidate.grant.accountId, binding: bindingOf(candidate.grant), storage: 'legacy-root', state: 'active' };
      this.accounts.push(record);
      return structuredClone(record);
    });
  }

  /** Publicación final de una cuenta ya emparejada y cuya propiedad comprobó Lumbre. */
  commitAccount(ownership: VerifiedOwnership, options: { id?: string } = {}): Promise<AccountRecord> {
    return this.mutate(() => {
      const id = options.id ?? randomUUID();
      if (!UUID.test(id)) throw new Error('account_id_invalid');
      if (this.accounts.some((entry) => (entry.sub === ownership.sub && entry.state !== 'removed') ||
        entry.id === id ||
        (entry.accountId === ownership.grant.accountId && sameBinding(entry.binding, ownership.grant)))) {
        throw new Error('account_exists');
      }
      const record: AccountRecord = { id, generation: 1, sub: ownership.sub,
        accountId: ownership.grant.accountId, binding: bindingOf(ownership.grant), storage: 'account-dir', state: 'active' };
      this.accounts.push(record);
      return structuredClone(record);
    });
  }

  /** El legado aún sin dueño cuyo `accountId` es este; nunca lo asigna, solo lo encuentra. */
  unclaimedLegacyOf(accountId: string): AccountRecord | null {
    const legacy = this.accounts.find((entry) => entry.storage === 'legacy-root' && entry.state === 'active' &&
      entry.sub === UNCLAIMED_LEGACY_SUB && entry.accountId === accountId);
    return legacy ? structuredClone(legacy) : null;
  }

  /**
   * Primera mitad de una renovación (§12.10): sube la generación y bloquea la cuenta, de modo
   * que los contextos y familias de la generación anterior dejan de valer antes de tocar sus
   * secretos. Repetirla con el mismo diario no cambia nada.
   */
  beginRenewal(ref: AccountRef, journalId: string): Promise<AccountRecord> {
    return this.mutate(() => {
      const record = this.accounts.find((entry) => entry.id === ref.id);
      if (!record || record.state !== 'active') throw new Error('account_inactive');
      if (record.renewing === journalId) return structuredClone(record);
      if (record.renewing !== undefined || record.generation !== ref.generation) throw new Error('account_inactive');
      record.generation += 1;
      record.renewing = journalId;
      return structuredClone(record);
    });
  }

  /**
   * Publica en una sola escritura atómica el vínculo y la generación nuevos. Solo la persona de
   * esa cuenta puede hacerlo: el `sub` (o el legado aún sin reclamar, con su mismo `accountId`) y
   * la bóveda tienen que coincidir, y el vínculo no puede ser de otro registro.
   */
  commitRenewal(ref: AccountRef, journalId: string, ownership: VerifiedOwnership): Promise<AccountRecord> {
    return this.mutate(() => {
      const record = this.accounts.find((entry) => entry.id === ref.id);
      if (!record || record.state !== 'active' || record.generation !== ref.generation ||
        record.renewing !== journalId) throw new Error('account_inactive');
      const sameOwner = record.sub === ownership.sub ||
        (record.sub === UNCLAIMED_LEGACY_SUB && record.storage === 'legacy-root');
      if (!sameOwner || record.accountId !== ownership.grant.accountId ||
        record.binding.syncVaultId !== ownership.grant.syncVaultId) throw new Error('renewal_owner_conflict');
      if (this.accounts.some((entry) => entry.id !== record.id && ((entry.sub === ownership.sub && entry.state !== 'removed') ||
        (entry.accountId === ownership.grant.accountId && sameBinding(entry.binding, ownership.grant))))) {
        throw new Error('account_exists');
      }
      record.sub = ownership.sub;
      record.binding = bindingOf(ownership.grant);
      record.generation += 1;
      record.renewedBy = journalId;
      delete record.renewing;
      return structuredClone(record);
    });
  }

  /**
   * Suelta una renovación que no llegó a publicarse. La generación sube otra vez: nadie vuelve a
   * entrar con una referencia tomada durante la publicación a medias. Sin bloqueo de este diario,
   * no escribe nada.
   */
  async abortRenewal(id: string, journalId: string): Promise<void> {
    if (this.accounts.find((entry) => entry.id === id)?.renewing !== journalId) return;
    await this.mutate(() => {
      const record = this.accounts.find((entry) => entry.id === id);
      if (record?.renewing !== journalId) return;
      delete record.renewing;
      record.generation += 1;
    });
  }

  authorize(grant: ActiveGrant, sub: string | null): AuthorizedAccount | null {
    const record = this.accounts.find((entry) => entry.state === 'active' && entry.renewing === undefined &&
      entry.accountId === grant.accountId && sameBinding(entry.binding, grant) &&
      (sub === null ? entry.storage === 'legacy-root' : entry.sub === sub));
    return record ? authorized(record) : null;
  }

  assertActive(ref: AccountRef): void {
    const record = this.accounts.find((entry) => entry.id === ref.id);
    if (!record || record.state !== 'active' || record.renewing !== undefined ||
      record.generation !== ref.generation) throw new Error('account_inactive');
  }

  beginRemoval(ref: AccountRef): Promise<AccountRecord> {
    return this.mutate(() => {
      const record = this.accounts.find((entry) => entry.id === ref.id);
      if (!record || record.generation !== ref.generation || record.state !== 'active') throw new Error('account_inactive');
      record.state = 'removing';
      record.generation += 1;
      record.removalPhase = 'blocked';
      return structuredClone(record);
    });
  }

  advanceRemoval(ref: AccountRef, phase: NonNullable<AccountRecord['removalPhase']>): Promise<AccountRecord> {
    return this.mutate(() => {
      const record = this.accounts.find((entry) => entry.id === ref.id);
      if (!record || record.state !== 'removing' || record.generation !== ref.generation) throw new Error('account_inactive');
      const order = ['blocked', 'remote-revoked', 'data-erased'] as const;
      const current = record.removalPhase ?? 'blocked';
      if (order.indexOf(phase) < order.indexOf(current)) return structuredClone(record);
      record.removalPhase = phase;
      return structuredClone(record);
    });
  }

  finishRemoval(ref: AccountRef): Promise<void> {
    return this.mutate(() => {
      const record = this.accounts.find((entry) => entry.id === ref.id);
      if (record?.state === 'removed' && record.generation === ref.generation) return;
      if (!record || record.generation !== ref.generation || record.state !== 'removing') {
        throw new Error('account_inactive');
      }
      record.state = 'removed';
      record.removalPhase = 'data-erased';
    });
  }
}

export function accountDataDir(root: string, account: AuthorizedAccount): string {
  return account.storage === 'legacy-root' ? root : join(root, 'accounts', account.id);
}

/** Local authority for stdio/workdir and shared caches, including other processes.
 * An unregistered standalone library remains usable. Once bound, absence, removal or a
 * different generation fails closed; deleting personal data cannot erase this tombstone.
 */
export function accountAccessGuard(dataDir: string): () => void {
  const directory = resolve(dataDir);
  const accountId = basename(dirname(directory)) === 'accounts' && UUID.test(basename(directory))
    ? basename(directory) : null;
  const root = accountId ? dirname(dirname(directory)) : directory;
  let expected: AccountRef | null = null;
  return () => {
    let parsed: Partial<AccountsFile>;
    try { parsed = JSON.parse(readFileSync(accountFile(root), 'utf8')) as Partial<AccountsFile>; }
    catch (error) {
      if (isEnoent(error) && !expected && !accountId) return;
      throw new Error('account_inactive');
    }
    if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.accounts) ||
      !parsed.accounts.every(validRecord) || !validRecords(parsed.accounts)) throw new Error('accounts_invalid');
    const record = parsed.accounts.find((entry) => accountId ? entry.id === accountId : entry.storage === 'legacy-root');
    if (!record) {
      if (expected || accountId) throw new Error('account_inactive');
      return;
    }
    if (record.state !== 'active' || record.renewing !== undefined || (expected &&
      (expected.id !== record.id || expected.generation !== record.generation))) throw new Error('account_inactive');
    expected ??= { id: record.id, generation: record.generation };
  };
}
