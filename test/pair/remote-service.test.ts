import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeRecoveryCode, type DeviceLinkPoll, type LumbreConnection } from '../../src/hebra';
import type { ActiveGrant, Binding } from '../../src/oauth/backchannel';
import { PairError } from '../../src/pair/errors';
import { hebraAccountIdOf } from '../../src/pair/remote/account-id';
import { RemotePairingJournalStore } from '../../src/pair/remote/journal';
import type { RemoteLinkRequest } from '../../src/pair/remote/link';
import { RevokeError } from '../../src/pair/remote/revoke';
import {
  REMOTE_PAIRING_ORIGIN,
  REMOTE_PAIRING_TTL_MS,
  RemotePairingService,
  type RemotePairingServiceOptions
} from '../../src/pair/remote/service';
import type { RemotePairingRenewals, VerifiedOwnership } from '../../src/pair/remote/types';

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

  it('el conector que inició el alta llega al aviso previo y a la vista previa, con su host', async () => {
    const service = createService({ link: fakeLink(recoveryCode, []) });
    const started = await service.start({ ...startInput(),
      client: { name: 'Claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback?x=1' } });
    expect(await service.noticeForCookie(started.cookie))
      .toMatchObject({ client: { name: 'Claude', callbackHost: 'claude.ai' } });
    await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
    expect(await service.poll(started.id, await currentAuth(service, started)))
      .toMatchObject({ kind: 'preview', preview: { client: { name: 'Claude', callbackHost: 'claude.ai' } } });
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

  describe('renovación', () => {
    const RENEWAL_ACCOUNT = '44'.repeat(32);
    const STORED_DEVICE = 'dd'.repeat(16);
    const STORED_LUMBRE_DEVICE = '55555555-5555-4555-8555-555555555555';

    function renewals(overrides: Partial<RemotePairingRenewals> = {}): RemotePairingRenewals {
      return {
        target: async () => ({ id: 'cuenta-david', generation: 3, accountId: RENEWAL_ACCOUNT, syncVaultId: SYNC_VAULT,
          opaqueDeviceId: STORED_DEVICE, lumbreDeviceId: STORED_LUMBRE_DEVICE }),
        agentKey: async () => ({ kty: 'EC', crv: 'P-256', d: 'guardada', x: 'x', y: 'y' }),
        keepRotatedTokens: vi.fn(async () => true),
        publish: vi.fn(async () => ({ id: 'cuenta-david', generation: 5 })),
        retire: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        ...overrides
      };
    }

    it('con la misma bóveda conserva dispositivo e identidad y publica sobre la cuenta', async () => {
      const set = renewals();
      const prepareAgent = vi.fn();
      const seen: Binding[] = [];
      const service = createService({ link: fakeLink(recoveryCode, []), renewals: set, agentAccountId: () => RENEWAL_ACCOUNT,
        prepareAgentSpy: prepareAgent, ownership: async ({ sub, binding }) => { seen.push(binding); return ownership(sub, binding); } });
      const started = await service.start({ ...startInput(), renew: true });
      expect(new URL(started.authorizationUrl).searchParams.get('deviceId')).toBe(STORED_LUMBRE_DEVICE);
      await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
      // Una credencial que sobrevive conserva su pública: se reutiliza la clave guardada.
      expect(prepareAgent.mock.calls[0]![3]).toMatchObject({ d: 'guardada' });
      const status = await service.poll(started.id, await currentAuth(service, started));
      expect(status).toMatchObject({ kind: 'preview' });
      if (status.kind === 'preview') expect(status.preview.replacesLibrary).toBeUndefined();
      expect(seen[0]!.opaqueDeviceId).toBe(STORED_DEVICE);
      await expect(service.confirm(started.id, await currentAuth(service, started)))
        .resolves.toMatchObject({ kind: 'confirmed', account: { id: 'cuenta-david', generation: 5 } });
      expect(set.publish).toHaveBeenCalledOnce();
      expect(vi.mocked(set.publish).mock.calls[0]![0].paired.device).toEqual({ opaqueDeviceId: STORED_DEVICE,
        lumbreDeviceId: STORED_LUMBRE_DEVICE });
      expect(set.retire).not.toHaveBeenCalled();
    });

    it('con otra bóveda la página lo dice y confirmar retira antes de dar de alta', async () => {
      const order: string[] = [];
      const set = renewals({
        target: async () => ({ id: 'cuenta-david', generation: 3, accountId: RENEWAL_ACCOUNT, syncVaultId: 'ee'.repeat(16),
          opaqueDeviceId: STORED_DEVICE, lumbreDeviceId: STORED_LUMBRE_DEVICE }),
        pendingWrites: async () => 0,
        retire: vi.fn(async () => { order.push('retire'); }),
        publish: vi.fn(async () => { throw new Error('no debe publicar sobre la cuenta anterior'); })
      });
      const publish = vi.fn(async () => { order.push('publish'); return { id: 'cuenta-nueva', generation: 1 }; });
      const seen: Binding[] = [];
      const service = createService({ link: fakeLink(recoveryCode, []), renewals: set, publish, agentAccountId: () => RENEWAL_ACCOUNT,
        ownership: async ({ sub, binding }) => { seen.push(binding); return ownership(sub, binding); } });
      const started = await service.start({ ...startInput(), renew: true });
      await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
      const status = await service.poll(started.id, await currentAuth(service, started));
      expect(status).toMatchObject({ kind: 'preview', preview: { replacesLibrary: true } });
      // Nada se toca hasta confirmar, y el dispositivo es nuevo: no se mezcla con la otra bóveda.
      expect(set.retire).not.toHaveBeenCalled();
      expect(seen[0]!.opaqueDeviceId).not.toBe(STORED_DEVICE);
      await expect(service.confirm(started.id, await currentAuth(service, started)))
        .resolves.toMatchObject({ kind: 'confirmed', account: { id: 'cuenta-nueva' } });
      expect(order).toEqual(['retire', 'publish']);
    });

    describe.each([[3], [null]])('otra bóveda con escrituras sin subir (%s)', (pending) => {
      const other = () => renewals({
        target: async () => ({ id: 'cuenta-david', generation: 3, accountId: RENEWAL_ACCOUNT, syncVaultId: 'ee'.repeat(16) }),
        pendingWrites: vi.fn(async () => pending),
        retire: vi.fn(async () => undefined)
      });

      it('la vista previa lo dice y confirmar sin la casilla aparte no retira nada', async () => {
        const set = other();
        const publish = vi.fn(async () => ({ id: 'cuenta-nueva', generation: 1 }));
        const service = createService({ link: fakeLink(recoveryCode, []), renewals: set, publish, agentAccountId: () => RENEWAL_ACCOUNT });
        const started = await service.start({ ...startInput(), renew: true });
        await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
        expect(await service.poll(started.id, await currentAuth(service, started)))
          .toMatchObject({ kind: 'preview', preview: { replacesLibrary: true, pendingWrites: pending } });
        await expect(service.confirm(started.id, await currentAuth(service, started)))
          .rejects.toMatchObject({ code: 'loss_unconfirmed' });
        expect(set.retire).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        // La transacción sigue viva: con la confirmación aparte, termina.
        await expect(service.confirm(started.id, await currentAuth(service, started), { acknowledgeLoss: true }))
          .resolves.toMatchObject({ kind: 'confirmed', account: { id: 'cuenta-nueva' } });
        expect(set.retire).toHaveBeenCalledOnce();
      });
    });

    it('si entre la vista previa y confirmar hay más escrituras, la casilla marcada antes no vale', async () => {
      let pending = 2;
      const set = renewals({
        target: async () => ({ id: 'cuenta-david', generation: 3, accountId: RENEWAL_ACCOUNT, syncVaultId: 'ee'.repeat(16) }),
        pendingWrites: vi.fn(async () => pending)
      });
      const publish = vi.fn(async () => ({ id: 'cuenta-nueva', generation: 1 }));
      const service = createService({ link: fakeLink(recoveryCode, []), renewals: set, publish, agentAccountId: () => RENEWAL_ACCOUNT });
      const started = await service.start({ ...startInput(), renew: true });
      await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
      await service.poll(started.id, await currentAuth(service, started));
      pending = 5;
      await expect(service.confirm(started.id, await currentAuth(service, started), { acknowledgeLoss: true }))
        .rejects.toMatchObject({ code: 'loss_unconfirmed' });
      expect(await service.previewOf(started.id)).toMatchObject({ pendingWrites: 5 });
      expect(set.retire).not.toHaveBeenCalled();
    });

    it('si la vista previa dio 0 y al confirmar hay escrituras, pide la casilla y no retira nada', async () => {
      let pending: number | null = 0;
      const set = renewals({
        target: async () => ({ id: 'cuenta-david', generation: 3, accountId: RENEWAL_ACCOUNT, syncVaultId: 'ee'.repeat(16) }),
        pendingWrites: vi.fn(async () => pending),
        retire: vi.fn(async () => undefined)
      });
      const publish = vi.fn(async () => ({ id: 'cuenta-nueva', generation: 1 }));
      const service = createService({ link: fakeLink(recoveryCode, []), renewals: set, publish, agentAccountId: () => RENEWAL_ACCOUNT });
      const started = await service.start({ ...startInput(), renew: true });
      await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
      expect(await service.poll(started.id, await currentAuth(service, started)))
        .toMatchObject({ kind: 'preview', preview: { pendingWrites: 0 } });
      pending = 4;
      await expect(service.confirm(started.id, await currentAuth(service, started)))
        .rejects.toMatchObject({ code: 'loss_unconfirmed' });
      expect(set.retire).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      // La página vuelve a enseñar el recuento nuevo, y con la casilla termina.
      expect(await service.previewOf(started.id)).toMatchObject({ pendingWrites: 4 });
      await expect(service.confirm(started.id, await currentAuth(service, started), { acknowledgeLoss: true }))
        .resolves.toMatchObject({ kind: 'confirmed' });
    });

    it('si retirar la cuenta anterior falla, revoca la nueva y no da de alta nada', async () => {
      const revoke = vi.fn(async () => undefined);
      const publish = vi.fn(async () => ({ id: 'cuenta-nueva', generation: 1 }));
      const set = renewals({
        target: async () => ({ id: 'cuenta-david', generation: 3, accountId: RENEWAL_ACCOUNT, syncVaultId: 'ee'.repeat(16) }),
        pendingWrites: async () => 0,
        retire: vi.fn(async () => { throw new Error('account_writer_busy'); })
      });
      const service = createService({ link: fakeLink(recoveryCode, []), renewals: set, publish, revoke,
        agentAccountId: () => RENEWAL_ACCOUNT });
      const started = await service.start({ ...startInput(), renew: true });
      await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
      await service.poll(started.id, await currentAuth(service, started));
      await expect(service.confirm(started.id, await currentAuth(service, started)))
        .rejects.toMatchObject({ code: 'unavailable' });
      expect(publish).not.toHaveBeenCalled();
      expect(revoke).toHaveBeenCalledOnce();
      expect(await journals.read(started.id)).toBeNull();
    });

    it('otra cuenta de Lumbre no llega a pedir la aprobación ni a publicar sobre esta', async () => {
      const startLink = vi.fn(async () => fakeLink(recoveryCode, []));
      const set = renewals();
      const service = createService({ link: fakeLink(recoveryCode, []), renewals: set, startLink,
        agentAccountId: () => 'ab'.repeat(32) });
      const started = await service.start({ ...startInput(), renew: true });
      await expect(service.receiveCredential(started.id, auth(started, started.formToken), 'code'))
        .rejects.toMatchObject({ code: 'wrong_lumbre_account' });
      expect(startLink).not.toHaveBeenCalled();
      expect(set.publish).not.toHaveBeenCalled();
    });

    it.each([
      ['otro sub', { sub: 'sumego|mikel' }],
      ['otra cuenta de Lumbre', { accountId: 'cc'.repeat(32) }]
    ] as const)('una concesión de %s no renueva esta cuenta', async (_name, change) => {
      const revoke = vi.fn(async () => undefined);
      const set = renewals();
      const service = createService({ link: fakeLink(recoveryCode, []), renewals: set, revoke, agentAccountId: () => RENEWAL_ACCOUNT,
        ownership: async ({ sub, binding }) => {
          const proof = ownership('sub' in change ? change.sub : sub, binding);
          return 'accountId' in change ? { ...proof, grant: { ...proof.grant, accountId: change.accountId } } : proof;
        } });
      const started = await service.start({ ...startInput(), renew: true });
      await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
      await expect(service.poll(started.id, await currentAuth(service, started)))
        .rejects.toMatchObject({ code: 'wrong_account' });
      expect(set.publish).not.toHaveBeenCalled();
      expect(revoke).toHaveBeenCalledOnce();
    });

    it('la doble confirmación de una renovación publica una sola vez', async () => {
      const set = renewals();
      const service = createService({ link: fakeLink(recoveryCode, []), renewals: set, agentAccountId: () => RENEWAL_ACCOUNT });
      const started = await service.start({ ...startInput(), renew: true });
      await service.receiveCredential(started.id, auth(started, started.formToken), 'code');
      await service.poll(started.id, await currentAuth(service, started));
      const form = await currentAuth(service, started);
      const results = await Promise.allSettled([service.confirm(started.id, form), service.confirm(started.id, form)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(set.publish).toHaveBeenCalledOnce();
    });

    it('sin cuenta que renovar, empieza un alta normal', async () => {
      const set = renewals({ target: async () => null });
      const service = createService({ link: fakeLink(recoveryCode, []), renewals: set });
      const started = await service.start({ ...startInput(), renew: true });
      expect((await journals.read(started.id))?.renewal).toBeUndefined();
    });
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
    renewals?: RemotePairingRenewals;
    agentAccountId?: () => string;
    startLink?: RemotePairingServiceOptions['startLink'];
    prepareAgentSpy?: (...args: unknown[]) => void;
  }): RemotePairingService {
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
