/**
 * Lo pendiente de las cuentas sin contexto abierto (D22, SPEC.md §12.10, "Sync"): sin llamadas no
 * hay rondas ni peticiones al relé por esa persona, pero una escritura hecha no se pierde por
 * cerrar su contexto.
 *
 * - `PendingUploadList`: la lista durable de `control/pending-uploads-v1.json`, por identificador
 *   opaco de cuenta y espacio. Sin títulos, `sub`, email ni credenciales.
 * - `AccountUploadLedger`: lo que cada biblioteca abierta usa para apuntarse o borrarse de la lista
 *   (`LibraryInstance.settleUploads`).
 * - `PendingSweep`: el único barrido global, cada 60 s, sin solaparse consigo mismo. Reintenta la
 *   lista, las retiradas pendientes y los diarios de alta caducados. Sin nada pendiente, ninguna
 *   petición. Un elemento que falla o se cuelga no para a los demás.
 *
 * Reintentar una subida abre el contexto por la vía normal (`WithAccountContext`), y quien lo abre
 * es quien sabe cuándo cerrarlo.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logEvent } from '../log/logger';
import type { RemotePairingJournal } from '../pair/remote/types';
import type { ServerContext } from '../server/context';
import { ToolError } from '../server/errors';
import type { UploadLedger, UploadLedgerState } from '../sync/library-instance';
import { retryableUploads, retryIsUseless } from '../sync/runner';
import type { AccountRef } from './types';

export const PENDING_SWEEP_INTERVAL_MS = 60_000;
/**
 * Lo que un elemento puede retener el barrido. Cabe abrir el contexto, con su espera de capacidad
 * (20 s), la ronda de abrir (10 s) y el cierre con su ronda final. Pasado el plazo el barrido sigue
 * con el siguiente, y ese elemento no se repite hasta que termine.
 */
export const SWEEP_ELEMENT_TIMEOUT_MS = 90_000;
/** Lo que `stop()` espera al barrido en curso: el apagado tiene su propio presupuesto. */
export const SWEEP_STOP_WAIT_MS = 5_000;
export const PENDING_UPLOADS_FILE = 'pending-uploads-v1.json';

const FILE_VERSION = 1;
/** Como `RemotePairingJournalStore.list`: lo demás de ese directorio no es un diario. */
const JOURNAL_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Una biblioteca con subidas pendientes. `space: null` es la personal de esa cuenta. */
export interface PendingUploadEntry {
  account: string;
  generation: number;
  space: string | null;
  /** Reintentar no sirve hasta que cambie algo (`UploadLedgerState`). */
  blocked: boolean;
}

function keyOf(entry: { account: string; space: string | null }): string {
  return JSON.stringify([entry.account, entry.space]);
}

function validEntry(value: unknown): value is PendingUploadEntry {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.account === 'string' && row.account.length > 0 &&
    Number.isSafeInteger(row.generation) &&
    (row.space === null || typeof row.space === 'string') && typeof row.blocked === 'boolean';
}

/** Lista durable. Serializa sus escrituras y publica cada estado de forma atómica. */
export class PendingUploadList {
  private queue: Promise<unknown> = Promise.resolve();
  /** Destinos con su escritor abierto en este proceso: su sync ya lo lleva su contexto. */
  private readonly openTargets = new Map<string, number>();

  private constructor(
    private readonly path: string,
    private readonly rows: Map<string, PendingUploadEntry>
  ) {}

