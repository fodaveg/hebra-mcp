/**
 * `HebraLibraryPort` (`./types.ts`) en proceso, sobre `SqliteLibraryEngine` de Hebra y el
 * adaptador `node:sqlite` de `./sqlite-conn-node.ts`. Deliberadamente NO reutiliza
 * `LocalLibraryPort` (`library/local-port` de Hebra): ese puerto implementa el
 * `LibraryStorePort` completo (`tagRename`, `noteMove`, `folder*`, `file*`…), y D2
 * (SPEC.md §3) prohíbe que nada de eso sea alcanzable desde las herramientas. Este puerto
 * usa `SqliteLibraryEngine` directamente y expone solo lo que D2 permite.
 *
 * Del mismo almacén salen tres vistas, todas por la MISMA cola (`SerialQueue`, ver su
 * cabecera) para que una ronda de sync y una escritura nunca se crucen en la conexión:
 * - `HebraLibraryPort` (esta clase): lo que ve la capa de herramientas.
 * - `SyncStorePort` (`syncStorePort()`, `./sync-port.ts`): el `LibraryPort` de Hebra
 *   que necesita `LibrarySyncEngine`; solo lo usa `src/sync/runner.ts`.
 * - `NoteWriteStore` (`writeExclusive()`): noteCreate/noteRead/noteSave en UN turno de
 *   la cola, para `./writes.ts` (crear = crear + guardar sin que una ronda se cuele en
 *   medio y suba una nota vacía).
 *
 * Solo lectura (SPEC.md §8, escritor único): con `mode: 'readOnly'` la SQLite se abre
 * con `readOnly: true` y toda escritura rechaza con `busy_other_instance`
 * (`./errors.ts`) antes de llegar al motor.
 *
 * Derivados: este fichero solo importa de `derive.ts` lo que no toca el analizador de
 * Markdown (`parseLinkRef`, `canonicalTitle`). `deriveNote` (que arrastra
 * `@codemirror/lang-markdown`) entra por `./writes.ts` y por el motor de sync de Hebra,
 * que deriva los registros entrantes él mismo (`decodeSnapshot` en `sync-engine.ts`).
 * El check del bundle que lo admite es `scripts/check-bundle.mjs`.
 */
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  canonicalTitle,
  cleanSearchPage,
  parseLinkRef,
  SqliteLibraryEngine,
  type FoldersList,
  type LibraryOpenInfo,
  type LinkResolution,
  type NoteRow,
  type NoteSaveInput,
  type NoteSaveResult,
  type NotesPage,
  type NotesScope,
  type SearchFilters,
  type SearchPage,
  type TagsList,
  type TitleCandidates
} from '../hebra';
import { openNodeSqliteConn, type NodeSqliteMode } from './sqlite-conn-node';
import { FsBlobStore } from './blob-store-fs';
import { busyOtherInstance } from './errors';
import { SerialQueue } from './serial-queue';
import { createSyncStorePort, type SyncStorePort } from './sync-port';
import type { HebraLibraryPort, NoteVisibilityEntry } from './types';
import type { NoteWriteStore, NoteWriteTarget } from './writes';

export interface OpenNodeLibraryOptions {
  /** Ruta del fichero SQLite, o `:memory:` (tests). */
  sqlitePath: string;
  /** Directorio de datos, donde cuelga `blobs/`. Sin él, los adjuntos se guardan en
   *  memoria (`MemoryBlobStore` de Hebra): basta para los tests, v1 no sirve adjuntos. */
  dataDir?: string;
  deviceLabel?: string;
  /** `readWrite` (por defecto): el escritor único. `readOnly`: otra instancia tiene el
   *  bloqueo (SPEC.md §8); la base tiene que existir ya. */
  mode?: NodeSqliteMode;
}

