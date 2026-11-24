import { createHash, randomUUID } from 'node:crypto';
import type { SecretStore } from '../secrets';
import { logEvent } from '../log/logger';
import { BackchannelError, sameBinding, type ExchangeDeliveryRef, type Grant, type LumbreBackchannel } from './backchannel';
import type { GrantSecrets } from './grants';
import { flushSecretStore } from './files';

const STORE_KEY = 'hebra-mcp-oauth-exchange-deliveries';
const MAX_PENDING = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSACTION = /^[A-Za-z0-9_-]{43}$/;

type JournalEntry = ExchangeDeliveryRef & { origin: string; resource: string };
export type DeliveredGrant = { grant: Grant; stageHash?: string };

function stageHash(deliveryId: string): string {
  return createHash('sha256').update(`exchange-delivery:${deliveryId}`).digest('hex');
}

function validEntry(value: unknown): value is JournalEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).length === 5 &&
    typeof entry.requestId === 'string' && UUID.test(entry.requestId) &&
    typeof entry.deliveryId === 'string' && UUID.test(entry.deliveryId) &&
    typeof entry.transactionId === 'string' && TRANSACTION.test(entry.transactionId) &&
    typeof entry.origin === 'string' && typeof entry.resource === 'string';
}

/**
 * Diario del salto de servidor a servidor. El proceso solo persiste los identificadores
 * de la entrega. El bearer va al almacén de concesiones cifrado antes del ACK.
 */
export class ExchangeDelivery {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly inFlight = new Set<string>();
  private recovery: Promise<void> | null = null;

  constructor(
    private readonly store: SecretStore,
    private readonly grants: GrantSecrets,
    private readonly backchannel: LumbreBackchannel,
    private readonly resource: string
  ) {}

  private async read(): Promise<JournalEntry[]> {
    const raw = await this.store.get(STORE_KEY);
    if (raw === null) return [];
    let entries: unknown;
    try { entries = JSON.parse(raw); }
    catch { throw new BackchannelError('unavailable'); }
    if (!Array.isArray(entries) || entries.length > MAX_PENDING || !entries.every(validEntry))
      throw new BackchannelError('unavailable');
    return entries;
  }

  private write(edit: (entries: JournalEntry[]) => JournalEntry[]): Promise<void> {
    const run = this.writes.then(async () => {
      const entries = edit(await this.read());
      await this.store.set(STORE_KEY, JSON.stringify(entries));
      await flushSecretStore(this.store);
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  private remove(deliveryId: string): Promise<void> {
    return this.write(entries => entries.filter(entry => entry.deliveryId !== deliveryId));
  }

  async exchange(
    input: Omit<ExchangeDeliveryRef, 'deliveryId'>,
    send: (deliveryId?: string) => Promise<Grant>
  ): Promise<DeliveredGrant> {
    if (!await this.backchannel.exchangeDeliverySupported()) return { grant: await send() };
    const deliveryId = randomUUID();
    const reference = { ...input, deliveryId };
    if (!validEntry({ ...reference, origin: this.backchannel.appOrigin, resource: this.resource }))
      throw new BackchannelError('invalid');
    this.inFlight.add(deliveryId);
    try {
      await this.write(entries => {
        if (entries.length >= MAX_PENDING) throw new BackchannelError('unavailable');
        return [...entries, { ...reference, origin: this.backchannel.appOrigin, resource: this.resource }];
      });
      let grant: Grant;
      try { grant = await send(deliveryId); }
      catch (error) {
        if (!(error instanceof BackchannelError) || error.kind !== 'unavailable' ||
          !await this.backchannel.exchangeDeliverySupported()) throw error;
        grant = await send(deliveryId);
      }
      const current = await this.backchannel.introspect(grant.accessToken);
      if (!current || current.credentialId !== grant.credentialId || current.clientId !== grant.clientId ||
        current.accountId !== grant.accountId || current.resource !== grant.resource || current.scope !== grant.scope ||
        current.expiresAt !== grant.expiresAt || !sameBinding(current, grant)) throw new BackchannelError('inactive');
      const staged = stageHash(deliveryId);
      await this.grants.stage(staged, grant.accessToken, true);
      await this.backchannel.acknowledgeExchangeDelivery(reference);
      await this.remove(deliveryId);
      return { grant, stageHash: staged };
    } finally {
      this.inFlight.delete(deliveryId);
    }
  }

  /** Una entrega recuperada después de arrancar es huérfana y solo se revoca. */
  recover(): Promise<void> {
    this.recovery ??= this.recoverEntries().finally(() => { this.recovery = null; });
    return this.recovery;
  }

  private async recoverEntries(): Promise<void> {
    // Toma la foto en la misma cola que borra las entregas ya aceptadas. Así un
    // canje activo nunca pasa a huérfano mientras se lee una copia anterior.
    const snapshot = this.writes.then(async () => (await this.read()).filter(entry =>
      entry.origin === this.backchannel.appOrigin && entry.resource === this.resource && !this.inFlight.has(entry.deliveryId)));
    this.writes = snapshot.catch(() => undefined);
    for (const { requestId, transactionId, deliveryId } of await snapshot) {
      const reference = { requestId, transactionId, deliveryId };
      try {
        const found = await this.backchannel.recoverExchangeDelivery(reference);
        if (found === 'pending') continue;
        const staged = stageHash(reference.deliveryId);
        if (found !== 'closed') {
          await this.grants.stage(staged, found.accessToken, true);
          await this.backchannel.revoke(found.accessToken);
          await this.backchannel.acknowledgeExchangeDelivery(reference);
        }
        await this.grants.unstage(staged);
        await this.remove(reference.deliveryId);
      } catch {
        logEvent({ event: 'oauth.grant.revoke', result: 'unavailable' });
      }
    }
  }
}
