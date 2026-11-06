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
  requestReserveBytes,
  type AdmissionTicket,
  type HighWater,
  type MemoryReader
} from './capacity';
import { realClock, ResourceLifecycle, WAIT_BACKSTOP_MARGIN_MS, type Clock } from './lifecycle';
import { RemoteStatusSource } from '../status/pairing-revocation';
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
  prepareSpaces(spaceIds: readonly string[], shouldStop?: () => boolean): Promise<void>;
  /**
   * Antes de llegar a las herramientas, con las llamadas de la petición (una entrada por llamada
   * con su destino, `'personal'` o el `spaceId`): guarda `signal` para las esperas de cada
   * llamada y, si hay alguna, aparta ya la memoria de UNA (`requestReserveBytes()`), en el turno
   * de la cuenta. Así una petición que no cabe recibe 503 con `Retry-After` antes de empezar.
   * Esa reserva la usa la primera herramienta que se ejecute; cada una de las demás aparta la
   * suya al empezar (`trackInvocation`) y la suelta al terminar, también si lanza. Lo que nadie
   * usó se suelta con la petición. Al agotar la espera,
   * `ContextUnavailableError('capacity_wait_timeout')`; con `signal` abortado, sale de la cola.
   */
  admitCalls(targets: readonly string[], signal?: AbortSignal): Promise<void>;
  /** La respuesta terminó. El lease dura hasta que acabe la última herramienta en curso. */
  release(): void;
}

/** El destino de una llamada sin `space`, o con `space: "personal"`. */
export const PERSONAL_TARGET = 'personal';

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

/** Aparta la memoria de una llamada en el turno de su cuenta. */
type AdmitCall = (signal?: AbortSignal) => Promise<AdmissionTicket>;

/**
 * El uso de una petición HTTP: su lease de cuenta, los de los espacios que toque y la memoria
 * de cada llamada en curso. Una herramienta sigue corriendo aunque el cliente se desconecte,
 * así que el fin de la respuesta no basta para soltarlos: hasta que no acaba la última, la
 * instancia no se puede cerrar. La memoria va por llamada: cada una la aparta al empezar y la
 * suelta al terminar (SPEC.md §12.10).
 */
class RequestUse {
  private invocations = 0;
  private released = false;
  private finished = false;
  private signal: AbortSignal | undefined;
  private readonly spaceLeases: SpaceLease[] = [];
  /** Reservas apartadas antes de llegar a las herramientas (`admitCalls`), aún sin herramienta. */
  private readonly prepaid: AdmissionTicket[] = [];

  constructor(
    private readonly finish: () => void,
    private readonly admitCall: AdmitCall
  ) {}

  /**
   * Una llamada de herramienta: cuenta como uso desde que pide turno, aparta su memoria (la ya
   * apartada por `admitCalls`, o espera la suya) y la suelta al terminar, bien o mal. Si el
   * cliente se va mientras espera, sale de la cola sin apartar y la llamada no se ejecuta.
   */
  async track<T>(run: () => Promise<T>): Promise<T> {
    if (this.finished) throw new Error('request_closed');
    this.invocations += 1;
    let ticket: AdmissionTicket | undefined;
    try {
      ticket = this.prepaid.shift();
      if (!ticket) ticket = await this.admitWithLog();
      return await run();
    } finally {
      ticket?.done();
      this.invocations -= 1;
      this.maybeFinish();
    }
  }

  /** Lo que guarda `admitCalls`: la señal de corte del cliente para las esperas de cada llamada. */
  watch(signal: AbortSignal | undefined): void {
    this.signal = signal;
  }

  /** La reserva de una llamada antes de llegar a las herramientas: la usa la primera que corra. */
  async prepay(): Promise<void> {
    const ticket = await this.admitCall(this.signal);
    if (this.finished) {
      ticket.done();
      throw new Error('request_closed');
    }
    this.prepaid.push(ticket);
  }