export async function openNodeLibraryPort(
  options: OpenNodeLibraryOptions
): Promise<NodeLibraryPort> {
  const mode = options.mode ?? 'readWrite';
  if (options.sqlitePath !== ':memory:' && mode === 'readWrite') {
    await mkdir(dirname(options.sqlitePath), { recursive: true, mode: 0o700 });
  }
  const { db, conn } = openNodeSqliteConn(options.sqlitePath, mode);
  const blobs = options.dataDir ? new FsBlobStore(options.dataDir) : undefined;
  let engine: SqliteLibraryEngine;
  try {
    // Escritor único (SPEC.md §8): `journalMode: 'WAL'` para que los lectores de las
    // demás instancias (`openReadOnly`, cada uno su propia conexión `node:sqlite` con
    // `readOnly: true`) convivan con esta sin bloquearse. El lector no toca pragmas ni
    // esquema (`openReadOnly` de `SqliteLibraryEngine`: la base ya existe, la creó el
    // escritor).
    engine =
      mode === 'readWrite'
        ? await SqliteLibraryEngine.open(conn, options.deviceLabel ?? 'hebra-mcp', {
            journalMode: 'WAL',
            ...(blobs ? { blobs } : {})
          })
        : await SqliteLibraryEngine.openReadOnly(conn, options.deviceLabel ?? 'hebra-mcp', {
            ...(blobs ? { blobs } : {})
          });
  } catch (error) {
    db.close();
    throw error;
  }
  if (options.sqlitePath !== ':memory:' && mode === 'readWrite') {
    await secureSqliteFileModes(options.sqlitePath);
  }
  return new NodeLibraryPort(engine, db, mode);
}

/**
 * SPEC.md §6.1: ficheros de datos en 0600 (el directorio ya se crea 0700, arriba).
 * `node:sqlite` crea `library.sqlite` con `open(2)` y el modo por defecto del SO
 * (`0666` menos umask, típicamente 0644): no acepta un modo propio al crear el fichero.
 * `journalMode: 'WAL'` (`SqliteLibraryEngine.open`, más arriba) añade `-wal`/`-shm` con
 * el mismo problema, y para cuando esta función corre ya existen los tres: `open()` ya
 * ejecutó `PRAGMA journal_mode=WAL` y escribió el esquema (`SCHEMA_SQL` +
 * `bootstrapLibraryId`), que en WAL crea `-wal`/`-shm` de inmediato, sin esperar a la
 * primera escritura del llamante. Se prefiere corregir aquí (en vez de
 * `process.umask(0o077)` al arrancar el proceso) para no afectar a nada más que abra
 * ficheros en el mismo proceso sin necesidad. `chmod` no distingue si el fichero es
 * nuevo o ya existía con permisos más abiertos (el bug medido: 0644): lo deja en 0600
 * en los dos casos.
 */
