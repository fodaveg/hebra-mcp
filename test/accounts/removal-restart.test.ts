/**
 * Retirada tras una caída (D22, §12.10): termina aunque el PID se repita, en cualquier fase
 * que la interrumpiera, sin exigir de nuevo lo ya borrado, y nunca actúa sobre un escritor de
 * este arranque ni de otro proceso vivo.
 *
 * El reinicio se simula entero: registro releído del disco, servicio nuevo, `server.lock`
 * soltado y vuelto a tomar (arranque nuevo) y, en los directorios que queden, el `writer.lock`
 * que deja un SIGKILL: con el PID de este proceso, que es el mismo tras reiniciar el contenedor,
 * y el identificador del arranque muerto.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountContexts } from '../../src/accounts/contexts';
import { AccountRegistry, accountDataDir } from '../../src/accounts/registry';
import { AccountRemovalService } from '../../src/accounts/removal';
import type { AccountRecord } from '../../src/accounts/types';
import { encodeRecoveryCode } from '../../src/hebra';
import { httpConfigFor } from '../../src/http/config';
import { startServeHttp, type ServeHttpHandle } from '../../src/http/serve-http';
import { acquireServerLock, classifyWriterLock, WriterLock, WRITER_LOCK_FILE, type ServerLock } from '../../src/lock';
import type { ActiveGrant } from '../../src/oauth/backchannel';
import type { OAuthHttpAuth } from '../../src/oauth/http-auth';
import { MemorySecretStore, openFileSecretStore, writePairedSecrets, type SecretStore } from '../../src/secrets';
import type { ServeContext } from '../../src/server/serve';
import { staticBearerAuth } from '../fixtures/http-app';

const dirs: string[] = [];
const bootLocks: ServerLock[] = [];
const handles: ServeHttpHandle[] = [];

const grantFor = (n: number, accountId: string): ActiveGrant => ({ active: true,
  credentialId: `0000000${n}-0000-4000-8000-000000000001`, clientId: 'hebra-mcp-claude',
  resource: 'https://mcp.hebra.pro/mcp', scope: 'hebra:mcp', accountId: accountId.repeat(64),
  expiresAt: '2026-12-01T00:00:00.000Z', pairedCredentialId: `1000000${n}-0000-4000-8000-000000000001`,
  syncVaultId: String(n).repeat(32), opaqueDeviceId: String(n + 1).repeat(32) });

afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) await handle.close();
  for (const lock of bootLocks.splice(0)) lock.release();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'hebra-restart-'));
  dirs.push(dataDir);
  await mkdir(join(dataDir, 'control'), { recursive: true });
  return dataDir;
}

function bootServer(dataDir: string): ServerLock {
  const lock = acquireServerLock(dataDir, join(dataDir, 'control'));
  if (!lock) throw new Error('server.lock ocupado');
  bootLocks.push(lock);
  return lock;
}

/** Lo que deja un SIGKILL: este PID, el del proceso que reinicia, y un arranque muerto. */
function leaveKilledLock(dir: string, bootId: string): string {
  const text = JSON.stringify({ pid: process.pid, nonce: `muerto-${bootId}`, startedAt: new Date(0).toISOString(),
    serverBootId: bootId });
  writeFileSync(join(dir, WRITER_LOCK_FILE), text);
  return text;
}

type Storage = 'account-dir' | 'legacy-root';

interface Fixture {
  dataDir: string;
  registry: AccountRegistry;
  account: AccountRecord;
  other: AccountRecord;
  personal: string;
  space: string;
  keyLock: string;
  secrets: SecretStore;
}

/** A, la cuenta que se retira, con espacio, bloqueo de clave y secretos; B, otra que no se toca. */
async function fixture(storage: Storage): Promise<Fixture> {
  const dataDir = await tempRoot();
  const registry = await AccountRegistry.open(dataDir);
  const account = storage === 'legacy-root'
    ? await registry.claimLegacy({ sub: 'david', grant: grantFor(1, 'a') })
    : await registry.commitAccount({ sub: 'mikel', grant: grantFor(1, 'a') });
  const other = await registry.commitAccount({ sub: 'otra', grant: grantFor(3, 'b') });
  const personal = accountDataDir(dataDir, account);
  const space = join(personal, 'spaces', 'cached-grant');
  const keyLock = join(personal, 'agent-key-lock');
  await mkdir(space, { recursive: true });
  await mkdir(keyLock, { recursive: true });
  await writeFile(join(personal, 'library.sqlite'), 'personal');
  await writeFile(join(space, 'library.sqlite'), 'shared');
  const secrets = openFileSecretStore(personal);
  await secrets.set('lumbre-connection', 'credencial');
  await mkdir(accountDataDir(dataDir, other), { recursive: true });
  await writeFile(join(accountDataDir(dataDir, other), 'library.sqlite'), 'b');
  return { dataDir, registry, account, other, personal, space, keyLock, secrets };
}

