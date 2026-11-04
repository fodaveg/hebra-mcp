import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Binding } from '../../src/oauth/backchannel';
import { RemotePairingJournalStore } from '../../src/pair/remote/journal';
import type { RemotePairingService } from '../../src/pair/remote/service';
import type { RemotePairingRenewals } from '../../src/pair/remote/types';
import {
  SYNC_VAULT,
  auth,
  buildService,
  currentAuth,
  fakeLink,
  openHarness,
  ownership,
  startInput,
  type CreateServiceInput
} from '../fixtures/remote-service-harness';

describe('RemotePairingService: renovación', () => {
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
});
