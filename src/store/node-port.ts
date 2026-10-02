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
import type { DatabaseSync, StatementSync } from 'node:sqlite';
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
import { ensureOperationsTable, sqliteOperationStore, type OperationStore } from './operations';
import { SerialQueue } from './serial-queue';
import { createSyncStorePort, type SyncStorePort } from './sync-port';
import type {
  HebraLibraryPort,
  NoteAttachmentRow,
  NoteVersion,
  NoteVersionsList,
  NoteVisibilityEntry,
  TrashIndex
} from './types';
import type { NoteWriteStore, NoteWriteTarget } from './writes';

/** Prefijo de un cuerpo bloqueado (`LOCKED_MARK` de `sqlite-engine.ts`). */
const LOCKED_BODY_PREFIX = 'hebra-locked:';

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
        ? await SqliteLibraryEngine.open(conn, options.deviceLabel ?? 'Claude', {
            journalMode: 'WAL',
            ...(blobs ? { blobs } : {})
          })
        : await SqliteLibraryEngine.openReadOnly(conn, options.deviceLabel ?? 'Claude', {
            ...(blobs ? { blobs } : {})
          });
  } catch (error) {
    db.close();
    throw error;
  }
  if (options.sqlitePath !== ':memory:' && mode === 'readWrite') {
    await secureSqliteFileModes(options.sqlitePath);
  }
  // Registro de idempotencia de `hebra_edit_note` (`./operations.ts`): tabla propia de
  // hebra-mcp; solo la crea (y la escribe) el escritor.
  if (mode === 'readWrite') ensureOperationsTable(db);
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
  /** Consultas propias ya preparadas (una vez por conexión; `close` las suelta). */
  private readonly statements = new Map<string, StatementSync>();
  private operationStore: OperationStore | null = null;
  /** `meta.library_id`: lo escribe `bootstrapLibraryId` al abrir y nada lo cambia
   *  mientras la conexión vive (`libraryReset` solo borra `binding` y `since_seq`). */
  private libraryIdCache: string | null = null;

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

  /** Consulta propia preparada una sola vez por conexión (como `statementFor` de
   *  `./sqlite-conn-node.ts`). La conexión es de `readBigInts`: igual que antes. */
  private prepared(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** El id de la biblioteca, sin turno de cola tras la primera vez. Solo dentro de un
   *  turno de la cola (la primera llamada lee del motor). */
  private libraryIdSync(): string {
    this.libraryIdCache ??= this.engine.libraryOpen().libraryId;
    return this.libraryIdCache;
  }

  async libraryOpen(): Promise<LibraryOpenInfo> {
    return this.read(() => this.engine.libraryOpen());
  }

  async libraryId(): Promise<string> {
    if (this.libraryIdCache !== null) return this.libraryIdCache;
    return this.read(() => this.libraryIdSync());
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

  /** `resolveLink` de varias refs en UN turno de la cola, en el mismo orden. */
  async resolveLinks(refs: readonly string[]): Promise<LinkResolution[]> {
    return this.read(() =>
      refs.map((ref): LinkResolution => {
        const query = parseLinkRef(ref);
        return query ? this.engine.resolveLink(query) : { status: 'missing', candidates: [] };
      })
    );
  }

  async backlinks(id: string, cursor: string | null = null, limit?: number): Promise<NotesPage> {
    return this.read(() => this.engine.backlinks(id, cursor, limit));
  }

  async search(
    q: string,
    cursor: string | null,
    limit?: number,
    filters?: SearchFilters | null,
    scope?: NotesScope | null
  ): Promise<SearchPage> {
    return this.read(() =>
      cleanSearchPage(this.engine.search(q, cursor, limit, filters ?? null, scope ?? null))
    );
  }

  async notesByTitlePrefix(prefix: string, limit?: number): Promise<TitleCandidates> {
    return this.read(() => this.engine.notesByTitlePrefix(canonicalTitle(prefix), limit));
  }

  /**
   * TODAS las notas vivas cuyo título normalizado (`canonicalTitle`) es exactamente
   * `title`, por id. `notesByTitlePrefix` del motor corta a 50 por prefijo: con más de 50
   * notas del mismo título (o 50 ocultas por privacidad delante de la visible), las que
   * quedan fuera no se veían. SQL propio sobre `notes`/`folders` de `schema.sql`, con la
   * misma carpeta efectiva que `notesByTitlePrefix`; el filtro de privados lo aplica
   * quien llama, sobre TODAS, antes de decidir nada.
   */
  async notesByExactTitle(title: string): Promise<TitleCandidates> {
    const normalized = canonicalTitle(title);
    return this.read(() => {
      const rows = this.prepared(
        `SELECT n.id AS id, n.title AS title,
                CASE WHEN f.id IS NOT NULL AND f.deleted = 0 THEN n.folder_id ELSE 'root' END AS folder_id
         FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
         WHERE n.title_norm = ? AND n.deleted = 0 AND n.trashed_at IS NULL
         ORDER BY n.id`
      ).all(normalized) as Array<{ id: string; title: string | null; folder_id: string }>;
      return {
        items: rows.map((row) => ({
          id: String(row.id),
          title: String(row.title ?? ''),
          folderId: String(row.folder_id)
        }))
      };
    });
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
    return this.read(() => this.visibilityRows());
  }

  /** La consulta de `notesVisibilityIndex`, sin cola: también la usa `writeExclusive`
   *  dentro de su turno. */
  private visibilityRows(): NoteVisibilityEntry[] {
    const rows = this.prepared(
        `SELECT n.id AS id,
                CASE WHEN f.id IS NOT NULL AND f.deleted = 0 THEN n.folder_id ELSE 'root' END AS folder_id,
                GROUP_CONCAT(t.tag, char(10)) AS tags
         FROM notes n
         LEFT JOIN folders f ON f.id = n.folder_id
         LEFT JOIN note_tags t ON t.note_id = n.id
         WHERE n.deleted = 0 AND n.trashed_at IS NULL
         GROUP BY n.id`
    ).all() as Array<{ id: string; folder_id: string; tags: string | null }>;
    return rows.map((row) => ({
      id: row.id,
      folderId: row.folder_id,
      tags: row.tags ? row.tags.split('\n') : []
    }));
  }

  async trashIndex(): Promise<TrashIndex> {
    return this.read(() => this.trashRows());
  }

  /**
   * La consulta de `trashIndex`, sin cola (también la usa `writeExclusive`). SQL propio
   * de hebra-mcp sobre `notes`, `note_tags` y `folders` de `schema.sql`, igual que
   * `visibilityRows`, pero con la carpeta GUARDADA de cada nota (no la efectiva) y todas
   * las filas de carpeta, lápidas incluidas: `folderTrash` de Hebra deja las carpetas
   * como lápida (`deleted = 1`, con su nombre y su padre) y manda sus notas a la
   * papelera sin tocar su `folder_id`, así que solo subiendo por esas filas se sabe si
   * una nota de la papelera venía de una carpeta privada (`src/privacy/trash-filter.ts`).
   */
  private trashRows(): TrashIndex {
    const notes = this.prepared(
        `SELECT n.id AS id, coalesce(n.folder_id, 'root') AS folder_id,
                n.trashed_at AS trashed_at, GROUP_CONCAT(t.tag, char(10)) AS tags
         FROM notes n
         LEFT JOIN note_tags t ON t.note_id = n.id
         WHERE n.deleted = 0 AND n.trashed_at IS NOT NULL
         GROUP BY n.id`
    ).all() as Array<{ id: string; folder_id: string; trashed_at: number; tags: string | null }>;
    const folders = this.prepared('SELECT id, parent_id, name, deleted FROM folders').all() as Array<{ id: string; parent_id: string | null; name: string | null; deleted: number }>;
    return {
      notes: notes.map((row) => ({
        id: row.id,
        folderId: row.folder_id,
        tags: row.tags ? row.tags.split('\n') : [],
        trashedAt: Number(row.trashed_at)
      })),
      folders: folders.map((row) => ({
        id: row.id,
        parentId: row.parent_id,
        name: row.name,
        deleted: Number(row.deleted) !== 0
      }))
    };
  }

  async noteVersionsList(noteId: string): Promise<NoteVersionsList> {
    return this.read(() => this.engine.noteVersionsList(noteId));
  }

  async noteVersionRead(versionId: number): Promise<NoteVersion | null> {
    return this.read(() => this.engine.noteVersionRead(versionId));
  }

  /** Varias versiones con su cuerpo en UN turno de la cola, en el orden pedido; `null` si
   *  ya no existe. */
  async noteVersionsRead(versionIds: readonly number[]): Promise<Array<NoteVersion | null>> {
    return this.read(() => versionIds.map((versionId) => this.engine.noteVersionRead(versionId)));
  }

  /** Si cada versión es el cuerpo de una nota BLOQUEADA, mirando solo el principio del
   *  cuerpo (sin leerlo entero), en UN turno de la cola; `null` si ya no existe. SQL propio
   *  sobre `note_versions` de `schema.sql`; el prefijo es `LOCKED_MARK` de Hebra. */
  async noteVersionsLocked(versionIds: readonly number[]): Promise<Array<boolean | null>> {
    return this.read(() =>
      versionIds.map((versionId) => {
        const row = this.prepared(
          `SELECT substr(body, 1, ${LOCKED_BODY_PREFIX.length}) = '${LOCKED_BODY_PREFIX}' AS locked
           FROM note_versions WHERE id = ?`
        ).get(versionId) as { locked: number | bigint } | undefined;
        return row === undefined ? null : Number(row.locked) !== 0;
      })
    );
  }

  async noteAttachments(noteId: string): Promise<NoteAttachmentRow[]> {
    return this.read(() => this.attachmentRows(noteId));
  }

  /**
   * La consulta de `noteAttachments`, sin cola (también la usa `writeExclusive`). SQL
   * propio de hebra-mcp sobre `note_blob_refs` y `blobs` de `schema.sql`: la fila de
   * `blobs` puede no existir (un `![[sha256:…]]` de otro dispositivo cuyos bytes nunca
   * bajaron) y entonces no se sabe ni el tamaño ni el tipo hasta leerlo.
   */
  private attachmentRows(noteId: string): NoteAttachmentRow[] {
    const rows = this.prepared(
        `SELECT lower(r.sha256) AS sha256, r.ordinal AS ordinal, b.byte_length AS byte_length,
                b.mime AS mime, coalesce(b.present, 0) AS present
         FROM note_blob_refs r
         LEFT JOIN blobs b ON b.sha256 = r.sha256
         WHERE r.note_id = ?
         ORDER BY r.ordinal, r.sha256`
    ).all(noteId) as Array<{
      sha256: string;
      ordinal: number;
      byte_length: number | null;
      mime: string | null;
      present: number;
    }>;
    return rows.map((row) => ({
      sha256: String(row.sha256),
      ordinal: Number(row.ordinal),
      byteLength: row.byte_length === null ? null : Number(row.byte_length),
      mime: row.mime ?? null,
      present: Number(row.present) !== 0
    }));
  }

  async blobRead(sha256: string): Promise<Uint8Array | null> {
    return this.read(() => this.engine.blobRead(sha256));
  }

  /**
   * Ejecuta `operation` en UN turno de la cola, con acceso directo (sin cola) al motor:
   * las operaciones de nota, lo que lee el filtro de privados y el registro de
   * idempotencia. Solo para `./writes.ts`: dentro de `operation` no se puede llamar a
   * ningún otro método de este puerto (esperaría detrás de sí mismo).
   */
  writeExclusive<T>(operation: (store: NoteWriteStore) => Promise<T>): Promise<T> {
    return this.write(() =>
      operation({
        noteCreate: (folderId) => this.engine.noteCreate(folderId ?? null),
        noteRead: async (id) => this.engine.noteRead(id),
        noteSave: (input) => this.engine.noteSave(input),
        noteMove: (id, folderId) => this.engine.noteMove(id, folderId),
        noteSetFavorite: (id, favorite) => this.engine.noteSetFavorite(id, favorite),
        noteArchive: (id) => this.engine.noteArchive(id),
        noteUnarchive: (id) => this.engine.noteUnarchive(id),
        noteTrash: (id) => this.engine.noteTrash(id),
        noteRestore: (id) => this.engine.noteRestore(id),
        noteVersionRead: (versionId) => this.engine.noteVersionRead(versionId),
        noteVersionSnapshot: async (noteId) => {
          await this.engine.noteVersionSnapshot(noteId);
        },
        libraryId: () => this.libraryIdSync(),
        foldersList: () => this.engine.foldersList(),
        notesVisibilityIndex: () => this.visibilityRows(),
        trashIndex: () => this.trashRows(),
        noteAttachments: (noteId) => this.attachmentRows(noteId),
        operations: (this.operationStore ??= sqliteOperationStore(this.db))
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
    this.statements.clear();
    this.operationStore = null;
    this.db.close();
  }
}
