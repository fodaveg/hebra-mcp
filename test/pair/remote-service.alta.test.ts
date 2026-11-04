import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Binding } from '../../src/oauth/backchannel';
import { RemotePairingJournalStore } from '../../src/pair/remote/journal';
import { REMOTE_PAIRING_ORIGIN, type RemotePairingService } from '../../src/pair/remote/service';
import {
  CONNECTION,
  NOW,
  auth,
  buildService,
  currentAuth,
  fakeLink,
  openHarness,
  ownership,
  startInput,
  type CreateServiceInput
} from '../fixtures/remote-service-harness';

describe('RemotePairingService: alta', () => {
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
});
