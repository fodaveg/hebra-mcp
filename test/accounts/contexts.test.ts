import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapacityGate, ContextUnavailableError, readCapacityConfig, readMemoryUsage } from '../../src/accounts/capacity';
import { AccountContexts, type AccountContextsOptions } from '../../src/accounts/contexts';
import type { WriterLockOwner } from '../../src/lock';
import type { Clock } from '../../src/accounts/lifecycle';
import type { AccountRegistry } from '../../src/accounts/registry';
import type { AuthorizedAccount } from '../../src/accounts/types';
import { createHttpApp } from '../../src/http/app';
import { httpConfigFor } from '../../src/http/config';
import { bindPairingRevocation } from '../../src/http/serve-http';
import type { SpaceLifecycleControl } from '../../src/server/context';
import type { ServeContext } from '../../src/server/serve';
import { PAIRING_REVOKED_REMOTE_REASON, PairingRevocation } from '../../src/status/pairing-revocation';
import { runStatus } from '../../src/server/tools/status';
import { deferred } from '../fixtures/deferred';

const account = (id: string, generation = 1): AuthorizedAccount => ({ id, generation,
  storage: id === 'legacy' ? 'legacy-root' : 'account-dir',
  binding: { pairedCredentialId: `${id}-credential`, syncVaultId: `${id}-vault`, opaqueDeviceId: `${id}-device` } });

const activeRegistry = { assertActive() {} } as unknown as AccountRegistry;
const MIB = 1024 * 1024;
const IDLE_MS = 120_000;
const WAIT_MS = 20_000;

/** Vacía promesas y `setImmediate` pendientes, sin esperar tiempo de reloj. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

class FakeClock implements Clock {
  private time = 0;
  private timers: Array<{ at: number; run: () => void }> = [];
  now(): number { return this.time; }
  setTimer(run: () => void, ms: number): () => void {
    const timer = { at: this.time + ms, run };
    this.timers.push(timer);
    return () => { this.timers = this.timers.filter((entry) => entry !== timer); };
  }
  get pending(): number { return this.timers.length; }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((entry) => entry !== due);
      this.time = Math.max(this.time, due.at);
      due.run();
      await settled();
    }
    this.time = end;
    await settled();
  }
}

/** Abre contextos sintéticos y falla si hay dos a la vez sobre un mismo directorio. */
class FakeLibraries {
  readonly opened: string[] = [];
  readonly closed: string[] = [];
  readonly live = new Map<string, number>();
  overlap = false;
  beforeClose: ((id: string) => Promise<void>) | null = null;
  beforeOpen: ((id: string) => Promise<void>) | null = null;
  decorate: ((context: ServeContext, id: string) => ServeContext) | null = null;

  open = async (entry: AuthorizedAccount): Promise<ServeContext> => {
    const id = entry.id;
    await this.beforeOpen?.(id);
    if ((this.live.get(id) ?? 0) > 0) this.overlap = true;
    this.live.set(id, (this.live.get(id) ?? 0) + 1);
    this.opened.push(id);
    const context: ServeContext = {
      ctx: { account: id } as never, instance: { beginShutdown() {} } as never, linked: true,
      close: async () => {
        await this.beforeClose?.(id);
        this.live.set(id, (this.live.get(id) ?? 0) - 1);
        this.closed.push(id);
      }
    };
    return this.decorate ? this.decorate(context, id) : context;
  };

  get openCount(): number {
    return [...this.live.values()].reduce((sum, count) => sum + count, 0);
  }
}

function harness(options: AccountContextsOptions & { registry?: AccountRegistry } = {}) {
  const clock = new FakeClock();
  const libraries = new FakeLibraries();
  const memory = { usedBytes: 0, limitBytes: 1000 * MIB };
  const contexts = new AccountContexts(options.registry ?? activeRegistry, libraries.open, {
    idleMs: IDLE_MS, openWaitMs: WAIT_MS, clock, readMemory: () => memory, ...options
  });
  return { clock, libraries, memory, contexts };
}

