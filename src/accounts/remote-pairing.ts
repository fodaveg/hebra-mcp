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
  type RemotePairingPublisher
} from '../pair/remote';
import type { Fetcher } from '../pair/lumbre';
import { AccountRegistry } from './registry';

export const REMOTE_PAIRING_JOURNAL_DIR = 'remote-pairing-v1';

function samePublished(journal: RemotePairingJournal, record: ReturnType<AccountRegistry['findById']>): boolean {
  const ownership = journal.ownership;
  return !!record && !!ownership && record.state === 'active' && record.sub === ownership.sub &&
    record.accountId === ownership.grant.accountId &&
    record.binding.pairedCredentialId === ownership.grant.pairedCredentialId &&
    record.binding.syncVaultId === ownership.grant.syncVaultId &&
    record.binding.opaqueDeviceId === ownership.grant.opaqueDeviceId;
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
}

/** Monta el alta durable y sus adaptadores sin dar acceso al contexto hasta `commitAccount`. */
export async function openRemotePairing(options: OpenRemotePairingOptions): Promise<RemotePairingRuntime> {
  const journals = new RemotePairingJournalStore(join(options.dataDir, REMOTE_PAIRING_JOURNAL_DIR));
  const accountsRoot = join(options.dataDir, 'accounts');
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
      return samePublished(journal, record) ? { id: record!.id, generation: record!.generation } : null;
    },
    async cleanupOrphan(journal) {
      if (options.registry.findById(journal.id)) return;
      await rm(join(accountsRoot, journal.id), { recursive: true, force: true });
    }
  };
  const service = new RemotePairingService({ journals, publisher,
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
      return started.authorizationUrl;
    },
    resumeIdentity: (input) => service.resumeIdentity(input.pairingSessionId, input.sub, input.identityExpiresAt),
    abandon: (id, oauthRequestId) => service.abandon(id, oauthRequestId)
  });
  const router = createRemotePairingRouter(service, {
    resumeOauth: (input) => options.provider.resumeRemoteAuthorization(input),
    cancelOauth: (input) => options.provider.cancelRemoteAuthorization(input.oauthRequestId),
    reauthenticate: (input, res) => options.provider.reauthenticateRemote(input, res)
  });
  return { service, router, async cleanupForSub(sub: string) {
    await service.cleanupForSub(sub);
  } };
}