  /**
   * Un fichero ilegible no impide arrancar, porque eso negaría el acceso a todos: se trata como
   * vacío y se dice en el log. Las escrituras siguen en cada SQLite y suben al volver a abrirla.
   */
  static async open(controlDir: string): Promise<PendingUploadList> {
    const path = join(controlDir, PENDING_UPLOADS_FILE);
    const rows = new Map<string, PendingUploadEntry>();
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown; entries?: unknown };
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.entries) || !parsed.entries.every(validEntry)) {
        throw new Error('pending_uploads_invalid');
      }
      for (const entry of parsed.entries as PendingUploadEntry[]) rows.set(keyOf(entry), entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logEvent({ event: 'pending_uploads.read', result: 'invalid' });
      }
    }
    return new PendingUploadList(path, rows);
  }

  entries(): PendingUploadEntry[] {
    return [...this.rows.values()].map((entry) => ({ ...entry }));
  }

  has(entry: { account: string; space: string | null }): boolean {
    return this.rows.has(keyOf(entry));
  }

  isBlocked(entry: { account: string; space: string | null }): boolean {
    return this.rows.get(keyOf(entry))?.blocked === true;
  }

  isOpen(entry: { account: string; space: string | null }): boolean {
    return this.openTargets.has(keyOf(entry));
  }

  /** Lo que usa cada biblioteca de esta cuenta. */
  ledger(account: AccountRef): AccountUploadLedger {
    return new AccountUploadLedger(this, account);
  }

  noteOpen(key: string): void {
    this.openTargets.set(key, (this.openTargets.get(key) ?? 0) + 1);
  }

  noteClosed(key: string): void {
    const left = (this.openTargets.get(key) ?? 0) - 1;
    if (left > 0) this.openTargets.set(key, left);
    else this.openTargets.delete(key);
  }

  /** Apunta o actualiza. Sin cambios, no toca el disco. */
  async put(account: AccountRef, space: string | null, blocked: boolean): Promise<void> {
    const entry: PendingUploadEntry = { account: account.id, generation: account.generation, space, blocked };
    const key = keyOf(entry);
    const current = this.rows.get(key);
    if (current && current.generation === entry.generation && current.blocked === blocked) {
      await this.queue;
      return;
    }
    this.rows.set(key, entry);
    await this.persist();
  }

  /** Borra si está. Sin ella, no toca el disco: en reposo este fichero ni se mira. */
  async remove(entry: { account: string; space: string | null }): Promise<void> {
    if (!this.rows.delete(keyOf(entry))) {
      await this.queue;
      return;
    }
    await this.persist();
  }

  private persist(): Promise<void> {
    const written = this.queue.then(() => this.writeFile());
    this.queue = written.then(() => undefined, () => undefined);
    return written;
  }

  private async writeFile(): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${PENDING_UPLOADS_FILE}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: FILE_VERSION, entries: [...this.rows.values()] }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
}

/** La lista vista desde las bibliotecas de un contexto: la personal y sus espacios. */
export class AccountUploadLedger implements UploadLedger {
  private readonly settles = new Map<string | null, () => Promise<void>>();

  constructor(
    private readonly list: PendingUploadList,
    private readonly account: AccountRef
  ) {}

  private key(space: string | null): string {
    return keyOf({ account: this.account.id, space });
  }

  opened(space: string | null, settle: () => Promise<void>): void {
    if (!this.settles.has(space)) this.list.noteOpen(this.key(space));
    this.settles.set(space, settle);
  }

  closed(space: string | null): void {
    if (this.settles.delete(space)) this.list.noteClosed(this.key(space));
  }

  record(space: string | null, state: UploadLedgerState): Promise<void> {
    if (state === 'clear') return this.list.remove({ account: this.account.id, space });
    return this.list.put(this.account, space, state === 'blocked');
  }

  /** La ronda final de todo lo abierto de este contexto. Nunca rechaza. */
  async settleAll(): Promise<void> {
    await Promise.allSettled([...this.settles.values()].map((settle) => settle()));
  }
}

/**
 * Da `fn` con el contexto de una cuenta abierto por la vía normal y lo cierra (o lo deja cerrarse)
 * después. El lote de ciclo de vida (D22) enchufa aquí su apertura; ver `startServeHttp`.
 */
export type WithAccountContext = <T>(ref: AccountRef, fn: (ctx: ServerContext) => Promise<T>) => Promise<T>;

export interface PendingSweepOptions {
  list: PendingUploadList;
  withAccountContext: WithAccountContext;
  /** Si no sigue activa con esa generación, su entrada se descarta sin abrir nada. */
  accountActive(ref: AccountRef): boolean;
  /** `AccountRemovalService.resumePending`. */
  resumeRemovals(): Promise<void>;
  /** `expireRemotePairings`. */
  expireJournals(): Promise<{ expired: number; failed: number }>;
  /** Tests: relojes y temporizador. */
  intervalMs?: number;
  elementTimeoutMs?: number;
  stopWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  schedule?: (tick: () => void, ms: number) => () => void;
}

