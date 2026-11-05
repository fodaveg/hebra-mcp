/**
 * `hebra_list_properties` (D23, SPEC.md §5, §6.3). Sin `key`, las claves del frontmatter con su
 * recuento de notas: `{keys:[{key,count}],nextCursor}`. Con `key`, los valores de esa clave con su
 * recuento: `{values:[{value,count}],nextCursor}`.
 *
 * El patrón de `hebra_list_tags`: los recuentos se calculan aquí, solo sobre notas VISIBLES, a
 * partir de las filas de `note_props` (`src/store/props-sql.ts` explica por qué no sirven los
 * recuentos del motor). Una clave o un valor que solo tienen notas ocultas se queda en 0 y no sale,
 * sin más filtro. Una clave definida sin valor (`clave:`) cuenta para la clave y no da ningún
 * valor. El tipo de la clave no sale: el del motor se calcula con las ocultas.
 *
 * Orden binario (estable, sin depender de los recuentos). El cursor es la posición en esa lista ya
 * filtrada: no lleva ningún valor, que puede ser más largo que el tope de un cursor.
 */
import { usageOf, type ToolContext } from '../context';
import { LIMITS, effectiveLimit, slicePage } from '../pagination';

export interface PropertyKeyCount {
  key: string;
  count: number;
}

export interface PropertyValueCount {
  value: string;
  count: number;
}

function byBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export async function runListProperties(
  ctx: ToolContext,
  input: { key?: string; limit?: number; cursor?: string } = {}
): Promise<{ keys: PropertyKeyCount[]; nextCursor: string | null } | { values: PropertyValueCount[]; nextCursor: string | null }> {
  const limit = effectiveLimit(input.limit, LIMITS.listProperties);
  // Las claves se guardan en minúsculas, como pasa `hebra_search` con `props`.
  const key = input.key?.toLowerCase();
  const rows = await ctx.port.propRows(key === undefined ? undefined : [key]);
  const visible = ctx.privacy.visibleNotes();
  // Los recuentos salen de todas las visibles: la puerta final las vuelve a juzgar, y si una ya
  // no se ve (la única de un valor), repite la llamada. Como `hebra_list_tags`.
  usageOf(ctx).visibleNotes(visible.keys());

  if (key === undefined) {
    const notesByKey = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!visible.has(row.noteId)) continue;
      let notes = notesByKey.get(row.key);
      if (!notes) notesByKey.set(row.key, (notes = new Set()));
      notes.add(row.noteId);
    }
    const keys = [...notesByKey]
      .map(([name, notes]) => ({ key: name, count: notes.size }))
      .sort((left, right) => byBytes(left.key, right.key));
    const page = slicePage(keys, 'pk1', { limit, cursor: input.cursor });
    return { keys: page.items, nextCursor: page.nextCursor };
  }

  // `note_props` no repite un par (nota, clave, valor): cada fila es una nota más.
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.value === '' || !visible.has(row.noteId)) continue;
    counts.set(row.value, (counts.get(row.value) ?? 0) + 1);
  }
  const values = [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => byBytes(left.value, right.value));
  const page = slicePage(values, 'pv1', { limit, cursor: input.cursor });
  return { values: page.items, nextCursor: page.nextCursor };
}
