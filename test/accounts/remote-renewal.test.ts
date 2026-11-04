/**
 * Renovación de una cuenta con el registro, los secretos y los diarios reales (D22, §12.10). Una
 * caída se simula dejando la publicación colgada en esa frontera y reabriendo todo desde el disco,
 * como tras un SIGKILL: el código de después no llega a ejecutarse.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountContexts } from '../../src/accounts/contexts';
import { PendingSweep, PendingUploadList } from '../../src/accounts/pending-sweep';
import { accountDataDir, AccountRegistry } from '../../src/accounts/registry';
import { openRemotePairing, remotePairingAdapters, type RemotePairingAccountServices } from '../../src/accounts/remote-pairing';
import { AccountRemovalService } from '../../src/accounts/removal';
import type { AccountRecord, AccountRef } from '../../src/accounts/types';
import { encodeRecoveryCode, type DeviceLinkPoll, type LumbreConnection } from '../../src/hebra';
import type { ActiveGrant } from '../../src/oauth/backchannel';
import type { HebraOAuthProvider, RemotePairingOAuthHooks } from '../../src/oauth/provider';
import { RemotePairingJournalStore } from '../../src/pair/remote/journal';
import type { RemoteLinkRequest } from '../../src/pair/remote/link';
import { RemotePairingService } from '../../src/pair/remote/service';
import { MemorySecretStore, openFileSecretStore, readPairedSecrets, writePairedSecrets, type PairedSecrets } from '../../src/secrets';
import { PairingRevocation } from '../../src/status/pairing-revocation';
import type { ServerContext } from '../../src/server/context';
import { LibraryInstance } from '../../src/sync/library-instance';
import { NO_PRIVATE } from '../fixtures/no-private';

const SUB = 'sumego|david';
const ACCOUNT = '44'.repeat(32);
const VAULT = '22'.repeat(16);
const OTHER_VAULT = 'ee'.repeat(16);
const DEVICE = 'dd'.repeat(16);
const LUMBRE_DEVICE = '55555555-5555-4555-8555-555555555555';
const OLD_CREDENTIAL = '11111111-1111-4111-8111-111111111111';
const NEW_CREDENTIAL = '66666666-6666-4666-8666-666666666666';
const API = 'https://app.lumbre.pro';

function connection(credentialId: string, token: string): LumbreConnection {
  return { credentialId, readToken: `read-${token}`, writeToken: `write-${token}`, apiOrigin: API,
    connectedAt: '2026-11-04T08:00:00.000Z' };
}

function grant(credentialId: string, syncVaultId: string, opaqueDeviceId: string): ActiveGrant {
  return { active: true, credentialId: '33333333-3333-4333-8333-333333333333', clientId: 'hebra-mcp', resource: 'https://mcp.hebra.pro/mcp',
    scope: 'hebra:mcp', accountId: ACCOUNT, expiresAt: '2026-12-01T00:00:00.000Z', pairedCredentialId: credentialId,
    syncVaultId, opaqueDeviceId };
}

function recoveryCodeOf(syncVaultId: string, fill: number): Promise<string> {
  return encodeRecoveryCode({ relayOrigin: API, syncVaultId, keyEpoch: 1, vaultKey: new Uint8Array(32).fill(fill) });
}

function link(recoveryCode: string, syncVaultId: string): RemoteLinkRequest {
  const granted: Extract<DeviceLinkPoll, { kind: 'granted' }> = { kind: 'granted', recoveryCode, approverLabel: 'Mac',
    approverSyncVaultId: syncVaultId, approverVaultCreatedAt: '2026-01-01T00:00:00.000Z', vaultCount: 1 };
  return { createdAt: '2026-11-04T08:00:00.000Z', initialRemainingMs: 600_000, poll: async () => granted,
    verify: async () => ({ syncVaultId, vaultCreatedAt: '2026-01-01T00:00:00.000Z', vaultCount: 1, recordsRead: 1,
      unreadable: 0, more: false, titles: ['Una nota'] }),
    complete: async () => undefined, cancel: async () => undefined };
}

describe('renovación con estado real', () => {
  let root: string;
  let registry: AccountRegistry;
  let account: AccountRecord;
  let paired: PairedSecrets;
  let revoke: ReturnType<typeof vi.fn>;
  let invalidate: ReturnType<typeof vi.fn>;
  let drain: ReturnType<typeof vi.fn>;
  let exchanged: ReturnType<typeof vi.fn>;
  const sharedRecovery: Record<string, string> = {};

  beforeEach(async () => {
    sharedRecovery[VAULT] = await recoveryCodeOf(VAULT, 7);
    sharedRecovery[OTHER_VAULT] = await recoveryCodeOf(OTHER_VAULT, 9);
    root = await mkdtemp(join(tmpdir(), 'hebra-renewal-'));
    registry = await AccountRegistry.open(root);
    account = await registry.commitAccount({ sub: SUB, grant: grant(OLD_CREDENTIAL, VAULT, DEVICE) });
    const directory = accountDataDir(root, account);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'library.sqlite'), 'notas de david');
    paired = { connection: connection(OLD_CREDENTIAL, 'vieja'), recoveryCode: await recoveryCodeOf(VAULT, 7),
      device: { opaqueDeviceId: DEVICE, lumbreDeviceId: LUMBRE_DEVICE } };
    await writePairedSecrets(openFileSecretStore(directory), paired);
    revoke = vi.fn(async () => undefined);
    invalidate = vi.fn(async () => 1);
    drain = vi.fn(async () => undefined);
    exchanged = vi.fn();
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function build(options: { registry?: AccountRegistry; syncVaultId?: string; services?: RemotePairingAccountServices;
    credential?: string; revokeDevice?: boolean; fetcher?: typeof globalThis.fetch;
    prepareFails?: Error } = {}) {
    const current = options.registry ?? registry;
    const syncVaultId = options.syncVaultId ?? VAULT;
    const services: RemotePairingAccountServices = options.services ?? {
      contexts: { drainAndClose: drain as never }, removal: { remove: vi.fn() }, legacySecrets: new MemorySecretStore() };
    const adapters = remotePairingAdapters({ dataDir: root, registry: current, services: () => services,
      provider: { invalidateFamiliesForRenewal: invalidate as never, pairing: new PairingRevocation() } });
    const journals = new RemotePairingJournalStore(join(root, 'journals'));
    const credential = options.credential ?? NEW_CREDENTIAL;
    return { journals, adapters, service: new RemotePairingService({ journals, publisher: adapters.publisher,
      renewals: adapters.renewals, revoke: revoke as never, fetcher: options.fetcher,
      exchangeCode: async () => { (exchanged as () => void)(); return connection(credential, 'nueva'); },
      prepareAgent: async (_connection, deviceId) => {
        if (options.prepareFails) throw options.prepareFails;
        return {
        privateKey: { kty: 'EC', crv: 'P-256', d: 'private', x: 'x', y: 'y' },
        registration: { credentialId: credential, deviceId, accountId: ACCOUNT, actorKind: 'agent', keyId: 'key',
          publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } }
        };
      },
      startLink: async () => link(sharedRecovery[syncVaultId]!, syncVaultId),
      registerDevice: async () => 'ok',
      ownership: { verify: async ({ sub, binding }) => ({ sub, grant: grant(binding.pairedCredentialId, binding.syncVaultId, binding.opaqueDeviceId) }) } }) };
  }

  async function toConfirmation(service: RemotePairingService) {
    const started = await service.start({ oauthRequestId: 'oauth-1', sub: SUB,
      identityExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), renew: true });
    await service.receiveCredential(started.id, { cookie: started.cookie, formToken: started.formToken }, 'code');
    await service.poll(started.id, { cookie: started.cookie, formToken: await service.formToken(started.id) });
    return { started, form: { cookie: started.cookie, formToken: await service.formToken(started.id) } };
  }

  describe('registro de la clave de agente que Lumbre no acepta tras el canje', () => {
    const start = (service: RemotePairingService) => service.start({ oauthRequestId: 'oauth-1', sub: SUB,
      identityExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), renew: true });

    it('401 (agente desactivado o revocado, indistinguibles) con la misma credencial: guarda los tokens nuevos, no revoca ni borra', async () => {
      const { AgentKeyUnauthorizedError } = await import('../../src/spaces/device');
      const { service, journals } = build({ credential: OLD_CREDENTIAL, prepareFails: new AgentKeyUnauthorizedError() });
      const started = await start(service);
      await expect(service.receiveCredential(started.id, { cookie: started.cookie, formToken: started.formToken }, 'code'))
        .rejects.toMatchObject({ code: 'agent_rejected', reason: 'tokens_kept' });
      // El canje rotó los tokens: los guardados ya no valen y los nuevos de la MISMA credencial
      // son los que permiten volver al reactivar el agente, sin otro login.
      const record = registry.findById(account.id)!;
      expect(record).toMatchObject({ state: 'active', binding: account.binding, generation: account.generation });
      expect(record.renewing).toBeUndefined();
      const stored = await readPairedSecrets(openFileSecretStore(accountDataDir(root, record)));
      expect(stored?.connection).toMatchObject({ credentialId: OLD_CREDENTIAL, readToken: 'read-nueva', writeToken: 'write-nueva' });
      expect(stored?.recoveryCode).toBe(paired.recoveryCode);
      expect(stored?.device).toEqual(paired.device);
      expect(revoke).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(drain).toHaveBeenCalledOnce();
      await expect(readFile(join(accountDataDir(root, record), 'library.sqlite'), 'utf8')).resolves.toBe('notas de david');
      expect(await journals.read(started.id)).toBeNull();
    });

    it('401 y el canje devuelve una credencial con otro id: nada que conservar, se revoca lo canjeado', async () => {
      const { AgentKeyUnauthorizedError } = await import('../../src/spaces/device');
      const { service, journals } = build({ credential: NEW_CREDENTIAL, prepareFails: new AgentKeyUnauthorizedError() });
      const started = await start(service);
      await expect(service.receiveCredential(started.id, { cookie: started.cookie, formToken: started.formToken }, 'code'))
        .rejects.toMatchObject({ code: 'agent_rejected', reason: 'credential_revoked' });
      expect(revoke).toHaveBeenCalledOnce();
      const stored = await readPairedSecrets(openFileSecretStore(accountDataDir(root, registry.findById(account.id)!)));
      expect(stored?.connection).toEqual(paired.connection);
      expect(registry.findById(account.id)?.renewing).toBeUndefined();
      expect(await journals.read(started.id)).toBeNull();
    });

    it('404 (espacios apagados, credencial no encontrada o carrera): no es "desactivado", la biblioteca se renueva sin clave de agente', async () => {
      const { AgentKeyNotFoundError } = await import('../../src/spaces/device');
      const { service } = build({ prepareFails: new AgentKeyNotFoundError() });
      const { started, form } = await toConfirmation(service);
      await expect(service.confirm(started.id, form)).resolves.toMatchObject({ kind: 'confirmed', account: { id: account.id } });
      expect(revoke).not.toHaveBeenCalled();
      const record = registry.findById(account.id)!;
      expect(record.binding.pairedCredentialId).toBe(NEW_CREDENTIAL);
      const store = openFileSecretStore(accountDataDir(root, record));
      // Sin clave guardada: los espacios la registran al usarse y dan su error normal si no pueden.
      expect(await store.get('agent-device-key')).toBeNull();
      expect((await readPairedSecrets(store))?.connection.readToken).toBe('read-nueva');
    });

    it('404 con una credencial que no existe: el enlace de aprobación falla y no se da por renovada', async () => {
      const { AgentKeyNotFoundError } = await import('../../src/spaces/device');
      const built = build({ prepareFails: new AgentKeyNotFoundError() });
      const service = new RemotePairingService({ journals: built.journals, publisher: built.adapters.publisher,
        renewals: built.adapters.renewals, revoke: revoke as never,
        exchangeCode: async () => connection(NEW_CREDENTIAL, 'nueva'),
        prepareAgent: async () => { throw new AgentKeyNotFoundError(); },
        startLink: async () => { throw new Error('credential_not_found'); },
        ownership: { verify: async () => { throw new Error('no'); } } });
      const started = await start(service);
      await expect(service.receiveCredential(started.id, { cookie: started.cookie, formToken: started.formToken }, 'code'))
        .rejects.toMatchObject({ code: 'unavailable' });
      expect(revoke).toHaveBeenCalledOnce();
      expect(registry.findById(account.id)).toMatchObject({ generation: account.generation, binding: account.binding });
    });
  });

  describe('marca de revocado tras reactivar el agente', () => {
    it('desactivado (401), marca, reactivado: una ronda correcta del runner nuevo la levanta', () => {
      const pairing = new PairingRevocation();
      // Runner viejo: el relé dio 401 (agente desactivado) y el contexto se cerró.
      const detachOld = pairing.attachRelay(OLD_CREDENTIAL, () => true, () => false);
      expect(pairing.isRevoked(OLD_CREDENTIAL)).toBe(true);
      detachOld();
      expect(pairing.isRevoked(OLD_CREDENTIAL)).toBe(true);
      // Reabrir no borra la marca: el runner nuevo todavía no ha hablado con el relé.
      let ok = false;
      const detachNew = pairing.attachRelay(OLD_CREDENTIAL, () => false, () => ok);
      expect(pairing.isRevoked(OLD_CREDENTIAL)).toBe(true);
      // Reactivado en Hebra: la siguiente ronda sale bien.
      ok = true;
      expect(pairing.isRevoked(OLD_CREDENTIAL)).toBe(false);
      detachNew();
      expect(pairing.isRevoked(OLD_CREDENTIAL)).toBe(false);
    });

    it('la marca de Lumbre (410) también se levanta con una ronda correcta, y otra cuenta no se toca', () => {
      const pairing = new PairingRevocation();
      pairing.markRevoked(OLD_CREDENTIAL);
      pairing.markRevoked(NEW_CREDENTIAL);
      pairing.attachRelay(OLD_CREDENTIAL, () => false, () => true);
      expect(pairing.isRevoked(OLD_CREDENTIAL)).toBe(false);
      expect(pairing.isRevoked(NEW_CREDENTIAL)).toBe(true);
    });

    it('un runner que no ha tenido una ronda correcta no levanta la marca', () => {
      const pairing = new PairingRevocation();
      pairing.markRevoked(OLD_CREDENTIAL);
      pairing.attachRelay(OLD_CREDENTIAL, () => false, () => false);
      expect(pairing.isRevoked(OLD_CREDENTIAL)).toBe(true);
    });
  });

  it('misma bóveda: conserva raíz, notas e identidad; vínculo y generación nuevos; ni contextos ni familias viejos', async () => {
    const order: string[] = [];
    const commit = registry.commitRenewal.bind(registry);
    registry.commitRenewal = async (...args) => { order.push('commit'); return commit(...args); };
    invalidate.mockImplementation(async () => { order.push('familias'); return 1; });
    drain.mockImplementation(async () => { order.push('drenaje'); });
    const { service, journals } = build();
    const { started, form } = await toConfirmation(service);
    const result = await service.confirm(started.id, form);
    expect(result).toMatchObject({ kind: 'confirmed', account: { id: account.id } });
    expect(order).toEqual(['familias', 'drenaje', 'commit']);

    const record = registry.findById(account.id)!;
    expect(record).toMatchObject({ state: 'active', sub: SUB, storage: 'account-dir' });
    expect(record.generation).toBeGreaterThan(account.generation);
    expect(record.renewing).toBeUndefined();
    expect(record.binding).toEqual({ pairedCredentialId: NEW_CREDENTIAL, syncVaultId: VAULT, opaqueDeviceId: DEVICE });
    expect(registry.authorize(grant(OLD_CREDENTIAL, VAULT, DEVICE), SUB)).toBeNull();
    expect(registry.authorize(grant(NEW_CREDENTIAL, VAULT, DEVICE), SUB)).toMatchObject({ id: account.id });
    expect(() => registry.assertActive(account)).toThrow('account_inactive');

    const directory = accountDataDir(root, record);
    expect(await readFile(join(directory, 'library.sqlite'), 'utf8')).toBe('notas de david');
    const stored = await readPairedSecrets(openFileSecretStore(directory));
    expect(stored?.connection.credentialId).toBe(NEW_CREDENTIAL);
    expect(stored?.device).toEqual(paired.device);
    expect(stored?.recoveryCode).toBe(paired.recoveryCode);
    expect(await journals.read(started.id)).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    await expect(stat(join(root, 'accounts', started.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('tras renovar, el barrido vuelve a intentar lo bloqueado y lo que esperaba, sin esperar su turno', async () => {
    const list = await PendingUploadList.open(join(root, 'control'));
    await list.put(account, null, true);
    await list.put(account, 'espacio', false);
    // Mientras la credencial vieja siga, ni la personal ni la del espacio suben.
    let renewed = false;
    const statusOf = () => renewed
      ? { pendingUpload: 0, errorsByCode: {}, revoked: false, lastSyncOutcome: 'ok' }
      : { pendingUpload: 2, errorsByCode: {}, revoked: !!(attempts.current % 2), lastSyncOutcome: null };
    const attempts = { current: 0 };
    const target = (): ServerContext => ({
      firstRound: async () => undefined,
      status: { getStatus: async () => statusOf() } } as unknown as ServerContext);
    const seen: Array<{ id: string; generation: number }> = [];
    let now = 0;
    const sweep = new PendingSweep({ list,
      withAccountContext: async (ref, fn) => {
        seen.push(ref);
        attempts.current += 1;
        const ctx = target();
        return fn({ ...ctx, spaces: { resolve: async () => target(), list: async () => [] } } as unknown as ServerContext);
      },
      accountActive: (ref) => { const r = registry.findById(ref.id); return r?.state === 'active' && r.generation === ref.generation; },
      currentRef: (id) => { const r = registry.findById(id); return r?.state === 'active' ? { id: r.id, generation: r.generation } : null; },
      resumeRemovals: async () => undefined,
      expireJournals: async () => ({ expired: 0, failed: 0 }),
      now: () => now });
    await sweep.runOnce();
    expect(seen).toHaveLength(2);
    // Sin renovar, los dos siguen: el espacio espera su turno y la personal ya se probó este arranque.
    expect(await sweep.runOnce()).toMatchObject({ uploaded: 0, skipped: 2 });
    expect(seen).toHaveLength(2);

    const { service } = build();
    const { started, form } = await toConfirmation(service);
    await service.confirm(started.id, form);
    const record = registry.findById(account.id)!;
    expect(record.generation).toBeGreaterThan(account.generation);
    renewed = true;

    // Sin avanzar el reloj ni reiniciar: la siguiente pasada prueba las dos con la generación nueva.
    expect(await sweep.runOnce()).toMatchObject({ uploaded: 2, kept: 0, dropped: 0 });
    expect(seen.slice(2).map((ref) => ref.generation)).toEqual([record.generation, record.generation]);
    expect(list.entries()).toEqual([]);
  });

  it('otra bóveda: retira la cuenta anterior por el camino normal y la nueva no mezcla datos', async () => {
    const contexts = new AccountContexts(registry, async () => { throw new Error('unexpected_open'); });
    const legacySecrets = new MemorySecretStore();
    const removed: string[] = [];
    const removal = new AccountRemovalService({ dataDir: root, registry, contexts, legacySecrets,
      oauth: { invalidateAccount: async () => { removed.push('oauth'); return 1; } },
      revokeDevice: async () => { removed.push('revoke'); } });
    const { service } = build({ syncVaultId: OTHER_VAULT, services: { contexts, removal, legacySecrets } });
    const { started, form } = await toConfirmation(service);
    expect(registry.findById(account.id)?.state).toBe('active');
    // La SQLite de la cuenta anterior es un fichero que no se puede leer: no se sabe si pierde
    // algo, y confirmar lo exige aparte.
    await expect(service.confirm(started.id, form)).rejects.toMatchObject({ code: 'loss_unconfirmed' });
    expect(registry.findById(account.id)?.state).toBe('active');
    const result = await service.confirm(started.id, { ...form, formToken: await service.formToken(started.id) },
      { acknowledgeLoss: true });
    expect(result).toMatchObject({ kind: 'confirmed', account: { id: started.id, generation: 1 } });
    expect(removed).toEqual(['oauth', 'revoke']);
    expect(registry.findById(account.id)?.state).toBe('removed');
    await expect(stat(accountDataDir(root, account))).rejects.toMatchObject({ code: 'ENOENT' });
    const current = registry.findBySub(SUB)!;
    expect(current.id).toBe(started.id);
    expect(current.binding.syncVaultId).toBe(OTHER_VAULT);
    expect(current.binding.opaqueDeviceId).not.toBe(DEVICE);
    const directory = accountDataDir(root, current);
    await expect(stat(join(directory, 'library.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readPairedSecrets(openFileSecretStore(directory)))?.recoveryCode).toBe(sharedRecovery[OTHER_VAULT]);
  });

  describe('escrituras sin subir de la cuenta anterior', () => {
    const target = () => ({ id: account.id, generation: account.generation, accountId: ACCOUNT, syncVaultId: VAULT });

    it('cuenta las de la SQLite personal y las de cada espacio, y devuelve null si no se pueden leer', async () => {
      const { adapters } = build();
      const directory = accountDataDir(root, account);
      // Un fichero que no es una base: no se sabe qué hay.
      expect(await adapters.renewals.pendingWrites!(target())).toBeNull();
      await rm(join(directory, 'library.sqlite'));
      expect(await adapters.renewals.pendingWrites!(target())).toBe(0);
      const personal = await LibraryInstance.open({ dataDir: directory, checkIntervalMs: null, lock: { releaseOnExit: false } });
      await personal.createNote({ body: '# Uno', privacy: NO_PRIVATE });
      await personal.createNote({ body: '# Dos', privacy: NO_PRIVATE });
      await personal.close();
      expect(await adapters.renewals.pendingWrites!(target())).toBe(2);
      const space = await LibraryInstance.open({ dataDir: join(directory, 'spaces', 'uno'), checkIntervalMs: null,
        lock: { releaseOnExit: false } });
      await space.createNote({ body: '# Compartida', privacy: NO_PRIVATE });
      await space.close();
      expect(await adapters.renewals.pendingWrites!(target())).toBe(3);
    });
  });

  it('retirar la cuenta anterior no se limpia a sí misma aunque el inventario pida los diarios de ese sub', async () => {
    const legacySecrets = new MemorySecretStore();
    let service!: RemotePairingService;
    const remove = vi.fn(async (ref: AccountRef) => {
      await service.cleanupForSub(SUB);
      await registry.finishRemoval(await registry.beginRemoval(ref));
    });
    ({ service } = build({ syncVaultId: OTHER_VAULT,
      services: { contexts: { drainAndClose: drain as never }, removal: { remove }, legacySecrets } }));
    const { started, form } = await toConfirmation(service);
    await expect(service.confirm(started.id, form, { acknowledgeLoss: true })).resolves.toMatchObject({ kind: 'confirmed' });
    expect(remove).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('una credencial que conserva su id: el vínculo no cambia, la generación sí y las familias se han cortado', async () => {
    const same = await AccountRegistry.open(root);
    const { service } = build({ registry: same, credential: OLD_CREDENTIAL });
    const { started, form } = await toConfirmation(service);
    await service.confirm(started.id, form);
    const record = same.findById(account.id)!;
    expect(record.binding).toEqual(account.binding);
    expect(record.generation).toBeGreaterThan(account.generation);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(() => same.assertActive(account)).toThrow('account_inactive');
    // Tras una caída, encontrarla por el vínculo no bastaría: solo cuenta quien la publicó.
    expect(record.renewedBy).toBe(started.id);
  });

  describe('caída en cada frontera', () => {
    /** `tras-secretos`: los secretos nuevos ya están en la cuenta y falta publicar el registro. */
    type Boundary = 'antes-de-bloquear' | 'tras-bloquear' | 'tras-familias' | 'tras-secretos' | 'tras-publicar';

    async function crashAt(boundary: Boundary): Promise<{ journalId: string }> {
      let reached!: () => void;
      const arrived = new Promise<void>((resolve) => { reached = resolve; });
      const hang = (): Promise<never> => { reached(); return new Promise<never>(() => undefined); };
      if (boundary === 'antes-de-bloquear') registry.beginRenewal = () => hang();
      if (boundary === 'tras-bloquear') invalidate.mockImplementation(() => hang());
      if (boundary === 'tras-familias') drain.mockImplementation(() => hang());
      if (boundary === 'tras-secretos') registry.commitRenewal = () => hang();
      const { service, journals } = build();
      if (boundary === 'tras-publicar') {
        const write = journals.write.bind(journals);
        vi.spyOn(journals, 'write').mockImplementation(async (journal) => {
          if (journal.phase === 'finished') return hang();
          return write(journal);
        });
      }
      const { started, form } = await toConfirmation(service);
      void service.confirm(started.id, form);
      await arrived;
      return { journalId: started.id };
    }

    it.each(['antes-de-bloquear', 'tras-bloquear', 'tras-familias', 'tras-secretos'] as const)(
      '%s: la recuperación revoca lo nuevo, la cuenta conserva todo y se puede renovar otra vez', async (boundary) => {
        const { journalId } = await crashAt(boundary);
        // El proceso que murió se lleva sus cuelgues: el arranque nuevo funciona con normalidad.
        invalidate.mockReset(); invalidate.mockResolvedValue(1);
        drain.mockReset(); drain.mockResolvedValue(undefined);
        const reopened = await AccountRegistry.open(root);
        const { service, journals } = build({ registry: reopened });
        revoke.mockClear();
        await expect(service.recover()).resolves.toEqual({ cleaned: 1, pending: 0 });
        expect(revoke).toHaveBeenCalledOnce();
        expect(revoke.mock.calls[0]![0]).toMatchObject({ credentialId: NEW_CREDENTIAL });
        expect(await journals.read(journalId)).toBeNull();
        const record = reopened.findById(account.id)!;
        expect(record).toMatchObject({ state: 'active', sub: SUB, binding: account.binding });
        expect(record.renewing).toBeUndefined();
        const directory = accountDataDir(root, record);
        expect(await readFile(join(directory, 'library.sqlite'), 'utf8')).toBe('notas de david');
        expect((await readPairedSecrets(openFileSecretStore(directory)))?.device).toEqual(paired.device);

        const { started, form } = await toConfirmation(service);
        await expect(service.confirm(started.id, form)).resolves.toMatchObject({ kind: 'confirmed' });
        expect(reopened.findById(account.id)?.binding.pairedCredentialId).toBe(NEW_CREDENTIAL);
        expect(await readFile(join(directory, 'library.sqlite'), 'utf8')).toBe('notas de david');
      });

    it('tras-publicar: la cuenta ya es nueva y la recuperación no la revoca', async () => {
      const { journalId } = await crashAt('tras-publicar');
      const reopened = await AccountRegistry.open(root);
      const { service, journals } = build({ registry: reopened });
      revoke.mockClear();
      await expect(service.recover()).resolves.toEqual({ cleaned: 1, pending: 0 });
      expect(revoke).not.toHaveBeenCalled();
      expect(await journals.read(journalId)).toBeNull();
      expect(reopened.findById(account.id)).toMatchObject({ state: 'active',
        binding: { pairedCredentialId: NEW_CREDENTIAL, syncVaultId: VAULT, opaqueDeviceId: DEVICE } });
    });

    it('una renovación colgada no impide el login siguiente: la suelta y empieza otra', async () => {
      const { journalId } = await crashAt('tras-bloquear');
      const reopened = await AccountRegistry.open(root);
      expect(reopened.findById(account.id)?.renewing).toBe(journalId);
      const { service, journals } = build({ registry: reopened });
      revoke.mockClear();
      invalidate.mockReset();
      invalidate.mockResolvedValue(1);
      const { started, form } = await toConfirmation(service);
      expect(await journals.read(journalId)).toBeNull();
      await expect(service.confirm(started.id, form)).resolves.toMatchObject({ kind: 'confirmed' });
      expect(reopened.findById(account.id)?.renewing).toBeUndefined();
    });
  });

  describe('openRemotePairing', () => {
    function fakeProvider() {
      const hooks: { current?: RemotePairingOAuthHooks } = {};
      const provider = { pairing: new PairingRevocation(), invalidateFamiliesForRenewal: invalidate,
        attachRemotePairing(attached: RemotePairingOAuthHooks) { hooks.current = attached; } };
      return { hooks, provider: provider as unknown as HebraOAuthProvider };
    }

    it('sin los servicios de la cuenta no ofrece renovar; con ellos sí', async () => {
      const { hooks, provider } = fakeProvider();
      const runtime = await openRemotePairing({ dataDir: root, registry, provider, lumbreOrigin: API });
      expect(hooks.current!.renewal!.ready()).toBe(false);
      await expect(runtime.service.start({ oauthRequestId: 'o', sub: SUB, renew: true,
        identityExpiresAt: new Date(Date.now() + 60_000).toISOString() })).resolves.toBeDefined();
      runtime.attachAccountServices({ contexts: { drainAndClose: drain as never }, removal: { remove: vi.fn() },
        legacySecrets: new MemorySecretStore() });
      expect(hooks.current!.renewal!.ready()).toBe(true);
    });

    it('el callback de Sumego lleva primero al aviso previo, con la cookie de la transacción', async () => {
      const { hooks, provider } = fakeProvider();
      await openRemotePairing({ dataDir: root, registry, provider, lumbreOrigin: API });
      const cookies: unknown[] = [];
      const location = await hooks.current!.start({ oauthRequestId: 'o', sub: 'sumego|nueva',
        identityExpiresAt: new Date(Date.now() + 60_000).toISOString() },
      { cookie: (...args: unknown[]) => { cookies.push(args); } } as never);
      expect(location).toBe('/lumbre/pairing/start');
      expect(cookies).toHaveLength(1);
      // Confirmar no abre nada: `openRemotePairing` ni siquiera recibe cómo abrir un contexto.
      expect(drain).not.toHaveBeenCalled();
    });

    it.each([[401, true], [403, true], [200, false], [503, false]] as const)(
      'con un %s al leer con sus tokens, credencial rechazada=%s', async (status, rejected) => {
        const fetcher = vi.fn(async () => new Response('{}', { status }));
        const { hooks, provider } = fakeProvider();
        const runtime = await openRemotePairing({ dataDir: root, registry, provider, lumbreOrigin: API, fetcher });
        runtime.attachAccountServices({ contexts: { drainAndClose: drain as never }, removal: { remove: vi.fn() },
          legacySecrets: new MemorySecretStore() });
        await expect(hooks.current!.renewal!.credentialRejected(account)).resolves.toBe(rejected);
        const [target, init] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
        expect(target.origin).toBe(API);
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer read-vieja');
      });

    it('un GET de lectura correcto al hacer login levanta la marca de revocado; un 401 no la toca', async () => {
      for (const [status, revoked] of [[200, false], [401, true]] as const) {
        const { hooks, provider } = fakeProvider();
        const pairing = (provider as unknown as { pairing: PairingRevocation }).pairing;
        pairing.markRevoked(OLD_CREDENTIAL);
        const runtime = await openRemotePairing({ dataDir: root, registry, provider, lumbreOrigin: API,
          fetcher: async () => new Response('{}', { status }) });
        runtime.attachAccountServices({ contexts: { drainAndClose: drain as never }, removal: { remove: vi.fn() },
          legacySecrets: new MemorySecretStore() });
        await hooks.current!.renewal!.credentialRejected(account);
        expect(pairing.isRevoked(OLD_CREDENTIAL)).toBe(revoked);
      }
    });

    it('sin red, la credencial no se da por rechazada', async () => {
      const { hooks, provider } = fakeProvider();
      const runtime = await openRemotePairing({ dataDir: root, registry, provider, lumbreOrigin: API,
        fetcher: async () => { throw new Error('offline'); } });
      runtime.attachAccountServices({ contexts: { drainAndClose: drain as never }, removal: { remove: vi.fn() },
        legacySecrets: new MemorySecretStore() });
      await expect(hooks.current!.renewal!.credentialRejected(account)).resolves.toBe(false);
    });
  });

  it('si no se puede publicar, suelta la cuenta y revoca: nada queda bloqueado', async () => {
    registry.commitRenewal = async () => { throw new Error('disk_full'); };
    const { service, journals } = build();
    const { started, form } = await toConfirmation(service);
    await expect(service.confirm(started.id, form)).rejects.toMatchObject({ code: 'unavailable' });
    expect(revoke).toHaveBeenCalledOnce();
    expect(registry.findById(account.id)?.renewing).toBeUndefined();
    expect(await journals.read(started.id)).toBeNull();
  });
});
