/**
 * D22, SPEC.md §8 y §12.10 "Sync": sin llamadas no hay peticiones al relé, y una escritura hecha no
 * se pierde por cerrar el contexto. Motor de sync y SQLite reales sobre el relé en memoria de Hebra,
 * envuelto para contar cada llamada y para fallar o colgarse a voluntad. El reloj se inyecta: ninguna
 * espera de estos tests depende de que pase tiempo real.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountContexts } from '../../src/accounts/contexts';
import {
  expireRemotePairings,
  PENDING_UPLOADS_FILE,
  PendingSweep,
  PendingUploadList,
  SWEEP_ELEMENT_TIMEOUT_MS,
  type PendingSweepOptions,
  type WithAccountContext
} from '../../src/accounts/pending-sweep';
import { AccountRegistry } from '../../src/accounts/registry';
import { AccountRemovalService } from '../../src/accounts/removal';
import type { AccountRef } from '../../src/accounts/types';
import { RemotePairingJournalStore } from '../../src/pair/remote/journal';
import { RemotePairingService } from '../../src/pair/remote/service';
import type { RemotePairingJournal } from '../../src/pair/remote/types';
import { MemorySecretStore } from '../../src/secrets';
import { buildMcpServer } from '../../src/server/build-server';
import type { ServerContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import { openServeContext, type OpenServeOptions, type ServeContext } from '../../src/server/serve';
import { STARTUP_READ_WAIT_MS } from '../../src/sync/runner';
import { deferred } from '../fixtures/deferred';
import { NO_PRIVATE } from '../fixtures/no-private';
import { appCreate, appDevice, IDENTITY, InMemoryLibraryRelay, VAULT_KEY } from '../sync/devices';

type RelayMode = 'up' | 'down' | 'hang';

/** Una cuenta de prueba con su propio relé, contable. */
interface TestAccount {
  ref: AccountRef;
  dir: string;
  relay: InMemoryLibraryRelay;
  mode: RelayMode;
  calls: number;
  /** Suelta las llamadas colgadas con `mode: 'hang'`. */
  hang: ReturnType<typeof deferred>;
  transport: InMemoryLibraryRelay;
}

let root: string;
let control: string;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  root = await mkdtemp(join(tmpdir(), 'hebra-pending-'));
  control = join(root, 'control');
});

afterEach(async () => {
  stderr.mockRestore();
  await rm(root, { recursive: true, force: true });
});

function testAccount(name: string): TestAccount {
  const relay = new InMemoryLibraryRelay();
  const account: TestAccount = {
    ref: { id: randomUUID(), generation: 1 },
    dir: join(root, name),
    relay,
    mode: 'up',
    calls: 0,
    hang: deferred(),
    transport: relay
  };
  account.transport = new Proxy(relay, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        account.calls += 1;
        if (account.mode === 'down') throw new TypeError('network');
        if (account.mode === 'hang') await account.hang.promise;
        return Reflect.apply(value, target, args);
      };
    }
  });
  return account;
}

type OpenExtras = Partial<Pick<OpenServeOptions, 'writerOnly'>> & {
  waitTimer?: (ms: number) => Promise<void>;
};

function openAccount(account: TestAccount, list: PendingUploadList | null, extras: OpenExtras = {}): Promise<ServeContext> {
  return openServeContext({
    dataDir: account.dir,
    secrets: null,
    writerOnly: extras.writerOnly ?? true,
    instance: {
      checkIntervalMs: null,
      lock: { releaseOnExit: false },
      sync: {
        identity: IDENTITY,
        vaultKey: VAULT_KEY,
        transport: account.transport,
        blobTransport: null,
        intervalMs: null,
        ...(extras.waitTimer ? { waitTimer: extras.waitTimer } : {})
      }
    },
    ...(list ? { uploadLedger: list.ledger(account.ref) } : {})
  });
}

/** La vía normal de abrir, usar y cerrar, como la enchufa el ciclo de vida. */
function viaOpenClose(accounts: TestAccount[], list: PendingUploadList, opened: string[] = []): WithAccountContext {
  return async (ref, fn) => {
    opened.push(ref.id);
    const account = accounts.find((entry) => entry.ref.id === ref.id);
    if (!account) throw new Error('account_inactive');
    const served = await openAccount(account, list);
    try {
      return await fn(served.ctx);
    } finally {
      await served.close();
    }
  };
}