describe('AccountContexts', () => {
  it('comparte una sola apertura por cuenta y nunca cruza contextos', async () => {
    const active = new Map([['legacy', 1], ['mikel', 1]]);
    const registry = { assertActive(ref: AuthorizedAccount) {
      if (active.get(ref.id) !== ref.generation) throw new Error('account_inactive');
    } } as AccountRegistry;
    const opened: string[] = [];
    const closed: string[] = [];
    const contexts = new AccountContexts(registry, async (entry): Promise<ServeContext> => {
      opened.push(entry.id);
      return { ctx: { account: entry.id } as never, instance: {} as never, linked: true,
        close: async () => { closed.push(entry.id); } };
    });
    const [david1, david2, mikel] = await Promise.all([
      contexts.acquire(account('legacy')), contexts.acquire(account('legacy')), contexts.acquire(account('mikel'))
    ]);
    expect(opened.sort()).toEqual(['legacy', 'mikel']);
    expect((david1.ctx as unknown as { account: string }).account).toBe('legacy');
    expect((david2.ctx as unknown as { account: string }).account).toBe('legacy');
    expect((mikel.ctx as unknown as { account: string }).account).toBe('mikel');
    david1.release(); david2.release(); mikel.release();
    await contexts.close();
    expect(closed.sort()).toEqual(['legacy', 'mikel']);
  });

  describe('use: el barrido por la adquisición normal', () => {
    function registryOf(current: { generation: number }): AccountRegistry {
      return {
        assertActive(ref: AuthorizedAccount) { if (ref.generation !== current.generation) throw new Error('account_inactive'); },
        findById: (id: string) => ({ id, generation: current.generation, state: 'active' })
      } as unknown as AccountRegistry;
    }

    it('la persona llama mientras el barrido drena su biblioteca: mismo contexto, respuesta normal y nada se cierra', async () => {
      const current = { generation: 1 };
      const { libraries, contexts } = harness({ registry: registryOf(current) });
      const sweepEntered = deferred();
      const sweepMayFinish = deferred();
      const sweeping = contexts.use({ id: 'mikel', generation: 1 }, async (ctx) => {
        sweepEntered.resolve();
        await sweepMayFinish.promise;
        return (ctx as unknown as { account: string }).account;
      });
      await sweepEntered.promise;

      // La persona llega con el barrido en curso: no recibe account_inactive.
      const person = await contexts.acquire(account('mikel'));
      expect((person.ctx as unknown as { account: string }).account).toBe('mikel');
      sweepMayFinish.resolve();
      expect(await sweeping).toBe('mikel');
      await settled();
      // El barrido ha terminado, pero la persona lo sigue usando: ni se cierra ni se retira.
      expect(libraries.opened).toEqual(['mikel']);
      expect(libraries.closed).toEqual([]);
      expect(person.ctx).toBeDefined();
      person.release();
      await contexts.closeIfIdle({ id: 'mikel', generation: 1 });
      expect(libraries.closed).toEqual(['mikel']);
    });

    it('el barrido cuenta como uso: la persona que llega después espera a la misma apertura, sin dos instancias', async () => {
      const { libraries, contexts } = harness({ registry: registryOf({ generation: 1 }) });
      const opening = deferred();
      libraries.beforeOpen = () => opening.promise;
      const sweeping = contexts.use({ id: 'mikel', generation: 1 }, async () => 'ok');
      await settled();
      const person = contexts.acquire(account('mikel'));
      opening.resolve();
      expect(await sweeping).toBe('ok');
      (await person).release();
      expect(libraries.opened).toEqual(['mikel']);
      expect(libraries.overlap).toBe(false);
    });

    it('al terminar cierra lo que abrió, y una generación vieja o una cuenta que no está da account_inactive', async () => {
      const { libraries, contexts } = harness({ registry: registryOf({ generation: 2 }) });
      await expect(contexts.use({ id: 'mikel', generation: 1 }, async () => 'no')).rejects.toThrow('account_inactive');
      expect(libraries.opened).toEqual([]);
      await contexts.use({ id: 'mikel', generation: 2 }, async () => 'ok');
      await settled();
      expect(libraries.closed).toEqual(['mikel']);
    });
  });

  it('una retirada bloquea adquisiciones nuevas y espera el lease vivo', async () => {
    let generation = 1;
    const registry = { assertActive(ref: AuthorizedAccount) {
      if (generation !== ref.generation) throw new Error('account_inactive');
    } } as AccountRegistry;
    let closed = false;
    const contexts = new AccountContexts(registry, async (): Promise<ServeContext> => ({
      ctx: {} as never, instance: {} as never, linked: true, close: async () => { closed = true; }
    }));
    const ref = account('legacy');
    const lease = await contexts.acquire(ref);
    generation = 2;
    const draining = contexts.drainAndClose(ref);
    await expect(contexts.acquire(ref)).rejects.toThrow('account_inactive');
    expect(closed).toBe(false);
    lease.release();
    await draining;
    expect(closed).toBe(true);
  });

  it('vuelve a comprobar la generación justo antes de publicar una respuesta', async () => {
    let generation = 1;
    const registry = { assertActive(ref: AuthorizedAccount) {
      if (generation !== ref.generation) throw new Error('account_inactive');
    } } as AccountRegistry;
    const contexts = new AccountContexts(registry, async (): Promise<ServeContext> => ({
      ctx: { authorize: async () => undefined } as never, instance: {} as never,
      linked: true, close: async () => undefined
    }));
    const lease = await contexts.acquire(account('mikel'));
    generation = 2;
    await expect(lease.ctx.authorize?.()).rejects.toThrow('account_inactive');
    lease.release();
    await contexts.close();
  });

  it('una apertura fallida no deja una entrada que bloquee el reintento de retirada', async () => {
    const contexts = new AccountContexts(activeRegistry, async () => { throw new Error('open_failed'); });
    const ref = account('mikel');
    await expect(contexts.acquire(ref)).rejects.toThrow('open_failed');
    await expect(contexts.drainAndClose(ref)).resolves.toBeUndefined();
    await contexts.close();
  });
});

