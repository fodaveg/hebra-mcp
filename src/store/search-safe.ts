/**
 * Búsqueda MCP sobre texto de notas. El motor mezcla notas que casan por cuerpo con
 * notas que casan por dibujos, PDF o nombres de ficheros incrustados. Esos recursos
 * pueden ser privados aunque la nota que los enlaza sea visible (SPEC.md §6.3, M6).
 * Se usa su rama `bodyOnly` para FTS y se añade aquí la rama de subcadenas del MISMO
 * índice de Hebra, sin consultar ningún índice de contenido incrustado.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  decodeCursor,
  encodeCursor,
  ftsExcludedQuery,
  ftsQuery,
  ftsSubstringQuery,
  flushSubstringPending,
  ROOT_FOLDER_ID,
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  sqliteResultCode,
  SqliteLibraryEngine,
  SUBSTRING_INDEX_READY_SQL,
  SUBSTRING_INDEX_VERSION,
  substringResidualSql,
  substringSnippet,
  type NotesScope,
  type SearchFilters,
  type SearchPage,
  type SqliteConn
} from '../hebra';
import { FolderIndex } from '../privacy/folder-index';

type SearchHit = SearchPage['items'][number];

/** Predicados de carpeta que usa el MCP; las demás vistas conservan `bodyOnly` del motor. */
function folderClause(engine: SqliteLibraryEngine, scope: NotesScope | null, bind: Array<string | number>): string {
  if (!scope || scope.kind === 'all') return '';
  if (scope.kind !== 'folder') return ' AND 0';
  if (scope.subfolders && scope.folderId === ROOT_FOLDER_ID) return '';
  if (scope.subfolders) {
    const subtree = FolderIndex.fromList(engine.foldersList()).subtree(scope.folderId);
    if (subtree.length > 1) {
      bind.push(...subtree);
      return ` AND n.folder_id IN (${subtree.map(() => '?').join(', ')})`;
    }
  }
  if (scope.folderId === ROOT_FOLDER_ID) {
    return ` AND (n.folder_id = 'root' OR NOT EXISTS (
      SELECT 1 FROM folders f WHERE f.id = n.folder_id AND f.deleted = 0))`;
  }
  bind.push(scope.folderId);
  return ' AND n.folder_id = ?';
}

/** Una página de la rama de subcadenas, con el mismo orden y cursor que el motor. */
function substringPage(
  engine: SqliteLibraryEngine,
  db: DatabaseSync,
  query: string,
  cursor: string | null,
  limit: number,
  filters: SearchFilters,
  scope: NotesScope | null
): SearchHit[] {
  const substring = ftsSubstringQuery(query);
  if (!substring.candidates) return [];
  const { query: match, literal } = ftsQuery(query);
  if (!match) return [];

  const bind: Array<string | number> = [substring.candidates, match];
  let conditions = '';
  if (substring.residual) conditions += ` AND ${substringResidualSql(substring.residual, false, bind)}`;
  const prefixExcluded = literal ? '' : ftsExcludedQuery(query);
  if (prefixExcluded) {
    conditions += ' AND n.rowid NOT IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)';
    bind.push(prefixExcluded);
  }
  if (substring.excluded) {
    conditions += ' AND n.rowid NOT IN (SELECT rowid FROM notes_trigram WHERE notes_trigram MATCH ?)';
    bind.push(substring.excluded);
  }
  conditions += folderClause(engine, scope, bind);
  for (const tag of filters.tags ?? []) {
    conditions += ' AND n.id IN (SELECT t.note_id FROM note_tags t WHERE t.tag = ?)';
    bind.push(tag);
  }
  if (cursor) {
    const after = decodeCursor(cursor, 1);
    conditions += ' AND (n.updated_at, n.id) < (?, ?)';
    bind.push(after.keys[0]!, after.id);
  }
  bind.push(limit);
  const rows = db.prepare(`SELECT n.id, n.title, n.updated_at, n.favorite, n.conflict_of,
      CASE WHEN n.locked = 1 THEN '' ELSE n.body END AS body
    FROM notes_trigram CROSS JOIN notes n ON n.rowid = notes_trigram.rowid
    WHERE notes_trigram MATCH ?
      AND n.rowid NOT IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)
      AND n.deleted = 0 AND n.trashed_at IS NULL${conditions}
    ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`).all(...bind) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ''),
    updatedAt: Number(row.updated_at),
    favorite: Number(row.favorite) === 1,
    conflict: row.conflict_of !== null,
    snippet: substringSnippet(String(row.body ?? ''), substring.needles, {
      start: SEARCH_MARK_START, end: SEARCH_MARK_END
    }, 12)
  }));
}

/** Página del motor sin ficheros incrustados y con subcadenas de la propia nota. */
export function safeTextSearch(
  engine: SqliteLibraryEngine,
  db: DatabaseSync,
  query: string,
  cursor: string | null,
  limit: number | undefined,
  filters: SearchFilters | null,
  scope: NotesScope | null,
  conn?: SqliteConn,
  writable = false
): SearchPage {
  const want = Math.min(Math.max(limit ?? 50, 1), 200);
  const safeFilters: SearchFilters = { ...filters, bodyOnly: true };
  // Otros consumidores (menciones sin enlazar) piden explícitamente solo FTS exacto.
  if (filters?.bodyOnly === true) return engine.search(query, cursor, want, safeFilters, scope);
  const ready = db.prepare(SUBSTRING_INDEX_READY_SQL).get(SUBSTRING_INDEX_VERSION) !== undefined;
  const substring = ready ? ftsSubstringQuery(query) : null;
  if (substring && (substring.candidates || substring.excluded) && writable && conn) {
    try {
      flushSubstringPending(conn);
    } catch (error) {
      const code = sqliteResultCode(error);
      if (code === null) throw error;
      console.warn('substring_flush', code);
    }
  }
  // Un término negativo por subcadena también excluye las coincidencias FTS normales.
  const excluded = substring?.excluded;
  const exactItems: SearchHit[] = [];
  let exactCursor = cursor;
  let exact: SearchPage;
  do {
    exact = engine.search(query, exactCursor, want, safeFilters, scope);
    exactItems.push(...(excluded
      ? exact.items.filter((hit) => !db.prepare(`SELECT 1 FROM notes_trigram
          WHERE notes_trigram MATCH ? AND rowid = (SELECT rowid FROM notes WHERE id = ?)`)
          .get(excluded, hit.id))
      : exact.items));
    exactCursor = exact.nextCursor;
  } while (excluded && exactItems.length < want && exactCursor);
  const substringItems = scope && scope.kind !== 'folder' && scope.kind !== 'all'
    ? []
    : ready ? substringPage(engine, db, query, cursor, want, safeFilters, scope) : [];
  const byId = new Map<string, SearchHit>();
  for (const item of [...exactItems, ...substringItems]) if (!byId.has(item.id)) byId.set(item.id, item);
  const items = [...byId.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, want);
  return {
    ...exact,
    items,
    nextCursor: items.length === want ? encodeCursor([items[items.length - 1]!.updatedAt], items[items.length - 1]!.id) : null
  };
}
