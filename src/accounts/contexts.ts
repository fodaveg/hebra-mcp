import { logEvent } from '../log/logger';
import type { WriterLockOwner } from '../lock';
import type { ServerContext, SpaceLease, SpaceLifecycleControl } from '../server/context';
import type { ServeContext } from '../server/serve';
import {
  CapacityGate,
  ContextUnavailableError,
  DEFAULT_CONTEXT_IDLE_MS,
  DEFAULT_HIGH_WATER,
  DEFAULT_OPEN_WAIT_MS,
  readMemoryUsage,
  type HighWater,
  type MemoryReader
} from './capacity';
import { realClock, ResourceLifecycle, type Clock } from './lifecycle';
import type { AccountRef, AuthorizedAccount } from './types';
import type { AccountRegistry } from './registry';

export interface AccountContextLease {
  ctx: ServerContext;
  /**
   * Abre de antemano los espacios que pide la petición y los retiene hasta soltarla. Es lo
   * que permite responder 503 a una apertura sin memoria (`ContextUnavailableError`): una
   * vez dentro de la herramienta, ya solo cabe un error de herramienta. No concede nada:
   * la herramienta sigue validando el catálogo en cada invocación.
   */
  prepareSpaces(spaceIds: readonly string[]): Promise<void>;
  /** La respuesta terminó. El lease dura hasta que acabe la última herramienta en curso. */
  release(): void;
}

type OpenAccount = (account: AuthorizedAccount) => Promise<ServeContext>;

export interface AccountContextsOptions {
  idleMs?: number;
  openWaitMs?: number;
  highWater?: HighWater;
  /** Tests: la lectura de memoria y el reloj, para probar sin esperas reales. */
  readMemory?: MemoryReader;
  clock?: Clock;
  /** Quién tiene el `writer.lock` de la cuenta, antes de abrir (`classifyWriterLock`). */
  classifyLock?(account: AuthorizedAccount): WriterLockOwner;
}

/** Cada cuánto se reintenta una apertura cuyo `writer.lock` tiene otro proceso vivo. */
const LOCK_RETRY_MS = 2_000;

interface Entry {
  account: AuthorizedAccount;
  life: ResourceLifecycle<ServeContext>;
}

/**
 * El uso de una petición HTTP: su lease de cuenta y los de los espacios que toque. Una
 * herramienta sigue corriendo aunque el cliente se desconecte, así que el fin de la respuesta
 * no basta para soltarlos: hasta que no acaba la última, la instancia no se puede cerrar.
 */
class RequestUse {
  private invocations = 0;
  private released = false;
  private finished = false;
  private readonly spaceLeases: SpaceLease[] = [];

  constructor(private readonly finish: () => void) {}

  async track<T>(run: () => Promise<T>): Promise<T> {
    if (this.finished) throw new Error('request_closed');
    this.invocations += 1;
    try {
      return await run();
    } finally {
      this.invocations -= 1;
      this.maybeFinish();
    }
  }

  hold(lease: SpaceLease): ServerContext {
    if (this.finished) {
      lease.release();
      throw new Error('request_closed');
    }
    this.spaceLeases.push(lease);
    return lease.value;
  }

  release(): void {
    this.released = true;
    this.maybeFinish();
  }

  private maybeFinish(): void {
    if (this.finished || !this.released || this.invocations > 0) return;
    this.finished = true;
    for (const lease of this.spaceLeases.splice(0)) lease.release();
    this.finish();
  }
}

function guardedContext(
  ctx: ServerContext,
  registry: AccountRegistry,
  account: AuthorizedAccount,
  use?: RequestUse
): ServerContext {
  const accountActive = async (): Promise<void> => { registry.assertActive(account); };
  const authorize = async (): Promise<void> => {
    await accountActive();
    await ctx.authorize?.();
    await accountActive();
  };
  const lifecycle = ctx.spaces?.lifecycle;
  const spaces = ctx.spaces ? {
    list: async () => {
      await accountActive();
      const result = await ctx.spaces!.list();
      await accountActive();
      return result;
    },
    resolve: async (spaceId: string) => {
      await accountActive();
      const selected = use && lifecycle
        ? use.hold(await lifecycle.acquire(spaceId))
        : await ctx.spaces!.resolve(spaceId);
      await accountActive();
      return guardedContext(selected, registry, account);
    }
  } : undefined;
  return { ...ctx, spaces, authorize, ...(use ? { trackInvocation: <T>(run: () => Promise<T>) => use.track(run) } : {}) };
}