describe('ciclo de vida sin recuento (D22)', () => {
  it('decenas de cuentas una tras otra entran sin rechazo y a los 120 s no queda ninguna abierta', async () => {
    const { clock, libraries, contexts } = harness();
    const ids = Array.from({ length: 60 }, (_, index) => `cuenta-${index}`);
    for (const id of ids) {
      const lease = await contexts.acquire(account(id));
      lease.release();
    }
    expect(libraries.opened).toEqual(ids);
    expect(libraries.openCount).toBe(ids.length);
    await clock.advance(IDLE_MS - 1);
    expect(libraries.openCount).toBe(ids.length);
    await clock.advance(1);
    expect(libraries.openCount).toBe(0);
    expect(clock.pending).toBe(0);
    expect(libraries.overlap).toBe(false);
    await contexts.close();
  });

  it('una petición nueva reinicia la espera, y tras cerrar se vuelve a abrir', async () => {
    const { clock, libraries, contexts } = harness();
    (await contexts.acquire(account('a'))).release();
    await clock.advance(IDLE_MS - 1);
    (await contexts.acquire(account('a'))).release();
    await clock.advance(IDLE_MS - 1);
    expect(libraries.closed).toEqual([]);
    await clock.advance(1);
    expect(libraries.closed).toEqual(['a']);
    (await contexts.acquire(account('a'))).release();
    expect(libraries.opened).toEqual(['a', 'a']);
    await contexts.close();
    expect(libraries.overlap).toBe(false);
  });

  it('una petición en curso impide cerrar, por larga que sea', async () => {
    const { clock, libraries, contexts } = harness();
    const lease = await contexts.acquire(account('a'));
    await clock.advance(IDLE_MS * 10);
    expect(libraries.closed).toEqual([]);
    lease.release();
    await clock.advance(IDLE_MS);
    expect(libraries.closed).toEqual(['a']);
    await contexts.close();
  });

  it('una herramienta en curso retiene el contexto aunque la respuesta ya terminara', async () => {
    const { clock, libraries, contexts } = harness();
    const lease = await contexts.acquire(account('a'));
    const tool = deferred();
    const call = lease.ctx.trackInvocation!(() => tool.promise);
    lease.release();
    await clock.advance(IDLE_MS * 2);
    expect(libraries.closed).toEqual([]);
    tool.resolve();
    await call;
    await clock.advance(IDLE_MS);
    expect(libraries.closed).toEqual(['a']);
    await contexts.close();
  });

  it('carrera de cierre y apertura: la petición espera al cierre y reabre, sin dos instancias', async () => {
    const { clock, libraries, contexts } = harness();
    (await contexts.acquire(account('a'))).release();
    const closing = deferred();
    libraries.beforeClose = () => closing.promise;
    await clock.advance(IDLE_MS);
    expect(libraries.closed).toEqual([]);
    const reopened = contexts.acquire(account('a'));
    const second = contexts.acquire(account('a'));
    await settled();
    expect(libraries.opened).toEqual(['a']);
    closing.resolve();
    const [first, other] = await Promise.all([reopened, second]);
    expect(libraries.opened).toEqual(['a', 'a']);
    expect(libraries.overlap).toBe(false);
    expect(libraries.openCount).toBe(1);
    first.release(); other.release();
    libraries.beforeClose = null;
    await contexts.close();
    expect(libraries.openCount).toBe(0);
  });

  it('peticiones concurrentes comparten la apertura, y su fallo no impide reintentar', async () => {
    const { libraries, contexts } = harness();
    const opening = deferred();
    let attempts = 0;
    libraries.beforeOpen = async () => {
      attempts += 1;
      await opening.promise;
      if (attempts === 1) throw new Error('disk');
    };
    const requests = [contexts.acquire(account('a')), contexts.acquire(account('a'))];
    opening.resolve();
    await expect(requests[0]).rejects.toThrow('disk');
    await expect(requests[1]).rejects.toThrow('disk');
    expect(attempts).toBe(1);
    (await contexts.acquire(account('a'))).release();
    expect(attempts).toBe(2);
    await contexts.close();
  });

  it('retirada durante una reapertura: la petición falla y no queda nada abierto', async () => {
    let active = true;
    const registry = { assertActive() { if (!active) throw new Error('account_inactive'); } } as unknown as AccountRegistry;
    const { clock, libraries, contexts } = harness({ registry });
    (await contexts.acquire(account('a'))).release();
    await clock.advance(IDLE_MS);
    const opening = deferred();
    libraries.beforeOpen = () => opening.promise;
    const reopening = contexts.acquire(account('a'));
    await settled();
    active = false;
    const draining = contexts.drainAndClose(account('a'));
    opening.resolve();
    await expect(reopening).rejects.toThrow('account_inactive');
    await draining;
    expect(libraries.openCount).toBe(0);
    expect(libraries.overlap).toBe(false);
    await expect(contexts.acquire(account('a'))).rejects.toThrow('account_inactive');
    await contexts.close();
  });

  it('una generación nueva espera a que la vieja termine y abre otra instancia', async () => {
    const { libraries, contexts } = harness();
    const old = await contexts.acquire(account('a', 1));
    const renewed = contexts.acquire(account('a', 2));
    await settled();
    expect(libraries.opened).toEqual(['a']);
    old.release();
    (await renewed).release();
    expect(libraries.opened).toEqual(['a', 'a']);
    expect(libraries.overlap).toBe(false);
    await contexts.close();
  });

  it('una cuenta revocada se cierra al terminar lo que tiene en curso, sin esperar', async () => {
    const { libraries, contexts } = harness();
    let revoked = false;
    libraries.decorate = (context) => ({
      ...context, instance: { get syncRunner() { return { revoked }; } } as never
    });
    const lease = await contexts.acquire(account('a'));
    revoked = true;
    await settled();
    expect(libraries.closed).toEqual([]);
    lease.release();
    await settled();
    expect(libraries.closed).toEqual(['a']);
    await contexts.close();
  });

  it('una cuenta retirada con una petición en curso se cierra al soltarla', async () => {
    let active = true;
    const registry = { assertActive() { if (!active) throw new Error('account_inactive'); } } as unknown as AccountRegistry;
    const { libraries, contexts } = harness({ registry });
    const lease = await contexts.acquire(account('a'));
    active = false;
    lease.release();
    await settled();
    expect(libraries.closed).toEqual(['a']);
    await contexts.close();
  });

  it('un cierre que falla no deja abrir otra instancia mientras siga fallando', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { clock, libraries, contexts } = harness();
      (await contexts.acquire(account('a'))).release();
      libraries.beforeClose = async () => { throw new Error('disk'); };
      await clock.advance(IDLE_MS);
      await expect(contexts.acquire(account('a'))).rejects.toThrow('disk');
      await clock.advance(1_000);
      await expect(contexts.acquire(account('a'))).rejects.toThrow('disk');
      expect(libraries.opened).toEqual(['a']);
      const logged = stderr.mock.calls.flat().join('');
      expect(logged).toContain('contexts.close_failed');
      expect(logged).not.toContain('disk');
    } finally { stderr.mockRestore(); }
  });

  it('un cierre fallido se reintenta con espera creciente y la cuenta vuelve sin reiniciar', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { clock, libraries, contexts } = harness();
      (await contexts.acquire(account('a'))).release();
      (await contexts.acquire(account('b'))).release();
      let failures = 3;
      libraries.beforeClose = async (id) => { if (id === 'a' && failures-- > 0) throw new Error('disk'); };
      await clock.advance(IDLE_MS);
      // Fallo 1; el reintento llega a 1 s, el siguiente a 2 s y el otro a 4 s.
      await expect(contexts.acquire(account('a'))).rejects.toThrow('disk');
      // Otra cuenta no se entera: se abre y se sirve con normalidad.
      (await contexts.acquire(account('b'))).release();
      await clock.advance(999);
      expect(failures).toBe(2);
      await clock.advance(1);
      expect(failures).toBe(1);
      await clock.advance(1_999);
      expect(failures).toBe(1);
      await clock.advance(1);
      expect(failures).toBe(0);
      await clock.advance(4_000);
      expect(libraries.closed).toContain('a');
      const lease = await contexts.acquire(account('a'));
      expect(libraries.opened.filter((id) => id === 'a')).toHaveLength(2);
      expect(libraries.overlap).toBe(false);
      lease.release();
      const logged = stderr.mock.calls.flat().join('');
      expect(logged).toContain('contexts.close_recovered');
      await contexts.close();
    } finally { stderr.mockRestore(); }
  });

  it('un cierre que no se recupera dice contexts.close_stuck cada 10 intentos y sigue reintentando', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { clock, libraries, contexts } = harness();
      (await contexts.acquire(account('a'))).release();
      libraries.beforeClose = async () => { throw new Error('disk'); };
      await clock.advance(IDLE_MS);
      // 1+2+4+8+16 s y después 30 s: el décimo intento cae antes de los 4 minutos.
      await clock.advance(240_000);
      expect(stderr.mock.calls.flat().join('')).toContain('contexts.close_stuck');
      libraries.beforeClose = null;
      await clock.advance(30_000);
      const lease = await contexts.acquire(account('a'));
      expect(libraries.opened.filter((id) => id === 'a')).toHaveLength(2);
      lease.release();
      await contexts.close();
    } finally { stderr.mockRestore(); }
  });

  it('apagar corta las esperas de la cuenta y de sus espacios', async () => {
    const { libraries, contexts } = harness();
    const shutdowns: string[] = [];
    libraries.decorate = (context) => ({
      ...context,
      ctx: { spaces: { lifecycle: spaceControl({ beginShutdown: () => shutdowns.push('space') }) } } as never,
      instance: { beginShutdown: () => shutdowns.push('account') } as never
    });
    const lease = await contexts.acquire(account('a'));
    contexts.beginShutdown();
    expect(shutdowns.sort()).toEqual(['account', 'space']);
    await expect(contexts.acquire(account('b'))).rejects.toThrow('contexts_closed');
    lease.release();
    await contexts.close();
  });
});