/** Como `revokeDevice` de `serve-http`: sin secretos no puede revocar. */
function serviceFor(f: Fixture, registry: AccountRegistry, count: { revocations: number },
  revoke?: () => Promise<void>): AccountRemovalService {
  return new AccountRemovalService({ dataDir: f.dataDir, registry,
    contexts: new AccountContexts(registry, async () => { throw new Error('unexpected_open'); }),
    oauth: { invalidateAccount: async () => 1 }, legacySecrets: f.secrets,
    revokeDevice: revoke ?? (async () => {
      if (!(await f.secrets.get('lumbre-connection'))) throw new Error('account_pairing_unavailable');
      count.revocations += 1;
    }) });
}

interface Frontier {
  name: string;
  /** Prepara la caída en el registro o el servicio de la primera pasada. */
  arm(registry: AccountRegistry, count: { revocations: number }): (() => Promise<void>) | undefined;
  /** Lo que deja hecho la caída además de los bloqueos. */
  after?(f: Fixture): Promise<void>;
  phaseAfterCrash: AccountRecord['removalPhase'];
  revocations: number;
}

const crash = (): Error => new Error('sigkill');

function crashAfterPersisting(registry: AccountRegistry, phase: 'remote-revoked' | 'data-erased'): void {
  const advance = registry.advanceRemoval.bind(registry);
  registry.advanceRemoval = async (ref, next) => {
    const result = await advance(ref, next);
    if (next === phase) throw crash();
    return result;
  };
}

function crashBeforePersisting(registry: AccountRegistry, phase: 'remote-revoked' | 'data-erased'): void {
  const advance = registry.advanceRemoval.bind(registry);
  registry.advanceRemoval = async (ref, next) => {
    if (next === phase) throw crash();
    return advance(ref, next);
  };
}

const FRONTIERS: Frontier[] = [
  { name: 'antes de revocar', phaseAfterCrash: 'blocked', revocations: 1,
    arm: () => async () => { throw crash(); } },
  { name: 'revocada en Lumbre sin registrarlo: reintenta', phaseAfterCrash: 'blocked', revocations: 2,
    arm: (registry, count) => { crashBeforePersisting(registry, 'remote-revoked');
      return async () => { count.revocations += 1; }; } },
  { name: 'revocación registrada, nada borrado', phaseAfterCrash: 'remote-revoked', revocations: 1,
    arm: (registry) => { crashAfterPersisting(registry, 'remote-revoked'); return undefined; } },
  { name: 'a medio borrar, ya sin secretos: no los exige', phaseAfterCrash: 'remote-revoked', revocations: 1,
    arm: (registry) => { crashAfterPersisting(registry, 'remote-revoked'); return undefined; },
    after: async (f) => {
      await f.secrets.delete('lumbre-connection');
      await rm(join(f.personal, 'library.sqlite'), { force: true });
    } },
  { name: 'datos borrados sin registrarlo', phaseAfterCrash: 'remote-revoked', revocations: 1,
    arm: (registry) => { crashBeforePersisting(registry, 'data-erased'); return undefined; } },
  { name: 'borrado registrado, sin marcar retirada', phaseAfterCrash: 'data-erased', revocations: 1,
    arm: (registry) => { crashAfterPersisting(registry, 'data-erased'); return undefined; } },
  { name: 'al publicar la retirada', phaseAfterCrash: 'data-erased', revocations: 1,
    arm: (registry) => { registry.finishRemoval = async () => { throw crash(); }; return undefined; } }
];

