import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeRecoveryCode, type DeviceLinkPoll, type LumbreConnection } from '../../src/hebra';
import type { ActiveGrant, Binding } from '../../src/oauth/backchannel';
import { hebraAccountIdOf } from '../../src/pair/remote/account-id';
import { RemotePairingJournalStore } from '../../src/pair/remote/journal';
import type { RemoteLinkRequest } from '../../src/pair/remote/link';
import {
  RemotePairingService,
  type RemotePairingServiceOptions
} from '../../src/pair/remote/service';
import type { RemotePairingRenewals, VerifiedOwnership } from '../../src/pair/remote/types';

/**
 * Soporte común de los tests de `RemotePairingService` (`test/pair/remote-service.*.test.ts`):
 * constantes, diario temporal, servicio con dobles y los ayudantes de formulario.
 */
export const NOW = Date.parse('2026-11-03T08:00:00.000Z');
export const CONNECTION: LumbreConnection = {
  credentialId: '11111111-1111-4111-8111-111111111111',
  readToken: 'read-secret',
  writeToken: 'write-secret',
  apiOrigin: 'https://app.lumbre.pro',
  connectedAt: '2026-11-03T08:00:00.000Z'
};
export const SYNC_VAULT = '22'.repeat(16);

/** Directorio temporal, diario y código de recuperación de un test (el que llama borra `root`). */
export async function openHarness(): Promise<{
  root: string;
  journals: RemotePairingJournalStore;
  recoveryCode: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'hebra-remote-service-'));
  const journals = new RemotePairingJournalStore(join(root, 'journals'));
  const recoveryCode = await encodeRecoveryCode({
    relayOrigin: CONNECTION.apiOrigin,
    syncVaultId: SYNC_VAULT,
    keyEpoch: 1,
    vaultKey: new Uint8Array(32).fill(7)
  });
  return { root, journals, recoveryCode };
}

export interface CreateServiceInput {
  link: RemoteLinkRequest;
  ownership?: (input: { sub: string; binding: Binding; oauthRequestId: string }) => Promise<VerifiedOwnership>;
  revoke?: RemotePairingServiceOptions['revoke'];
  publish?: RemotePairingServiceOptions['publisher']['publish'];
  findCommitted?: RemotePairingServiceOptions['publisher']['findCommitted'];
  cleanupOrphan?: RemotePairingServiceOptions['publisher']['cleanupOrphan'];
  registerDevice?: RemotePairingServiceOptions['registerDevice'];
  exchangeCode?: RemotePairingServiceOptions['exchangeCode'];
  now?: () => number;
  renewals?: RemotePairingRenewals;
  agentAccountId?: () => string;
  startLink?: RemotePairingServiceOptions['startLink'];
  prepareAgentSpy?: (...args: unknown[]) => void;
}

export function buildService(
  journals: RemotePairingJournalStore,
  input: CreateServiceInput
): RemotePairingService {
  return new RemotePairingService({
    journals,
    now: input.now ?? (() => NOW),
    exchangeCode: input.exchangeCode ?? (async () => CONNECTION),
    prepareAgent: async (connection, deviceId, fetcher, existingKey) => {
      input.prepareAgentSpy?.(connection, deviceId, fetcher, existingKey);
      return {
        privateKey: { kty: 'EC', crv: 'P-256', d: 'private', x: 'x', y: 'y' },
        registration: {
          credentialId: CONNECTION.credentialId,
          deviceId,
          accountId: input.agentAccountId?.() ?? hebraAccountIdOf('sumego|david'),
          actorKind: 'agent',
          keyId: 'key',
          publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }
        }
      };
    },
    startLink: input.startLink ?? (async () => input.link),
    renewals: input.renewals,
    revoke: input.revoke ?? (async () => undefined),
    registerDevice: input.registerDevice ?? (async () => 'ok'),
    ownership: { verify: input.ownership ?? (async ({ sub, binding }) => ownership(sub, binding)) },
    publisher: {
      publish: input.publish ?? (async () => ({ id: 'account', generation: 1 })),
      findCommitted: input.findCommitted ?? (async () => null),
      cleanupOrphan: input.cleanupOrphan ?? (async () => undefined)
    }
  });
}

export function startInput(identityExpiresAt = new Date(NOW + 5 * 60_000).toISOString()) {
  return { oauthRequestId: 'oauth-1', sub: 'sumego|david', identityExpiresAt };
}

export function auth(started: { cookie: string }, formToken: string) {
  return { cookie: started.cookie, formToken };
}

export async function currentAuth(
  service: RemotePairingService,
  started: { id: string; cookie: string }
) {
  return auth(started, await service.formToken(started.id));
}

export function ownership(sub: string, binding: Binding): VerifiedOwnership {
  const grant: ActiveGrant = {
    ...binding,
    credentialId: '33333333-3333-4333-8333-333333333333',
    clientId: 'hebra-desktop',
    resource: 'https://mcp.hebra.pro',
    scope: 'hebra:library',
    accountId: '44'.repeat(32),
    expiresAt: '2026-11-03T09:00:00.000Z',
    active: true
  };
  return { sub, grant };
}

export function fakeLink(recoveryCode: string, calls: string[]): RemoteLinkRequest {
  const granted: Extract<DeviceLinkPoll, { kind: 'granted' }> = {
    kind: 'granted',
    recoveryCode,
    approverLabel: 'David',
    approverSyncVaultId: SYNC_VAULT,
    approverVaultCreatedAt: '2026-01-01T00:00:00.000Z',
    vaultCount: 1
  };
  return {
    createdAt: '2026-11-03T08:00:00.000Z',
    initialRemainingMs: 600_000,
    poll: async () => granted,
    verify: async () => {
      calls.push('preview');
      return {
        syncVaultId: SYNC_VAULT,
        vaultCreatedAt: '2026-01-01T00:00:00.000Z',
        vaultCount: 1,
        recordsRead: 1,
        unreadable: 0,
        more: false,
        titles: ['<script>privada</script>']
      };
    },
    complete: async () => undefined,
    cancel: async () => undefined
  };
}