function spaceControl(overrides: Partial<SpaceLifecycleControl> = {}): SpaceLifecycleControl {
  return {
    configure() {},
    acquire: async () => { throw new Error('unused'); },
    prepare: async () => [],
    reclaimIdle: async () => undefined,
    beginShutdown() {},
    ...overrides
  };
}

describe('espacios desde la petición', () => {
  it('el lease de un espacio dura lo que la petición que lo usó, no lo que la cuenta', async () => {
    const { libraries, contexts } = harness();
    const released: string[] = [];
    let configured = false;
    const control = spaceControl({
      configure: () => { configured = true; },
      acquire: async (spaceId) => ({ value: { spaceId } as never, release: () => released.push(spaceId) }),
      prepare: async (spaceIds) => spaceIds.map((spaceId) => ({ value: { spaceId } as never, release: () => released.push(`prep-${spaceId}`) }))
    });
    libraries.decorate = (context) => ({
      ...context,
      ctx: { spaces: { lifecycle: control, list: async () => [], resolve: async () => { throw new Error('unused'); } } } as never
    });
    const lease = await contexts.acquire(account('a'));
    expect(configured).toBe(true);
    await lease.prepareSpaces(['s1']);
    const selected = await lease.ctx.spaces!.resolve('s2');
    expect(selected.spaceId).toBe('s2');
    expect(released).toEqual([]);
    const other = await contexts.acquire(account('a'));
    lease.release();
    expect(released.sort()).toEqual(['prep-s1', 's2']);
    other.release();
    await contexts.close();
  });
});

