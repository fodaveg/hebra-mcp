import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { decodeRecoveryCode, sanitizeDeviceLabel } from '../../hebra';
import { sameBinding, type Binding } from '../../oauth/backchannel';
import { openFileSecretStore, writePairedSecrets, type PairedSecrets } from '../../secrets';
import {
  prepareAgentDevice,
  savePreparedAgentDevice
} from '../../spaces/device';
import { DEFAULT_PAIR_LABEL } from '../pair';
import {
  DEFAULT_LUMBRE_ORIGIN,
  exchangePairingCode,
  pairingUrl,
  type Fetcher
} from '../lumbre';
import { RemotePairingJournalStore } from './journal';
import { startRemoteLink, type RemoteLinkRequest } from './link';
import { revokeRemoteCredential } from './revoke';
import {
  RemotePairingError,
  type OwnershipVerifier,
  type PairingPreview,
  type RemotePairingJournal,
  type RemotePairingPublisher,
  type RemotePairingSession,
  type RemotePairingStatus,
  type VerifiedOwnership
} from './types';

export const REMOTE_PAIRING_ORIGIN = 'https://mcp.hebra.pro';
export const REMOTE_PAIRING_TTL_MS = 10 * 60_000;

type GrantedPoll = Extract<Awaited<ReturnType<RemoteLinkRequest['poll']>>, { kind: 'granted' }>;

interface RuntimePairing {
  cookie: string;
  csrf: string;
  link?: RemoteLinkRequest;
  granted?: GrantedPoll;
  preview?: PairingPreview;
  ownership?: VerifiedOwnership;
}

export interface RemotePairingServiceOptions {
  journals: RemotePairingJournalStore;
  ownership: OwnershipVerifier;
  publisher: RemotePairingPublisher;
  publicOrigin?: string;
  lumbreOrigin?: string;
  fetcher?: Fetcher;
  now?: () => number;
  exchangeCode?: typeof exchangePairingCode;
  prepareAgent?: typeof prepareAgentDevice;
  startLink?: typeof startRemoteLink;
  revoke?: typeof revokeRemoteCredential;
}

export interface StartRemotePairingInput {
  oauthRequestId: string;
  sub: string;
  identityExpiresAt: string;
  label?: string;
}

export interface StartedRemotePairing {
  id: string;
  cookie: string;
  formToken: string;
  authorizationUrl: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function equalDigest(expected: string, value: string): boolean {
  const actual = digest(value);
  return expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function validFuture(value: string, now: number): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time > now;
}

/** Orquesta el emparejado sin confiar nunca en identidad ni sesión recibidas del formulario. */
export class RemotePairingService {
  private readonly runtime = new Map<string, RuntimePairing>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly publicOrigin: string;
  private readonly exchangeCode: typeof exchangePairingCode;
  private readonly prepareAgent: typeof prepareAgentDevice;
  private readonly startLink: typeof startRemoteLink;
  private readonly revoke: typeof revokeRemoteCredential;

  constructor(private readonly options: RemotePairingServiceOptions) {
    this.publicOrigin = options.publicOrigin ?? REMOTE_PAIRING_ORIGIN;
    if (this.publicOrigin !== REMOTE_PAIRING_ORIGIN) throw new Error('invalid_remote_pairing_origin');
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.exchangeCode = options.exchangeCode ?? exchangePairingCode;
    this.prepareAgent = options.prepareAgent ?? prepareAgentDevice;
    this.startLink = options.startLink ?? startRemoteLink;
    this.revoke = options.revoke ?? revokeRemoteCredential;
  }

  async start(input: StartRemotePairingInput): Promise<StartedRemotePairing> {
    return this.exclusive(`sub:${input.sub}`, () => this.startUnlocked(input));
  }

