/**
 * Búsqueda MCP sobre texto de notas, la que se usa con algo privado configurado (sin nada
 * privado, `NodeLibraryPort.search` usa la del motor entera). El motor mezcla notas que
 * casan por cuerpo con notas que casan por dibujos, PDF o nombres de ficheros incrustados.
 * Esos recursos pueden ser privados aunque la nota que los enlaza sea visible (SPEC.md
 * §6.3, M6).
 * Se usa su rama `bodyOnly` para FTS y se añade aquí la rama de subcadenas del MISMO
 * índice de Hebra, sin consultar ningún índice de contenido incrustado.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
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
 * - `props`: aquí solo llegan pares de clave en minúsculas (`searchCheckingValues` comprueba los
 *   valores aparte), que piden que la nota tenga la clave.
 * - `linksTo`: las notas con un enlace a alguna nota de ese título, por id o por título, sin contar
 *   el enlace de una nota a sí misma. Sin destinos, nada.
 */
function filterConditions(db: DatabaseSync, filters: SearchFilters, bind: Array<string | number>): string {
  let conditions = '';
  for (const prop of filters.props ?? []) {
    conditions += ' AND n.id IN (SELECT p.note_id FROM note_props p WHERE p.key = ?)';
    bind.push(prop.key.toLowerCase());
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

/** ¿Hay algún par de `props` con valor? Sin ninguno, la búsqueda va directa, como siempre. */
export function hasValuedProps(filters: SearchFilters | null | undefined): boolean {
  return (filters?.props ?? []).some((prop) => prop.value !== null);
}

/** Valores que se pliegan por turno. Una nota no tiene tope de valores: por encima de esto se suelta
 *  el hilo y se sigue donde iba. */
const VALUE_ROWS_PER_TURN = 20_000;

/** Caracteres que se pliegan por turno, porque plegar cuesta según el largo: unos 45 ms con caracteres
 *  no ASCII (1,8 s por 20 millones, medido). */
const VALUE_CHARS_PER_TURN = 500_000;

/** Los pares con valor por clave en minúsculas, con su valor plegado. */
function valuesByKey(filters: SearchFilters): Map<string, Set<string>> {
  const wanted = new Map<string, Set<string>>();
  for (const prop of filters.props ?? []) {
    if (prop.value === null) continue;
    const key = prop.key.toLowerCase();
    let needles = wanted.get(key);
    if (!needles) wanted.set(key, (needles = new Set()));
    needles.add(foldFileName(prop.value));
  }
  return wanted;
}

/** Lo que recibe la búsqueda interna: cada clave con valor, como un par solo de clave, y una sola
 *  vez. Es un filtro previo: solo mira si la nota tiene la clave. */
function withoutValues(filters: SearchFilters): SearchFilters {
  const keys = new Set((filters.props ?? []).map((prop) => prop.key.toLowerCase()));
  return { ...filters, props: [...keys].map((key) => ({ key, value: null })) };
}

/**
 * ¿Tiene esta nota todos los pares con valor? Mira solo las filas de ESTA nota, plegando en JS con la
 * regla del motor (el valor ENTERO sin mayúsculas ni acentos), y para en cuanto los ha visto todos o
 * le falta una clave. Lee las filas de una en una, así que nunca hay en memoria más que un valor.
 * Es un generador: cede en cuanto el tramo pasa de `VALUE_ROWS_PER_TURN` filas o de
 * `VALUE_CHARS_PER_TURN` caracteres, antes de plegar el valor siguiente, para que quien lo mueve
 * suelte el hilo; cierra la consulta antes de ceder y reanuda detrás del último valor visto. Un valor
 * gigante se pliega entero: no hay forma de partirlo sin cambiar la regla. Devuelve si casa.
 */
function* noteHasValues(
  reads: { first: StatementSync; next: StatementSync },
  noteId: string,
  wanted: ReadonlyMap<string, ReadonlySet<string>>,
  budget: { rows: number; chars: number }
): Generator<void, boolean, void> {
  const spent = (): boolean => budget.rows >= VALUE_ROWS_PER_TURN || budget.chars >= VALUE_CHARS_PER_TURN;
  for (const [key, needles] of wanted) {
    const missing = new Set(needles);
    let after: string | null = null;
    while (missing.size > 0) {
      const rows = (after === null
        ? reads.first.iterate(noteId, key)
        : reads.next.iterate(noteId, key, after)) as Iterable<{ value: string }>;
      let finished = true;
      for (const row of rows) {
        const value = String(row.value);
        missing.delete(foldFileName(value));
        budget.rows += 1;
        budget.chars += value.length;
        if (missing.size === 0 || spent()) {
          after = value;
          finished = false;
          break;
        }
      }
      if (spent()) {
        budget.rows = 0;
        budget.chars = 0;
        yield;
      }
      if (missing.size === 0) break;
      if (finished) return false;
    }
  }
  return true;
}

/** Los resultados de una página que tienen todos los pares con valor, en su orden, hasta `room`. */
function* keptHits(
  db: DatabaseSync,
  items: readonly SearchHit[],
  wanted: ReadonlyMap<string, ReadonlySet<string>>,
  room: number
): Generator<void, SearchHit[], void> {
  const reads = {
    first: db.prepare('SELECT value FROM note_props WHERE note_id = ? AND key = ? ORDER BY value'),
    next: db.prepare('SELECT value FROM note_props WHERE note_id = ? AND key = ? AND value > ? ORDER BY value')
  };
  const kept: SearchHit[] = [];
  const budget = { rows: 0, chars: 0 };
  for (const item of items) {
    if (kept.length >= room) break;
    if (yield* noteHasValues(reads, item.id, wanted, budget)) kept.push(item);
  }
  return kept;
}

/** Suelta el hilo: un `await` de la cola no llega, porque son microtareas y no deja correr a nadie. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * La búsqueda con pares de `props` con valor, el mismo camino con algo privado y sin nada privado
 * (SPEC.md §6.3). El motor no los recibe nunca: con uno, lee todos los valores no ASCII de esa clave
 * en TODA la biblioteca, también los de notas ocultas, y mete como parámetro SQL los que pliegan
 * igual, así que la respuesta y la memoria dependerían de lo oculto.
 *
 * Un solo bucle alrededor de la búsqueda interna (`page`, la del motor o `safeTextSearch`): pide una
 * página de 200 con cada clave como filtro previo, comprueba los pares nota a nota sobre esa página,
 * mirando solo las filas de cada nota, y sigue con el `nextCursor` de la interna hasta llenar `want` o
 * agotarlas. Con el mismo orden y el mismo cursor (`updated_at`, id) que el motor con los pares
 * (`test/store/search-safe-filters.node.test.ts`). El cursor lo decodifica siempre la interna, también
 * si no casa nada: uno inválido da siempre el mismo error.
 *
 * Cada página y cada tramo de comprobación van en su propio turno de la cola (`turn`) y entre dos se
 * suelta el hilo: un recorrido largo tarda más, pero no para a las demás cuentas. `want` es el tope de
 * lo que se guarda.
 */
export async function searchCheckingValues(options: {
  db: DatabaseSync;
  cursor: string | null;
  limit: number | undefined;
  filters: SearchFilters;
  page(cursor: string | null, filters: SearchFilters): SearchPage;
  turn<T>(operation: () => T): Promise<T>;
}): Promise<SearchPage> {
  const want = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const wanted = valuesByKey(options.filters);
  const inner = withoutValues(options.filters);
  const items: SearchHit[] = [];
  let next = options.cursor;
  do {
    const from = next;
    const page: SearchPage = await options.turn(() => options.page(from, inner));
    const checks = keptHits(options.db, page.items, wanted, want - items.length);
    for (;;) {
      const step: IteratorResult<void, SearchHit[]> = await options.turn(() => checks.next());
      if (step.done) {
        items.push(...step.value);
        break;
      }
      await yieldToEventLoop();
    }
    next = page.nextCursor;
    if (next && items.length < want) await yieldToEventLoop();
  } while (next && items.length < want);
  const last = items.at(-1);
  return {
    items,
    nextCursor: last && items.length === want ? encodeCursor([last.updatedAt], last.id) : null
  };
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