/** Lo que aún tiene que subir, salvo que la credencial esté revocada y no pueda subir nunca. */
async function hasPendingUploads(instance: ServeContext['instance']): Promise<boolean> {
  try {
    const status = await instance.status();
    return status.pendingUpload > 0 && !status.revoked;
  } catch {
    return false;
  }
}

/**
 * Una apertura compartida por cuenta y ningún máximo de cuentas: cada contexto se abre porque
 * llega una petición que lo usa y se cierra porque su uso terminó (SPEC.md §12.10, D22). La
 * capacidad la regula la memoria real (`CapacityGate`). Una retirada impide adquirir y espera
 * los leases vivos.
 */
export class AccountContexts {
  private readonly entries = new Map<string, Entry>();
  private readonly idleMs: number;
  private readonly openWaitMs: number;
  private readonly clock: Clock;
  private readonly gate: CapacityGate;
  private readonly classifyLock?: (account: AuthorizedAccount) => WriterLockOwner;
  private closed = false;

  constructor(
    private readonly registry: AccountRegistry,
    private readonly open: OpenAccount,
    options: AccountContextsOptions = {}
  ) {
    this.idleMs = options.idleMs ?? DEFAULT_CONTEXT_IDLE_MS;
    this.openWaitMs = options.openWaitMs ?? DEFAULT_OPEN_WAIT_MS;
    this.clock = options.clock ?? realClock;
    this.classifyLock = options.classifyLock;
    this.gate = new CapacityGate({
      readMemory: options.readMemory ?? (() => readMemoryUsage()),
      highWater: options.highWater ?? DEFAULT_HIGH_WATER,
      waitMs: this.openWaitMs,
      clock: this.clock,
      reclaim: () => this.reclaim()
    });
  }

  async acquire(account: AuthorizedAccount): Promise<AccountContextLease> {
    for (;;) {
      if (this.closed) throw new Error('contexts_closed');
      this.registry.assertActive(account);
      const current = this.entries.get(account.id);
      if (current && current.account.generation !== account.generation) {
        // Otra generación de la misma cuenta usa el mismo directorio: primero se cierra la
        // vieja, al terminar lo suyo, y después se abre esta.
        await current.life.retire();
        if (this.entries.get(account.id) === current) this.entries.delete(account.id);
        continue;
      }
      const entry = current ?? this.createEntry(account);
      const lease = await entry.life.acquire();
      try {
        this.registry.assertActive(account);
      } catch (error) {
        lease.release();
        throw error;
      }
      const use = new RequestUse(() => lease.release());
      const lifecycle = lease.value.ctx.spaces?.lifecycle;
      return {
        ctx: guardedContext(lease.value.ctx, this.registry, account, use),
        prepareSpaces: async (spaceIds) => {
          if (!lifecycle) return;
          for (const spaceId of spaceIds) {
            const prepared = await lifecycle.prepare(spaceId);
            if (prepared) use.hold(prepared);
          }
        },
        release: () => use.release()
      };
    }
  }

  /**
   * Da `fn` con el contexto de la cuenta por la misma adquisición que una petición (el barrido de
   * lo pendiente, D22): comparte el contexto con quien ya lo tenga abierto, cuenta como uso mientras
   * dura y, al soltarlo, lo cierra si nadie más lo usa. No retira nada: la persona que llama
   * mientras tanto recibe respuesta normal.
   */
  async use<T>(ref: AccountRef, fn: (ctx: ServerContext) => Promise<T>): Promise<T> {
    const account = this.registry.findById(ref.id);
    if (!account || account.generation !== ref.generation) throw new Error('account_inactive');
    const lease = await this.acquire(account);
    try {
      return await fn(lease.ctx);
    } finally {
      lease.release();
      await this.closeIfIdle(ref).catch(() => undefined);
    }
  }

  /**
   * Cierra ya el contexto de la cuenta si nadie lo está usando, sin esperar a la inactividad y
   * sin retirarlo: quien llegue después lo abre de nuevo. Es lo que usa el barrido al terminar,
   * para no tener abierta una biblioteca que nadie pidió.
   */
  async closeIfIdle(ref: AccountRef): Promise<void> {
    const entry = this.entries.get(ref.id);
    if (!entry || entry.account.generation !== ref.generation) return;
    await entry.life.closeIfIdle();
  }

