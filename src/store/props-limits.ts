/**
 * Topes de las propiedades del frontmatter que comparten el almacén y las herramientas
 * (SPEC.md §5, §6.3).
 */

/** Puntos de código de un valor o un título que entran en la clave de orden y en el cursor de
 *  `hebra_query_properties`: `substr` de SQLite y el recorte de `src/server/tools/props-order.ts`
 *  cuentan lo mismo. */
export const SORT_TEXT_SQL_CHARS = 128;

/** Caracteres de una respuesta de `hebra_list_properties` o `hebra_query_properties`, como el
 *  tope de `hebra_grep`: la página se corta antes, con `nextCursor`, y siempre lleva un elemento. */
export const PROPERTIES_RESPONSE_MAX_CHARS = 100_000;