function sweepOf(list: PendingUploadList, withAccountContext: WithAccountContext, more: Partial<PendingSweepOptions> = {}): PendingSweep {
  return new PendingSweep({
    list,
    withAccountContext,
    accountActive: () => true,
    resumeRemovals: async () => undefined,
    expireJournals: async () => ({ expired: 0, failed: 0 }),
    ...more
  });
}

/** Deja `account` con una nota escrita sin subir y su contexto cerrado. */
async function closeWithPendingUpload(account: TestAccount, list: PendingUploadList): Promise<string> {
  const previous = account.mode;
  account.mode = 'down';
  const served = await openAccount(account, list);
  const note = await served.instance.createNote({ body: '# Titulo privado\n\ncuerpo', privacy: NO_PRIVATE });
  await served.close();
  account.mode = previous;
  return note.id;
}

async function listFile(): Promise<{ version: number; entries: unknown[] }> {
  return JSON.parse(await readFile(join(control, PENDING_UPLOADS_FILE), 'utf8')) as { version: number; entries: unknown[] };
}

async function noteOnRelay(account: TestAccount, id: string): Promise<string | undefined> {
  const app = await appDevice(account.relay);
  await app.sync.runRound();
  return (await app.port.noteRead(id))?.body;
}

describe('al cerrar: ronda final y lista durable', () => {
  it('sin nada pendiente, cerrar no hace ninguna ronda ni toca el disco', async () => {
    const account = testAccount('a');
    const list = await PendingUploadList.open(control);
    const served = await openAccount(account, list);
    await served.ctx.firstRound?.();
    const before = account.calls;
    await served.close();
    expect(account.calls).toBe(before);
    await expect(stat(join(control, PENDING_UPLOADS_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('si la ronda final sube lo pendiente, no queda en la lista', async () => {
    const account = testAccount('a');
    const list = await PendingUploadList.open(control);
    account.mode = 'down';
    const served = await openAccount(account, list);
    const note = await served.instance.createNote({ body: '# Sube al cerrar', privacy: NO_PRIVATE });
    await served.instance.syncRunner!.requestRound();
    expect(list.entries()).toHaveLength(1);
    account.mode = 'up';
    await served.close();
    expect(list.entries()).toEqual([]);
    expect((await listFile()).entries).toEqual([]);
    expect(await noteOnRelay(account, note.id)).toBe('# Sube al cerrar');
  });

  it('si falla, queda en un fichero atómico y opaco, sin título, cuerpo ni datos de la persona', async () => {
    const account = testAccount('a');
    const list = await PendingUploadList.open(control);
    await closeWithPendingUpload(account, list);
    expect((await listFile())).toEqual({ version: 1, entries: [
      { account: account.ref.id, generation: 1, space: null, blocked: false }
    ] });
    const raw = await readFile(join(control, PENDING_UPLOADS_FILE), 'utf8');
    expect(raw).not.toContain('Titulo');
    expect(raw).not.toContain('cuerpo');
    expect((await stat(join(control, PENDING_UPLOADS_FILE))).mode & 0o777).toBe(0o600);
    expect(await readdir(control)).toEqual([PENDING_UPLOADS_FILE]);
  });

  it('la escritura ya deja apuntada la biblioteca, por si el proceso muere antes de cerrar', async () => {
    const account = testAccount('a');
    const list = await PendingUploadList.open(control);
    account.mode = 'down';
    const served = await openAccount(account, list);
    await served.instance.createNote({ body: '# Sin cerrar', privacy: NO_PRIVATE });
    await vi.waitFor(async () => {
      expect((await listFile()).entries).toHaveLength(1);
    }, { timeout: 20_000 });
    const afterCrash = await PendingUploadList.open(control);
    expect(afterCrash.entries().map((entry) => entry.account)).toEqual([account.ref.id]);
    await served.close();
  });

  it('con el relé colgado, el cierre no espera más que su plazo y lo deja apuntado antes de intentarlo', async () => {
    const account = testAccount('a');
    const list = await PendingUploadList.open(control);
    const limits: Array<ReturnType<typeof deferred>> = [];
    const asked: number[] = [];
    const served = await openAccount(account, list, { waitTimer: (ms) => {
      asked.push(ms);
      const limit = deferred();
      limits.push(limit);
      return limit.promise;
    } });
    await served.ctx.firstRound?.();
    account.mode = 'down';
    await served.instance.createNote({ body: '# Colgada', privacy: NO_PRIVATE });
    await served.instance.syncRunner!.requestRound();
    account.mode = 'hang';
    const closing = served.close();
    await vi.waitFor(() => { expect(asked).toHaveLength(2); }, { timeout: 20_000 });
    expect(asked).toEqual([STARTUP_READ_WAIT_MS, 10_000]);
    expect((await listFile()).entries).toHaveLength(1);
    limits[1]!.resolve();
    // Se acabó el plazo con la ronda aún colgada: ya solo espera a que termine lo que hay en vuelo.
    account.hang.resolve();
    await closing;
    expect(list.entries()).toHaveLength(1);
  });

  it('un 401 deja la entrada bloqueada: el barrido la prueba una vez por arranque y no insiste', async () => {
    const account = testAccount('a');
    const list = await PendingUploadList.open(control);
    account.mode = 'down';
    const served = await openAccount(account, list);
    await served.instance.createNote({ body: '# Revocada', privacy: NO_PRIVATE });
    await served.instance.syncRunner!.requestRound();
    account.mode = 'up';
    account.relay.httpErrorNextChanges = { status: 401 };
    await served.close();
    expect(list.entries()).toMatchObject([{ blocked: true }]);

    const opened: string[] = [];
    const withContext: WithAccountContext = (ref, fn) => {
      account.relay.httpErrorNextChanges = { status: 401 };
      return viaOpenClose([account], list, opened)(ref, fn);
    };
    const sweep = sweepOf(list, withContext);
    expect(await sweep.runOnce()).toMatchObject({ kept: 1 });
    const calls = account.calls;
    expect(await sweep.runOnce()).toMatchObject({ kept: 0, skipped: 1 });
    expect(opened).toHaveLength(1);
    expect(account.calls).toBe(calls);
    // Un arranque nuevo (por ejemplo, un binario nuevo) lo intenta otra vez, ya sin 401.
    const afterDeploy = sweepOf(list, viaOpenClose([account], list, opened));
    expect(await afterDeploy.runOnce()).toMatchObject({ uploaded: 1, kept: 0 });
    expect(list.entries()).toEqual([]);
  });

  it('una escritura sigue funcionando aunque no se pueda escribir la lista', async () => {
    const account = testAccount('a');
    await writeFile(join(root, 'control'), 'no soy un directorio');
    const list = await PendingUploadList.open(control);
    account.mode = 'down';
    const served = await openAccount(account, list);
    const note = await served.instance.createNote({ body: '# A salvo', privacy: NO_PRIVATE });
    await served.close();
    account.mode = 'up';
    const reopened = await openAccount(account, null);
    await reopened.ctx.firstRound?.();
    expect((await reopened.instance.port.noteRead(note.id))?.body).toBe('# A salvo');
    await reopened.close();
    expect(await noteOnRelay(account, note.id)).toBe('# A salvo');
  });

  it('un fichero ilegible no impide arrancar', async () => {
    await mkdir(control, { recursive: true });
    await writeFile(join(control, PENDING_UPLOADS_FILE), '{no es json');
    expect((await PendingUploadList.open(control)).entries()).toEqual([]);
  });
});

describe('barrido global', () => {
  it('en reposo, 0 peticiones: ni contextos, ni retiradas, ni diarios', async () => {
    const account = testAccount('a');
    const list = await PendingUploadList.open(control);
    const served = await openAccount(account, list);
    await served.ctx.firstRound?.();
    await served.close();
    const calls = account.calls;

    const registry = await AccountRegistry.open(root);
    const sideEffects = vi.fn();
    const removal = new AccountRemovalService({ dataDir: root, registry,
      contexts: new AccountContexts(registry, async () => { sideEffects('open'); throw new Error('unexpected_open'); }),
      oauth: { invalidateAccount: async () => { sideEffects('oauth'); return 0; } },
      revokeDevice: async () => { sideEffects('revoke'); },
      legacySecrets: new MemorySecretStore() });
    const fetcher = vi.fn(async () => new Response('{}'));
    const journals = new RemotePairingJournalStore(join(root, 'remote-pairing-v1'));
    const service = new RemotePairingService({ journals, fetcher,
      ownership: { verify: async () => { throw new Error('unexpected'); } },
      publisher: { publish: async () => { throw new Error('unexpected'); }, findCommitted: async () => null, cleanupOrphan: async () => undefined } });
    const opened: string[] = [];
    let tick: () => void = () => undefined;
    const sweep = sweepOf(list, viaOpenClose([account], list, opened), {
      resumeRemovals: () => removal.resumePending(),
      expireJournals: () => expireRemotePairings(journals, service, Date.now()),
      schedule: (run, ms) => { expect(ms).toBe(60_000); tick = run; return () => undefined; }
    });
    sweep.start();
    for (let round = 0; round < 5; round += 1) {
      tick();
      await sweep.runOnce();
    }
    expect(account.calls).toBe(calls);
    expect(opened).toEqual([]);
    expect(sideEffects).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(stderr.mock.calls.join('')).not.toContain('pending_sweep');
    await sweep.stop();
  });

  it('cierre con subida pendiente y barrido que la sube tras reiniciar; después, 0 peticiones', async () => {
    const account = testAccount('a');
    const before = await PendingUploadList.open(control);
    const id = await closeWithPendingUpload(account, before);
    expect(await noteOnRelay(account, id)).toBeUndefined();

    const list = await PendingUploadList.open(control);
    expect(list.entries()).toHaveLength(1);
    const opened: string[] = [];
    const sweep = sweepOf(list, viaOpenClose([account], list, opened));
    expect(await sweep.runOnce()).toMatchObject({ uploaded: 1, kept: 0, dropped: 0 });
    expect(opened).toEqual([account.ref.id]);
    expect(list.entries()).toEqual([]);
    expect((await listFile()).entries).toEqual([]);
    expect(await noteOnRelay(account, id)).toBe('# Titulo privado\n\ncuerpo');

    const calls = account.calls;
    await sweep.runOnce();
    expect(account.calls).toBe(calls);
    expect(opened).toHaveLength(1);
  });

  it('un fallo persistente no bloquea a otra cuenta, y se reintenta en cada barrido', async () => {
    const failing = testAccount('falla');
    const healthy = testAccount('sana');
    const list = await PendingUploadList.open(control);
    await closeWithPendingUpload(failing, list);
    const id = await closeWithPendingUpload(healthy, list);
    expect(list.entries().map((entry) => entry.account)).toEqual([failing.ref.id, healthy.ref.id]);
    failing.mode = 'down';

    const opened: string[] = [];
    const sweep = sweepOf(list, viaOpenClose([failing, healthy], list, opened));
    expect(await sweep.runOnce()).toMatchObject({ uploaded: 1, kept: 1 });
    expect(await noteOnRelay(healthy, id)).toBe('# Titulo privado\n\ncuerpo');
    expect(list.entries().map((entry) => entry.account)).toEqual([failing.ref.id]);
    expect(await sweep.runOnce()).toMatchObject({ uploaded: 0, kept: 1 });
    expect(opened).toEqual([failing.ref.id, healthy.ref.id, failing.ref.id]);

    failing.mode = 'up';
    expect(await sweep.runOnce()).toMatchObject({ uploaded: 1, kept: 0 });
    expect(list.entries()).toEqual([]);
  });

  it('una apertura que lanza tampoco bloquea: es un fallo más de ese elemento', async () => {
    const failing = testAccount('falla');
    const healthy = testAccount('sana');
    const list = await PendingUploadList.open(control);
    await closeWithPendingUpload(failing, list);
    await closeWithPendingUpload(healthy, list);
    const normal = viaOpenClose([healthy], list);
    const sweep = sweepOf(list, (ref, fn) => ref.id === failing.ref.id
      ? Promise.reject(new Error('capacity_wait_timeout'))
      : normal(ref, fn));
    expect(await sweep.runOnce()).toMatchObject({ uploaded: 1, kept: 1 });
    expect(stderr.mock.calls.join('')).toContain('"code":"Error"');
  });

  it('un elemento colgado agota su plazo, deja pasar a los demás y no se repite hasta que termine', async () => {
    const stuck = testAccount('colgada');
    const healthy = testAccount('sana');
    const list = await PendingUploadList.open(control);
    await closeWithPendingUpload(stuck, list);
    await closeWithPendingUpload(healthy, list);

    const release = deferred();
    const limits: Array<{ ms: number; timer: ReturnType<typeof deferred> }> = [];
    const opens: string[] = [];
    const normal = viaOpenClose([healthy], list, opens);
    const sweep = sweepOf(list, async (ref, fn) => {
      if (ref.id === stuck.ref.id) {
        opens.push(ref.id);
        await release.promise;
        throw new Error('colgada');
      }
      return normal(ref, fn);
    }, { sleep: (ms) => {
      const timer = deferred();
      limits.push({ ms, timer });
      return timer.promise;
    } });

    const first = sweep.runOnce();
    await vi.waitFor(() => { expect(opens).toEqual([stuck.ref.id]); }, { timeout: 20_000 });
    expect(limits.map(({ ms }) => ms)).toEqual([SWEEP_ELEMENT_TIMEOUT_MS, SWEEP_ELEMENT_TIMEOUT_MS, SWEEP_ELEMENT_TIMEOUT_MS]);
    // Vence el plazo de lo que hay en marcha, no el del siguiente elemento, que aún no ha empezado.
    for (const { timer } of limits.splice(0)) timer.resolve();
    expect(await first).toMatchObject({ uploaded: 1, kept: 1 });

    expect(await sweep.runOnce()).toMatchObject({ uploaded: 0, kept: 0, skipped: 1 });
    expect(opens).toEqual([stuck.ref.id, healthy.ref.id]);
    release.resolve();
    await vi.waitFor(async () => {
      await sweep.runOnce();
      expect(opens.filter((id) => id === stuck.ref.id).length).toBeGreaterThan(1);
    }, { timeout: 20_000 });
  });

  it('no se solapa consigo mismo: los ticks con uno en curso no empiezan otro', async () => {
    const account = testAccount('a');
    const list = await PendingUploadList.open(control);
    await closeWithPendingUpload(account, list);

    const gate = deferred();
    const resumeRemovals = vi.fn(async () => { await gate.promise; });
    const expireJournals = vi.fn(async () => ({ expired: 0, failed: 0 }));
    const opened: string[] = [];
    let tick: () => void = () => undefined;
    const sweep = sweepOf(list, viaOpenClose([account], list, opened), {
      resumeRemovals, expireJournals,
      schedule: (run) => { tick = run; return () => undefined; }
    });
    sweep.start();
    sweep.start();
    tick();
    const running = sweep.runOnce();
    tick();
    tick();
    await vi.waitFor(() => { expect(list.entries()).toEqual([]); }, { timeout: 20_000 });
    expect(resumeRemovals).toHaveBeenCalledTimes(1);
    expect(expireJournals).toHaveBeenCalledTimes(1);
    expect(opened).toHaveLength(1);
    gate.resolve();
    await running;
    await sweep.runOnce();
    expect(resumeRemovals).toHaveBeenCalledTimes(2);
  });

  it('un contexto abierto no se toca: su sync ya lo lleva él', async () => {
    const account = testAccount('a');
    const list = await PendingUploadList.open(control);
    account.mode = 'down';
    const served = await openAccount(account, list);
    await served.instance.createNote({ body: '# Abierto', privacy: NO_PRIVATE });
    await vi.waitFor(() => { expect(list.entries()).toHaveLength(1); }, { timeout: 20_000 });
    const opened: string[] = [];
    const sweep = sweepOf(list, viaOpenClose([account], list, opened));
    expect(await sweep.runOnce()).toMatchObject({ skipped: 1, kept: 0 });
    expect(opened).toEqual([]);
    await served.close();
    account.mode = 'up';
    expect(await sweep.runOnce()).toMatchObject({ uploaded: 1 });
  });

  it('la entrada de una cuenta retirada se descarta sin abrir nada', async () => {
    const account = testAccount('a');
    const list = await PendingUploadList.open(control);
    await closeWithPendingUpload(account, list);
    const opened: string[] = [];
    const sweep = sweepOf(list, viaOpenClose([account], list, opened), { accountActive: () => false });
    expect(await sweep.runOnce()).toMatchObject({ dropped: 1 });
    expect(opened).toEqual([]);
    expect(list.entries()).toEqual([]);
  });

  it('una cuenta retirada durante el intento también se descarta', async () => {
    const account = testAccount('a');
    const list = await PendingUploadList.open(control);
    await closeWithPendingUpload(account, list);
    let active = true;
    const sweep = sweepOf(list, async () => { active = false; throw new Error('account_inactive'); },
      { accountActive: () => active });
    expect(await sweep.runOnce()).toMatchObject({ dropped: 1 });
    expect(list.entries()).toEqual([]);
  });

  it('una retirada que falla no impide subir lo demás, y se reintenta', async () => {
    const account = testAccount('a');
    const list = await PendingUploadList.open(control);
    await closeWithPendingUpload(account, list);
    const resumeRemovals = vi.fn(async () => { throw new Error('account_writer_busy'); });
    const sweep = sweepOf(list, viaOpenClose([account], list), { resumeRemovals });
    expect(await sweep.runOnce()).toMatchObject({ uploaded: 1, removalsFailed: true });
    await sweep.runOnce();
    expect(resumeRemovals).toHaveBeenCalledTimes(2);
  });

  it('stop no espera de más a lo que está en curso y no deja empezar nada nuevo', async () => {
    const list = await PendingUploadList.open(control);
    const gate = deferred();
    const limit = deferred();
    const resumeRemovals = vi.fn(async () => { await gate.promise; });
    const sweep = sweepOf(list, viaOpenClose([], list), { resumeRemovals, sleep: () => limit.promise });
    void sweep.runOnce();
    const stopped = sweep.stop();
    limit.resolve();
    await stopped;
    gate.resolve();
    expect(await sweep.runOnce()).toMatchObject({ uploaded: 0 });
    expect(resumeRemovals).toHaveBeenCalledTimes(1);
  });

  describe('entrada de un espacio', () => {
    const SPACE = '351f12d0-dd49-48a6-b84c-301e16c9d64a';
    const ACCOUNT: AccountRef = { id: 'cuenta', generation: 1 };

    async function listWithSpace(): Promise<PendingUploadList> {
      const list = await PendingUploadList.open(control);
      await list.put(ACCOUNT, SPACE, false);
      return list;
    }
    const contextWith = (spaces: ServerContext['spaces']): ServerContext => ({ spaces } as ServerContext);

    it('un espacio denegado que el listado confirma se descarta', async () => {
      const list = await listWithSpace();
      const sweep = sweepOf(list, (_ref, fn) => fn(contextWith({
        list: async () => [],
        resolve: async () => { throw new ToolError('space_access_denied'); }
      })));
      expect(await sweep.runOnce()).toMatchObject({ dropped: 1 });
      expect(list.entries()).toEqual([]);
    });

    it('con el relé caído, space_access_denied no olvida las subidas', async () => {
      const list = await listWithSpace();
      const sweep = sweepOf(list, (_ref, fn) => fn(contextWith({
        list: async () => { throw new ToolError('space_access_denied'); },
        resolve: async () => { throw new ToolError('space_access_denied'); }
      })));
      expect(await sweep.runOnce()).toMatchObject({ kept: 1, dropped: 0 });
      expect(list.entries()).toHaveLength(1);
    });

    it('un espacio que aún sale en el listado tampoco se olvida si no abre', async () => {
      const list = await listWithSpace();
      const sweep = sweepOf(list, (_ref, fn) => fn(contextWith({
        list: async () => [{ spaceId: SPACE, name: null }],
        resolve: async () => { throw new ToolError('space_access_denied'); }
      })));
      expect(await sweep.runOnce()).toMatchObject({ kept: 1 });
    });
  });
});

describe('diarios de alta caducados', () => {
  const NOW = Date.parse('2026-11-04T12:00:00.000Z');

  function journal(id: string, expiresAt: string, patch: Partial<RemotePairingJournal> = {}): RemotePairingJournal {
    return { version: 1, id, oauthRequestId: `oauth-${id}`, sub: 'persona', cookieHash: 'c', csrfHash: 'c',
      phase: 'credential', createdAt: '2026-11-04T11:00:00.000Z', updatedAt: '2026-11-04T11:00:00.000Z',
      expiresAt, identityExpiresAt: expiresAt, deviceId: 'd', verifier: 'v', cleanupRequired: false, ...patch };
  }

  it('limpia solo los caducados: un alta en curso sigue viva, y sin credencial no hay peticiones', async () => {
    const journals = new RemotePairingJournalStore(join(root, 'remote-pairing-v1'));
    const expired = randomUUID();
    const live = randomUUID();
    await journals.write(journal(expired, '2026-11-04T11:59:59.000Z'));
    await journals.write(journal(live, '2026-11-04T12:05:00.000Z'));
    const fetcher = vi.fn(async () => new Response('{}'));
    const service = new RemotePairingService({ journals, fetcher, now: () => NOW,
      ownership: { verify: async () => { throw new Error('unexpected'); } },
      publisher: { publish: async () => { throw new Error('unexpected'); }, findCommitted: async () => null, cleanupOrphan: async () => undefined } });

    expect(await expireRemotePairings(journals, service, NOW)).toEqual({ expired: 1, failed: 0 });
    expect(await journals.read(expired)).toBeNull();
    expect(await journals.read(live)).not.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    // Lo que no se puede hacer aquí: `recover` limpia también el que está en curso.
    expect((await service.recover()).cleaned).toBe(1);
    expect(await journals.read(live)).toBeNull();
  });

  it('uno que falla o está corrupto no para a los demás; sin directorio, nada', async () => {
    const journals = new RemotePairingJournalStore(join(root, 'remote-pairing-v1'));
    expect(await expireRemotePairings(journals, { abandon: vi.fn() }, NOW)).toEqual({ expired: 0, failed: 0 });
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) await journals.write(journal(id, '2026-11-04T11:00:00.000Z'));
    const corrupt = randomUUID();
    await mkdir(journals.sessionDir(corrupt), { recursive: true });
    await writeFile(join(journals.sessionDir(corrupt), 'pairing.json'), '{}');
    await writeFile(join(journals.root, 'no-soy-un-diario'), '');
    const abandon = vi.fn(async (id: string) => { if (id === ids[0]) throw new Error('cleanup_revoke_failed'); });
    expect(await expireRemotePairings(journals, { abandon }, NOW)).toEqual({ expired: 1, failed: 2 });
    expect(abandon).toHaveBeenCalledTimes(2);
  });
});

describe('lecturas en la biblioteca personal: esperan a la ronda de abrir, como mucho 10 s', () => {
  async function connect(served: ServeContext) {
    const server = buildMcpServer(served.ctx, 'test');
    const client = new Client({ name: 'pending-sweep-tests', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    return { client, close: async () => { await client.close(); await server.close(); } };
  }
  const json = (result: unknown) => JSON.parse((result as CallToolResult).content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))[0]!) as Record<string, unknown>;

  // `writerOnly` es `serve-http`; sin él es `serve` por stdio, al que §8 también se lo pide.
  it.each([['serve-http', true], ['serve', false]] as const)('%s: agotado el plazo responde lo local y hebra_status lo dice', async (_name, writerOnly) => {
    const account = testAccount('a');
    const limit = deferred();
    const asked: number[] = [];
    account.mode = 'hang';
    // Abrir no espera: en `serve`, el saludo de MCP no se retrasa.
    const served = await openAccount(account, null, { writerOnly, waitTimer: (ms) => { asked.push(ms); return limit.promise; } });
    expect(asked).toEqual([10_000]);
    const { client, close } = await connect(served);

    let answered = false;
    const reading = client.callTool({ name: 'hebra_list_notes', arguments: {} }).then((result) => {
      answered = true;
      return result;
    });
    // Margen para que una lectura que no esperase llegara a responder. No puede dar un rojo falso:
    // la que sí espera no responde por mucho que pase, porque el plazo lo suelta el test.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(answered).toBe(false);

    limit.resolve();
    expect((await reading as CallToolResult).isError).not.toBe(true);
    const status = json(await client.callTool({ name: 'hebra_status', arguments: {} }));
    expect(status).toMatchObject({ lastSyncAt: null, lastSyncOutcome: null, writer: 'this' });
    // Es el mismo plazo para todas: desde abrir, no desde cada llamada.
    expect(asked).toEqual([10_000]);

    account.hang.resolve();
    await served.instance.whenReady();
    await close();
    await served.close();
  });

  it('terminada la ronda, la lectura sale sin agotar el plazo y ve lo que trajo', async () => {
    const account = testAccount('a');
    const app = await appDevice(account.relay);
    const id = await appCreate(app, '# Del Mac');
    await app.sync.runRound();
    account.mode = 'hang';
    const never = deferred();
    const served = await openAccount(account, null, { waitTimer: () => never.promise });
    const { client, close } = await connect(served);
    const reading = client.callTool({ name: 'hebra_read_note', arguments: { id } });
    account.hang.resolve();
    const body = json(await reading);
    expect(body).toMatchObject({ id });
    const status = json(await client.callTool({ name: 'hebra_status', arguments: {} }));
    expect(status.lastSyncOutcome).toBe('ok');
    await close();
    await served.close();
  });
});
