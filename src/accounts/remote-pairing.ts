import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Response, Router } from 'express';
import type { HebraOAuthProvider } from '../oauth/provider';
import { BackchannelError } from '../oauth/backchannel';
import {
  createRemotePairingRouter,
  RemotePairingJournalStore,
  RemotePairingService,
  setRemotePairingCookie,
  RemotePairingError,
  type RemotePairingJournal,
  type RemotePairingPublisher,
  type RemotePairingRenewals
} from '../pair/remote';
import { hebraAccountIdOf } from '../pair/remote/account-id';
import type { Fetcher } from '../pair/lumbre';
import { openFileSecretStore, readPairedSecrets, readStoredIdentity, writePairedSecrets, type SecretStore } from '../secrets';
import { savePreparedAgentDevice } from '../spaces/device';
import { accountDataDir, AccountRegistry } from './registry';
import type { AccountRecord, AccountRef } from './types';

export const REMOTE_PAIRING_JOURNAL_DIR = 'remote-pairing-v1';
const PROBE_PATH = '/api/integrations/hebra/account/profile';

function samePublished(journal: RemotePairingJournal, record: ReturnType<AccountRegistry['findById']>): boolean {
  const ownership = journal.ownership;
  return !!record && !!ownership && record.state === 'active' && record.sub === ownership.sub &&
    record.accountId === ownership.grant.accountId &&
    record.binding.pairedCredentialId === ownership.grant.pairedCredentialId &&
    record.binding.syncVaultId === ownership.grant.syncVaultId &&
    record.binding.opaqueDeviceId === ownership.grant.opaqueDeviceId;
}

/** Lo que renovar necesita de `serve-http`: sin ello, una revocación sigue sin resolverse aquí. */
export interface RemotePairingAccountServices {
  contexts: { drainAndClose(ref: AccountRef): Promise<void> };
  removal: { remove(ref: AccountRef): Promise<void> };
  /** El store de la raíz heredada; las cuentas `account-dir` usan el suyo. */
  legacySecrets: SecretStore;
}

export interface OpenRemotePairingOptions {
  dataDir: string;
  registry: AccountRegistry;
  provider: HebraOAuthProvider;
  lumbreOrigin: string;
  fetcher?: Fetcher;
}

export interface RemotePairingRuntime {
  service: RemotePairingService;
  router: Router;
  cleanupForSub(sub: string): Promise<void>;
  attachAccountServices(services: RemotePairingAccountServices): void;
}

export interface RemotePairingAdapterOptions {
  dataDir: string;
  registry: AccountRegistry;
  provider: Pick<HebraOAuthProvider, 'invalidateFamiliesForRenewal' | 'pairing'>;
  services(): RemotePairingAccountServices | null;
}

