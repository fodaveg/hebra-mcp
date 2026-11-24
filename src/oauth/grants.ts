/**
 * Bearers upstream de todas las cuentas, nunca en metadata OAuth. En `serve-http` con almacén
 * de fichero, `store` es `control/secrets.json` (D22, `../accounts/control-secrets.ts`).
 */
import type { SecretStore } from '../secrets';
import { logEvent } from '../log/logger';
import { flushSecretStore } from './files';
import { RefreshSealer } from './sumego-refresh';

const KEY = 'hebra-mcp-oauth-grants';
const PENDING_KEY = 'hebra-mcp-oauth-pending';
const FAMILY = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const CODE_HASH = /^[0-9a-f]{64}$/;

type StoredGrant = { token: string } | { sealedToken: string };
type PendingGrant = StoredGrant & { familyId?: string };
interface FamilyGrant { token: string; stored: string }

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
      if (pending.familyId !== undefined && (typeof pending.familyId !== 'string' || !FAMILY.test(pending.familyId))) continue;
      const grant = typeof pending.sealedToken === 'string' && pending.token === undefined
        ? { sealedToken: pending.sealedToken }
        : typeof pending.token === 'string' && TOKEN.test(pending.token) && pending.sealedToken === undefined
          ? { token: pending.token } : null;
      if (grant) result[codeHash] = { ...grant, ...(pending.familyId ? { familyId: pending.familyId } : {}) };
    }
    return result;
  } catch { return {}; }
}

export class GrantSecrets {
  private readonly values = new Map<string, FamilyGrant>();
  private queue: Promise<unknown> = Promise.resolve();
  private sealer: Promise<RefreshSealer> | null = null;

  private constructor(private readonly store: SecretStore) {}

  private async sealing(): Promise<RefreshSealer> {
    this.sealer ??= RefreshSealer.open(this.store, 'oauth-grant');
    try { return await this.sealer; }
    catch (error) { this.sealer = null; throw error; }
  }

  private async decode(key: string, stored: string): Promise<string | null> {
    if (TOKEN.test(stored)) return stored; // Concesión legacy.
    if (!stored.startsWith('v1.')) return null;
    const token = (await this.sealing()).open(stored, key);
    return token !== null && TOKEN.test(token) ? token : null;
  }

  static async open(store: SecretStore, _liveIds: readonly string[]): Promise<GrantSecrets> {
    const result = new GrantSecrets(store);
    const raw = await store.get(KEY);
    if (raw !== null) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch { /* Un fichero roto deja todas las concesiones sin bearer. */ }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [id, stored] of Object.entries(parsed)) {
          // Un bearer sin familia local aún debe revocarse upstream tras un crash.
          if (!FAMILY.test(id) || typeof stored !== 'string') continue;
          const token = await result.decode(id, stored);
          if (token !== null) result.values.set(id, { token, stored });
        }
      }
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
      const token = 'token' in entry ? entry.token : await grants.decode(key, entry.sealedToken);
      if (!token) continue;
      if (entry.familyId && liveIds.includes(entry.familyId) && grants.get(entry.familyId) === token) {
        delete entries[key];
        continue;
      }
      try { await revoke(token); }
      catch { logEvent({ event: 'oauth.grant.revoke', result: 'unavailable' }); continue; }
      try {
        if (entry.familyId && !liveIds.includes(entry.familyId) && grants.get(entry.familyId) === token) {
          await grants.delete(entry.familyId);
        }
        delete entries[key];
      } catch { logEvent({ event: 'oauth.grant.cleanup', result: 'failed' }); }
    }
    await store.set(PENDING_KEY, JSON.stringify(entries));
  }

  /** Guarda antes de emitir un código OAuth; al caducar o fallar se revoca upstream. */
  async stage(codeHash: string, token: string, seal = false): Promise<void> {
    const run = this.queue.then(async () => {
      const entries = parsePending(await this.store.get(PENDING_KEY));
      entries[codeHash] = seal ? { sealedToken: (await this.sealing()).seal(token, codeHash) } : { token };
      await this.store.set(PENDING_KEY, JSON.stringify(entries));
      if (seal) await flushSecretStore(this.store);
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

  get(id: string): string | null { return this.values.get(id)?.token ?? null; }

  /** Reintenta al arrancar los bearers cuyo token local ya no existe. */
  async recoverOrphans(liveIds: readonly string[], revoke: (token: string) => Promise<void>): Promise<void> {
    const live = new Set(liveIds);
    for (const [id, { token }] of this.values) {
      if (live.has(id)) continue;
      try { await revoke(token); }
      catch { logEvent({ event: 'oauth.grant.revoke', result: 'unavailable' }); continue; }
      await this.delete(id).catch(() => logEvent({ event: 'oauth.grant.cleanup', result: 'failed' }));
    }
  }

  private async persist(): Promise<void> {
    await this.store.set(KEY, JSON.stringify(Object.fromEntries([...this.values].map(([id, grant]) => [id, grant.stored]))));
  }

  /** Conserva huérfanos hasta confirmar su revocación; serializa cambios de secreto. */
  set(id: string, token: string, _liveIds: readonly string[], stageHash?: string): Promise<void> {
    const run = this.queue.then(async () => {
      const stage = stageHash ? parsePending(await this.store.get(PENDING_KEY))[stageHash] : undefined;
      const stored = stage && 'sealedToken' in stage ? (await this.sealing()).seal(token, id) : token;
      const before = new Map(this.values);
      this.values.set(id, { token, stored });
      try {
        await this.persist();
        if (stored !== token) await flushSecretStore(this.store);
      } catch (error) {
        this.values.clear();
        for (const [key, value] of before) this.values.set(key, value);
        throw error;
      }
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