async function secureSqliteFileModes(sqlitePath: string): Promise<void> {
  await chmod(sqlitePath, 0o600);
  for (const suffix of ['-wal', '-shm']) {
    try {
      await chmod(`${sqlitePath}${suffix}`, 0o600);
    } catch (error) {
      // El checkpoint pudo truncar y borrar el `-wal` (o nunca hubo escritura que
      // activara `-shm`): sin ficheros que corregir, no es un fallo.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export class NodeLibraryPort implements HebraLibraryPort, NoteWriteTarget {
  private readonly queue = new SerialQueue();
  private syncView: SyncStorePort | null = null;
  private closed = false;

  constructor(
    private readonly engine: SqliteLibraryEngine,
    private readonly db: DatabaseSync,
    readonly mode: NodeSqliteMode = 'readWrite'
  ) {}

  /** `true` si esta instancia es el escritor único y la conexión sigue abierta. */
  get writable(): boolean {
    return this.mode === 'readWrite' && !this.closed;
  }

  private read<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.queue.run(operation);
  }

  private write<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.writable ? this.queue.run(operation) : Promise.reject(busyOtherInstance());
  }

  async libraryOpen(): Promise<LibraryOpenInfo> {
    return this.read(() => this.engine.libraryOpen());
  }

  async noteCreate(folderId?: string | null): Promise<NoteRow> {
    return this.write(() => this.engine.noteCreate(folderId ?? null));
  }

  async noteRead(id: string): Promise<NoteRow | null> {
    return this.read(() => this.engine.noteRead(id));
  }

  async noteSave(input: NoteSaveInput): Promise<NoteSaveResult> {
    return this.write(() => this.engine.noteSave(input));
  }

  async notesPage(cursor: string | null, limit: number, scope?: NotesScope): Promise<NotesPage> {
    return this.read(() => this.engine.notesPage(cursor, limit, scope));
  }

  async foldersList(): Promise<FoldersList> {
    return this.read(() => this.engine.foldersList());
  }

  async tagsList(): Promise<TagsList> {
    return this.read(() => this.engine.tagsList());
  }

  async resolveLink(ref: string): Promise<LinkResolution> {
    const query = parseLinkRef(ref);
    return query
      ? this.read(() => this.engine.resolveLink(query))
      : { status: 'missing', candidates: [] };
  }

  async backlinks(id: string, cursor: string | null = null, limit?: number): Promise<NotesPage> {
    return this.read(() => this.engine.backlinks(id, cursor, limit));
  }

  async search(
    q: string,
    cursor: string | null,
    limit?: number,
    filters?: SearchFilters | null
  ): Promise<SearchPage> {
    return this.read(() => cleanSearchPage(this.engine.search(q, cursor, limit, filters ?? null)));
  }

  async notesByTitlePrefix(prefix: string, limit?: number): Promise<TitleCandidates> {
    return this.read(() => this.engine.notesByTitlePrefix(canonicalTitle(prefix), limit));
  }

  /**
   * Carpeta efectiva y etiquetas de cada nota viva, en UNA consulta (§ comentario de
   * `./types.ts`). Carpeta efectiva: la propia `folder_id` si esa carpeta existe y no
   * es lápida, si no la raíz (`root`) — misma regla que `rowToNote`/`notesPageQuery` de
   * `sqlite-engine.ts`, aquí en SQL para no leer nota a nota. Etiquetas: `GROUP_CONCAT`
   * con `\n` como separador (una etiqueta canónica nunca lleva salto de línea) en vez de
   * una subconsulta por nota; `GROUP_CONCAT` de cero filas es `NULL`, de ahí el `?? ''`.
   * SQL propio de hebra-mcp sobre las tablas de `schema.sql` (`notes`, `folders`,
   * `note_tags`), no un método de Hebra: pasa por `this.db` (el mismo `DatabaseSync` del
   * adaptador, `./sqlite-conn-node.ts`) y por la cola serie como cualquier otra lectura.
   */
  async notesVisibilityIndex(): Promise<NoteVisibilityEntry[]> {
    return this.read(() => {
      const rows = this.db
        .prepare(
          `SELECT n.id AS id,
                  CASE WHEN f.id IS NOT NULL AND f.deleted = 0 THEN n.folder_id ELSE 'root' END AS folder_id,
                  GROUP_CONCAT(t.tag, char(10)) AS tags
           FROM notes n
           LEFT JOIN folders f ON f.id = n.folder_id
           LEFT JOIN note_tags t ON t.note_id = n.id
           WHERE n.deleted = 0 AND n.trashed_at IS NULL
           GROUP BY n.id`
        )
        .all() as Array<{ id: string; folder_id: string; tags: string | null }>;
      return rows.map((row) => ({
        id: row.id,
        folderId: row.folder_id,
        tags: row.tags ? row.tags.split('\n') : []
      }));
    });
  }

  /**
   * Ejecuta `operation` en UN turno de la cola, con acceso directo (sin cola) a las tres
   * operaciones de nota del motor. Solo para `./writes.ts`: dentro de `operation` no se
   * puede llamar a ningún otro método de este puerto (esperaría detrás de sí mismo).
   */
  writeExclusive<T>(operation: (store: NoteWriteStore) => Promise<T>): Promise<T> {
    return this.write(() =>
      operation({
        noteCreate: (folderId) => this.engine.noteCreate(folderId ?? null),
        noteRead: async (id) => this.engine.noteRead(id),
        noteSave: (input) => this.engine.noteSave(input)
      })
    );
  }

  /** La vista `LibraryPort` del motor de sync (`./sync-port.ts`). Una por puerto. */
  syncStorePort(): SyncStorePort {
    this.syncView ??= createSyncStorePort(this.engine, this.queue, () => this.writable);
    return this.syncView;
  }

  /** Espera a que termine lo que haya en cola y cierra la conexión. */
  async closeWhenIdle(): Promise<void> {
    if (this.closed) return;
    await this.queue.whenIdle();
    this.close();
  }

  /** Cierra la conexión SQLite ya (sin esperar a la cola). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