describe('memoria real, no recuento', () => {
  it('por debajo del límite no se cierra nada ni se espera', async () => {
    const { clock, memory, libraries, contexts } = harness();
    memory.usedBytes = 700 * MIB;
    (await contexts.acquire(account('a'))).release();
    (await contexts.acquire(account('b'))).release();
    expect(libraries.closed).toEqual([]);
    expect(clock.pending).toBe(2); // las dos esperas de inactividad, ninguna medición
    await contexts.close();
  });

  it('por encima, cierra antes los contextos sin peticiones en curso y no toca los que tienen', async () => {
    const { memory, libraries, contexts } = harness();
    (await contexts.acquire(account('libre'))).release();
    const busy = await contexts.acquire(account('ocupada'));
    memory.usedBytes = 900 * MIB;
    libraries.beforeClose = async () => { memory.usedBytes = 500 * MIB; };
    (await contexts.acquire(account('nueva'))).release();
    expect(libraries.closed).toEqual(['libre']);
    expect(libraries.opened).toContain('nueva');
    busy.release();
    libraries.beforeClose = null;
    await contexts.close();
  });

  it('no acorta la espera de quien tiene subidas pendientes', async () => {
    const { clock, memory, libraries, contexts } = harness();
    libraries.decorate = (context, id) => ({
      ...context,
      instance: { status: async () => ({ pendingUpload: id === 'pendiente' ? 3 : 0, revoked: false }) } as never
    });
    (await contexts.acquire(account('pendiente'))).release();
    memory.usedBytes = 900 * MIB;
    const failure = contexts.acquire(account('nueva')).catch((error: unknown) => error);
    await clock.advance(WAIT_MS);
    expect(await failure).toMatchObject({ reason: 'capacity_wait_timeout' });
    expect(libraries.closed).toEqual([]);
    await contexts.close();
  });

  it('si no basta, espera y entra en cuanto baja; quien ya tiene su contexto no espera', async () => {
    const { clock, memory, libraries, contexts } = harness();
    const holder = await contexts.acquire(account('a'));
    memory.usedBytes = 900 * MIB;
    const waiting = contexts.acquire(account('b'));
    let entered = false;
    void waiting.then(() => { entered = true; });
    await clock.advance(WAIT_MS - 1000);
    expect(entered).toBe(false);
    expect(libraries.opened).toEqual(['a']);
    const again = await contexts.acquire(account('a'));
    again.release();
    memory.usedBytes = 100 * MIB;
    await clock.advance(500);
    expect(entered).toBe(true);
    (await waiting).release();
    holder.release();
    await contexts.close();
  });

  it('al agotar la espera, un error con motivo y Retry-After; las siguientes abren normal', async () => {
    const { clock, memory, libraries, contexts } = harness();
    const holder = await contexts.acquire(account('a'));
    memory.usedBytes = 900 * MIB;
    const waiting = contexts.acquire(account('b'));
    const failure = waiting.catch((error: unknown) => error);
    await clock.advance(WAIT_MS);
    const error = await failure as ContextUnavailableError;
    expect(error).toBeInstanceOf(ContextUnavailableError);
    expect(error.reason).toBe('capacity_wait_timeout');
    expect(error.retryAfterSeconds).toBe(20);
    expect(libraries.opened).toEqual(['a']);
    memory.usedBytes = 100 * MIB;
    (await contexts.acquire(account('b'))).release();
    holder.release();
    await contexts.close();
  });

  it('las aperturas esperan en orden de llegada, sin distinguir quién conectó antes', async () => {
    const clock = new FakeClock();
    const memory = { usedBytes: 900 * MIB, limitBytes: 1000 * MIB };
    const gate = new CapacityGate({ readMemory: () => memory, highWater: { ratio: 0.8 }, waitMs: WAIT_MS,
      clock, reclaim: async () => undefined, reserveBytes: 100 * MIB });
    const order: string[] = [];
    const first = gate.admit().then((ticket) => { order.push('primero'); return ticket; });
    const second = gate.admit().then((ticket) => { order.push('segundo'); return ticket; });
    await settled();
    memory.usedBytes = 750 * MIB; // quedan 50 MiB: entra una apertura y aparta 100, no dos
    await clock.advance(500);
    expect(order).toEqual(['primero']);
    const ticket = await first;
    memory.usedBytes = 600 * MIB;
    ticket.done();
    await settled();
    expect(order).toEqual(['primero', 'segundo']);
    (await second).done();
    expect(clock.pending).toBe(0);
  });

  it('una ráfaga no sobrepasa el límite por lo que aún está abriendo', async () => {
    const { clock, memory, libraries, contexts } = harness();
    memory.usedBytes = 790 * MIB;
    const opening = deferred();
    const started: string[] = [];
    libraries.beforeOpen = async (id) => {
      started.push(id);
      await opening.promise;
    };
    const first = contexts.acquire(account('a'));
    const second = contexts.acquire(account('b'));
    await settled();
    expect(started).toEqual(['a']);
    // Lo apartado se suelta cuando la lectura ya ve lo abierto.
    memory.usedBytes = 850 * MIB;
    opening.resolve();
    (await first).release();
    expect(started).toEqual(['a']);
    memory.usedBytes = 100 * MIB;
    await clock.advance(500);
    (await second).release();
    expect(libraries.opened).toEqual(['a', 'b']);
    await contexts.close();
  });

  it('otro proceso con writer.lock: espera y responde lock_held; si lo suelta, abre', async () => {
    const lockHeld = Object.assign(new Error('writer_lock_held'), { code: 'writer_lock_held' });
    let held = true;
    const clock = new FakeClock();
    const contexts = new AccountContexts(activeRegistry, async (): Promise<ServeContext> => {
      if (held) throw lockHeld;
      return { ctx: {} as never, instance: {} as never, linked: true, close: async () => undefined };
    }, { idleMs: IDLE_MS, openWaitMs: WAIT_MS, clock, readMemory: () => ({ usedBytes: 0, limitBytes: MIB }) });
    const failing = contexts.acquire(account('a')).catch((error: unknown) => error);
    await clock.advance(WAIT_MS);
    expect(await failing).toMatchObject({ reason: 'lock_held', retryAfterSeconds: 20 });
    const retrying = contexts.acquire(account('a'));
    await clock.advance(2000);
    held = false;
    await clock.advance(2000);
    (await retrying).release();
    await contexts.close();
  });

  it.each(['other-process', 'this-boot'] as const)(
    'writer.lock clasificado %s: no intenta abrir, espera y responde lock_held; libre, abre', async (owner) => {
      const lock: { owner: WriterLockOwner } = { owner };
      const { clock, libraries, contexts } = harness({ classifyLock: () => lock.owner });
      const failing = contexts.acquire(account('a')).catch((error: unknown) => error);
      await clock.advance(WAIT_MS);
      expect(await failing).toMatchObject({ reason: 'lock_held', retryAfterSeconds: 20 });
      expect(libraries.opened).toEqual([]);
      const retrying = contexts.acquire(account('a'));
      await clock.advance(2000);
      expect(libraries.opened).toEqual([]);
      lock.owner = 'stale';
      await clock.advance(2000);
      (await retrying).release();
      expect(libraries.opened).toEqual(['a']);
      await contexts.close();
    }
  );

  it('esperando un writer.lock no aparta memoria: las demás cuentas abren', async () => {
    const { memory, libraries, contexts } = harness({
      classifyLock: (entry) => (entry.id === 'bloqueada' ? 'other-process' : 'none')
    });
    memory.usedBytes = 790 * MIB; // solo cabe una apertura a la vez
    const failure = contexts.acquire(account('bloqueada')).catch((error: unknown) => error);
    await settled();
    (await contexts.acquire(account('b'))).release();
    expect(libraries.opened).toEqual(['b']);
    contexts.beginShutdown();
    expect(await failure).toMatchObject({ message: 'contexts_closed' });
    await contexts.close();
  });

  it('el apagado corta a quien espera memoria', async () => {
    const { memory, contexts } = harness();
    memory.usedBytes = 900 * MIB;
    const waiting = contexts.acquire(account('a'));
    await settled();
    contexts.beginShutdown();
    await expect(waiting).rejects.toThrow('contexts_closed');
    await contexts.close();
  });
});