  /**
   * Una llamada que no consigue turno dentro de una petición ya respondida con 200 no puede ser
   * un 503: la herramienta falla con el motivo como texto (el SDK lo convierte en `isError`), y
   * el log dice `mcp.unavailable` con `scope: 'call'`, sin datos de la persona.
   */
  private async admitWithLog(): Promise<AdmissionTicket> {
    try {
      return await this.admitCall(this.signal);
    } catch (error) {
      if (error instanceof ContextUnavailableError) {
        logEvent({ event: 'mcp.unavailable', reason: error.reason, scope: 'call' });
      }
      throw error;
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
    // Lo apartado para una llamada que no llegó a ejecutarse (el SDK la rechazó antes).
    for (const ticket of this.prepaid.splice(0)) ticket.done();
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
  // El directorio es un dato de permisos de la persona: una cuenta retirada o desactivada no
  // lo lee, ni antes de pedirlo ni con la respuesta ya en la mano.
  const directory = ctx.directory ? async () => {
    await accountActive();
    const view = await ctx.directory!();
    await accountActive();
    return view;
  } : undefined;
  return { ...ctx, status: new RemoteStatusSource(ctx.status), spaces, directory, authorize, ...(use ? { trackInvocation: <T>(run: () => Promise<T>) => use.track(run) } : {}) };
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

  /** Lo apartado ahora en la compuerta de memoria (diagnóstico y pruebas). */
  get reservedBytes(): number {
    return this.gate.reservedBytes;
  }

  /** Aperturas y llamadas esperando turno de memoria (diagnóstico y pruebas). */
  get waitingCount(): number {
    return this.gate.waitingCount;
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
      // Cada llamada aparta lo suyo en el turno de su cuenta (SPEC.md §12.10).
      const use = new RequestUse(
        () => lease.release(),
        (signal) => this.gate.admit(signal, requestReserveBytes(), account.id)
      );
      const lifecycle = lease.value.ctx.spaces?.lifecycle;
      return {
        ctx: guardedContext(lease.value.ctx, this.registry, account, use),
        prepareSpaces: async (spaceIds, shouldStop) => {
          if (!lifecycle || spaceIds.length === 0) return;
          for (const space of await lifecycle.prepare(spaceIds, shouldStop)) use.hold(space);
        },
        admitCalls: async (targets, signal) => {
          use.watch(signal);
          if (targets.length > 0) await use.prepay();
        },
        release: () => use.release()
      };
    }
  }

  /**
   * Da `fn` con el contexto de la cuenta por la misma adquisición que una petición (el barrido de
   * lo pendiente, D22): comparte el contexto con quien ya lo tenga abierto, cuenta como uso mientras
   * dura y, al soltarlo, lo cierra si nadie más lo usa, pero solo si lo abrió este uso: un
   * contexto que ya estaba abierto o que se abre para una persona mientras tanto es de ella, y
   * lo cierra su inactividad. No retira nada: la persona que llama mientras tanto recibe
   * respuesta normal.
   */
  async use<T>(ref: AccountRef, fn: (ctx: ServerContext) => Promise<T>): Promise<T> {
    const account = this.registry.findById(ref.id);
    if (!account || account.generation !== ref.generation) throw new Error('account_inactive');
    const current = this.entries.get(ref.id);
    const openedByUs = !current || current.account.generation !== ref.generation || current.life.state === 'cerrado';
    const lease = await this.acquire(account);
    try {
      return await fn(lease.ctx);
    } finally {
      lease.release();
      // `closeIfIdle` no cierra con peticiones en curso: si llegó una persona, queda abierto.
      if (openedByUs) await this.closeIfIdle(ref).catch(() => undefined);
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
        resource: 'account',
        waitMs: this.openWaitMs + WAIT_BACKSTOP_MARGIN_MS,
        waitTimeoutError: () => new ContextUnavailableError('open_failed', this.gate.retryAfterSeconds)
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
      const ticket = await this.gate.admit(signal, undefined, account.id);
      try {
        this.registry.assertActive(account);
        const opened = await this.open(account);
        this.prepareOpened(opened, account);
        return opened;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'writer_lock_held') throw error;
      } finally {
        ticket.done();
      }
      await waitForLock();
    }
  }

  private prepareOpened(opened: ServeContext, account: AuthorizedAccount): void {
    const lifecycle: SpaceLifecycleControl | undefined = opened.ctx.spaces?.lifecycle;
    lifecycle?.configure({
      idleMs: this.idleMs,
      openWaitMs: this.openWaitMs,
      clock: this.clock,
      admit: (signal) => this.gate.admit(signal, undefined, account.id),
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
   *
   * Si no queda nada de eso por cerrar y la presión sigue (la compuerta vuelve a llamar mientras
   * alguien espera), cierra también las ociosas CON subidas pendientes: su cierre apunta la
   * biblioteca en la lista durable antes de intentar la ronda final (`settleUploads`) y el barrido
   * la reabre cuando el relé conteste. Sin esto, con el relé caído y la memoria alta, las
   * aperturas esperarían por cuentas que nadie usa.
   */
  private async reclaim(): Promise<void> {
    const opened = [...this.entries.values()].flatMap((entry) => {
      const value = entry.life.peek();
      return value ? [{ entry, value }] : [];
    });
    let closed = 0;
    const withPending: typeof opened = [];
    await Promise.allSettled(opened.map(async ({ entry, value }) => {
      if (entry.life.idle && !(await hasPendingUploads(value.instance))) {
        closed += 1;
        void entry.life.closeIfIdle().catch(() => undefined);
      } else {
        if (entry.life.idle) withPending.push({ entry, value });
        await value.ctx.spaces?.lifecycle?.reclaimIdle();
      }
    }));
    const closing = [...this.entries.values()].some((entry) => entry.life.state === 'cerrando');
    if (closed > 0 || closing) return;
    for (const { entry } of withPending) void entry.life.closeIfIdle().catch(() => undefined);
  }
}