export interface SweepReport {
  /** Entradas que ya no están: subidas, o ya sin nada que subir. */
  uploaded: number;
  /** Entradas que siguen para el barrido siguiente. */
  kept: number;
  /** Entradas de una cuenta retirada o un espacio denegado. */
  dropped: number;
  /** Abiertas ahora, bloqueadas o con un reintento anterior aún en curso. */
  skipped: number;
  removalsFailed: boolean;
  journalsExpired: number;
  journalsFailed: number;
}

function errorCode(error: unknown): string {
  if (error instanceof ToolError) return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function realSchedule(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  // El barrido no mantiene vivo el proceso.
  timer.unref?.();
  return () => clearInterval(timer);
}

const TIMED_OUT = Symbol('timed_out');

export class PendingSweep {
  private cancelTimer: (() => void) | null = null;
  private running: Promise<SweepReport> | null = null;
  private stopped = false;
  /** Lo que sigue en marcha, también después de agotar su plazo: nunca dos veces a la vez. */
  private readonly inFlight = new Set<string>();
  /** Bloqueadas ya reintentadas: una vez por arranque, por si un binario nuevo lo resuelve. */
  private readonly triedBlocked = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: PendingSweepOptions) {
    this.sleep = options.sleep ?? realSleep;
  }

  /** Un único temporizador; idempotente. */
  start(): void {
    if (this.cancelTimer || this.stopped) return;
    this.cancelTimer = (this.options.schedule ?? realSchedule)(
      () => void this.runOnce(),
      this.options.intervalMs ?? PENDING_SWEEP_INTERVAL_MS
    );
  }

  /** Sin solaparse: con uno en curso, devuelve ese. */
  runOnce(): Promise<SweepReport> {
    if (this.running) return this.running;
    const run = this.sweep().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  /** No empieza nada más y espera poco a lo que esté en curso: `contexts.close()` lo drena. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    const running = this.running;
    if (running) await Promise.race([running, this.sleep(this.options.stopWaitMs ?? SWEEP_STOP_WAIT_MS)]);
  }

  private async sweep(): Promise<SweepReport> {
    const report: SweepReport = { uploaded: 0, kept: 0, dropped: 0, skipped: 0,
      removalsFailed: false, journalsExpired: 0, journalsFailed: 0 };
    if (this.stopped) return report;
    await Promise.all([
      this.sweepRemovals(report),
      this.sweepJournals(report),
      this.sweepUploads(report)
    ]);
    const worked = report.uploaded + report.kept + report.dropped + report.journalsExpired +
      report.journalsFailed > 0 || report.removalsFailed;
    // En reposo, ni una línea.
    if (worked) logEvent({ event: 'pending_sweep.round', ...report });
    return report;
  }

  private async sweepRemovals(report: SweepReport): Promise<void> {
    try {
      const done = await this.bounded('removals', () => this.options.resumeRemovals());
      if (done === TIMED_OUT) report.removalsFailed = true;
    } catch {
      report.removalsFailed = true;
    }
  }

  private async sweepJournals(report: SweepReport): Promise<void> {
    try {
      const done = await this.bounded('journals', () => this.options.expireJournals());
      if (done === TIMED_OUT) report.journalsFailed += 1;
      else if (done) {
        report.journalsExpired += done.expired;
        report.journalsFailed += done.failed;
      }
    } catch {
      report.journalsFailed += 1;
    }
  }

  /** Una a una: abrir una biblioteca cuesta memoria, y el barrido no compite con nadie por ella. */
  private async sweepUploads(report: SweepReport): Promise<void> {
    const { list } = this.options;
    for (const entry of list.entries()) {
      if (this.stopped) return;
      const key = keyOf(entry);
      if (list.isOpen(entry) || (entry.blocked && this.triedBlocked.has(key))) {
        report.skipped += 1;
        continue;
      }
      if (entry.blocked) this.triedBlocked.add(key);
      try {
        const outcome = await this.bounded(`upload:${key}`, () => this.retryUpload(entry));
        // Si este mismo intento la ha bloqueado, ya cuenta como el de este arranque.
        if (list.isBlocked(entry)) this.triedBlocked.add(key);
        if (outcome === 'dropped') report.dropped += 1;
        else if (outcome === null) report.skipped += 1;
        else if (outcome === TIMED_OUT || list.has(entry)) report.kept += 1;
        else report.uploaded += 1;
      } catch (error) {
        report.kept += 1;
        logEvent({ event: 'pending_sweep.element', result: 'failed', code: errorCode(error) });
      }
    }
  }

  /**
   * `task` con plazo. Agotado, el barrido sigue pero `task` también, y mientras no termine ese
   * nombre no se repite (`null`). Sin esto, un relé que no contesta pararía a todos para siempre.
   */
  private async bounded<T>(name: string, task: () => Promise<T>): Promise<T | null | typeof TIMED_OUT> {
    if (this.inFlight.has(name)) return null;
    this.inFlight.add(name);
    const work = task().finally(() => this.inFlight.delete(name));
    // Si el plazo gana, nadie espera ya a `work`: que su rechazo no quede sin atender.
    void work.catch(() => undefined);
    const limit = this.sleep(this.options.elementTimeoutMs ?? SWEEP_ELEMENT_TIMEOUT_MS)
      .then((): typeof TIMED_OUT => TIMED_OUT);
    return Promise.race([work, limit]);
  }

  /** `dropped` si la entrada ya no tiene sentido; `tried` si se intentó, sea cual sea el final. */
  private async retryUpload(entry: PendingUploadEntry): Promise<'dropped' | 'tried'> {
    const { list, withAccountContext, accountActive } = this.options;
    const ref: AccountRef = { id: entry.account, generation: entry.generation };
    if (!accountActive(ref)) {
      await list.remove(entry);
      return 'dropped';
    }
    let state: UploadLedgerState | 'denied';
    try {
      state = await withAccountContext(ref, async (ctx) => {
        const target = await targetOf(ctx, entry);
        if (!target) return 'denied' as const;
        await target.firstRound?.();
        const status = await target.status.getStatus();
        if (retryableUploads(status) === 0) return 'clear' as const;
        return retryIsUseless(status) ? 'blocked' as const : 'retry' as const;
      });
    } catch (error) {
      if (accountActive(ref)) throw error;
      await list.remove(entry);
      return 'dropped';
    }
    if (state === 'denied') {
      await list.remove(entry);
      return 'dropped';
    }
    if (state === 'clear') await list.remove(entry);
    else if (state === 'blocked' && list.has(entry)) await list.put(ref, entry.space, true);
    return 'tried';
  }
}

/**
 * La biblioteca de la entrada, o `null` si el espacio ya no es de esta persona. `resolve` responde
 * `space_access_denied` también con el relé caído, así que eso solo no basta para olvidar unas
 * subidas: lo confirma un listado que conteste. Si tampoco contesta, sigue para el barrido siguiente.
 */
async function targetOf(ctx: ServerContext, entry: PendingUploadEntry): Promise<ServerContext | null> {
  if (entry.space === null) return ctx;
  if (!ctx.spaces) throw new Error('spaces_unavailable');
  try {
    return await ctx.spaces.resolve(entry.space);
  } catch (error) {
    if (!(error instanceof ToolError) || error.code !== 'space_access_denied') throw error;
    const visible = await ctx.spaces.list();
    if (visible.some((space) => space.spaceId === entry.space)) throw error;
    return null;
  }
}

/**
 * Los diarios de alta caducados. No sirve `RemotePairingService.recover`: limpia TODOS los diarios,
 * porque es para el arranque, y aquí se llevaría por delante las altas en curso de esas personas.
 * `abandon` hace la misma limpieza sobre uno solo, en su turno; una cuenta ya publicada solo pierde
 * el diario, nunca la credencial. Lee los diarios uno a uno para que uno ilegible no pare al resto.
 */
export async function expireRemotePairings(
  journals: { root: string; read(id: string): Promise<RemotePairingJournal | null> },
  service: { abandon(id: string, oauthRequestId: string): Promise<void> },
  now: number
): Promise<{ expired: number; failed: number }> {
  let names: string[];
  try {
    names = await readdir(journals.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { expired: 0, failed: 0 };
    throw error;
  }
  let expired = 0;
  let failed = 0;
  for (const name of names) {
    if (!JOURNAL_NAME.test(name)) continue;
    try {
      const journal = await journals.read(name);
      if (!journal || Date.parse(journal.expiresAt) > now) continue;
      await service.abandon(journal.id, journal.oauthRequestId);
      expired += 1;
    } catch {
      failed += 1;
    }
  }
  return { expired, failed };
}