  async drainAndClose(ref: AccountRef): Promise<void> {
    const entry = this.entries.get(ref.id);
    if (!entry || entry.account.generation > ref.generation) return;
    await entry.life.retire();
    if (this.entries.get(ref.id) === entry) this.entries.delete(ref.id);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.gate.shutdown();
    await Promise.all([...this.entries.values()].map((entry) => entry.life.retire()));
    this.entries.clear();
  }

  beginShutdown(): void {
    this.closed = true;
    this.gate.shutdown();
    for (const entry of this.entries.values()) {
      const opened = entry.life.peek();
      if (opened) this.shutDownOpened(opened);
      // Lo que aún abre (quizá esperando un `writer.lock`) ya no tiene a quién responder.
      else if (entry.life.state === 'abriendo') void entry.life.retire().catch(() => undefined);
    }
  }

  private shutDownOpened(opened: ServeContext): void {
    opened.instance.beginShutdown();
    opened.ctx.spaces?.lifecycle?.beginShutdown();
  }

  private createEntry(account: AuthorizedAccount): Entry {
    const entry: Entry = {
      account,
      life: new ResourceLifecycle<ServeContext>({
        clock: this.clock,
        idleMs: () => this.idleMs,
        open: (signal) => this.openAccount(account, signal),
        close: (opened) => opened.close(),
        retiredError: () => new Error(this.closed ? 'contexts_closed' : 'account_inactive'),
        closeAfterUse: (opened) => !this.isActive(account) || opened.instance.syncRunner?.revoked === true,
        onDisposable: () => {
          if (this.entries.get(account.id) === entry) this.entries.delete(account.id);
          this.gate.recheck();
        },
        onCloseFailed: (error) => {
          logEvent({ event: 'contexts.close_failed', resource: 'account',
            error: error instanceof Error ? error.name : 'unknown' });
        }
      })
    };
    this.entries.set(account.id, entry);
    return entry;
  }

  private isActive(account: AuthorizedAccount): boolean {
    try {
      this.registry.assertActive(account);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `writer.lock` de otro (una orden por `compose exec`) o de algo de este arranque que no es
   * esta máquina de estados: espera como una apertura sin memoria, y al agotar el plazo
   * responde su propio motivo. Se clasifica antes de abrir porque, con el bloqueo tomado y sin
   * `library.sqlite`, la apertura falla como lector con otro error. Mientras espera el bloqueo
   * no aparta memoria: el turno de admisión solo cubre cada intento de abrir.
   */
  private async openAccount(account: AuthorizedAccount, signal: AbortSignal): Promise<ServeContext> {
    const deadline = this.clock.now() + this.openWaitMs;
    const waitForLock = async (): Promise<void> => {
      if (this.clock.now() >= deadline) {
        throw new ContextUnavailableError('lock_held', this.gate.retryAfterSeconds);
      }
      await this.sleep(LOCK_RETRY_MS, signal);
    };
    for (;;) {
      if (signal.aborted) throw signal.reason;
      this.registry.assertActive(account);
      const owner = this.classifyLock?.(account) ?? 'none';
      if (owner === 'this-boot' || owner === 'other-process') {
        await waitForLock();
        continue;
      }
      const ticket = await this.gate.admit(signal);
      try {
        this.registry.assertActive(account);
        const opened = await this.open(account);
        this.prepareOpened(opened);
        return opened;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'writer_lock_held') throw error;
      } finally {
        ticket.done();
      }
      await waitForLock();
    }
  }

  private prepareOpened(opened: ServeContext): void {
    const lifecycle: SpaceLifecycleControl | undefined = opened.ctx.spaces?.lifecycle;
    lifecycle?.configure({
      idleMs: this.idleMs,
      clock: this.clock,
      admit: (signal) => this.gate.admit(signal),
      onClosed: () => this.gate.recheck()
    });
    if (this.closed) this.shutDownOpened(opened);
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancel = this.clock.setTimer(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        cancel();
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Con la memoria por encima del límite, cierra ya lo que no tiene peticiones en curso ni
   * subidas pendientes, aunque no haya agotado su espera: solo la acorta. No espera a que
   * terminen los cierres (un relé colgado los retrasa); los mira la siguiente medición.
   */
  private async reclaim(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map(async (entry) => {
      const opened = entry.life.peek();
      if (!opened) return;
      if (entry.life.idle && !(await hasPendingUploads(opened.instance))) {
        void entry.life.closeIfIdle().catch(() => undefined);
      } else {
        await opened.ctx.spaces?.lifecycle?.reclaimIdle();
      }
    }));
  }
}