/** Publicar un alta y renovar una cuenta, sobre el registro y los secretos reales de cada cuenta. */
export function remotePairingAdapters(options: RemotePairingAdapterOptions): {
  publisher: RemotePairingPublisher;
  renewals: RemotePairingRenewals;
  storeOf(record: AccountRecord, attached: RemotePairingAccountServices): SecretStore;
} {
  const accountsRoot = join(options.dataDir, 'accounts');
  const storeOf = (record: AccountRecord, attached: RemotePairingAccountServices): SecretStore =>
    record.storage === 'legacy-root' ? attached.legacySecrets :
      openFileSecretStore(accountDataDir(options.dataDir, record));
  const recordOfSub = (sub: string): AccountRecord | null => {
    const own = options.registry.findBySub(sub);
    if (own) return own.state === 'active' ? own : null;
    return options.registry.unclaimedLegacyOf(hebraAccountIdOf(sub));
  };
  const publisher: RemotePairingPublisher = {
    async publish(input) {
      await mkdir(accountsRoot, { recursive: true, mode: 0o700 });
      const target = join(accountsRoot, input.journalId);
      await rename(input.preparedDir, target);
      const directory = await open(accountsRoot, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      const record = await options.registry.commitAccount(input.ownership, { id: input.journalId });
      return { id: record.id, generation: record.generation };
    },
    async findCommitted(journal) {
      const record = options.registry.findById(journal.id);
      if (samePublished(journal, record)) return { id: record!.id, generation: record!.generation };
      // Una renovación publica sobre la cuenta existente: solo cuenta si la publicó este diario.
      const renewed = journal.renewal ? options.registry.findById(journal.renewal.id) : null;
      return renewed?.state === 'active' && renewed.renewedBy === journal.id
        ? { id: renewed.id, generation: renewed.generation } : null;
    },
    async cleanupOrphan(journal) {
      if (options.registry.findById(journal.id)) return;
      await rm(join(accountsRoot, journal.id), { recursive: true, force: true });
    }
  };
  const renewals: RemotePairingRenewals = {
    async target(sub) {
      const attached = options.services();
      const record = attached ? recordOfSub(sub) : null;
      if (!attached || !record) return null;
      const identity = await readStoredIdentity(storeOf(record, attached)).catch(() => null);
      return { id: record.id, generation: record.generation, accountId: record.accountId,
        syncVaultId: record.binding.syncVaultId, opaqueDeviceId: identity?.device.opaqueDeviceId,
        lumbreDeviceId: identity?.device.lumbreDeviceId };
    },
    async agentKey(renewal) {
      const record = options.registry.findById(renewal.id);
      const attached = options.services();
      if (!attached || !record) return undefined;
      const stored = await storeOf(record, attached).get('agent-device-key').catch(() => null);
      if (!stored) return undefined;
      try { return (JSON.parse(stored) as { privateKey?: JsonWebKey }).privateKey; }
      catch { return undefined; }
    },
    async publish(input) {
      const attached = options.services();
      if (!attached) throw new Error('renewals_not_attached');
      // Orden de §12.10: la cuenta queda bloqueada, sin familias ni contexto de la generación
      // anterior, antes de tocar sus secretos. Vínculo y generación se publican en una escritura.
      const held = await options.registry.beginRenewal(input.renewal, input.journalId);
      await options.provider.invalidateFamiliesForRenewal(held, input.ownership.sub);
      await attached.contexts.drainAndClose(held);
      const store = storeOf(held, attached);
      await savePreparedAgentDevice(store, input.paired, input.preparedAgent);
      await writePairedSecrets(store, input.paired);
      const record = await options.registry.commitRenewal(held, input.journalId, input.ownership);
      options.provider.pairing.isRevoked(record.binding.pairedCredentialId);
      return { id: record.id, generation: record.generation };
    },
    async retire(renewal) {
      const attached = options.services();
      if (!attached) throw new Error('renewals_not_attached');
      await attached.removal.remove({ id: renewal.id, generation: renewal.generation });
    },
    async abort(journal) {
      if (journal.renewal) await options.registry.abortRenewal(journal.renewal.id, journal.id);
    }
  };
  return { publisher, renewals, storeOf };
}

/** Monta el alta durable y sus adaptadores sin dar acceso al contexto hasta `commitAccount`. */
export async function openRemotePairing(options: OpenRemotePairingOptions): Promise<RemotePairingRuntime> {
  const journals = new RemotePairingJournalStore(join(options.dataDir, REMOTE_PAIRING_JOURNAL_DIR));
  let services: RemotePairingAccountServices | null = null;
  const { publisher, renewals, storeOf } = remotePairingAdapters({ dataDir: options.dataDir, registry: options.registry,
    provider: options.provider, services: () => services });
  const service = new RemotePairingService({ journals, publisher, renewals,
    ownership: { async verify(input) {
      try { return await options.provider.verifyRemoteOwnership(input); }
      catch (error) {
        if (error instanceof BackchannelError &&
          (error.kind === 'unavailable' || error.kind === 'rate_limited')) {
          throw new RemotePairingError('unavailable');
        }
        throw error;
      }
    } },
    lumbreOrigin: options.lumbreOrigin, fetcher: options.fetcher });
  await service.recover();
  options.provider.attachRemotePairing({
    async start(input, res: Response) {
      const started = await service.start(input);
      setRemotePairingCookie(res, started.cookie);
      // Primero el aviso previo; desde él se sale hacia Lumbre con un clic.
      return '/lumbre/pairing/start';
    },
    resumeIdentity: (input) => service.resumeIdentity(input.pairingSessionId, input.sub, input.identityExpiresAt),
    abandon: (id, oauthRequestId) => service.abandon(id, oauthRequestId),
    renewal: {
      ready: () => services !== null,
      // Lumbre puede dar por bueno el vínculo y el relé rechazar los tokens que guarda esta cuenta.
      async credentialRejected(account) {
        if (!services) return false;
        try {
          const paired = await readPairedSecrets(storeOf(account, services));
          if (!paired) return true;
          const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
          const response = await fetcher(new URL(PROBE_PATH, paired.connection.apiOrigin), {
            redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5_000),
            headers: { Authorization: `Bearer ${paired.connection.readToken}` }
          });
          await response.body?.cancel();
          return response.status === 401 || response.status === 403;
        } catch { return false; }
      }
    }
  });
  const router = createRemotePairingRouter(service, {
    resumeOauth: (input) => options.provider.resumeRemoteAuthorization(input),
    cancelOauth: (input) => options.provider.cancelRemoteAuthorization(input.oauthRequestId),
    reauthenticate: (input, res) => options.provider.reauthenticateRemote(input, res)
  });
  return { service, router, async cleanupForSub(sub: string) {
    await service.cleanupForSub(sub);
  }, attachAccountServices(attached) { services = attached; } };
}
