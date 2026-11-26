/**
 * Bearers upstream de todas las cuentas, nunca en metadata OAuth. En `serve-http` con almacén
 * de fichero, `store` es `control/secrets.json` (D22, `../accounts/control-secrets.ts`).
 */
import type { SecretStore } from '../secrets';
import { logEvent } from '../log/logger';
import { BackchannelError, type DeliveryRef, type LumbreBackchannel } from './backchannel';

const KEY = 'hebra-mcp-oauth-grants';
const PENDING_KEY = 'hebra-mcp-oauth-pending';
const DELIVERY_KEY = 'hebra-mcp-oauth-deliveries';
const FAMILY = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const CODE_HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSACTION = /^[A-Za-z0-9_-]{32,256}$/;
const MAX_DELIVERIES = 4096;

interface PendingGrant { token: string; familyId?: string }
interface PendingDelivery extends DeliveryRef { owned: boolean }

export function closedDelivery(error: unknown): boolean {
  return error instanceof BackchannelError && (error.status === 404 || error.status === 410);
}

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

  private async deliveries(): Promise<PendingDelivery[]> {
    const raw = await this.store.get(DELIVERY_KEY);
    if (raw === null) return [];
    let entries: unknown;
    try { entries = JSON.parse(raw); }
    catch { throw new Error('invalid_grant_deliveries'); }
    if (!Array.isArray(entries) || entries.length > MAX_DELIVERIES || entries.some((entry) =>
      !entry || typeof entry !== 'object' || typeof entry.requestId !== 'string' || !UUID.test(entry.requestId) ||
      typeof entry.deliveryId !== 'string' || !UUID.test(entry.deliveryId) ||
      typeof entry.transactionId !== 'string' || !TRANSACTION.test(entry.transactionId) || typeof entry.owned !== 'boolean'
    )) throw new Error('invalid_grant_deliveries');
    return entries as PendingDelivery[];
  }

  private updateDeliveries(update: (entries: PendingDelivery[]) => PendingDelivery[]): Promise<void> {
    const run = this.queue.then(async () => {
      await this.store.set(DELIVERY_KEY, JSON.stringify(update(await this.deliveries())));
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  recordDelivery(ref: DeliveryRef): Promise<void> {
    return this.updateDeliveries((entries) => {
      if (entries.length >= MAX_DELIVERIES) throw new Error('grant_deliveries_full');
      return [...entries, { ...ref, owned: false }];
    });
  }

  ownDelivery(ref: DeliveryRef): Promise<void> {
    return this.updateDeliveries((entries) => {
      const entry = entries.find((item) => item.deliveryId === ref.deliveryId);
      if (!entry) throw new Error('grant_delivery_missing');
      entry.owned = true;
      return entries;
    });
  }

  forgetDelivery(ref: DeliveryRef): Promise<void> {
    return this.updateDeliveries((entries) => entries.filter((entry) => entry.deliveryId !== ref.deliveryId));
  }

  /** Reanuda el acuse o revoca un canje que se interrumpió antes de tener custodia local. */
  async recoverDeliveries(backchannel: LumbreBackchannel): Promise<void> {
    const entries = await this.deliveries();
    for (const { owned, requestId, transactionId, deliveryId } of entries) {
      const ref = { requestId, transactionId, deliveryId };
      try {
        if (!owned) {
          const grant = await backchannel.recoverDelivery(ref);
          await backchannel.revoke(grant.accessToken);
        }
        await backchannel.acknowledgeDelivery(ref);
      } catch (error) {
        if (!closedDelivery(error)) {
          // Si falla el canal, el resto queda para otro arranque.
          if (!(error instanceof BackchannelError) || (error.status !== 202 && error.kind !== 'invalid')) return;
          continue;
        }
      }
      await this.forgetDelivery(ref);
    }
  }

  static async open(store: SecretStore, _liveIds: readonly string[]): Promise<GrantSecrets> {
    const result = new GrantSecrets(store);
    const raw = await store.get(KEY);
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
        for (const [id, token] of Object.entries(parsed)) {
          // Un bearer sin familia local aún debe revocarse upstream tras un crash.
          if (FAMILY.test(id) && typeof token === 'string' && TOKEN.test(token)) result.values.set(id, token);
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
      try { await revoke(entry.token); }
      catch { logEvent({ event: 'oauth.grant.revoke', result: 'unavailable' }); continue; }
      try {
        if (entry.familyId && !liveIds.includes(entry.familyId) && grants.get(entry.familyId) === entry.token) {
          await grants.delete(entry.familyId);
        }
        delete entries[key];
      } catch { logEvent({ event: 'oauth.grant.cleanup', result: 'failed' }); }
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

  /** Reintenta al arrancar los bearers cuyo token local ya no existe. */
  async recoverOrphans(liveIds: readonly string[], revoke: (token: string) => Promise<void>): Promise<void> {
    const live = new Set(liveIds);
    for (const [id, token] of this.values) {
      if (live.has(id)) continue;
      try { await revoke(token); }
      catch { logEvent({ event: 'oauth.grant.revoke', result: 'unavailable' }); continue; }
      await this.delete(id).catch(() => logEvent({ event: 'oauth.grant.cleanup', result: 'failed' }));
    }
  }

  private async persist(): Promise<void> {
    await this.store.set(KEY, JSON.stringify(Object.fromEntries(this.values)));
  }

  /** Conserva huérfanos hasta confirmar su revocación; serializa cambios de secreto. */
  set(id: string, token: string, _liveIds: readonly string[]): Promise<void> {
    const run = this.queue.then(async () => {
      const before = new Map(this.values);
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