describe('retirada interrumpida en cada fase y reanudada tras un reinicio con el mismo PID', () => {
  describe.each(['account-dir', 'legacy-root'] as const)('%s', (storage) => {
    it.each(FRONTIERS.map((frontier) => [frontier.name, frontier] as const))('%s', async (_name, frontier) => {
      const f = await fixture(storage);
      const firstBoot = bootServer(f.dataDir);
      const count = { revocations: 0 };
      const revoke = frontier.arm(f.registry, count);
      await expect(serviceFor(f, f.registry, count, revoke).remove(f.account)).rejects.toThrow('sigkill');
      await frontier.after?.(f);

      // SIGKILL: el kernel suelta `server.lock`, y los `writer.lock` se quedan.
      firstBoot.release();
      const left = [f.personal, f.space, f.keyLock].filter((dir) => existsSync(dir));
      expect(left).toContain(f.personal);
      for (const dir of left) leaveKilledLock(dir, firstBoot.bootId);
      const otherDir = accountDataDir(f.dataDir, f.other);
      const otherLock = leaveKilledLock(otherDir, firstBoot.bootId);

      const registry = await AccountRegistry.open(f.dataDir);
      expect(registry.findById(f.account.id)).toMatchObject({ state: 'removing', removalPhase: frontier.phaseAfterCrash,
        generation: f.account.generation + 1 });
      bootServer(f.dataDir);
      await serviceFor(f, registry, count).resumePending();

      expect(registry.findById(f.account.id)).toMatchObject({ state: 'removed', removalPhase: 'data-erased',
        generation: f.account.generation + 1 });
      expect(count.revocations).toBe(frontier.revocations);
      expect(await f.secrets.get('lumbre-connection')).toBeNull();
      expect(existsSync(join(f.personal, 'library.sqlite'))).toBe(false);
      expect(existsSync(join(f.personal, WRITER_LOCK_FILE))).toBe(false);
      expect(existsSync(f.space)).toBe(false);
      if (storage === 'account-dir') expect(existsSync(f.personal)).toBe(false);
      else expect(existsSync(join(f.dataDir, 'control'))).toBe(true);
      // B ni se abre ni se limpia: su bloqueo obsoleto espera a que se use su cuenta.
      expect(registry.findById(f.other.id)).toMatchObject({ state: 'active' });
      expect(await readFile(join(otherDir, 'library.sqlite'), 'utf8')).toBe('b');
      expect(await readFile(join(otherDir, WRITER_LOCK_FILE), 'utf8')).toBe(otherLock);

      // Repetirla no reduce la generación ni reactiva nada.
      await serviceFor(f, registry, count).remove(f.account);
      expect(registry.findById(f.account.id)).toMatchObject({ state: 'removed', generation: f.account.generation + 1 });
    });
  });

  it('legacy-root: el resto de un bloqueo obsoleto a medio retirar no detiene el inventario', async () => {
    const f = await fixture('legacy-root');
    bootServer(f.dataDir);
    await writeFile(join(f.dataDir, `${WRITER_LOCK_FILE}.stale-1234`), 'resto');
    await serviceFor(f, f.registry, { revocations: 0 }).remove(f.account);
    expect(f.registry.findById(f.account.id)).toMatchObject({ state: 'removed' });
    expect(existsSync(join(f.dataDir, `${WRITER_LOCK_FILE}.stale-1234`))).toBe(false);
  });
});

