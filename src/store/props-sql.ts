/**
 * Lecturas de las propiedades del frontmatter (`note_props` de `schema.sql`) para
 * `hebra_list_properties` y `hebra_query_properties` (SPEC.md §5, §6.3). El frontmatter no tiene
 * tope de claves ni de valores, así que nada de aquí trae a JS todas las filas: los recuentos se
 * agrupan y se paginan en SQLite y, si hay que mirar valores en JS, se recorren de uno en uno.
 *
 * Por qué no valen las funciones del motor que dan esto ya hecho, medido leyendo
 * `props-store.ts` en `596efe9`:
 * - `propsKeysList` y `propsValues` agrupan en SQL sobre TODAS las notas vivas: sus recuentos
 *   y el tipo de cada clave ya llevan dentro las ocultas, y un recuento bruto no se puede
 *   corregir sin saber qué notas lo forman. `propsValues` además corta a 50 valores, y una
 *   clave con muchos valores ocultos dejaría fuera los visibles.
 * - `propsQuery` decide si una clave ordena como número mirando todos sus valores de la
 *   biblioteca, ocultos y de la papelera incluidos (`allPropValuesNumericPrefixed`): un valor
 *   no numérico en una nota oculta cambiaría el orden de las visibles, y eso lo delata. Y su
 *   cursor solo existe al final de cada página del almacén, no tras una fila cualquiera.
 *   Por eso de ella solo se usa el filtro (`propsFilterSql`): el orden es de hebra-mcp, sobre
 *   lo visible (`src/server/tools/props-order.ts`).
 *
 * El filtro de visibles entra en las consultas como una subconsulta de `./visible-sql.ts`
 * (`withVisibleNotes`), con las reglas del filtro de la llamada (`VisibleNotesScope`, pieza A7 del
 * plan de memoria, 6 nov 2026; antes era una lista con los ids de TODAS las visibles, que obligaba a cargar la biblioteca
 * entera en el filtro): un grupo que solo tienen ocultas no llega a existir. Coste asumido: el
 * recorrido pasa también por las filas de las notas ocultas (solo clave, valor e id), que nunca
 * salen de aquí.
 *
 * Notas bloqueadas: no derivan propiedades (`lockedDerived`), así que una fila de `note_props` de
 * una bloqueada es un resto anterior al bloqueo y no cuenta en ningún sitio: los recuentos y el
 * recorrido de valores solo miran visibles sin bloquear (`is_locked` de esa subconsulta), y
 * `readPropsMatches` las juzga como notas sin propiedades.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  foldFileName,
  propsFilterSql,
  type PropsQueryFilter,
  type PropsQueryFilters,
  type SqliteConn
} from '../hebra';
import { SORT_TEXT_SQL_CHARS } from './props-limits';
import { withVisibleNotes, type VisibleNotesScope } from './visible-sql';

/** Una nota VISIBLE que cumple los filtros de una consulta de propiedades. */
export interface PropsMatch {
  id: string;
  /** Carpeta efectiva (la de `VISIBILITY_COLUMNS`). */
  folderId: string;
  /** Bloqueada: no tiene propiedades, aunque quede alguna fila de antes de bloquearla. */
  locked: boolean;
  title: string;
  /** `notes.title_norm`, la clave de orden por título del motor, en sus primeros caracteres:
   *  el orden no mira más allá, y un título no tiene tope. */
  titleNorm: string;
  /** `notes.local_seq`: el sello de la puerta final (`src/server/privacy-gate.ts`). */
  localSeq: number;
}

/** Una página de recuentos de `hebra_list_properties`. */
export interface PropCountsRequest {
  /** Con clave, sus valores no vacíos. Sin ella, las claves. */
  key?: string;
  /** Las reglas del filtro de la llamada: cuentan las notas visibles y sin bloquear. */
  scope: VisibleNotesScope;
  offset: number;
  limit: number;
  /** Tope de caracteres de la página. El primer elemento sale siempre. */
  maxChars: number;
}

export interface PropCountsPage {
  items: Array<{ name: string; count: number }>;
  /** Queda algo después de lo devuelto. */
  more: boolean;
}

/** Lo que ocupa un elemento serializado: `{"key":…,"count":…},` o `{"value":…,"count":…},`, con el
 *  nombre del campo que le toca. Lo que descuenta de la página. */
function itemChars(name: string, count: number, isValue: boolean): number {
  return JSON.stringify(name).length + String(count).length + (isValue ? 20 : 18);
}

/**
 * Una página de claves o de valores con su recuento, agrupada y ordenada en SQLite. `+p.note_id`
 * no deja usar la clave primaria para el filtro: la consulta recorre `note_props_by_key_value` en
 * orden, sin ordenar nada aparte, y para en cuanto tiene la página. Orden binario, el de la
 * columna. El cursor es una posición (`OFFSET`), que sigue contando solo grupos con notas visibles
 * y sin bloquear: una posición lejana recorre lo anterior, en SQLite y sin traerlo a JS.
 */
