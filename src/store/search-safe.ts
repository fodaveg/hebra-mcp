/**
 * Búsqueda MCP sobre texto de notas, la que se usa con algo privado configurado (sin nada
 * privado, `NodeLibraryPort.search` usa la del motor entera). El motor mezcla notas que
 * casan por cuerpo con notas que casan por dibujos, PDF o nombres de ficheros incrustados.
 * Esos recursos pueden ser privados aunque la nota que los enlaza sea visible (SPEC.md
 * §6.3, M6).
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
  foldFileName,
  ROOT_FOLDER_ID,
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  sqliteResultCode,
  SqliteLibraryEngine,
  SUBSTRING_INDEX_READY_SQL,
  SUBSTRING_INDEX_VERSION,
  substringColumn,
  substringResidualSql,
  substringSnippet,
  type NotesScope,
  type SearchFilters,
  type SearchPage,
  type SqliteConn
} from '../hebra';
import { FolderIndex } from '../privacy/folder-index';
import { readFoldedTitleTargets } from './props-sql';

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

/**
 * `props` y `linksTo` como condiciones de la rama de subcadenas, con sus `?` en `bind`: las evalúa
 * SQLite una vez por consulta. Antes se pedían al motor todas las notas que los cumplen (su búsqueda
 * sin texto, de 200 en 200, con todas sus subconsultas en cada página), lo que paraba el hilo varios
 * segundos con una biblioteca grande. Son las reglas de `searchKeyed` del motor, que no las expone
 * sueltas, y `test/store/search-safe-filters.node.test.ts` las compara con él, caso a caso:
 * - La clave, en minúsculas. Sin valor, que la nota tenga la clave. Con valor, el valor ENTERO sin
 *   mayúsculas ni acentos. Los valores de una clave se pliegan aquí de uno en uno, una sola pasada
 *   por clave aunque haya varios pares sobre ella, sin guardar más que los que casan, y entran como
 *   lista: así la condición usa el índice en vez de comparar cada fila una vez por par.
 * - `linksTo`: las notas con un enlace a alguna nota de ese título, por id o por título, sin contar
 *   el enlace de una nota a sí misma. Sin destinos, nada.
 */
function filterConditions(db: DatabaseSync, filters: SearchFilters, bind: Array<string | number>): string {
  let conditions = '';
  const wanted = new Map<string, Map<string, string[]>>();
  for (const prop of filters.props ?? []) {
    if (prop.value === null) continue;
    const key = prop.key.toLowerCase();
    let needles = wanted.get(key);
    if (!needles) wanted.set(key, (needles = new Map()));
    needles.set(foldFileName(prop.value), []);
  }
  const distinctValues = db.prepare('SELECT DISTINCT value FROM note_props WHERE key = ?');
  for (const [key, needles] of wanted) {
    for (const row of distinctValues.iterate(key) as Iterable<{ value: string }>) {
      const value = String(row.value);
      needles.get(foldFileName(value))?.push(value);
    }
  }
  for (const prop of filters.props ?? []) {
    const key = prop.key.toLowerCase();
    if (prop.value === null) {
      conditions += ' AND n.id IN (SELECT p.note_id FROM note_props p WHERE p.key = ?)';
      bind.push(key);
      continue;
    }
    const values = wanted.get(key)!.get(foldFileName(prop.value))!;
    if (values.length === 0) return ' AND 0';
    conditions += ` AND n.id IN (SELECT p.note_id FROM note_props p WHERE p.key = ?
      AND p.value IN (SELECT value FROM json_each(?)))`;
    bind.push(key, JSON.stringify(values));
  }
  for (const title of filters.linksTo ?? []) {
    const targets = readFoldedTitleTargets(db, title).map((target) => [target.id, target.titleNorm]);
    if (targets.length === 0) return ' AND 0';
    const json = JSON.stringify(targets);
    conditions += ` AND n.id IN (
      SELECT l.src_note_id FROM json_each(?) t
        JOIN links l ON l.target_kind = 'id' AND l.target = json_extract(t.value, '$[0]')
        WHERE l.src_note_id <> json_extract(t.value, '$[0]')
      UNION
      SELECT l.src_note_id FROM json_each(?) t
        JOIN links l ON l.target_kind = 'title' AND l.target = json_extract(t.value, '$[1]')
        WHERE l.src_note_id <> json_extract(t.value, '$[0]'))`;
    bind.push(json, json);
  }
  return conditions;
}

/**
 * Valores distintos no ASCII de una clave a partir de los cuales una búsqueda con un par de esa
 * clave no los deja en manos del motor: `searchKeyed` los trae todos a JS en cada página y por cada
 * par, y con 750 000 agota 256 MiB de memoria con un solo par (medido; SPEC.md §6.3). Muy por encima
 * de lo que tiene una biblioteca normal, y por debajo del límite de variables de SQLite.
 */
const ENGINE_FOLDED_VALUES_MAX = 20_000;

/** ¿Algún par con valor apunta a una clave que el motor no debe plegar? Mira como mucho
 *  `ENGINE_FOLDED_VALUES_MAX` valores distintos por clave, en SQLite y sin traerlos. */
function overloadsEngine(db: DatabaseSync, filters: SearchFilters | null): boolean {
  const keys = new Set(
    (filters?.props ?? []).filter((prop) => prop.value !== null).map((prop) => prop.key.toLowerCase())
  );
  if (keys.size === 0) return false;
  const statement = db.prepare(`SELECT 1 FROM (
      SELECT DISTINCT value FROM note_props WHERE key = ? AND length(CAST(value AS BLOB)) > length(value)
    ) LIMIT 1 OFFSET ?`);
  for (const key of keys) {
    if (statement.get(key, ENGINE_FOLDED_VALUES_MAX) !== undefined) return true;
  }
  return false;
}

