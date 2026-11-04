import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PairError } from '../../src/pair/errors';
import { RemotePairingJournalStore } from '../../src/pair/remote/journal';
import { RevokeError } from '../../src/pair/remote/revoke';
import {
  REMOTE_PAIRING_TTL_MS,
  type RemotePairingService
} from '../../src/pair/remote/service';
import {
  CONNECTION,
  NOW,
  auth,
  buildService,
  currentAuth,
  fakeLink,
  openHarness,
  startInput,
  type CreateServiceInput
} from '../fixtures/remote-service-harness';

describe('RemotePairingService: recovery, TTL y limpieza', () => {
  let root: string;
  let journals: RemotePairingJournalStore;
  let recoveryCode: string;

  beforeEach(async () => {
    ({ root, journals, recoveryCode } = await openHarness());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function createService(input: CreateServiceInput): RemotePairingService {
    return buildService(journals, input);
  }

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

  it.each([404, 410])(
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

  it.each(['credential', 'approval'] as const)(
    'un login nuevo del mismo sub antes del TTL sustituye al diario %s sin terminar', async (phase) => {
      const revoke = vi.fn(async () => undefined);
      const service = createService({ link: fakeLink(recoveryCode, []), revoke });
      const started = await service.start(startInput());
      if (phase === 'approval') await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
      const replacement = await service.start(startInput());
      expect(replacement.id).not.toBe(started.id);
      expect(await journals.read(started.id)).toBeNull();
      expect(await service.sessionForCookie(started.cookie)).toBeNull();
      expect(await service.sessionForCookie(replacement.cookie)).not.toBeNull();
      expect(revoke).toHaveBeenCalledTimes(phase === 'approval' ? 1 : 0);
    });

  it('sustituir un intento no revoca una cuenta ya publicada', async () => {
    const revoke = vi.fn(async () => undefined);
    const cleanupOrphan = vi.fn(async () => undefined);
    const service = createService({ link: fakeLink(recoveryCode, []), revoke, cleanupOrphan,
      findCommitted: async () => ({ id: 'account-david', generation: 1 }) });
    const started = await service.start(startInput());
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    await service.start(startInput());
    expect(revoke).not.toHaveBeenCalled();
    expect(cleanupOrphan).not.toHaveBeenCalled();
  });

  it('un canje ambiguo sin resolver no bloquea el login siguiente; el log da un motivo cerrado', async () => {
    let clock = NOW;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exchangeCode = vi.fn(async () => { throw new PairError('exchange_rejected', 410); });
    const service = createService({ link: fakeLink(recoveryCode, []), now: () => clock, exchangeCode });
    const started = await service.start(startInput());
    await expect(service.receiveCredential(started.id, auth(started, started.formToken), 'secret-code'))
      .rejects.toMatchObject({ code: 'unavailable', reason: 'exchange_failed:exchange_rejected:410' });
    clock = NOW + 1_000;
    const next = await service.start(startInput(new Date(clock + 60_000).toISOString()));
    expect(await service.sessionForCookie(next.cookie)).not.toBeNull();
    // El efecto sin resolver no se olvida: sigue en disco, sin sesión, con su intención.
    expect(await journals.read(started.id)).toMatchObject({ phase: 'exchange-pending', pairingCode: 'secret-code' });
    const logged = stderr.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes('remote_pairing.superseded'));
    expect(logged.map((line) => JSON.parse(line))).toEqual([{ event: 'remote_pairing.superseded', result: 'cleanup_pending',
      reason: 'cleanup_exchange_recover_failed:exchange_rejected:410' }]);
    expect(logged.join('')).not.toContain('secret-code');
    expect(logged.join('')).not.toContain('sumego|david');
  });

  it('si la revocación del intento anterior falla, el login siguiente sigue y el log da el estado HTTP', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const revoke = vi.fn().mockRejectedValueOnce(new RevokeError(403)).mockResolvedValue(undefined);
    const service = createService({ link: fakeLink(recoveryCode, []), revoke });
    const started = await service.start(startInput());
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    const next = await service.start(startInput());
    expect(next.id).not.toBe(started.id);
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('cleanup_revoke_failed:403');
    expect((await journals.read(started.id))?.phase).toBe('cleanup-pending');
    // El barrido la termina y no toca la transacción que está viva.
    await expect(service.recover()).resolves.toEqual({ cleaned: 1, pending: 0 });
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(await journals.read(started.id)).toBeNull();
    expect(await service.sessionForCookie(next.cookie)).not.toBeNull();
  });

  it('TTL no olvida un canje ambiguo si sigue sin poder recuperar su resultado', async () => {
    let clock = NOW;
    const exchangeCode = vi.fn(async () => { throw new Error('offline'); });
    const service = createService({ link: fakeLink(recoveryCode, []), now: () => clock, exchangeCode });
    const started = await service.start(startInput());
    await expect(service.receiveCredential(started.id, auth(started, started.formToken), 'code'))
      .rejects.toMatchObject({ code: 'unavailable' });
    clock += REMOTE_PAIRING_TTL_MS + 1;
    await service.start(startInput(new Date(clock + 60_000).toISOString()));
    expect(exchangeCode).toHaveBeenCalledTimes(2);
    expect((await journals.read(started.id))?.phase).toBe('exchange-pending');
    await expect(service.recover()).resolves.toEqual({ cleaned: 0, pending: 1 });
    expect((await journals.read(started.id))?.phase).toBe('exchange-pending');
  });

  it('un canje perdido cuyo código resulta inválido en recovery se resuelve sin revocar nada', async () => {
    const revoke = vi.fn(async () => undefined);
    const first = createService({ link: fakeLink(recoveryCode, []), exchangeCode: async () => { throw new Error('offline'); } });
    const started = await first.start(startInput());
    await expect(first.receiveCredential(started.id, auth(started, started.formToken), 'code'))
      .rejects.toMatchObject({ code: 'unavailable' });
    const recovered = createService({ link: fakeLink(recoveryCode, []), revoke,
      exchangeCode: async () => { throw new PairError('exchange_rejected', 401); } });
    await expect(recovered.recover()).resolves.toEqual({ cleaned: 1, pending: 0 });
    expect(revoke).not.toHaveBeenCalled();
    expect(await journals.read(started.id)).toBeNull();
  });

  it('recover no toca una transacción viva y limpia la que caducó', async () => {
    let clock = NOW;
    const revoke = vi.fn(async () => undefined);
    const service = createService({ link: fakeLink(recoveryCode, []), revoke, now: () => clock });
    const started = await service.start(startInput());
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    await expect(service.recover()).resolves.toEqual({ cleaned: 0, pending: 0 });
    expect(revoke).not.toHaveBeenCalled();
    expect(await service.sessionForCookie(started.cookie)).not.toBeNull();
    clock += REMOTE_PAIRING_TTL_MS + 1;
    await expect(service.recover()).resolves.toEqual({ cleaned: 1, pending: 0 });
    expect(revoke).toHaveBeenCalledOnce();
    expect(await journals.read(started.id)).toBeNull();
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

  it('TTL deja pendiente una revocación fallida sin frenar la otra alta y la resuelve al repetir', async () => {
    let clock = NOW;
    const revoke = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const service = createService({ link: fakeLink(recoveryCode, []), now: () => clock, revoke });
    const started = await service.start(startInput());
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    clock += REMOTE_PAIRING_TTL_MS + 1;
    const replacementInput = startInput(new Date(clock + 60_000).toISOString());
    const replacement = await service.start(replacementInput);
    expect((await journals.read(started.id))?.phase).toBe('cleanup-pending');
    expect(await service.sessionForCookie(started.cookie)).toBeNull();
    expect(await service.sessionForCookie(replacement.cookie)).not.toBeNull();
    const outcomes = await Promise.allSettled([service.start(replacementInput), service.start(replacementInput)]);
    // Dos logins simultáneos del mismo sub: gana el último y solo queda un diario vivo.
    const live = [];
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled' && await service.sessionForCookie(outcome.value.cookie)) live.push(outcome.value.id);
    }
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(2);
    expect(live).toHaveLength(1);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(await journals.list()).toHaveLength(1);
    expect((await journals.list())[0]!.id).toBe(live[0]);
  });
});