export function readPropCounts(db: DatabaseSync, request: PropCountsRequest): PropCountsPage {
  return withVisibleNotes(db, request.scope, ({ table, params }) => {
    const counted = `+p.note_id IN (SELECT id FROM ${table} WHERE NOT is_locked)`;
    const statement =
      request.key === undefined
        ? db.prepare(
            `SELECT p.key AS name, COUNT(DISTINCT p.note_id) AS count
             FROM note_props p
             WHERE ${counted}
             GROUP BY p.key ORDER BY p.key LIMIT ? OFFSET ?`
          )
        : db.prepare(
            `SELECT p.value AS name, COUNT(*) AS count
             FROM note_props p
             WHERE p.key = ? AND p.value <> '' AND ${counted}
             GROUP BY p.value ORDER BY p.value LIMIT ? OFFSET ?`
          );
    // Los parámetros en el orden del texto: la clave (si la hay) antes que los de las visibles.
    const bind = request.key === undefined ? params : [request.key, ...params];
    const items: PropCountsPage['items'] = [];
    let chars = 0;
    let more = false;
    for (const row of statement.iterate(...bind, request.limit + 1, request.offset) as Iterable<Record<string, unknown>>) {
      const name = String(row.name);
      const count = Number(row.count);
      const size = itemChars(name, count, request.key !== undefined);
      if (items.length >= request.limit || (items.length > 0 && chars + size > request.maxChars)) {
        more = true;
        break;
      }
      chars += size;
      items.push({ name, count });
    }
    return { items, more };
  });
}

/**
 * Cada fila no vacía de una clave en una nota visible y sin bloquear (`scope`), de una en una y
 * sin guardarlas: lo que necesita el orden de `hebra_query_properties`, que se queda con un valor
 * por nota. La recorre el índice de la clave, en orden de valor.
 */
export function visitPropValues(
  db: DatabaseSync,
  key: string,
  scope: VisibleNotesScope,
  visit: (noteId: string, value: string) => void
): void {
  withVisibleNotes(db, scope, ({ table, params }) => {
    const statement = db.prepare(
      `SELECT p.note_id AS note_id, p.value AS prop_value FROM note_props p
       WHERE p.key = ? AND p.value <> '' AND +p.note_id IN (SELECT id FROM ${table} WHERE NOT is_locked)`
    );
    for (const row of statement.iterate(key, ...params) as Iterable<Record<string, unknown>>) {
      visit(String(row.note_id), String(row.prop_value));
    }
  });
}

/** Una nota de una página de `hebra_query_properties`, lo que ya ocupa y si tiene valores que leer. */
export interface NoteValuesRequest {
  id: string;
  /** Lo que ocupa serializada sin ningún valor: su id, su título, su carpeta y sus claves. */
  chars: number;
  /** `false` en una bloqueada, que no tiene propiedades, o si no se han pedido. */
  readValues: boolean;
}

/** Los valores de una página de notas, por nota y por clave. */
export interface NotePropValues {
  /** En el orden pedido: una nota que no cupo y las de detrás no están. */
  notes: Array<{ id: string; values: Map<string, string[]> }>;
}

/**
 * Los valores no vacíos de `keys` en esas notas, en orden binario, nota a nota y hasta `maxChars`
 * de la respuesta, contando cada nota entera (`NoteValuesRequest.chars` y sus valores): una nota con
 * miles de valores en una clave no puede traer los de toda la página. La primera sale siempre
 * entera. Sin filtro de privados: quien llama pasa solo notas visibles.
 */
export function readPropValuesOfNotes(
  db: DatabaseSync,
  requested: readonly NoteValuesRequest[],
  keys: readonly string[],
  maxChars: number
): NotePropValues {
  const statement = db.prepare(
    `SELECT p.key AS prop_key, p.value AS prop_value FROM note_props p
     WHERE p.note_id = ? AND p.value <> '' AND p.key IN (SELECT value FROM json_each(?))
     ORDER BY p.key, p.value`
  );
  const wanted = JSON.stringify(keys);
  const notes: NotePropValues['notes'] = [];
  let chars = 0;
  for (const note of requested) {
    chars += note.chars;
    if (notes.length > 0 && chars > maxChars) return { notes };
    const values = new Map<string, string[]>();
    if (note.readValues) {
      for (const row of statement.iterate(note.id, wanted) as Iterable<Record<string, unknown>>) {
        const value = String(row.prop_value);
        chars += JSON.stringify(value).length + 1;
        if (notes.length > 0 && chars > maxChars) return { notes };
        const key = String(row.prop_key);
        const list = values.get(key);
        if (list) list.push(value);
        else values.set(key, [value]);
      }
    }
    notes.push({ id: note.id, values });
    if (chars > maxChars) return { notes };
  }
  return { notes };
}

/** La pseudoclave del título de un filtro de Base: mira `notes.title`, no `note_props`. */
function isTitleFilter(filter: PropsQueryFilter): boolean {
  return filter.key.trim().toLocaleLowerCase('es') === 'note.title';
}

/** Los filtros de `hebra_query_properties` y las reglas del filtro de privados de la llamada. */
export interface PropsMatchesRequest extends PropsQueryFilters {
  scope: VisibleNotesScope;
}