/** ¿Es el error del motor con demasiadas variantes plegadas de un valor? Solo ese. */
function isTooManyVariables(error: unknown): boolean {
  return error instanceof Error && error.message.includes('too many SQL variables');
}

/**
 * Una página del motor sin los pares con valor, que se comprueban aquí con el SQL de arriba, sobre
 * cada página de resultados: el mismo orden y el mismo cursor (`updated_at`, id) que si los hubiera
 * filtrado él. Pide páginas hasta llenar la de `want` o agotarlas: más caro si casan pocas, y solo
 * se usa cuando el motor no puede con esos pares.
 */
export function searchFilteringValues(
  engine: SqliteLibraryEngine,
  db: DatabaseSync,
  query: string,
  cursor: string | null,
  want: number,
  filters: SearchFilters,
  scope: NotesScope | null
): SearchPage {
  const valued = (filters.props ?? []).filter((prop) => prop.value !== null);
  const rest = (filters.props ?? []).filter((prop) => prop.value === null);
  const engineFilters: SearchFilters = { ...filters, props: rest };
  const bind: Array<string | number> = [];
  const conditions = filterConditions(db, { props: valued }, bind);
  if (conditions === ' AND 0') return { items: [], nextCursor: null };
  const accepted = db.prepare(
    `SELECT n.id AS id FROM notes n WHERE n.id IN (SELECT value FROM json_each(?))${conditions}`
  );
  const items: SearchHit[] = [];
  let next = cursor;
  do {
    const page = engine.search(query, next, 200, engineFilters, scope);
    const kept = new Set(
      (accepted.all(JSON.stringify(page.items.map((item) => item.id)), ...bind) as Array<{ id: string }>)
        .map((row) => String(row.id))
    );
    items.push(...page.items.filter((item) => kept.has(item.id)));
    next = page.nextCursor;
  } while (next && items.length < want);
  const shown = items.slice(0, want);
  const last = shown.at(-1);
  return {
    items: shown,
    nextCursor: last && shown.length === want ? encodeCursor([last.updatedAt], last.id) : null
  };
}

/**
 * La búsqueda entera del motor (sin nada privado configurado), salvo con una clave que no debe
 * plegar (`overloadsEngine`). El error de demasiadas variables se queda como está: sin nada privado
 * no hay nada que ocultar y lo provocan los valores que el usuario puede ver.
 */
export function engineSearch(
  engine: SqliteLibraryEngine,
  db: DatabaseSync,
  query: string,
  cursor: string | null,
  limit: number | undefined,
  filters: SearchFilters | null,
  scope: NotesScope | null
): SearchPage {
  if (filters && overloadsEngine(db, filters)) {
    const want = Math.min(Math.max(limit ?? 50, 1), 200);
    return searchFilteringValues(engine, db, query, cursor, want, filters, scope);
  }
  return engine.search(query, cursor, limit, filters, scope);
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
  const { query: parsed, literal } = ftsQuery(query);
  if (!parsed) return [];
  // `titleOnly`: las dos consultas y lo excluido, solo en la columna `title`. Sin él, igual.
  const titleOnly = filters.titleOnly === true;
  const match = substringColumn(parsed, titleOnly);

  const bind: Array<string | number> = [substringColumn(substring.candidates, titleOnly), match];
  let conditions = '';
  if (substring.residual) conditions += ` AND ${substringResidualSql(substring.residual, titleOnly, bind)}`;
  const prefixExcluded = literal ? '' : ftsExcludedQuery(query);
  if (prefixExcluded) {
    conditions += ' AND n.rowid NOT IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)';
    bind.push(substringColumn(prefixExcluded, titleOnly));
  }
  if (substring.excluded) {
    conditions += ' AND n.rowid NOT IN (SELECT rowid FROM notes_trigram WHERE notes_trigram MATCH ?)';
    bind.push(substringColumn(substring.excluded, titleOnly));
  }
  conditions += folderClause(engine, scope, bind);
  for (const tag of filters.tags ?? []) {
    conditions += ' AND n.id IN (SELECT t.note_id FROM note_tags t WHERE t.tag = ?)';
    bind.push(tag);
  }
  const filterBind: Array<string | number> = [];
  const filterSql = filterConditions(db, filters, filterBind);
  if (filterSql === ' AND 0') return [];
  conditions += filterSql;
  bind.push(...filterBind);
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
  const excluded = substring?.excluded
    ? substringColumn(substring.excluded, filters?.titleOnly === true)
    : undefined;
  const exactItems: SearchHit[] = [];
  let exactCursor = cursor;
  let exact: SearchPage;
  // Los valores de la clave cuentan también los de notas ocultas: ni la memoria ni un error del
  // motor por demasiadas variantes pueden depender de ellas. Por eso, con pares que no puede
  // plegar, los filtra aquí, y la respuesta es la misma haya o no esas filas (§6.3).
  let ownValues = overloadsEngine(db, safeFilters);
  const exactPage = (from: string | null): SearchPage => {
    if (ownValues) return searchFilteringValues(engine, db, query, from, want, safeFilters, scope);
    try {
      return engine.search(query, from, want, safeFilters, scope);
    } catch (error) {
      if (!isTooManyVariables(error)) throw error;
      ownValues = true;
      return searchFilteringValues(engine, db, query, from, want, safeFilters, scope);
    }
  };
  do {
    exact = exactPage(exactCursor);
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
