/**
 * Una instancia de hebra-mcp sobre su directorio de datos: el almacén, el escritor único
 * (`src/lock/writer-lock.ts`) y el bucle de sync (`./runner.ts`), montados según quién
 * tenga el bloqueo (SPEC.md §8).
 *
 * - Con el bloqueo (escritor): SQLite en lectura-escritura, `SyncRunner` en marcha y
 *   escrituras permitidas.
 * - Sin él: SQLite en solo lectura (WAL), sin sync; las lecturas funcionan y las
 *   escrituras rechazan con `busy_other_instance`.
 * - Cada `checkIntervalMs` (30 s) se revisa el bloqueo: si el escritor murió, esta
 *   instancia lo toma, reabre la SQLite en lectura-escritura y arranca el sync; si el
 *   escritor descubre que el fichero ya no es suyo (`verify`), para el sync y pasa a
 *   solo lectura.
 *
 * `port` es estable durante toda la vida de la instancia (las herramientas lo guardan
 * una vez): delega en el `NodeLibraryPort` vigente, que cambia al cambiar de papel.
 */
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type {
  FoldersList,
  LibraryOpenInfo,
  LinkResolution,
  NoteRow,
  NoteSaveInput,
  NoteSaveResult,
  NotesPage,
  NotesScope,
  SearchFilters,
  SearchPage,
  TagsList,
  TitleCandidates
} from '$lib/library/types';
import { WriterLock, type WriterLockOptions } from '../lock/writer-lock';
import { busyOtherInstance } from '../store/errors';
import { openNodeLibraryPort, type NodeLibraryPort } from '../store/node-port';
import type { HebraLibraryPort, NoteVisibilityEntry } from '../store/types';
import {
  NoteWriter,
  type AppendToNoteInput,
  type AppendToNoteResult,
  type CreateNoteInput,
  type CreateNoteResult,
  type NoteWriteStore,
  type NoteWriteTarget
} from '../store/writes';
import {
  SyncRunner,
  STARTUP_READ_WAIT_MS,
  type SyncConflictCopy,
  type SyncRunnerOptions,
  type SyncStatusSnapshot
} from './runner';

export const WRITER_CHECK_INTERVAL_MS = 30_000;
export const LIBRARY_SQLITE_FILE = 'library.sqlite';
const OPEN_READER_TIMEOUT_MS = 10_000;
const OPEN_READER_RETRY_MS = 100;

export type WriterRole = 'this' | 'other_instance';

/** Lo que el runner necesita además del almacén: identidad, clave y transporte. */
export type LibrarySyncConfig = Omit<SyncRunnerOptions, 'port'>;

export interface OpenLibraryInstanceOptions {
  /** Directorio de datos (se crea con 0700 si falta). */
  dataDir: string;
  /** Por defecto, `<dataDir>/library.sqlite`. */
  sqlitePath?: string;
  deviceLabel?: string;
  /** Sin él (aún sin emparejar, L2), el escritor no sincroniza. */
  sync?: LibrarySyncConfig | null;
  /** Cada cuánto se revisa el bloqueo; `null` lo desactiva (tests: `checkWriter()`). */
  checkIntervalMs?: number | null;
  /** Opciones del bloqueo para tests (`pid`, `isAlive`, `releaseOnExit`). */
  lock?: Omit<WriterLockOptions, 'dataDir'>;
}

export interface InstanceStatus extends SyncStatusSnapshot {
  writer: WriterRole;
}

export class LibraryInstance implements NoteWriteTarget {
  private current!: NodeLibraryPort;
  private runner: SyncRunner | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private switching: Promise<void> = Promise.resolve();
  private readonly conflictListeners = new Set<(copy: SyncConflictCopy) => void>();
  private readonly writer: NoteWriter;
  /** Vista estable para la capa de herramientas. */
  readonly port: HebraLibraryPort;

  private constructor(
    private readonly options: OpenLibraryInstanceOptions,
    private readonly lock: WriterLock,
    private readonly sqlitePath: string
  ) {
    this.port = stablePort(() => this.current);
    this.writer = new NoteWriter(this, { onWritten: () => void this.runner?.requestRound() });
  }

  static async open(options: OpenLibraryInstanceOptions): Promise<LibraryInstance> {
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    const lock = new WriterLock({ dataDir: options.dataDir, ...options.lock });
    const sqlitePath = options.sqlitePath ?? join(options.dataDir, LIBRARY_SQLITE_FILE);
    const instance = new LibraryInstance(options, lock, sqlitePath);
    await instance.becomeFromLock();
    const interval =
      options.checkIntervalMs === undefined ? WRITER_CHECK_INTERVAL_MS : options.checkIntervalMs;
    if (interval !== null) {
      instance.timer = setInterval(() => void instance.checkWriter(), interval);
      instance.timer.unref?.();
    }
    return instance;
  }

  /** `this` si esta instancia es el escritor único. */
  get role(): WriterRole {
    return this.current.writable ? 'this' : 'other_instance';
  }

  /** El runner vigente (solo en el escritor con `sync`). */
  get syncRunner(): SyncRunner | null {
    return this.runner;
  }

  private async openPort(mode: 'readWrite' | 'readOnly'): Promise<NodeLibraryPort> {
    return openNodeLibraryPort({
      sqlitePath: this.sqlitePath,
      dataDir: this.options.dataDir,
      deviceLabel: this.options.deviceLabel,
      mode
    });
  }

