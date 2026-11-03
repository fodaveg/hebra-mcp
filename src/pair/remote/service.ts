import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { decodeRecoveryCode, sanitizeDeviceLabel } from '../../hebra';
import { sameBinding, type Binding } from '../../oauth/backchannel';
import { openFileSecretStore, writePairedSecrets, type PairedSecrets } from '../../secrets';
import { linkedSyncFrom, registerLinkedDevice } from '../../sync/linked';
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
  type RemotePairingFormAuthorization,
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
  registerDevice?: (paired: PairedSecrets, fetcher: Fetcher) => Promise<string>;
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
  private readonly registerDevice: (paired: PairedSecrets, fetcher: Fetcher) => Promise<string>;

  constructor(private readonly options: RemotePairingServiceOptions) {
    this.publicOrigin = options.publicOrigin ?? REMOTE_PAIRING_ORIGIN;
    if (this.publicOrigin !== REMOTE_PAIRING_ORIGIN) throw new Error('invalid_remote_pairing_origin');
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.exchangeCode = options.exchangeCode ?? exchangePairingCode;
    this.prepareAgent = options.prepareAgent ?? prepareAgentDevice;
    this.startLink = options.startLink ?? startRemoteLink;
    this.revoke = options.revoke ?? revokeRemoteCredential;
    this.registerDevice = options.registerDevice ?? (async (paired, fetcher) => {
      const linked = await linkedSyncFrom(paired, { fetcher });
      return linked ? registerLinkedDevice(linked, fetcher) : 'account_mismatch';
    });
  }

  async start(input: StartRemotePairingInput): Promise<StartedRemotePairing> {
    return this.exclusive(`sub:${input.sub}`, () => this.startUnlocked(input));
  }

  private async startUnlocked(input: StartRemotePairingInput): Promise<StartedRemotePairing> {
    if (!input.oauthRequestId || !input.sub || !validFuture(input.identityExpiresAt, this.now())) {
      throw new RemotePairingError('invalid_session');
    }
    for (const candidate of await this.options.journals.list()) {
      if (candidate.sub !== input.sub || ['finished', 'cancelled'].includes(candidate.phase)) continue;
      await this.exclusive(candidate.id, async () => {
        const existing = await this.options.journals.read(candidate.id);
        if (!existing || ['finished', 'cancelled'].includes(existing.phase)) return;
        if (validFuture(existing.expiresAt, this.now())) throw new RemotePairingError('replayed');
        // El TTL retira el intento anterior solo tras resolver sus efectos remotos.
        await this.cleanup(existing);
      });
    }
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
      return this.exclusive(id, async () => {
        const current = this.runtime.get(id);
        if (!current || current.cookie !== cookie) return null;
        const journal = await this.requireJournal(id);
        if (!equalDigest(journal.cookieHash, cookie)) return null;
        await this.ensureAlive(journal);
        return this.sessionOf(journal);
      });
    }
    return null;
  }

  async pageForCookie(cookie: string): Promise<{
    session: RemotePairingSession;
    formToken: string;
  } | null> {
    for (const [id, runtime] of this.runtime) {
      if (runtime.cookie !== cookie) continue;
      return this.exclusive(id, async () => {
        const current = this.runtime.get(id);
        if (!current || current.cookie !== cookie) return null;
        const journal = await this.requireJournal(id);
        if (!equalDigest(journal.cookieHash, cookie)) return null;
        await this.ensureAlive(journal);
        return { session: this.sessionOf(journal), formToken: current.csrf };
      });
    }
    return null;
  }

  async session(id: string): Promise<RemotePairingSession> {
    return this.sessionOf(await this.requireJournal(id));
  }

  async formToken(id: string): Promise<string> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      return this.requireRuntime(id).csrf;
    });
  }

  private async authorizeFormLocked(
    journal: RemotePairingJournal,
    runtime: RuntimePairing,
    authorization: RemotePairingFormAuthorization
  ): Promise<void> {
    const { cookie, formToken } = authorization;
    if (
      runtime.cookie !== cookie || runtime.csrf !== formToken ||
      !equalDigest(journal.cookieHash, cookie) || !equalDigest(journal.csrfHash, formToken)
    ) throw new RemotePairingError('invalid_form');
    // Cada POST consume su token antes de ejecutar cualquier efecto remoto.
    runtime.csrf = randomBytes(32).toString('base64url');
    journal.csrfHash = digest(runtime.csrf);
    journal.updatedAt = new Date(this.now()).toISOString();
    await this.options.journals.write(journal);
  }

  async receiveCredential(
    id: string,
    authorization: RemotePairingFormAuthorization,
    code: string
  ): Promise<void> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      const runtime = this.requireRuntime(id);
      await this.authorizeFormLocked(journal, runtime, authorization);
      if (journal.phase !== 'credential') throw new RemotePairingError('replayed');
      if (!code || code.length > 4_096) throw new RemotePairingError('invalid_form');
      // El intent queda durable ANTES del efecto remoto. Sin idempotencia/revocación por
      // deviceId, una respuesta perdida no se puede clasificar como «sin efecto».
      journal.phase = 'exchange-pending';
      journal.cleanupRequired = true;
      journal.pairingCode = code;
      journal.updatedAt = new Date(this.now()).toISOString();
      await this.options.journals.write(journal);
      let connection;
      try {
        connection = await this.exchangeCode({
          apiOrigin: this.options.lumbreOrigin ?? DEFAULT_LUMBRE_ORIGIN,
          code,
          deviceId: journal.deviceId,
          verifier: journal.verifier,
          fetcher: this.fetcher,
          now: this.now
        });
      } catch {
        this.runtime.delete(id);
        throw new RemotePairingError('unavailable');
      }
      journal.connection = connection;
      journal.pairingCode = undefined;
      journal.phase = 'credential';
      journal.updatedAt = new Date(this.now()).toISOString();
      try {
        await this.options.journals.write(journal);
      } catch {
        this.runtime.delete(id);
        try {
          await this.revoke(connection, this.fetcher);
          journal.phase = 'cancelled';
          journal.cleanupRequired = false;
          await this.options.journals.write(journal);
          await this.options.journals.remove(id);
        } catch { /* El intent durable bloquea una reactivación hasta recovery. */ }
        throw new RemotePairingError('unavailable');
      }
      try {
        journal.preparedAgent = await this.prepareAgent(connection, journal.deviceId, this.fetcher);
        const link = await this.startLink({
          connection,
          label: DEFAULT_PAIR_LABEL,
          fetcher: this.fetcher
        });
        runtime.link = link;
        journal.phase = 'approval';
        journal.updatedAt = new Date(this.now()).toISOString();
        await this.options.journals.write(journal);
      } catch {
        await this.cleanup(journal);
        throw new RemotePairingError('unavailable');
      }
    });
  }

  async poll(
    id: string,
    authorization: RemotePairingFormAuthorization
  ): Promise<RemotePairingStatus> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      const runtime = this.requireRuntime(id);
      await this.authorizeFormLocked(journal, runtime, authorization);
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
      if ((journal.phase !== 'owner-check' && journal.phase !== 'confirmation') || !this.requireRuntime(id).granted) {
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

  async confirm(
    id: string,
    authorization: RemotePairingFormAuthorization
  ): Promise<
    | { kind: 'reauthenticate' }
    | { kind: 'confirmed'; account: Awaited<ReturnType<RemotePairingPublisher['publish']>> }
  > {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      const runtime = this.requireRuntime(id);
      await this.authorizeFormLocked(journal, runtime, authorization);
      if (
        journal.phase !== 'confirmation' || !runtime.preview || !runtime.ownership ||
        !journal.connection || !journal.preparedAgent || !journal.paired
      ) throw new RemotePairingError(journal.phase === 'committing' ? 'replayed' : 'not_ready');
      if (!validFuture(journal.identityExpiresAt, this.now())) return { kind: 'reauthenticate' };
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
        this.runtime.delete(id);
        const committed = await this.options.publisher.findCommitted(journal);
        if (committed) account = committed;
        else {
          await this.abortPublish(journal);
          throw new RemotePairingError('unavailable');
        }
      }
      // La cuenta publicada ya no pertenece al alta cancelable, incluso si falla el disco.
      this.runtime.delete(id);
      journal.phase = 'finished';
      journal.cleanupRequired = false;
      journal.committedAccountId = account.id;
      journal.updatedAt = new Date(this.now()).toISOString();
      try {
        await this.options.journals.write(journal);
        await this.options.journals.remove(id);
      } catch { /* Recovery reconoce la publicación durable antes de limpiar el diario. */ }
      return { kind: 'confirmed', account };
    });
  }

  async cancel(id: string, authorization: RemotePairingFormAuthorization): Promise<void> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      const runtime = this.requireRuntime(id);
      await this.authorizeFormLocked(journal, runtime, authorization);
      await this.cleanup(journal);
    });
  }

  /** Callback OAuth autenticado: solo puede abandonar la transacción original enlazada. */
  async abandon(id: string, oauthRequestId: string): Promise<void> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      if (journal.oauthRequestId !== oauthRequestId) throw new RemotePairingError('invalid_session');
      await this.cleanup(journal);
    });
  }

  /** Retirada administrativa ya autenticada por el control local; no depende de CSRF web. */
  async cleanupForSub(sub: string): Promise<void> {
    for (const candidate of await this.options.journals.list()) {
      if (candidate.sub !== sub) continue;
      await this.exclusive(candidate.id, async () => this.cleanup(await this.requireJournal(candidate.id)));
    }
  }

  /** Se ejecuta antes de aceptar tráfico. Nunca reanuda claves efímeras perdidas. */
  async recover(): Promise<{ cleaned: number; pending: number }> {
    let cleaned = 0;
    let pending = 0;
    for (const candidate of await this.options.journals.list()) {
      try {
        await this.exclusive(candidate.id, async () => {
          const journal = await this.options.journals.read(candidate.id);
          if (journal) await this.cleanup(journal);
        });
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
    if (await this.registerDevice(paired, this.fetcher) !== 'ok') {
      await this.cleanup(journal);
      throw new RemotePairingError('unavailable');
    }
    let ownership: VerifiedOwnership;
    try {
      ownership = await this.options.ownership.verify({
        sub: journal.sub,
        binding,
        oauthRequestId: journal.oauthRequestId
      });
    } catch (error) {
      await this.cleanup(journal);
      if (error instanceof RemotePairingError && error.code === 'unavailable') throw error;
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
    const link = this.runtime.get(journal.id)?.link;
    // El proceso falla cerrado incluso si el disco falla al persistir el bloqueo.
    this.runtime.delete(journal.id);
    // Publicar es irreversible para el alta: nunca revocar una cuenta ya registrada.
    if (journal.phase === 'finished' || journal.phase === 'cancelled' ||
      await this.options.publisher.findCommitted(journal)) {
      await this.options.journals.remove(journal.id);
      return;
    }
    if (journal.cleanupRequired && !journal.connection) {
      // Un error HTTP genérico no prueba que el canje no ocurrió. Conservar el intent
      // hasta recuperar exactamente su resultado y poder revocarlo.
      if (journal.phase !== 'exchange-pending' || !journal.pairingCode) {
        throw new RemotePairingError('unavailable');
      }
      try {
        journal.connection = await this.exchangeCode({
          apiOrigin: this.options.lumbreOrigin ?? DEFAULT_LUMBRE_ORIGIN,
          code: journal.pairingCode,
          deviceId: journal.deviceId,
          verifier: journal.verifier,
          fetcher: this.fetcher,
          now: this.now
        });
        journal.pairingCode = undefined;
      } catch {
        throw new RemotePairingError('unavailable');
      }
    }
    journal.phase = 'cleanup-pending';
    journal.updatedAt = new Date(this.now()).toISOString();
    await this.options.journals.write(journal);
    try { await link?.cancel(); } catch { /* Caduca en el relé. */ }
    if (journal.connection && journal.cleanupRequired) {
      try {
        await this.revoke(journal.connection, this.fetcher);
      } catch {
        throw new RemotePairingError('unavailable');
      }
    }
    await this.options.publisher.cleanupOrphan(journal);
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
      await this.cleanup(journal);
    } catch {
      throw new RemotePairingError('unavailable');
    }
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