  private async startUnlocked(input: StartRemotePairingInput): Promise<StartedRemotePairing> {
    if (!input.oauthRequestId || !input.sub || !validFuture(input.identityExpiresAt, this.now())) {
      throw new RemotePairingError('invalid_session');
    }
    const existing = (await this.options.journals.list()).find(
      (journal) => journal.sub === input.sub && !['finished', 'cancelled'].includes(journal.phase)
    );
    if (existing) throw new RemotePairingError('replayed');
    const id = randomUUID();
    const cookie = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const deviceId = randomUUID();
    const label = sanitizeDeviceLabel(input.label ?? DEFAULT_PAIR_LABEL, 'agent');
    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + REMOTE_PAIRING_TTL_MS).toISOString();
    const { url, verifier } = await pairingUrl({
      lumbreOrigin: this.options.lumbreOrigin ?? DEFAULT_LUMBRE_ORIGIN,
      deviceId,
      label,
      webOrigin: this.publicOrigin
    });
    const journal: RemotePairingJournal = {
      version: 1,
      id,
      oauthRequestId: input.oauthRequestId,
      sub: input.sub,
      cookieHash: digest(cookie),
      csrfHash: digest(csrf),
      phase: 'credential',
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      identityExpiresAt: input.identityExpiresAt,
      deviceId,
      verifier,
      cleanupRequired: false
    };
    await this.options.journals.write(journal);
    this.runtime.set(id, { cookie, csrf });
    return { id, cookie, formToken: csrf, authorizationUrl: url };
  }

  async sessionForCookie(cookie: string): Promise<RemotePairingSession | null> {
    for (const [id, runtime] of this.runtime) {
      if (runtime.cookie !== cookie) continue;
      const journal = await this.requireJournal(id);
      if (!equalDigest(journal.cookieHash, cookie)) return null;
      await this.ensureAlive(journal);
      return this.sessionOf(journal);
    }
    return null;
  }

  async session(id: string): Promise<RemotePairingSession> {
    return this.sessionOf(await this.requireJournal(id));
  }

  async formToken(id: string): Promise<string> {
    const token = this.runtime.get(id)?.csrf;
    if (!token) throw new RemotePairingError('invalid_session');
    return token;
  }

  async authorizeForm(id: string, cookie: string, formToken: string): Promise<void> {
    const [journal, runtime] = await Promise.all([
      this.requireJournal(id),
      Promise.resolve(this.runtime.get(id))
    ]);
    if (
      !runtime || runtime.cookie !== cookie || runtime.csrf !== formToken ||
      !equalDigest(journal.cookieHash, cookie) || !equalDigest(journal.csrfHash, formToken)
    ) throw new RemotePairingError('invalid_form');
    await this.ensureAlive(journal);
    // Cada POST consume su token antes de ejecutar cualquier efecto remoto.
    runtime.csrf = randomBytes(32).toString('base64url');
    journal.csrfHash = digest(runtime.csrf);
    journal.updatedAt = new Date(this.now()).toISOString();
    await this.options.journals.write(journal);
  }

