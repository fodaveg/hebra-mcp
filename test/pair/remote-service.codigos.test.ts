import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PairError } from '../../src/pair/errors';
import { hebraAccountIdOf } from '../../src/pair/remote/account-id';
import { RemotePairingJournalStore } from '../../src/pair/remote/journal';
import { RevokeError } from '../../src/pair/remote/revoke';
import type { RemotePairingService } from '../../src/pair/remote/service';
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

describe('RemotePairingService: códigos rechazados y cuenta equivocada', () => {
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

  it.each([400, 401])('un código que Lumbre rechaza con %s no bloquea: la misma transacción acepta el bueno', async (status) => {
    const revoke = vi.fn(async () => undefined);
    const exchangeCode = vi.fn(async ({ code }: { code: string }) => {
      if (code === 'basura') throw new PairError('exchange_rejected', status);
      return CONNECTION;
    });
    const service = createService({ link: fakeLink(recoveryCode, []), exchangeCode, revoke });
    const started = await service.start(startInput());
    await expect(service.receiveCredential(started.id, auth(started, started.formToken), 'basura'))
      .rejects.toMatchObject({ code: 'code_rejected' });
    const journal = await journals.read(started.id);
    expect(journal).toMatchObject({ phase: 'credential', cleanupRequired: false });
    expect(journal?.pairingCode).toBeUndefined();
    await service.receiveCredential(started.id, await currentAuth(service, started), 'bueno');
    expect((await journals.read(started.id))?.phase).toBe('approval');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('código rechazado, login nuevo y alta correcta: nada queda bloqueado ni se revoca', async () => {
    const revoke = vi.fn(async () => undefined);
    const exchangeCode = vi.fn(async ({ code }: { code: string }) => {
      if (code === 'basura') throw new PairError('exchange_rejected', 401);
      return CONNECTION;
    });
    const publish = vi.fn(async () => ({ id: 'account-david', generation: 1 }));
    const service = createService({ link: fakeLink(recoveryCode, []), exchangeCode, revoke, publish });
    const first = await service.start(startInput());
    await expect(service.receiveCredential(first.id, auth(first, first.formToken), 'basura'))
      .rejects.toMatchObject({ code: 'code_rejected' });
    const second = await service.start(startInput());
    expect(await journals.read(first.id)).toBeNull();
    await service.receiveCredential(second.id, auth(second, second.formToken), 'bueno');
    await service.poll(second.id, await currentAuth(service, second));
    await expect(service.confirm(second.id, await currentAuth(service, second)))
      .resolves.toMatchObject({ kind: 'confirmed', account: { id: 'account-david' } });
    expect(revoke).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
  });

  it('cinco códigos rechazados en una transacción la terminan, sin tocar a Lumbre más', async () => {
    const exchangeCode = vi.fn(async () => { throw new PairError('exchange_rejected', 401); });
    const service = createService({ link: fakeLink(recoveryCode, []), exchangeCode });
    const started = await service.start(startInput());
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await expect(service.receiveCredential(started.id, await currentAuth(service, started), 'basura'))
        .rejects.toMatchObject({ code: 'code_rejected' });
    }
    await expect(service.receiveCredential(started.id, await currentAuth(service, started), 'basura'))
      .rejects.toMatchObject({ code: 'too_many_codes' });
    expect(exchangeCode).toHaveBeenCalledTimes(5);
    expect(await journals.read(started.id)).toBeNull();
  });

  it('los rechazos de una persona suman entre transacciones; con el tope no se canjea nada más', async () => {
    let clock = NOW;
    const exchangeCode = vi.fn(async () => { throw new PairError('exchange_rejected', 401); });
    const service = createService({ link: fakeLink(recoveryCode, []), exchangeCode, now: () => clock });
    for (let round = 0; round < 2; round += 1) {
      const started = await service.start(startInput());
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(service.receiveCredential(started.id, await currentAuth(service, started), 'basura'))
          .rejects.toMatchObject({ code: attempt === 4 ? 'too_many_codes' : 'code_rejected' });
      }
    }
    expect(exchangeCode).toHaveBeenCalledTimes(10);
    const third = await service.start(startInput());
    await expect(service.receiveCredential(third.id, auth(third, third.formToken), 'basura'))
      .rejects.toMatchObject({ code: 'too_many_codes' });
    expect(exchangeCode).toHaveBeenCalledTimes(10);
    // La ventana es de una hora: pasada, la persona vuelve a poder intentarlo.
    clock += 60 * 60_000 + 1;
    const later = await service.start(startInput(new Date(clock + 60_000).toISOString()));
    await expect(service.receiveCredential(later.id, auth(later, later.formToken), 'basura'))
      .rejects.toMatchObject({ code: 'code_rejected' });
  });

  it('un 429 de /exchange no cuenta, conserva la transacción y trae el Retry-After', async () => {
    const revoke = vi.fn(async () => undefined);
    let limited = true;
    const exchangeCode = vi.fn(async () => {
      if (limited) throw new PairError('exchange_failed', 429, 17);
      return CONNECTION;
    });
    const service = createService({ link: fakeLink(recoveryCode, []), exchangeCode, revoke });
    const started = await service.start(startInput());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expect(service.receiveCredential(started.id, await currentAuth(service, started), 'bueno'))
        .rejects.toMatchObject({ code: 'rate_limited', retryAfterSeconds: 17 });
    }
    expect(await journals.read(started.id)).toMatchObject({ phase: 'credential', cleanupRequired: false });
    limited = false;
    await service.receiveCredential(started.id, await currentAuth(service, started), 'bueno');
    expect((await journals.read(started.id))?.phase).toBe('approval');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('la sesión de Lumbre de otra cuenta se detecta antes de pedir la aprobación y se puede reintentar', async () => {
    const revoke = vi.fn(async () => undefined);
    const startLink = vi.fn(async () => fakeLink(recoveryCode, []));
    let account = hebraAccountIdOf('sumego|otra');
    const service = createService({ link: fakeLink(recoveryCode, []), revoke, startLink,
      agentAccountId: () => account });
    const started = await service.start({ ...startInput(), email: 'david@example.test' });
    await expect(service.receiveCredential(started.id, auth(started, started.formToken), 'code'))
      .rejects.toMatchObject({ code: 'wrong_lumbre_account' });
    expect(startLink).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledOnce();
    const journal = (await journals.read(started.id))!;
    expect(journal).toMatchObject({ phase: 'credential', cleanupRequired: false });
    expect(journal.connection).toBeUndefined();
    const notice = await service.noticeForCookie(started.cookie);
    expect(notice).toMatchObject({ email: 'david@example.test', renewal: false });
    // Verifier nuevo: el enlace del reintento no reutiliza el challenge ya gastado.
    expect(notice!.authorizationUrl).not.toBe(started.authorizationUrl);
    expect(JSON.stringify(journal)).not.toContain('david@example.test');
    account = hebraAccountIdOf('sumego|david');
    await service.receiveCredential(started.id, await currentAuth(service, started), 'code-2');
    expect(startLink).toHaveBeenCalledOnce();
    expect((await journals.read(started.id))?.phase).toBe('approval');
  });

  it('un código válido de otra cuenta cuenta como rechazo: a los 5 cierra la transacción y suma por persona', async () => {
    const revoke = vi.fn(async () => undefined);
    const exchangeCode = vi.fn(async () => CONNECTION);
    const service = createService({ link: fakeLink(recoveryCode, []), revoke, exchangeCode,
      agentAccountId: () => hebraAccountIdOf('sumego|otra') });
    const started = await service.start(startInput());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.receiveCredential(started.id, await currentAuth(service, started), 'code'))
        .rejects.toMatchObject({ code: attempt === 4 ? 'too_many_codes' : 'wrong_lumbre_account' });
    }
    expect(exchangeCode).toHaveBeenCalledTimes(5);
    expect(await journals.read(started.id)).toBeNull();
    // Y suman al contador de la persona: otra transacción de 5 llega a 10 y la siguiente se bloquea.
    const second = await service.start(startInput());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.receiveCredential(second.id, await currentAuth(service, second), 'code'))
        .rejects.toMatchObject({ code: attempt === 4 ? 'too_many_codes' : 'wrong_lumbre_account' });
    }
    const third = await service.start(startInput());
    await expect(service.receiveCredential(third.id, auth(third, third.formToken), 'code'))
      .rejects.toMatchObject({ code: 'too_many_codes' });
    expect(exchangeCode).toHaveBeenCalledTimes(10);
  });

  it('si no se puede revocar la credencial de la otra cuenta, queda pendiente sin atascar el login', async () => {
    const revoke = vi.fn().mockRejectedValue(new RevokeError(503));
    const service = createService({ link: fakeLink(recoveryCode, []), revoke,
      agentAccountId: () => hebraAccountIdOf('sumego|otra') });
    const started = await service.start(startInput());
    await expect(service.receiveCredential(started.id, auth(started, started.formToken), 'code'))
      .rejects.toMatchObject({ code: 'wrong_lumbre_account' });
    expect((await journals.read(started.id))?.phase).toBe('cleanup-pending');
    expect(await service.sessionForCookie(started.cookie)).toBeNull();
    const next = await service.start(startInput());
    expect(await service.sessionForCookie(next.cookie)).not.toBeNull();
  });
});