/**
 * Las notas VISIBLES (`scope`) que cumplen los filtros, con el filtro del motor, sin orden: cada
 * comparación mira solo la fila de la nota, nunca el resto de la biblioteca.
 *
 * Una bloqueada se juzga como una nota sin propiedades, tenga las filas que tenga: un filtro que
 * pide un valor no la encuentra (lo contrario confirmaría ese valor), `missing` sí, y los de título
 * miran su título. Por eso no vale un `n.locked = 0` a secas, que la quitaría también de una
 * consulta sin filtros, donde sale como en `hebra_list_notes`.
 */
export function readPropsMatches(
  db: DatabaseSync,
  conn: SqliteConn,
  request: PropsMatchesRequest
): PropsMatch[] {
  const { scope: visibleScope, ...filters } = request;
  const props = filters.props ?? [];
  const unlocked = propsFilterSql(conn, filters);
  const needsValue = props.some((filter) => !isTitleFilter(filter) && filter.op !== 'missing');
  const locked = needsValue ? null : propsFilterSql(conn, { props: props.filter(isTitleFilter) });
  const scope = locked
    ? `((n.locked = 0${unlocked.sql}) OR (n.locked <> 0${locked.sql}))`
    : `n.locked = 0${unlocked.sql}`;
  return withVisibleNotes(db, visibleScope, ({ table, params }) => {
    // Los parámetros en el orden del texto: los de las visibles (en el `JOIN`) y después los filtros.
    const rows = db
      .prepare(
        `SELECT n.id AS id, n.title AS title, substr(n.title_norm, 1, ${SORT_TEXT_SQL_CHARS}) AS title_norm,
                n.local_seq AS local_seq, vn.folder_id AS folder_id, vn.is_locked AS is_locked
         FROM notes n JOIN ${table} vn ON vn.id = n.id
         WHERE n.deleted = 0 AND n.trashed_at IS NULL AND ${scope}`
      )
      .all(...params, ...(unlocked.bind as string[]), ...((locked?.bind ?? []) as string[])) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: String(row.id),
      folderId: String(row.folder_id),
      locked: Number(row.is_locked) !== 0,
      title: String(row.title ?? ''),
      titleNorm: String(row.title_norm ?? ''),
      localSeq: Number(row.local_seq)
    }));
  });
}

/** Un destino de `SearchFilters.linksTo`: una nota viva con su `title_norm`. */
export interface FoldedTitleTarget {
  id: string;
  titleNorm: string;
}

/**
 * Las notas vivas cuyo título entero, plegado con `foldFileName` (sin mayúsculas ni acentos), es
 * `title`: los destinos de `linksTo`, sin filtro de privados. `title_norm` ya está en minúsculas,
 * así que basta la igualdad más, aparte, los títulos con algún carácter de fuera de ASCII, que son
 * los únicos que el plegado puede igualar a otro texto. Sin recorrer todas las notas.
 */
export function readFoldedTitleTargets(db: DatabaseSync, title: string): FoldedTitleTarget[] {
  const needle = foldFileName(title);
  if (!needle) return [];
  const targets = new Map<string, string>();
  const keep = (rows: Iterable<Record<string, unknown>>): void => {
    for (const row of rows) {
      const norm = String(row.title_norm ?? '');
      if (norm && foldFileName(norm) === needle) targets.set(String(row.id), norm);
    }
  };
  keep(db
    .prepare('SELECT id, title_norm FROM notes WHERE title_norm = ? AND deleted = 0 AND trashed_at IS NULL')
    .iterate(needle) as Iterable<Record<string, unknown>>);
  keep(db
    .prepare(
      `SELECT id, title_norm FROM notes
       WHERE deleted = 0 AND trashed_at IS NULL AND length(CAST(title_norm AS BLOB)) > length(title_norm)`
    )
    .iterate() as Iterable<Record<string, unknown>>);
  return [...targets].map(([id, titleNorm]) => ({ id, titleNorm }));
}

/**
 * Las notas que enlazan a alguna de `noteIds`, por id o por título, sin contar el enlace de una nota
 * a sí misma: la regla de `backlinks` del motor, en una consulta en vez de una por página. Sin
 * filtro de privados. Pueden salir notas de la papelera: las quita quien filtra por visibles.
 */
export function readLinkSources(db: DatabaseSync, noteIds: readonly string[]): string[] {
  const ids = JSON.stringify(noteIds);
  const rows = db
    .prepare(
      `SELECT l.src_note_id AS id FROM json_each(?) t
         JOIN links l ON l.target_kind = 'id' AND l.target = t.value
         WHERE l.src_note_id <> t.value
       UNION
       SELECT l.src_note_id FROM json_each(?) t
         JOIN notes d ON d.id = t.value AND d.title_norm <> ''
         JOIN links l ON l.target_kind = 'title' AND l.target = d.title_norm
         WHERE l.src_note_id <> t.value`
    )
    .all(ids, ids) as Array<Record<string, unknown>>;
  return rows.map((row) => String(row.id));
}