describe('lectura de memoria', () => {
  const files = (entries: Record<string, string>) => (path: string): string | null => entries[path] ?? null;

  it('cgroup v2 descuenta la caché de disco recuperable', () => {
    const reading = readMemoryUsage(files({
      '/sys/fs/cgroup/memory.current': '400000000\n',
      '/sys/fs/cgroup/memory.max': '536870912\n',
      '/sys/fs/cgroup/memory.stat': 'anon 90000000\ninactive_file 300000000\nactive_file 10\n'
    }), () => 1);
    expect(reading).toEqual({ usedBytes: 100000000, limitBytes: 536870912 });
  });

  it('cgroup v1 también, y un límite enorme se trata como sin límite', () => {
    const reading = readMemoryUsage(files({
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': '500\n',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n',
      '/sys/fs/cgroup/memory/memory.stat': 'total_inactive_file 100\n'
    }), () => 1);
    expect(reading.usedBytes).toBe(400);
    expect(reading.limitBytes).toBeLessThan(2 ** 60);
    expect(reading.limitBytes).toBeGreaterThan(0);
  });

  it('cgroup v2 sin límite y sin cgroup usan el límite del proceso', () => {
    const noLimit = readMemoryUsage(files({
      '/sys/fs/cgroup/memory.current': '500\n', '/sys/fs/cgroup/memory.max': 'max\n'
    }), () => 1);
    expect(noLimit.usedBytes).toBe(500);
    expect(noLimit.limitBytes).toBeGreaterThan(0);
    const bare = readMemoryUsage(files({}), () => 1234);
    expect(bare.usedBytes).toBe(1234);
    expect(bare.limitBytes).toBeGreaterThan(0);
  });

  it('un medidor roto no niega el acceso', async () => {
    const gate = new CapacityGate({ readMemory: () => { throw new Error('eio'); }, highWater: { ratio: 0.8 },
      waitMs: WAIT_MS, clock: new FakeClock(), reclaim: async () => undefined });
    (await gate.admit()).done();
  });

  it('lee y valida la configuración del entorno', () => {
    expect(readCapacityConfig({})).toEqual({ idleMs: 120_000, openWaitMs: 20_000, highWater: { ratio: 0.8 } });
    expect(readCapacityConfig({ HEBRA_MCP_CONTEXT_IDLE_MS: '5000', HEBRA_MCP_OPEN_WAIT_MS: '0',
      HEBRA_MCP_MEMORY_HIGH_WATER: '75%' })).toEqual({ idleMs: 5000, openWaitMs: 0, highWater: { ratio: 0.75 } });
    expect(readCapacityConfig({ HEBRA_MCP_MEMORY_HIGH_WATER: '0.5' }).highWater).toEqual({ ratio: 0.5 });
    expect(readCapacityConfig({ HEBRA_MCP_MEMORY_HIGH_WATER: '400000000' }).highWater).toEqual({ bytes: 400000000 });
    for (const bad of ['-1', 'mucho', '0%', '101%', '0']) {
      expect(() => readCapacityConfig({ HEBRA_MCP_MEMORY_HIGH_WATER: bad })).toThrow('HEBRA_MCP_MEMORY_HIGH_WATER');
    }
    expect(() => readCapacityConfig({ HEBRA_MCP_CONTEXT_IDLE_MS: 'x' })).toThrow('HEBRA_MCP_CONTEXT_IDLE_MS');
  });
});