describe('la retirada no actúa sobre un escritor vivo', () => {
  it.each(['account-dir', 'legacy-root'] as const)('%s: espera a las peticiones en curso de este arranque', async (storage) => {
    const f = await fixture(storage);
    bootServer(f.dataDir);
    const writer = new WriterLock({ dataDir: f.personal, releaseOnExit: false });
    expect(writer.tryAcquire()).toBe(true);
    const contexts = new AccountContexts(f.registry, async () => ({ ctx: {}, instance: { beginShutdown() {} }, linked: false,
      close: async () => { writer.release(); } }) as unknown as ServeContext);
    const lease = await contexts.acquire(f.account);
    let revocations = 0;
    let oauthInvalidated!: () => void;
    const invalidated = new Promise<void>((resolve) => { oauthInvalidated = resolve; });
    const service = new AccountRemovalService({ dataDir: f.dataDir, registry: f.registry, contexts,
      oauth: { invalidateAccount: async () => { oauthInvalidated(); return 1; } }, legacySecrets: f.secrets,
      revokeDevice: async () => { revocations += 1; } });

    const removing = service.remove(f.account);
    // La lápida ya está escrita y lo siguiente es drenar.
    await invalidated;
    // Un giro de la cola de E/S: lo que venga tras el drenaje ya habría tenido ocasión de correr.
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.registry.findById(f.account.id)?.state).toBe('removing');
    expect(revocations).toBe(0);
    expect(classifyWriterLock(f.personal)).toBe('this-boot');
    expect(await readFile(join(f.personal, 'library.sqlite'), 'utf8')).toBe('personal');

    lease.release();
    await removing;
    expect(revocations).toBe(1);
    expect(f.registry.findById(f.account.id)).toMatchObject({ state: 'removed' });
  });

  it.each(['account-dir', 'legacy-root'] as const)('%s: un escritor de este arranque fuera de los contextos la deja bloqueada', async (storage) => {
    const f = await fixture(storage);
    bootServer(f.dataDir);
    const writer = new WriterLock({ dataDir: f.space, releaseOnExit: false });
    expect(writer.tryAcquire()).toBe(true);
    const count = { revocations: 0 };
    const service = serviceFor(f, f.registry, count);
    await expect(service.remove(f.account)).rejects.toThrow('account_writer_busy');
    expect(writer.verify()).toBe(true);
    expect(f.registry.findById(f.account.id)).toMatchObject({ state: 'removing', removalPhase: 'blocked' });
    expect(count.revocations).toBe(0);
    expect(await f.secrets.get('lumbre-connection')).toBe('credencial');
    writer.release();
    await service.resumePending();
    expect(f.registry.findById(f.account.id)).toMatchObject({ state: 'removed' });
  });

  it('una orden externa viva la deja bloqueada también tras reiniciar; al salir, termina', async () => {
    const f = await fixture('account-dir');
    bootServer(f.dataDir);
    const child = spawn(process.execPath, ['-e', `
      require('node:fs').writeFileSync(process.argv[1], JSON.stringify({
        pid: process.pid, nonce: 'external-writer', startedAt: new Date().toISOString()
      }), { flag: 'wx', mode: 0o600 });
      process.send('ready');
      process.on('message', () => process.exit(0));
    `, join(f.personal, WRITER_LOCK_FILE)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    await once(child, 'message');
    const count = { revocations: 0 };
    const service = serviceFor(f, f.registry, count);
    try {
      await expect(service.remove(f.account)).rejects.toThrow('account_writer_busy');
      expect(classifyWriterLock(f.personal)).toBe('other-process');
      expect(count.revocations).toBe(0);
    } finally {
      const exited = once(child, 'exit');
      child.send('stop');
      await exited;
    }
    await service.resumePending();
    expect(f.registry.findById(f.account.id)).toMatchObject({ state: 'removed' });
  });

  it('sin arranque registrado, este PID cuenta como ocupado: no se puede probar que sea anterior', async () => {
    const f = await fixture('account-dir');
    const text = leaveKilledLock(f.personal, 'de-quien-sea');
    const count = { revocations: 0 };
    await expect(serviceFor(f, f.registry, count).remove(f.account)).rejects.toThrow('account_writer_busy');
    expect(await readFile(join(f.personal, WRITER_LOCK_FILE), 'utf8')).toBe(text);
    expect(count.revocations).toBe(0);
  });
});

describe('startServeHttp tras un SIGKILL con el PID repetido', () => {
  it.each(['account-dir', 'legacy-root'] as const)('%s: reanuda la retirada al arrancar y no toca las demás cuentas', async (storage) => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const f = await fixture(storage);
    await f.registry.beginRemoval(f.account);
    leaveKilledLock(f.personal, 'arranque-anterior');
    leaveKilledLock(f.space, 'arranque-anterior');
    const otherDir = accountDataDir(f.dataDir, f.other);
    mkdirSync(otherDir, { recursive: true });
    const otherLock = leaveKilledLock(otherDir, 'arranque-anterior');

    const registry = await AccountRegistry.open(f.dataDir);
    const auth = { ...staticBearerAuth('token'), accounts: registry,
      provider: { attachRemotePairing() {}, invalidateAccount: async () => 0 },
      lumbreOrigin: 'https://app.lumbre.pro' } as unknown as OAuthHttpAuth;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    // Los secretos de `legacy-root` son los de la raíz; los de una cuenta, los de su directorio.
    const paired = openFileSecretStore(f.personal);
    const pairedGrant = grantFor(1, 'a');
    await writePairedSecrets(paired, {
      connection: { credentialId: pairedGrant.pairedCredentialId!, readToken: 'read', writeToken: 'write',
        apiOrigin: 'https://app.lumbre.pro', connectedAt: new Date(0).toISOString() },
      recoveryCode: await encodeRecoveryCode({ relayOrigin: 'https://app.lumbre.pro', syncVaultId: pairedGrant.syncVaultId!,
        keyEpoch: 1, vaultKey: randomBytes(32) }),
      device: { opaqueDeviceId: pairedGrant.opaqueDeviceId!, lumbreDeviceId: '30000000-0000-4000-8000-000000000001' }
    });
    const handle = await startServeHttp({ dataDir: f.dataDir, secrets: storage === 'legacy-root' ? paired : new MemorySecretStore(),
      multiuser: true, config: httpConfigFor('http://127.0.0.1', 0), version: '0.0.0-test',
      authConfigured: () => true, loadAuth: async () => auth, fetcher });
    handles.push(handle);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(registry.findById(f.account.id)).toMatchObject({ state: 'removed', removalPhase: 'data-erased' });
    expect(existsSync(join(f.personal, 'library.sqlite'))).toBe(false);
    expect(await readFile(join(otherDir, WRITER_LOCK_FILE), 'utf8')).toBe(otherLock);
    expect(classifyWriterLock(otherDir)).toBe('stale');
  });
});
