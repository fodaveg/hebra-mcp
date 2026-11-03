import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeRecoveryCode, type DeviceLinkPoll, type LumbreConnection } from '../../src/hebra';
import type { ActiveGrant, Binding } from '../../src/oauth/backchannel';
import { PairError } from '../../src/pair/errors';
import { RemotePairingJournalStore } from '../../src/pair/remote/journal';
import type { RemoteLinkRequest } from '../../src/pair/remote/link';
import {
  REMOTE_PAIRING_ORIGIN,
  REMOTE_PAIRING_TTL_MS,
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

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('usa el callback exacto, comprueba dueño antes del preview y no persiste títulos', async () => {
    const calls: string[] = [];
    const link = fakeLink(recoveryCode, calls);
    const service = createService({
      link,
      registerDevice: async () => { calls.push('register'); return 'ok'; },
      ownership: async ({ sub, binding }) => {
        calls.push('owner');
        return ownership(sub, binding);
      }
    });
    const started = await service.start(startInput());
    const authorize = new URL(started.authorizationUrl);
    expect(authorize.searchParams.get('webOrigin')).toBe(REMOTE_PAIRING_ORIGIN);

    await service.receiveCredential(started.id, auth(started, started.formToken), 'one-use-code');
    const status = await service.poll(started.id, await currentAuth(service, started));
    expect(status.kind).toBe('preview');
    expect(calls).toEqual(['register', 'owner', 'preview']);
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
    await expect(service.receiveCredential(started.id,
      { cookie: 'cookie-de-otro-navegador', formToken: started.formToken }, 'code'))
      .rejects.toMatchObject({ code: 'invalid_form' });
    await service.receiveCredential(started.id, auth(started, started.formToken), 'one-use-code');
    await expect(service.poll(started.id, await currentAuth(service, started)))
      .rejects.toMatchObject({ code: 'wrong_account' });
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
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    clock += 2_000;
    await expect(service.poll(started.id, await currentAuth(service, started)))
      .resolves.toEqual({ kind: 'reauthenticate' });
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
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    await service.poll(started.id, await currentAuth(service, started));
    const confirmation = await currentAuth(service, started);
    const results = await Promise.allSettled([
      service.confirm(started.id, confirmation), service.confirm(started.id, confirmation)
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('si la identidad caduca tras preview, reautentica y publica sin repetir ownership', async () => {
    let clock = NOW;
    const verifyOwner = vi.fn(async ({ sub, binding }: { sub: string; binding: Binding }) => ownership(sub, binding));
    const publish = vi.fn(async () => ({ id: 'account-david', generation: 1 }));
    const service = createService({ link: fakeLink(recoveryCode, []), ownership: verifyOwner, publish,
      now: () => clock });
    const started = await service.start(startInput(new Date(NOW + 60_000).toISOString()));
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    await expect(service.poll(started.id, await currentAuth(service, started)))
      .resolves.toMatchObject({ kind: 'preview' });
    clock += 61_000;
    await expect(service.confirm(started.id, await currentAuth(service, started)))
      .resolves.toEqual({ kind: 'reauthenticate' });
    await service.resumeIdentity(started.id, 'sumego|david', new Date(clock + 60_000).toISOString());
    await expect(service.confirm(started.id, await currentAuth(service, started)))
      .resolves.toMatchObject({ kind: 'confirmed', account: { id: 'account-david' } });
    expect(verifyOwner).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
  });

  it('consume el token dentro del mismo lock en receive y poll concurrentes', async () => {
    const exchangeCode = vi.fn(async () => CONNECTION);
    const service = createService({ link: fakeLink(recoveryCode, []), exchangeCode });
    const started = await service.start(startInput());
    const firstForm = auth(started, started.formToken);
    const exchanges = await Promise.allSettled([
      service.receiveCredential(started.id, firstForm, 'code'),
      service.receiveCredential(started.id, firstForm, 'code')
    ]);
    expect(exchanges.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(exchangeCode).toHaveBeenCalledOnce();

    const pollForm = await currentAuth(service, started);
    const polls = await Promise.allSettled([
      service.poll(started.id, pollForm), service.poll(started.id, pollForm)
    ]);
    expect(polls.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('bloquea durablemente el alta y elimina el preview si falla la revocación', async () => {
    const service = createService({
      link: fakeLink(recoveryCode, []),
      revoke: async () => { throw new Error('offline'); }
    });
    const started = await service.start(startInput());
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    await service.poll(started.id, await currentAuth(service, started));
    const cancelForm = await currentAuth(service, started);
    await expect(service.cancel(started.id, cancelForm)).rejects.toMatchObject({ code: 'unavailable' });
    expect((await journals.read(started.id))?.phase).toBe('cleanup-pending');
    await expect(service.confirm(started.id, cancelForm)).rejects.toMatchObject({ code: 'invalid_session' });
  });

  it('falla cerrado en memoria si el disco no puede persistir cleanup-pending', async () => {
    const publish = vi.fn(async () => ({ id: 'account', generation: 1 }));
    const service = createService({ link: fakeLink(recoveryCode, []), publish });
    const started = await service.start(startInput());
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    await service.poll(started.id, await currentAuth(service, started));
    const cancelForm = await currentAuth(service, started);
    const write = journals.write.bind(journals);
    const writeSpy = vi.spyOn(journals, 'write').mockImplementation(async (journal) => {
      if (journal.phase === 'cleanup-pending') throw new Error('disk_full');
      return write(journal);
    });

    await expect(service.cancel(started.id, cancelForm)).rejects.toThrow('disk_full');
    expect((await journals.read(started.id))?.phase).toBe('confirmation');
    writeSpy.mockRestore();
    await expect(service.confirm(started.id, cancelForm)).rejects.toMatchObject({ code: 'invalid_session' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('recovery revoca el staging huérfano pero conserva una cuenta ya publicada', async () => {
    const revoke = vi.fn(async () => undefined);
    const first = createService({ link: fakeLink(recoveryCode, []), revoke });
    const abandoned = await first.start(startInput());
    await first.receiveCredential(abandoned.id, auth(abandoned, abandoned.formToken), 'code');

    const recovered = createService({
      link: fakeLink(recoveryCode, []),
      revoke,
      findCommitted: async () => null
    });
    await expect(recovered.recover()).resolves.toEqual({ cleaned: 1, pending: 0 });
    expect(revoke).toHaveBeenCalledOnce();
    expect(await journals.read(abandoned.id)).toBeNull();
  });

  it('recovery repite un exchange-pending idempotente y revoca la credencial recuperada', async () => {
    const first = createService({
      link: fakeLink(recoveryCode, []),
      exchangeCode: async () => { throw new Error('response_lost'); }
    });
    const pending = await first.start(startInput());
    await expect(first.receiveCredential(pending.id, auth(pending, pending.formToken), 'durable-code'))
      .rejects.toMatchObject({ code: 'unavailable' });
    expect((await journals.read(pending.id))?.phase).toBe('exchange-pending');

    const revoke = vi.fn(async () => undefined);
    const recovered = createService({
      link: fakeLink(recoveryCode, []),
      exchangeCode: async ({ code }) => {
        expect(code).toBe('durable-code');
        return CONNECTION;
      },
      revoke
    });
    await expect(recovered.recover()).resolves.toEqual({ cleaned: 1, pending: 0 });
    expect(revoke).toHaveBeenCalledOnce();
  });

  it.each([401, 404])(
    'conserva exchange-pending ante un rechazo HTTP %s ambiguo en recovery',
    async (status) => {
      const rejected = () => { throw new PairError('exchange_rejected', status); };
      const first = createService({
        link: fakeLink(recoveryCode, []),
        exchangeCode: async () => rejected()
      });
      const pending = await first.start(startInput());
      await expect(first.receiveCredential(pending.id, auth(pending, pending.formToken), 'durable-code'))
        .rejects.toMatchObject({ code: 'unavailable' });

      const recovered = createService({
        link: fakeLink(recoveryCode, []),
        exchangeCode: async () => rejected()
      });
      await expect(recovered.recover()).resolves.toEqual({ cleaned: 0, pending: 1 });
      expect((await journals.read(pending.id))?.phase).toBe('exchange-pending');
    }
  );

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
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    await service.poll(started.id, await currentAuth(service, started));
    await expect(service.confirm(started.id, await currentAuth(service, started)))
      .rejects.toMatchObject({ code: 'unavailable' });
    expect(revoke).toHaveBeenCalledOnce();
    expect(cleanupOrphan).toHaveBeenCalledOnce();
    expect(await journals.read(started.id)).toBeNull();
  });

  it.each(['credential', 'approval'] as const)('permite otra alta tras TTL de un diario %s abandonado', async (phase) => {
    let clock = NOW;
    const revoke = vi.fn(async () => undefined);
    const service = createService({ link: fakeLink(recoveryCode, []), now: () => clock, revoke });
    const started = await service.start(startInput());
    if (phase === 'approval') {
      await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    }
    clock += REMOTE_PAIRING_TTL_MS + 1;
    const replacement = await service.start(startInput(new Date(clock + 60_000).toISOString()));
    expect(replacement.id).not.toBe(started.id);
    expect(await journals.read(started.id)).toBeNull();
    expect(revoke).toHaveBeenCalledTimes(phase === 'approval' ? 1 : 0);
    expect(await service.sessionForCookie(started.cookie)).toBeNull();
  });

  it('TTL no olvida un canje ambiguo si sigue sin poder recuperar su resultado', async () => {
    let clock = NOW;
    const exchangeCode = vi.fn(async () => { throw new Error('offline'); });
    const service = createService({ link: fakeLink(recoveryCode, []), now: () => clock, exchangeCode });
    const started = await service.start(startInput());
    await expect(service.receiveCredential(started.id, auth(started, started.formToken), 'code'))
      .rejects.toMatchObject({ code: 'unavailable' });
    clock += REMOTE_PAIRING_TTL_MS + 1;
    await expect(service.start(startInput(new Date(clock + 60_000).toISOString())))
      .rejects.toMatchObject({ code: 'unavailable' });
    expect(exchangeCode).toHaveBeenCalledTimes(2);
    expect((await journals.read(started.id))?.phase).toBe('exchange-pending');
  });

  it.each([
    ['write', 'admin'], ['remove', 'admin'],
    ['write', 'ttl'], ['remove', 'ttl'],
    ['write', 'recover'], ['remove', 'recover'],
    ['write', 'abandon'], ['remove', 'abandon']
  ] as const)('publicar es irrevocable aunque falle %s al sellar y limpie %s', async (failure, cleanup) => {
    let clock = NOW;
    const revoke = vi.fn(async () => undefined);
    const cleanupOrphan = vi.fn(async () => undefined);
    const account = { id: 'account-david', generation: 1 };
    let committed = false;
    const service = createService({ link: fakeLink(recoveryCode, []), now: () => clock, revoke, cleanupOrphan,
      publish: async () => { committed = true; return account; },
      findCommitted: async () => committed ? account : null });
    const started = await service.start(startInput());
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    await service.poll(started.id, await currentAuth(service, started));
    const confirmation = await currentAuth(service, started);
    const write = journals.write.bind(journals);
    const failureSpy = failure === 'write'
      ? vi.spyOn(journals, 'write').mockImplementation(async (journal) => {
        if (journal.phase === 'finished') throw new Error('disk_full');
        await write(journal);
      })
      : vi.spyOn(journals, 'remove').mockRejectedValue(new Error('disk_full'));
    await expect(service.confirm(started.id, confirmation)).resolves.toEqual({ kind: 'confirmed', account });
    expect(await service.sessionForCookie(started.cookie)).toBeNull();
    await expect(service.cancel(started.id, confirmation)).rejects.toMatchObject({ code: 'invalid_session' });
    failureSpy.mockRestore();
    clock += REMOTE_PAIRING_TTL_MS + 1;
    if (cleanup === 'admin') await service.cleanupForSub('sumego|david');
    if (cleanup === 'ttl') await expect(service.formToken(started.id)).rejects.toMatchObject({ code: 'expired' });
    if (cleanup === 'recover') await expect(service.recover()).resolves.toEqual({ cleaned: 1, pending: 0 });
    if (cleanup === 'abandon') await service.abandon(started.id, 'oauth-1');
    await expect(service.recover()).resolves.toEqual({ cleaned: 0, pending: 0 });
    expect(revoke).not.toHaveBeenCalled();
    expect(cleanupOrphan).not.toHaveBeenCalled();
  });

  it('limpieza administrativa conserva un committing publicado antes de sellar', async () => {
    const revoke = vi.fn(async () => undefined);
    const service = createService({ link: fakeLink(recoveryCode, []), revoke,
      findCommitted: async () => ({ id: 'account-david', generation: 1 }) });
    const started = await service.start(startInput());
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    const journal = (await journals.read(started.id))!;
    journal.phase = 'committing';
    await journals.write(journal);
    await service.cleanupForSub('sumego|david');
    expect(revoke).not.toHaveBeenCalled();
    expect(await journals.read(started.id)).toBeNull();
  });

  it('abandon verifica el OAuth original y limpia el alta con identidad cambiada', async () => {
    const revoke = vi.fn(async () => undefined);
    const service = createService({ link: fakeLink(recoveryCode, []), revoke });
    const started = await service.start(startInput());
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    await expect(service.abandon(started.id, 'otro-oauth')).rejects.toMatchObject({ code: 'invalid_session' });
    expect(revoke).not.toHaveBeenCalled();
    await service.abandon(started.id, 'oauth-1');
    expect(revoke).toHaveBeenCalledOnce();
    expect(await journals.read(started.id)).toBeNull();
    expect(await service.sessionForCookie(started.cookie)).toBeNull();
  });

  it('TTL recupera un canje ambiguo antes de revocar y admitir una nueva alta', async () => {
    let clock = NOW;
    const exchangeCode = vi.fn().mockRejectedValueOnce(new Error('response_lost')).mockResolvedValue(CONNECTION);
    const revoke = vi.fn(async () => undefined);
    const service = createService({ link: fakeLink(recoveryCode, []), now: () => clock, exchangeCode, revoke });
    const started = await service.start(startInput());
    await expect(service.receiveCredential(started.id, auth(started, started.formToken), 'code'))
      .rejects.toMatchObject({ code: 'unavailable' });
    clock += REMOTE_PAIRING_TTL_MS + 1;
    const replacement = await service.start(startInput(new Date(clock + 60_000).toISOString()));
    expect(replacement.id).not.toBe(started.id);
    expect(exchangeCode).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledOnce();
    expect(await journals.read(started.id)).toBeNull();
  });

  it('TTL conserva el bloqueo si falla revocar y solo admite otra alta al resolverlo', async () => {
    let clock = NOW;
    const revoke = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const service = createService({ link: fakeLink(recoveryCode, []), now: () => clock, revoke });
    const started = await service.start(startInput());
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    clock += REMOTE_PAIRING_TTL_MS + 1;
    const replacementInput = startInput(new Date(clock + 60_000).toISOString());
    await expect(service.start(replacementInput)).rejects.toMatchObject({ code: 'unavailable' });
    expect((await journals.read(started.id))?.phase).toBe('cleanup-pending');
    expect(await service.sessionForCookie(started.cookie)).toBeNull();
    const outcomes = await Promise.allSettled([service.start(replacementInput), service.start(replacementInput)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(await journals.list()).toHaveLength(1);
  });

  function createService(input: {
    link: RemoteLinkRequest;
    ownership?: (input: { sub: string; binding: Binding; oauthRequestId: string }) => Promise<VerifiedOwnership>;
    revoke?: RemotePairingServiceOptions['revoke'];
    publish?: RemotePairingServiceOptions['publisher']['publish'];
    findCommitted?: RemotePairingServiceOptions['publisher']['findCommitted'];
    cleanupOrphan?: RemotePairingServiceOptions['publisher']['cleanupOrphan'];
    registerDevice?: RemotePairingServiceOptions['registerDevice'];
    exchangeCode?: RemotePairingServiceOptions['exchangeCode'];
    now?: () => number;
  }): RemotePairingService {
    return new RemotePairingService({
      journals,
      now: input.now ?? (() => NOW),
      exchangeCode: input.exchangeCode ?? (async () => CONNECTION),
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
      registerDevice: input.registerDevice ?? (async () => 'ok'),
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

function auth(started: { cookie: string }, formToken: string) {
  return { cookie: started.cookie, formToken };
}

async function currentAuth(
  service: RemotePairingService,
  started: { id: string; cookie: string }
) {
  return auth(started, await service.formToken(started.id));
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