describe('/mcp sobre AccountContexts', () => {
  let server: Server | null = null;
  let stderr: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = null;
    stderr?.mockRestore();
    stderr = null;
  });

  async function serve(contexts: AccountContexts): Promise<{ post(body: object, signal?: AbortSignal): Promise<Response>; logged(): string }> {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const app = createHttpApp({
      contexts, version: 'test', config: httpConfigFor('http://127.0.0.1', 0),
      auth: { install() {}, requireAuth: (_req, _res, next) => next(), account: () => account('sub-secreto') }
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    return {
      post: (body, signal) => fetch(url, { method: 'POST', body: JSON.stringify(body), signal,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }),
      logged: () => stderr!.mock.calls.flat().join('')
    };
  }

  const LIST_TOOLS = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const STATUS_CALL = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hebra_status', arguments: {} } };

  it('capacity_wait_timeout: 503 con Retry-After y el motivo en el log, sin datos personales', async () => {
    const { clock, memory, contexts } = harness();
    memory.usedBytes = 900 * MIB;
    const { post, logged } = await serve(contexts);
    const response = post(LIST_TOOLS);
    await vi.waitFor(() => expect(clock.pending).toBeGreaterThan(0));
    await clock.advance(WAIT_MS);
    const res = await response;
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('20');
    expect(logged()).toContain('"event":"mcp.unavailable","reason":"capacity_wait_timeout"');
    expect(logged()).not.toContain('sub-secreto');
    await contexts.close();
  });

  it('open_failed: 503 con Retry-After, sin el mensaje del error', async () => {
    const contexts = new AccountContexts(activeRegistry, async () => { throw new Error('ruta/privada/titulo'); },
      { readMemory: () => ({ usedBytes: 0, limitBytes: MIB }) });
    const { post, logged } = await serve(contexts);
    const res = await post(LIST_TOOLS);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(logged()).toContain('"reason":"open_failed"');
    expect(logged()).not.toContain('titulo');
    await contexts.close();
  });

  it('lock_held: 503 con su motivo', async () => {
    const clock = new FakeClock();
    const contexts = new AccountContexts(activeRegistry, async () => {
      throw Object.assign(new Error('writer_lock_held'), { code: 'writer_lock_held' });
    }, { openWaitMs: 0, clock, readMemory: () => ({ usedBytes: 0, limitBytes: MIB }) });
    const { post, logged } = await serve(contexts);
    const res = await post(LIST_TOOLS);
    expect(res.status).toBe(503);
    expect(logged()).toContain('"reason":"lock_held"');
    await contexts.close();
  });

  it('una cuenta inactiva sigue dando 401, no 503', async () => {
    const registry = { assertActive() { throw new Error('account_inactive'); } } as unknown as AccountRegistry;
    const { contexts } = harness({ registry });
    const { post, logged } = await serve(contexts);
    expect((await post(LIST_TOOLS)).status).toBe(401);
    expect(logged()).not.toContain('mcp.unavailable');
    await contexts.close();
  });

  it('la respuesta terminada suelta el contexto, que se cierra por inactividad', async () => {
    const { clock, libraries, contexts } = harness();
    libraries.decorate = (context) => ({
      ...context, ctx: { privacyConfig: { privateFolders: [], privateTags: [] } } as never
    });
    const { post } = await serve(contexts);
    const res = await post(LIST_TOOLS);
    expect(res.status).toBe(200);
    await res.text();
    await vi.waitFor(() => expect(clock.pending).toBe(1));
    await clock.advance(IDLE_MS);
    expect(libraries.closed).toEqual(['sub-secreto']);
    await contexts.close();
  });

  it('el cliente se desconecta con una herramienta en curso: se retiene hasta que acabe, y luego se cierra', async () => {
    const { clock, libraries, contexts } = harness();
    const entered = deferred();
    const tool = deferred();
    libraries.decorate = (context) => ({
      ...context,
      ctx: { privacyConfigSource: { current: async () => {
        entered.resolve();
        await tool.promise;
        throw new Error('fin');
      } }, status: { getStatus: () => ({}) } } as never
    });
    const { post } = await serve(contexts);
    const closedOnServer = new Promise<void>((resolve) => {
      server!.on('request', (_req, res) => res.once('close', () => resolve()));
    });
    const abort = new AbortController();
    const request = post(STATUS_CALL, abort.signal).catch(() => null);
    await entered.promise;
    abort.abort();
    await request;
    await closedOnServer;
    await settled();
    await clock.advance(IDLE_MS * 2);
    expect(libraries.closed).toEqual([]);
    tool.resolve();
    await settled();
    await clock.advance(IDLE_MS);
    expect(libraries.closed).toEqual(['sub-secreto']);
    await contexts.close();
  });

  it('una apertura de espacio sin memoria también responde 503 con su motivo', async () => {
    const { libraries, contexts } = harness();
    libraries.decorate = (context) => ({
      ...context,
      ctx: { spaces: { lifecycle: spaceControl({
        prepare: async () => { throw new ContextUnavailableError('capacity_wait_timeout', 20); }
      }), list: async () => [], resolve: async () => { throw new Error('unused'); } } } as never
    });
    const { post, logged } = await serve(contexts);
    const res = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'hebra_status', arguments: { space: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } } });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('20');
    expect(logged()).toContain('"reason":"capacity_wait_timeout"');
    expect(logged()).not.toContain('aaaaaaaa');
    await contexts.close();
  });
});

