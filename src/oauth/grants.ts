/** Bearers upstream en el mismo almacén seguro que el emparejado, nunca en metadata OAuth. */
import type { SecretStore } from '../secrets';

const KEY = 'hebra-mcp-oauth-grants';
const PENDING_KEY = 'hebra-mcp-oauth-pending';
const FAMILY = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[0-9a-f]{64}$/;

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
  static async recoverPending(store: SecretStore, revoke: (token: string) => Promise<void>): Promise<void> {
    const raw = await store.get(PENDING_KEY);
    if (raw === null) return;
    let entries: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entries = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string' && TOKEN.test(value)));
      }
    } catch { /* Un formato roto se descarta sin exponerlo. */ }
    for (const [key, token] of Object.entries(entries)) {
      try { await revoke(token); delete entries[key]; } catch { /* Se reintentará en el siguiente arranque. */ }
    }
    await store.set(PENDING_KEY, JSON.stringify(entries));
  }

  /** Guarda antes de emitir un código OAuth; al caducar o fallar se revoca upstream. */
  async stage(codeHash: string, token: string): Promise<void> {
    const run = this.queue.then(async () => {
      const raw = await this.store.get(PENDING_KEY);
      let entries: Record<string, string> = {};
      try { if (raw) entries = JSON.parse(raw) as Record<string, string>; } catch { /* Cerrado al formato previo. */ }
      entries[codeHash] = token;
      await this.store.set(PENDING_KEY, JSON.stringify(entries));
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async unstage(codeHash: string): Promise<void> {
    const run = this.queue.then(async () => {
      const raw = await this.store.get(PENDING_KEY);
      if (!raw) return;
      let entries: Record<string, string>;
      try { entries = JSON.parse(raw) as Record<string, string>; } catch { await this.store.delete(PENDING_KEY); return; }
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