  /**
   * Primer montaje: escritor si el bloqueo es suyo; lector si no. Un lector no puede
   * crear la base (solo lectura): si el escritor aún no la ha creado (arrancaron a la
   * vez), se reintenta hasta `OPEN_READER_TIMEOUT_MS`, volviendo a mirar el bloqueo en
   * cada intento por si el escritor murió entre medias.
   */
  private async becomeFromLock(): Promise<void> {
    const deadline = Date.now() + OPEN_READER_TIMEOUT_MS;
    for (;;) {
      if (this.lock.tryAcquire()) {
        await this.becomeWriter(null);
        return;
      }
      try {
        this.current = await this.openPort('readOnly');
        return;
      } catch (error) {
        const missing =
          error instanceof Error && /unable to open database file/.test(error.message);
        if (!missing || Date.now() >= deadline) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, OPEN_READER_RETRY_MS));
    }
  }

  private async becomeWriter(previous: NodeLibraryPort | null): Promise<void> {
    const port = await this.openPort('readWrite');
    this.current = port;
    if (previous) await previous.closeWhenIdle();
    if (this.options.sync) {
      const runner = await SyncRunner.create({ ...this.options.sync, port: port.syncStorePort() });
      runner.onConflictCopy((copy) => {
        for (const listener of this.conflictListeners) listener(copy);
      });
      this.runner = runner;
      runner.start();
    }
  }

  private async becomeReader(): Promise<void> {
    const runner = this.runner;
    this.runner = null;
    await runner?.stop();
    const previous = this.current;
    this.current = await this.openPort('readOnly');
    await previous.closeWhenIdle();
  }

  /**
   * Revisa el bloqueo (lo llama el temporizador cada 30 s; los tests, a mano): toma el
   * relevo si el escritor murió y suelta el papel si el fichero ya no es suyo.
   */
  checkWriter(): Promise<void> {
    const next = this.switching.then(async () => {
      if (this.closed) return;
      if (this.current.writable) {
        if (!this.lock.verify()) await this.becomeReader();
        return;
      }
      if (this.lock.tryAcquire()) await this.becomeWriter(this.current);
    });
    this.switching = next.catch(() => undefined);
    return next;
  }

  /** Lecturas: espera a la primera ronda de sync como mucho `maxWaitMs` (§8). */
  async whenReady(maxWaitMs = STARTUP_READ_WAIT_MS): Promise<void> {
    await this.runner?.whenReady(maxWaitMs);
  }

  /** Avisa de las copias de conflicto de las rondas del escritor. */
  onConflictCopy(listener: (copy: SyncConflictCopy) => void): () => void {
    this.conflictListeners.add(listener);
    return () => this.conflictListeners.delete(listener);
  }

  /** Rechaza con `busy_other_instance` si esta instancia no es el escritor. */
  writeExclusive<T>(operation: (store: NoteWriteStore) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(busyOtherInstance());
    return this.current.writeExclusive(operation);
  }

  createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    return this.writer.createNote(input);
  }

  appendToNote(input: AppendToNoteInput): Promise<AppendToNoteResult> {
    return this.writer.appendToNote(input);
  }

  /** Estado para `hebra_status` sin `linked` (L2). En un lector, `pendingUpload` y
   *  `errorsByCode` se leen igual de la base; las rondas son del otro proceso. */
  async status(): Promise<InstanceStatus> {
    const role = this.role;
    if (this.runner) return { ...(await this.runner.syncStatus()), writer: role };
    const counts = await this.current.syncStorePort().syncStatus();
    const errorsByCode: Record<string, number> = {};
    for (const entry of counts.errors) {
      errorsByCode[entry.code] = (errorsByCode[entry.code] ?? 0) + entry.count;
    }
    return {
      lastSyncAt: null,
      lastSyncOutcome: null,
      pendingUpload: counts.dirty + counts.blobsPending,
      errorsByCode,
      revoked: false,
      writer: role
    };
  }

  /** Para el sync, cierra la SQLite y suelta el bloqueo. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.switching;
    await this.runner?.stop();
    this.runner = null;
    await this.current.closeWhenIdle();
    this.lock.release();
  }
}

/** `HebraLibraryPort` que delega en el puerto vigente en cada llamada. */
function stablePort(current: () => NodeLibraryPort): HebraLibraryPort {
  return {
    libraryOpen: (): Promise<LibraryOpenInfo> => current().libraryOpen(),
    noteCreate: (folderId?: string | null): Promise<NoteRow> => current().noteCreate(folderId),
    noteRead: (id: string): Promise<NoteRow | null> => current().noteRead(id),
    noteSave: (input: NoteSaveInput): Promise<NoteSaveResult> => current().noteSave(input),
    notesPage: (cursor: string | null, limit: number, scope?: NotesScope): Promise<NotesPage> =>
      current().notesPage(cursor, limit, scope),
    foldersList: (): Promise<FoldersList> => current().foldersList(),
    tagsList: (): Promise<TagsList> => current().tagsList(),
    resolveLink: (ref: string): Promise<LinkResolution> => current().resolveLink(ref),
    backlinks: (id: string, cursor?: string | null, limit?: number): Promise<NotesPage> =>
      current().backlinks(id, cursor ?? null, limit),
    search: (
      q: string,
      cursor: string | null,
      limit?: number,
      filters?: SearchFilters | null
    ): Promise<SearchPage> => current().search(q, cursor, limit, filters),
    notesByTitlePrefix: (prefix: string, limit?: number): Promise<TitleCandidates> =>
      current().notesByTitlePrefix(prefix, limit),
    notesVisibilityIndex: (): Promise<NoteVisibilityEntry[]> => current().notesVisibilityIndex(),
    close: (): void => current().close()
  };
}
