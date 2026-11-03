import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeRecoveryCode, type DeviceLinkPoll, type LumbreConnection } from '../../src/hebra';
import type { ActiveGrant, Binding } from '../../src/oauth/backchannel';
import { RemotePairingJournalStore } from '../../src/pair/remote/journal';
import type { RemoteLinkRequest } from '../../src/pair/remote/link';
import {
  REMOTE_PAIRING_ORIGIN,
  RemotePairingService,
  type RemotePairingServiceOptions
} from '../../src/pair/remote/service';
import type { VerifiedOwnership } from '../../src/pair/remote/types';

const NOW = Date.parse('2026-11-03T08:00:00.000Z');
const CONNECTION: LumbreConnection = {
  credentialId: '11111111-1111-4111-8111-111111111111',
  readToken: 'read-secret',
  writeToken: 'write-secret',
  apiOrigin: 'https://app.lumbre.pro',
  connectedAt: '2026-11-03T08:00:00.000Z'
};
const SYNC_VAULT = '22'.repeat(16);

describe('RemotePairingService', () => {
  let root: string;
  let journals: RemotePairingJournalStore;
  let recoveryCode: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hebra-remote-service-'));
    journals = new RemotePairingJournalStore(join(root, 'journals'));
    recoveryCode = await encodeRecoveryCode({
      relayOrigin: CONNECTION.apiOrigin,
      syncVaultId: SYNC_VAULT,
      keyEpoch: 1,
      vaultKey: new Uint8Array(32).fill(7)
    });
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('usa el callback exacto, comprueba dueño antes del preview y no persiste títulos', async () => {
    const calls: string[] = [];
    const link = fakeLink(recoveryCode, calls);
    const service = createService({
      link,
      ownership: async ({ sub, binding }) => {
        calls.push('owner');
        return ownership(sub, binding);
      }
    });
    const started = await service.start(startInput());
    const authorize = new URL(started.authorizationUrl);
    expect(authorize.searchParams.get('webOrigin')).toBe(REMOTE_PAIRING_ORIGIN);

    await service.authorizeForm(started.id, started.cookie, started.formToken);
    await expect(service.authorizeForm(started.id, started.cookie, started.formToken))
      .rejects.toMatchObject({ code: 'invalid_form' });
    await service.receiveCredential(started.id, 'one-use-code');
    const status = await service.poll(started.id);
    expect(status.kind).toBe('preview');
    expect(calls).toEqual(['owner', 'preview']);
    if (status.kind === 'preview') expect(status.preview.titles).toEqual(['<script>privada</script>']);
    const raw = await readFile(join(journals.sessionDir(started.id), 'pairing.json'), 'utf8');
    expect(raw).not.toContain('privada');
  });

  it('rechaza otro navegador y otra cuenta sin publicar ni mostrar títulos', async () => {
    const revoke = vi.fn(async () => undefined);
    const publish = vi.fn(async () => ({ id: 'account', generation: 1 }));
    const calls: string[] = [];
    const service = createService({
      link: fakeLink(recoveryCode, calls),
      revoke,
      publish,
      ownership: async ({ binding }) => {
        calls.push('owner');
        return ownership('sumego|mikel', binding);
      }
    });
    const started = await service.start(startInput());
    await expect(service.authorizeForm(started.id, 'cookie-de-otro-navegador', started.formToken))
      .rejects.toMatchObject({ code: 'invalid_form' });
    await service.receiveCredential(started.id, 'one-use-code');
    await expect(service.poll(started.id)).rejects.toMatchObject({ code: 'wrong_account' });
    expect(calls).toEqual(['owner']);
    expect(revoke).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it('exige reautenticación con el mismo sub y rechaza el sub cruzado', async () => {
    let clock = NOW;
    const revoke = vi.fn(async () => undefined);
    const service = createService({
      link: fakeLink(recoveryCode, []),
      revoke,
      now: () => clock
    });
    const started = await service.start(startInput(new Date(NOW + 1_000).toISOString()));
    await service.receiveCredential(started.id, 'code');
    clock += 2_000;
    await expect(service.poll(started.id)).resolves.toEqual({ kind: 'reauthenticate' });
    await expect(service.resumeIdentity(started.id, 'sumego|mikel', new Date(clock + 60_000).toISOString()))
      .rejects.toMatchObject({ code: 'wrong_account' });
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('serializa la doble confirmación y publica una sola cuenta', async () => {
    const publish = vi.fn(async ({ preparedDir }) => {
      expect(await readFile(join(preparedDir, 'secrets.json'), 'utf8')).toContain('recovery-code');
      return { id: 'account-david', generation: 1 };
    });
    const service = createService({ link: fakeLink(recoveryCode, []), publish });
    const started = await service.start(startInput());
    await service.receiveCredential(started.id, 'code');
    await service.poll(started.id);
    const results = await Promise.allSettled([service.confirm(started.id), service.confirm(started.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('recovery revoca el staging huérfano pero conserva una cuenta ya publicada', async () => {
    const revoke = vi.fn(async () => undefined);
    const first = createService({ link: fakeLink(recoveryCode, []), revoke });
    const abandoned = await first.start(startInput());
    await first.receiveCredential(abandoned.id, 'code');

    const recovered = createService({
      link: fakeLink(recoveryCode, []),
      revoke,
      findCommitted: async () => null
    });
    await expect(recovered.recover()).resolves.toEqual({ cleaned: 1, pending: 0 });
    expect(revoke).toHaveBeenCalledOnce();
    expect(await journals.read(abandoned.id)).toBeNull();
  });

  it('si publicar falla, revoca y retira la raíz huérfana antes de olvidar el diario', async () => {
    const revoke = vi.fn(async () => undefined);
    const cleanupOrphan = vi.fn(async () => undefined);
    const service = createService({
      link: fakeLink(recoveryCode, []),
      revoke,
      publish: async () => { throw new Error('registry_down'); },
      cleanupOrphan
    });
    const started = await service.start(startInput());
    await service.receiveCredential(started.id, 'code');
    await service.poll(started.id);
    await expect(service.confirm(started.id)).rejects.toMatchObject({ code: 'unavailable' });
    expect(revoke).toHaveBeenCalledOnce();
    expect(cleanupOrphan).toHaveBeenCalledOnce();
    expect(await journals.read(started.id)).toBeNull();
  });

  function createService(input: {
    link: RemoteLinkRequest;
    ownership?: (input: { sub: string; binding: Binding; oauthRequestId: string }) => Promise<VerifiedOwnership>;
    revoke?: RemotePairingServiceOptions['revoke'];
    publish?: RemotePairingServiceOptions['publisher']['publish'];
    findCommitted?: RemotePairingServiceOptions['publisher']['findCommitted'];
    cleanupOrphan?: RemotePairingServiceOptions['publisher']['cleanupOrphan'];
    now?: () => number;
  }): RemotePairingService {
    return new RemotePairingService({
      journals,
      now: input.now ?? (() => NOW),
      exchangeCode: async () => CONNECTION,
      prepareAgent: async (_connection, deviceId) => ({
        privateKey: { kty: 'EC', crv: 'P-256', d: 'private', x: 'x', y: 'y' },
        registration: {
          credentialId: CONNECTION.credentialId,
          deviceId,
          accountId: 'account-david',
          actorKind: 'agent',
          keyId: 'key',
          publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }
        }
      }),
      startLink: async () => input.link,
      revoke: input.revoke ?? (async () => undefined),
      ownership: { verify: input.ownership ?? (async ({ sub, binding }) => ownership(sub, binding)) },
      publisher: {
        publish: input.publish ?? (async () => ({ id: 'account', generation: 1 })),
        findCommitted: input.findCommitted ?? (async () => null),
        cleanupOrphan: input.cleanupOrphan ?? (async () => undefined)
      }
    });
  }
});

function startInput(identityExpiresAt = new Date(NOW + 5 * 60_000).toISOString()) {
  return { oauthRequestId: 'oauth-1', sub: 'sumego|david', identityExpiresAt };
}

function ownership(sub: string, binding: Binding): VerifiedOwnership {
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

function fakeLink(recoveryCode: string, calls: string[]): RemoteLinkRequest {
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
