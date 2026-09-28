/** Bearers upstream en el mismo almacén seguro que el emparejado, nunca en metadata OAuth. */
import type { SecretStore } from '../secrets';

const KEY = 'hebra-mcp-oauth-grants';
const PENDING_KEY = 'hebra-mcp-oauth-pending';
const FAMILY = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const CODE_HASH = /^[0-9a-f]{64}$/;

interface PendingGrant { token: string; familyId?: string }

function parsePending(raw: string | null): Record<string, PendingGrant> {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, PendingGrant> = {};
    for (const [codeHash, entry] of Object.entries(value)) {
      if (!CODE_HASH.test(codeHash)) continue;
      // Compatibilidad con marcas staged creadas antes de la promoción durable.
      const candidate = typeof entry === 'string' ? { token: entry } : entry;
      if (!candidate || typeof candidate !== 'object') continue;
      const pending = candidate as Record<string, unknown>;
      if (typeof pending.token !== 'string' || !TOKEN.test(pending.token) ||
        (pending.familyId !== undefined && (typeof pending.familyId !== 'string' || !FAMILY.test(pending.familyId)))) continue;
      result[codeHash] = { token: pending.token, ...(pending.familyId ? { familyId: pending.familyId } : {}) };
    }
    return result;
  } catch { return {}; }
}

export class GrantSecrets {
  private readonly values = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly store: SecretStore) {}

  static async open(store: SecretStore, liveIds: readonly string[]): Promise<GrantSecrets> {
    const result = new GrantSecrets(store);
    const raw = await store.get(KEY);
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
        for (const [id, token] of Object.entries(parsed)) {
          if (FAMILY.test(id) && typeof token === 'string' && TOKEN.test(token) && liveIds.includes(id)) result.values.set(id, token);
        }
      } catch { /* Un fichero roto deja todas las concesiones sin bearer. */ }
    }
    await result.persist();
    return result;
  }

  /** Concesiones canjeadas cuyo código local aún no se ha presentado, recuperables tras un reinicio. */
  static async recoverPending(
    store: SecretStore,
    liveIds: readonly string[],
    grants: GrantSecrets,
    revoke: (token: string) => Promise<void>
  ): Promise<void> {
    const raw = await store.get(PENDING_KEY);
    if (raw === null) return;
    const entries = parsePending(raw);
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.familyId && liveIds.includes(entry.familyId) && grants.get(entry.familyId) === entry.token) {
        delete entries[key];
        continue;
      }
      try { await revoke(entry.token); delete entries[key]; } catch { /* Se reintentará en el siguiente arranque. */ }
    }
    await store.set(PENDING_KEY, JSON.stringify(entries));
  }

  /** Guarda antes de emitir un código OAuth; al caducar o fallar se revoca upstream. */
  async stage(codeHash: string, token: string): Promise<void> {
    const run = this.queue.then(async () => {
      const entries = parsePending(await this.store.get(PENDING_KEY));
      entries[codeHash] = { token };
      await this.store.set(PENDING_KEY, JSON.stringify(entries));
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** La marca se conserva hasta que `oauth-tokens.json` confirma la familia. */
  markPromoting(codeHash: string, familyId: string): Promise<void> {
    const run = this.queue.then(async () => {
      const entries = parsePending(await this.store.get(PENDING_KEY));
      const entry = entries[codeHash];
      if (!entry || !FAMILY.test(familyId)) throw new Error('pending_grant_missing');
      entries[codeHash] = { ...entry, familyId };
      await this.store.set(PENDING_KEY, JSON.stringify(entries));
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async unstage(codeHash: string): Promise<void> {
    const run = this.queue.then(async () => {
      const raw = await this.store.get(PENDING_KEY);
      if (!raw) return;
      const entries = parsePending(raw);
      delete entries[codeHash];
      await this.store.set(PENDING_KEY, JSON.stringify(entries));
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  get(id: string): string | null { return this.values.get(id) ?? null; }

  private async persist(): Promise<void> {
    await this.store.set(KEY, JSON.stringify(Object.fromEntries(this.values)));
  }

  /** Limita huérfanos a las familias activas; serializa cambios de secreto. */
  set(id: string, token: string, liveIds: readonly string[]): Promise<void> {
    const run = this.queue.then(async () => {
      const before = new Map(this.values);
      for (const key of this.values.keys()) if (!liveIds.includes(key)) this.values.delete(key);
      this.values.set(id, token);
      try { await this.persist(); } catch (error) { this.values.clear(); for (const [key, value] of before) this.values.set(key, value); throw error; }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  delete(id: string): Promise<void> {
    const run = this.queue.then(async () => {
      if (!this.values.has(id)) return;
      const token = this.values.get(id)!;
      this.values.delete(id);
      try { await this.persist(); } catch (error) { this.values.set(id, token); throw error; }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
