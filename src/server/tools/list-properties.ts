/**
 * `hebra_list_properties` (D23, SPEC.md §5, §6.3). Sin `key`, las claves del frontmatter con su
 * recuento de notas: `{keys:[{key,count}],nextCursor}`. Con `key`, los valores de esa clave con su
 * recuento: `{values:[{value,count}],nextCursor}`.
 *
 * El patrón de `hebra_list_tags`, con los recuentos solo sobre notas VISIBLES, pero agrupados en
 * SQLite: el frontmatter no tiene tope de claves y traer todas las filas a JS agotaba la memoria
 * (`src/store/props-sql.ts` explica también por qué no sirven los recuentos del motor). Las
 * reglas del filtro de privados entran en la propia consulta (`notesScope`, con la subconsulta de
 * visibles de `src/store/visible-sql.ts`; pieza A7 del plan de memoria, 6 nov 2026): una clave o
 * un valor que solo tienen notas ocultas no llega a formar grupo, y el filtro no carga ninguna
 * nota (`privacyLoad: 'lazy'`). Una clave definida sin valor (`clave:`) cuenta para la clave y no
 * da ningún valor. El tipo de la clave no sale: el del motor se calcula con las ocultas.
 *
 * Orden binario (estable, sin depender de los recuentos). El cursor es la posición en esa lista ya
 * filtrada: no lleva ningún valor, que puede ser más largo que el tope de un cursor. La página se
 * corta antes de `PROPERTIES_RESPONSE_MAX_CHARS`, con `nextCursor`, y siempre lleva un elemento.
 */
import { PROPERTIES_RESPONSE_MAX_CHARS } from '../../store/props-limits';
import type { ToolContext } from '../context';
import { ToolError } from '../errors';
import { LIMITS, effectiveLimit, unwrapCursor, wrapCursor } from '../pagination';

export { PROPERTIES_RESPONSE_MAX_CHARS };

export interface PropertyKeyCount {
  key: string;
  count: number;
}

export interface PropertyValueCount {
  value: string;
  count: number;
}

/** La posición de un cursor de esta lista. Ilegible o de la otra lista, `invalid_input`. */
function positionOf(kind: 'pk1' | 'pv1', cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const position = Number(unwrapCursor(kind, cursor));
  if (!Number.isSafeInteger(position) || position < 0) throw new ToolError('invalid_input');
  return position;
}

export async function runListProperties(
  ctx: ToolContext,
  input: { key?: string; limit?: number; cursor?: string } = {}
): Promise<{ keys: PropertyKeyCount[]; nextCursor: string | null } | { values: PropertyValueCount[]; nextCursor: string | null }> {
  const limit = effectiveLimit(input.limit, LIMITS.listProperties);
  // Las claves se guardan en minúsculas, como pasa `hebra_search` con `props`.
  const key = input.key?.toLowerCase();
  const kind = key === undefined ? 'pk1' : 'pv1';
  const offset = positionOf(kind, input.cursor);
  // Los recuentos salen de todas las visibles sin bloquear, con las reglas del filtro dentro de
  // la consulta (pieza A7 del plan de memoria): el filtro no carga ninguna nota. No las declaran
  // a la puerta final (serían todas): si una deja de verse durante la llamada, la época de
  // privacidad cambia y la puerta la repite. Como `hebra_list_tags`.
  const page = await ctx.port.propCounts({
    ...(key === undefined ? {} : { key }),
    scope: ctx.privacy.notesScope(),
    offset,
    limit,
    maxChars: PROPERTIES_RESPONSE_MAX_CHARS
  });
  const nextCursor = page.more ? wrapCursor(kind, String(offset + page.items.length)) : null;
  if (key === undefined) {
    return { keys: page.items.map(({ name, count }) => ({ key: name, count })), nextCursor };
  }
  return { values: page.items.map(({ name, count }) => ({ value: name, count })), nextCursor };
}