  async receiveCredential(id: string, code: string): Promise<void> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      if (journal.phase !== 'credential') throw new RemotePairingError('replayed');
      if (!code || code.length > 4_096) throw new RemotePairingError('invalid_form');
      const connection = await this.exchangeCode({
        apiOrigin: this.options.lumbreOrigin ?? DEFAULT_LUMBRE_ORIGIN,
        code,
        deviceId: journal.deviceId,
        verifier: journal.verifier,
        fetcher: this.fetcher,
        now: this.now
      });
      journal.connection = connection;
      journal.cleanupRequired = true;
      journal.updatedAt = new Date(this.now()).toISOString();
      await this.options.journals.write(journal);
      try {
        journal.preparedAgent = await this.prepareAgent(connection, journal.deviceId, this.fetcher);
        const link = await this.startLink({
          connection,
          label: DEFAULT_PAIR_LABEL,
          fetcher: this.fetcher
        });
        this.requireRuntime(id).link = link;
        journal.phase = 'approval';
        journal.updatedAt = new Date(this.now()).toISOString();
        await this.options.journals.write(journal);
      } catch {
        await this.cleanup(journal);
        throw new RemotePairingError('unavailable');
      }
    });
  }

  async poll(id: string): Promise<RemotePairingStatus> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      const runtime = this.requireRuntime(id);
      if (journal.phase === 'confirmation' && runtime.preview) {
        return { kind: 'preview', preview: runtime.preview };
      }
      if (journal.phase !== 'approval' && journal.phase !== 'owner-check') {
        throw new RemotePairingError('not_ready');
      }
      const link = runtime.link;
      if (!link) throw new RemotePairingError('invalid_session');
      const result = runtime.granted ?? await link.poll();
      if (result.kind === 'waiting') return result;
      if (result.kind !== 'granted') {
        await this.cleanup(journal);
        throw new RemotePairingError(result.kind === 'expired' ? 'expired' : 'denied');
      }
      runtime.granted = result;
      journal.phase = 'owner-check';
      journal.updatedAt = new Date(this.now()).toISOString();
      await this.options.journals.write(journal);
      if (!validFuture(journal.identityExpiresAt, this.now())) return { kind: 'reauthenticate' };
      try {
        return await this.verifyOwnershipAndPreview(journal, runtime, result);
      } catch (error) {
        if (error instanceof RemotePairingError) throw error;
        await this.cleanup(journal);
        throw new RemotePairingError('unavailable');
      }
    });
  }

  async resumeIdentity(id: string, sub: string, identityExpiresAt: string): Promise<void> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      if (journal.phase !== 'owner-check' || !this.requireRuntime(id).granted) {
        throw new RemotePairingError('not_ready');
      }
      if (sub !== journal.sub) {
        await this.cleanup(journal);
        throw new RemotePairingError('wrong_account');
      }
      if (!validFuture(identityExpiresAt, this.now())) throw new RemotePairingError('invalid_session');
      journal.identityExpiresAt = identityExpiresAt;
      journal.updatedAt = new Date(this.now()).toISOString();
      await this.options.journals.write(journal);
    });
  }

  async confirm(id: string): Promise<Awaited<ReturnType<RemotePairingPublisher['publish']>>> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      const runtime = this.requireRuntime(id);
      if (
        journal.phase !== 'confirmation' || !runtime.preview || !runtime.ownership ||
        !journal.connection || !journal.preparedAgent || !journal.paired
      ) throw new RemotePairingError(journal.phase === 'committing' ? 'replayed' : 'not_ready');
      journal.phase = 'committing';
      journal.updatedAt = new Date(this.now()).toISOString();
      await this.options.journals.write(journal);
      const preparedDir = this.options.journals.preparedDir(id);
      await mkdir(preparedDir, { recursive: true, mode: 0o700 });
      await chmod(preparedDir, 0o700);
      const secrets = openFileSecretStore(preparedDir);
      await savePreparedAgentDevice(secrets, journal.paired, journal.preparedAgent);
      await writePairedSecrets(secrets, journal.paired);
      try { await runtime.link?.complete(); } catch { /* El sobre caduca solo. */ }
      let account: Awaited<ReturnType<RemotePairingPublisher['publish']>>;
      try {
        account = await this.options.publisher.publish({
          ownership: runtime.ownership,
          paired: journal.paired,
          preparedDir,
          journalId: id
        });
      } catch {
        const committed = await this.options.publisher.findCommitted(journal);
        if (committed) account = committed;
        else {
          await this.abortPublish(journal);
          throw new RemotePairingError('unavailable');
        }
      }
      journal.phase = 'finished';
      journal.cleanupRequired = false;
      journal.committedAccountId = account.id;
      journal.updatedAt = new Date(this.now()).toISOString();
      await this.options.journals.write(journal);
      await this.options.journals.remove(id);
      this.runtime.delete(id);
      return account;
    });
  }

  async cancel(id: string): Promise<void> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.cleanup(journal);
    });
  }

  /** Se ejecuta antes de aceptar tráfico. Nunca reanuda claves efímeras perdidas. */
  async recover(): Promise<{ cleaned: number; pending: number }> {
    let cleaned = 0;
    let pending = 0;
    for (const journal of await this.options.journals.list()) {
      if (journal.phase === 'finished' || journal.phase === 'cancelled') {
        await this.options.journals.remove(journal.id);
        cleaned += 1;
        continue;
      }
      if (await this.options.publisher.findCommitted(journal)) {
        await this.options.journals.remove(journal.id);
        cleaned += 1;
        continue;
      }
      if (!journal.connection || !journal.cleanupRequired) {
        await this.options.publisher.cleanupOrphan(journal);
        await this.options.journals.remove(journal.id);
        cleaned += 1;
        continue;
      }
      try {
        await this.revoke(journal.connection, this.fetcher);
        await this.options.publisher.cleanupOrphan(journal);
        await this.options.journals.remove(journal.id);
        cleaned += 1;
      } catch {
        pending += 1;
      }
    }
    return { cleaned, pending };
  }

  private async verifyOwnershipAndPreview(
    journal: RemotePairingJournal,
    runtime: RuntimePairing,
    granted: GrantedPoll
  ): Promise<RemotePairingStatus> {
    if (!journal.connection) throw new RemotePairingError('invalid_session');
    const recovered = await decodeRecoveryCode(granted.recoveryCode);
    const paired: PairedSecrets = {
      connection: journal.connection,
      recoveryCode: granted.recoveryCode,
      device: { opaqueDeviceId: randomBytes(16).toString('hex'), lumbreDeviceId: journal.deviceId }
    };
    const binding: Binding = {
      pairedCredentialId: journal.connection.credentialId,
      syncVaultId: recovered.syncVaultId,
      opaqueDeviceId: paired.device.opaqueDeviceId
    };
    let ownership: VerifiedOwnership;
    try {
      ownership = await this.options.ownership.verify({
        sub: journal.sub,
        binding,
        oauthRequestId: journal.oauthRequestId
      });
    } catch {
      await this.cleanup(journal);
      throw new RemotePairingError('wrong_account');
    }
    if (ownership.sub !== journal.sub || !sameBinding(binding, ownership.grant)) {
      await this.cleanup(journal);
      throw new RemotePairingError('wrong_account');
    }
    const verified = await runtime.link!.verify(granted);
    const preview: PairingPreview = {
      titles: verified.titles.slice(0, 3),
      vaultCreatedAt: verified.vaultCreatedAt,
      recordsRead: verified.recordsRead,
      more: verified.more
    };
    runtime.ownership = ownership;
    runtime.preview = preview;
    journal.ownership = ownership;
    journal.paired = paired;
    journal.phase = 'confirmation';
    journal.updatedAt = new Date(this.now()).toISOString();
    await this.options.journals.write(journal);
    return { kind: 'preview', preview };
  }

  private async cleanup(journal: RemotePairingJournal): Promise<void> {
    try { await this.runtime.get(journal.id)?.link?.cancel(); } catch { /* Caduca en el relé. */ }
    if (journal.connection && journal.cleanupRequired) {
      try {
        await this.revoke(journal.connection, this.fetcher);
      } catch {
        journal.updatedAt = new Date(this.now()).toISOString();
        await this.options.journals.write(journal);
        throw new RemotePairingError('unavailable');
      }
    }
    journal.phase = 'cancelled';
    journal.cleanupRequired = false;
    journal.updatedAt = new Date(this.now()).toISOString();
    await this.options.journals.write(journal);
    await this.options.journals.remove(journal.id);
    this.runtime.delete(journal.id);
  }

  /** Falla del rename/registro: revoca primero y no olvida un orphan no retirado. */
  private async abortPublish(journal: RemotePairingJournal): Promise<void> {
    try {
      if (journal.connection && journal.cleanupRequired) {
        await this.revoke(journal.connection, this.fetcher);
      }
      await this.options.publisher.cleanupOrphan(journal);
    } catch {
      journal.updatedAt = new Date(this.now()).toISOString();
      await this.options.journals.write(journal);
      throw new RemotePairingError('unavailable');
    }
    journal.phase = 'cancelled';
    journal.cleanupRequired = false;
    journal.updatedAt = new Date(this.now()).toISOString();
    await this.options.journals.write(journal);
    await this.options.journals.remove(journal.id);
    this.runtime.delete(journal.id);
  }

  private sessionOf(journal: RemotePairingJournal): RemotePairingSession {
    return {
      id: journal.id,
      oauthRequestId: journal.oauthRequestId,
      sub: journal.sub,
      expiresAt: journal.expiresAt
    };
  }

  private async requireJournal(id: string): Promise<RemotePairingJournal> {
    const journal = await this.options.journals.read(id).catch(() => null);
    if (!journal) throw new RemotePairingError('not_found');
    return journal;
  }

  private requireRuntime(id: string): RuntimePairing {
    const runtime = this.runtime.get(id);
    if (!runtime) throw new RemotePairingError('invalid_session');
    return runtime;
  }

  private async ensureAlive(journal: RemotePairingJournal): Promise<void> {
    if (Date.parse(journal.expiresAt) > this.now()) return;
    await this.cleanup(journal);
    throw new RemotePairingError('expired');
  }

  private async exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(id, tail);
    await previous;
    try { return await task(); }
    finally {
      release();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }
}