describe('marca de revocación compartida (bindPairingRevocation)', () => {
  const statusOf = (revoked: boolean) => ({ getStatus: () => ({ linked: true, lastSyncAt: null, lastSyncOutcome: null,
    pendingUpload: 0, errorsByCode: {}, writer: 'this' as const, revoked }) });

  /** Lo que hace `startServeHttp` por cuenta: abrir con un runner propio y atar la marca. */
  function revocableHarness(pairing: PairingRevocation) {
    const runners = new Map<string, { revoked: boolean }>();
    const libraries = new FakeLibraries();
    libraries.decorate = (context, id) => {
      const runner = { revoked: false };
      runners.set(id, runner);
      return bindPairingRevocation({
        ...context, ctx: { status: statusOf(false) } as never,
        instance: { beginShutdown() {}, syncRunner: runner } as never
      }, pairing, `${id}-credential`);
    };
    const clock = new FakeClock();
    const contexts = new AccountContexts(activeRegistry, libraries.open, {
      idleMs: IDLE_MS, openWaitMs: WAIT_MS, clock, readMemory: () => ({ usedBytes: 0, limitBytes: 1000 * MIB }) });
    const statusNow = async (id: string, generation = 1) => {
      const lease = await contexts.acquire(account(id, generation));
      try { return await lease.ctx.status.getStatus(); } finally { lease.release(); }
    };
    return { runners, libraries, clock, contexts, statusNow };
  }

  it('account-dir: el relé revoca, la cuenta se cierra por inactividad, se reabre y sigue revocada', async () => {
    const pairing = new PairingRevocation();
    const { runners, libraries, clock, contexts, statusNow } = revocableHarness(pairing);
    expect((await statusNow('mikel')).revoked).toBe(false);
    runners.get('mikel')!.revoked = true;
    expect((await statusNow('mikel')).revoked).toBe(true);
    await clock.advance(IDLE_MS);
    expect(libraries.closed).toEqual(['mikel']);
    // El runner nuevo no sabe nada: la marca viene de la credencial.
    const reopened = await statusNow('mikel');
    expect(libraries.opened).toEqual(['mikel', 'mikel']);
    expect(reopened.revoked).toBe(true);
    expect(reopened.revokedReason).toBe(PAIRING_REVOKED_REMOTE_REASON);
    await contexts.close();
  });

  it('una credencial renovada deja de estar revocada; con el mismo id, tras clear', async () => {
    const pairing = new PairingRevocation();
    const { runners, clock, contexts, statusNow } = revocableHarness(pairing);
    await statusNow('mikel');
    runners.get('mikel')!.revoked = true;
    await statusNow('mikel');
    await clock.advance(IDLE_MS);
    expect(pairing.isRevoked('mikel-credential')).toBe(true);
    // La renovación con la misma bóveda puede conservar el id: `commitRenewal` limpia la marca.
    pairing.clear('mikel-credential');
    expect((await statusNow('mikel', 2)).revoked).toBe(false);
    await contexts.close();
  });

  it('la revocación de una cuenta no marca a otra', async () => {
    const pairing = new PairingRevocation();
    const { runners, clock, contexts, statusNow } = revocableHarness(pairing);
    await statusNow('mikel');
    await statusNow('ane');
    runners.get('mikel')!.revoked = true;
    await clock.advance(IDLE_MS);
    expect((await statusNow('ane')).revoked).toBe(false);
    expect((await statusNow('mikel')).revoked).toBe(true);
    // También para legacy-root, que usa la misma marca.
    expect((await statusNow('legacy')).revoked).toBe(false);
    await contexts.close();
  });

  it('uno vigente no se marca revocado al cerrar', async () => {
    const pairing = new PairingRevocation();
    const { clock, contexts, statusNow } = revocableHarness(pairing);
    await statusNow('mikel');
    await clock.advance(IDLE_MS);
    expect(pairing.isRevoked('mikel-credential')).toBe(false);
    await contexts.close();
  });

  it('hebra_status dice el motivo del conector remoto, y en stdio el de siempre', async () => {
    const pairing = new PairingRevocation();
    const { runners, contexts } = revocableHarness(pairing);
    const lease = await contexts.acquire(account('mikel'));
    runners.get('mikel')!.revoked = true;
    const remote = await runStatus({ status: lease.ctx.status, privacyConfig: { privateFolders: [], privateTags: [] } } as never);
    expect(remote.revokedReason).toBe(PAIRING_REVOKED_REMOTE_REASON);
    expect(remote.revokedReason).not.toContain('hebra-mcp pair');
    lease.release();
    const stdio = await runStatus({ status: statusOf(true), privacyConfig: { privateFolders: [], privateTags: [] } } as never);
    expect(stdio.revokedReason).toContain('hebra-mcp pair');
    await contexts.close();
  });
});
