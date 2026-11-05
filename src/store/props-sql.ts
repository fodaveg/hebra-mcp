/**
 * Lecturas de las propiedades del frontmatter (`note_props` de `schema.sql`) para
 * `hebra_list_properties` y `hebra_query_properties` (SPEC.md §5, §6.3). Devuelven FILAS, sin
 * agrupar ni ordenar, y sin filtro de privados: lo aplica la herramienta, nota a nota.
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
 * Coste asumido: la consulta recorre también las filas de las notas ocultas (solo id, clave y
 * valor), que nunca salen de aquí; como `notesVisibilityIndex`, que ya lee sus etiquetas.
 * Las notas bloqueadas no derivan propiedades (`lockedDerived`), y `n.locked = 0` asegura que
 * una fila anterior al bloqueo no salga aunque siguiera ahí.
 */
import type { DatabaseSync } from 'node:sqlite';
import { foldFileName, propsFilterSql, type PropsQueryFilters, type SqliteConn } from '../hebra';

/** Una fila de `note_props` de una nota viva: la nota, la clave y UN valor (`''` si la clave
 *  está definida sin valor). */
export interface PropRow {
  noteId: string;
  key: string;
  value: string;
}

/** Una nota viva que cumple los filtros de una consulta de propiedades. */
export interface PropsMatch {
  id: string;
  title: string;
  /** `notes.title_norm`, la clave de orden por título del motor. */
  titleNorm: string;
  /** `notes.local_seq`: el sello de la puerta final (`src/server/privacy-gate.ts`). */
  localSeq: number;
}

/** Lo que lee una consulta de propiedades, de un mismo turno de la cola. */
export interface PropsScan {
  matches: PropsMatch[];
  props: PropRow[];
}

/** Las filas de esas claves (todas si no se dan). Sin filtro de privados. */
export function readPropRows(db: DatabaseSync, keys?: readonly string[]): PropRow[] {
  const byKey = keys ? ' AND p.key IN (SELECT value FROM json_each(?))' : '';
  const rows = db
    .prepare(
      `SELECT p.note_id AS note_id, p.key AS prop_key, p.value AS prop_value
       FROM note_props p JOIN notes n ON n.id = p.note_id
       WHERE n.deleted = 0 AND n.trashed_at IS NULL AND n.locked = 0${byKey}`
    )
    .all(...(keys ? [JSON.stringify(keys)] : [])) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    noteId: String(row.note_id),
    key: String(row.prop_key),
    value: String(row.prop_value ?? '')
  }));
}

/** Las notas vivas que cumplen `filters`, con el filtro del motor, sin orden: cada comparación
 *  mira solo la fila de la nota, nunca el resto de la biblioteca. Sin filtro de privados. */
export function readPropsMatches(
  db: DatabaseSync,
  conn: SqliteConn,
  filters: PropsQueryFilters
): PropsMatch[] {
  const where = propsFilterSql(conn, filters);
  const rows = db
    .prepare(
      `SELECT n.id AS id, n.title AS title, n.title_norm AS title_norm, n.local_seq AS local_seq
       FROM notes n WHERE n.deleted = 0 AND n.trashed_at IS NULL${where.sql}`
    )
    .all(...(where.bind as string[])) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ''),
    titleNorm: String(row.title_norm ?? ''),
    localSeq: Number(row.local_seq)
  }));
}

/**
 * Ids de las notas vivas cuyo título entero, plegado con `foldFileName` (sin mayúsculas ni
 * acentos), es `title`: los destinos que tendría `SearchFilters.linksTo`, para que
 * `hebra_search` se quede con los visibles. Sin filtro de privados. Recorre `title_norm` de
 * todas las notas: el plegado de los acentos no lo sabe hacer SQLite.
 */
export function readIdsByFoldedTitle(db: DatabaseSync, title: string): string[] {
  const needle = foldFileName(title);
  if (!needle) return [];
  const rows = db
    .prepare('SELECT id, title_norm FROM notes WHERE deleted = 0 AND trashed_at IS NULL')
    .all() as Array<Record<string, unknown>>;
  return rows
    .filter((row) => foldFileName(String(row.title_norm ?? '')) === needle)
    .map((row) => String(row.id));
}
