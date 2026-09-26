/**
 * `HebraLibraryPort` (`./types.ts`) en proceso, sobre `SqliteLibraryEngine` de Hebra y el
 * adaptador `node:sqlite` de `./sqlite-conn-node.ts`. Deliberadamente NO reutiliza
 * `LocalLibraryPort` (`$lib/library/local-port`): ese puerto delega `tagRename` y
 * `tagsReindex` en `tag-rename.ts`/`tags-reindex.ts`, que llaman a `deriveNote` (para
 * recalcular título/etiquetas/enlaces al reescribir), y `deriveNote` importa
 * `notes/markdown.ts` → `markdown/dialect.ts` → `@codemirror/lang-markdown`, que arrastra
 * `@codemirror/view`. Medido con esbuild (26 sep 2026): ese paquete deja en el bundle
 * texto literal `document.`/`window.`/`navigator.` (guardado tras `typeof document !==
 * 'undefined'`, así que carga y analiza bien bajo Node — se probó — pero el TEXTO sigue
 * ahí), lo que el check de L0 (`scripts/check-bundle.mjs`) tiene que poder rechazar sin
 * falsos negativos. v1 nunca llama a `tagRename` ni a `tagsReindex` (D2), así que este
 * puerto usa `SqliteLibraryEngine` directamente y solo importa de `derive.ts` lo que NO
 * toca el analizador de markdown (`parseLinkRef`, `canonicalTitle`): con eso el bundle
 * queda limpio (comprobado, ver `check:bundle`). Si un lote futuro (L3) necesita derivar
 * título/etiquetas de un cuerpo Markdown para `hebra_create_note`/`hebra_append_to_note`,
 * hará falta `deriveNote` y esta nota deja de aplicar: hay que volver a medir el bundle.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SqliteLibraryEngine } from '$lib/library/sqlite-engine';
import { canonicalTitle, parseLinkRef } from '$lib/library/derive';
import { cleanSearchPage } from '$lib/library/search-snippet';
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
import { openNodeSqliteConn } from './sqlite-conn-node';
import { FsBlobStore } from './blob-store-fs';
import type { HebraLibraryPort } from './types';

export interface OpenNodeLibraryOptions {
  /** Ruta del fichero SQLite, o `:memory:` (tests). */
  sqlitePath: string;
  /** Directorio de datos, donde cuelga `blobs/`. Sin él, los adjuntos se guardan en
   *  memoria (`MemoryBlobStore` de Hebra): basta para los tests, v1 no sirve adjuntos. */
  dataDir?: string;
  deviceLabel?: string;
}

export async function openNodeLibraryPort(
  options: OpenNodeLibraryOptions
): Promise<NodeLibraryPort> {
  if (options.sqlitePath !== ':memory:') {
    await mkdir(dirname(options.sqlitePath), { recursive: true, mode: 0o700 });
  }
  const { db, conn } = openNodeSqliteConn(options.sqlitePath);
  const blobs = options.dataDir ? new FsBlobStore(options.dataDir) : undefined;
  const engine = await SqliteLibraryEngine.open(conn, options.deviceLabel ?? 'hebra-mcp', {
    ...(blobs ? { blobs } : {})
  });
  // `SqliteLibraryEngine.open` ya dejó `journal_mode=DELETE` (pensado para una única
  // conexión web, §3 de sqlite-engine.ts). hebra-mcp SÍ quiere lectores concurrentes
  // (SPEC.md §8: un escritor, los demás en solo lectura), así que sube a WAL DESPUÉS de
  // que el esquema exista. Sin efecto sobre `:memory:` (SQLite no hace WAL ahí).
  db.exec('PRAGMA journal_mode=WAL');
  return new NodeLibraryPort(engine, db);
}

export class NodeLibraryPort implements HebraLibraryPort {
  constructor(
    private readonly engine: SqliteLibraryEngine,
    private readonly db: DatabaseSync
  ) {}

  async libraryOpen(): Promise<LibraryOpenInfo> {
    return this.engine.libraryOpen();
  }

  async noteCreate(folderId?: string | null): Promise<NoteRow> {
    return this.engine.noteCreate(folderId ?? null);
  }

  async noteRead(id: string): Promise<NoteRow | null> {
    return this.engine.noteRead(id);
  }

  async noteSave(input: NoteSaveInput): Promise<NoteSaveResult> {
    return this.engine.noteSave(input);
  }

  async notesPage(cursor: string | null, limit: number, scope?: NotesScope): Promise<NotesPage> {
    return this.engine.notesPage(cursor, limit, scope);
  }

  async foldersList(): Promise<FoldersList> {
    return this.engine.foldersList();
  }

  async tagsList(): Promise<TagsList> {
    return this.engine.tagsList();
  }

  async resolveLink(ref: string): Promise<LinkResolution> {
    const query = parseLinkRef(ref);
    return query ? this.engine.resolveLink(query) : { status: 'missing', candidates: [] };
  }

  async backlinks(id: string, cursor: string | null = null, limit?: number): Promise<NotesPage> {
    return this.engine.backlinks(id, cursor, limit);
  }

  async search(
    q: string,
    cursor: string | null,
    limit?: number,
    filters?: SearchFilters | null
  ): Promise<SearchPage> {
    return cleanSearchPage(this.engine.search(q, cursor, limit, filters ?? null));
  }

  async notesByTitlePrefix(prefix: string, limit?: number): Promise<TitleCandidates> {
    return this.engine.notesByTitlePrefix(canonicalTitle(prefix), limit);
  }

  close(): void {
    this.db.close();
  }
}
