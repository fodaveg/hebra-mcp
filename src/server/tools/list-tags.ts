/**
 * `hebra_list_tags` (SPEC.md §5, §6.3): `{tags:[{tag,count}]}`, anidadas como `a/b`. El
 * recuento se recalcula sobre notas VISIBLES (no el de `tagsList()`, que cuenta TODA la
 * biblioteca): una etiqueta privada, o que solo tienen notas ocultas por carpeta o por
 * otra etiqueta, sale con recuento 0 y se omite. `limit`/`cursor` paginan esa lista ya
 * filtrada (cursor = la última etiqueta devuelta); sin `limit`, todas.
 *
 * Los recuentos se agrupan en SQLite con las reglas del filtro de la llamada
 * (`visibleTagCounts`, `src/store/visible-sql.ts`; pieza A7 del plan de memoria, 6 nov 2026):
 * a JS llega una fila por etiqueta, no una por nota, y el filtro no carga ninguna nota
 * (`privacyLoad: 'lazy'`). Antes recorría `visibleNotes()`, con la biblioteca entera cargada:
 * 104 MiB y 1,1 s por llamada a 30 000 notas.
 */
import { usageOf, type ToolContext } from '../context';
import { LIMITS, effectiveLimit, slicePage } from '../pagination';

export interface TagCount {
  tag: string;
  count: number;
}

export async function runListTags(
  ctx: ToolContext,
  input: { limit?: number; cursor?: string } = {}
): Promise<{ tags: TagCount[]; nextCursor: string | null }> {
  const { tags } = await ctx.port.tagsList();
  const visibleCounts = await ctx.port.visibleTagCounts(ctx.privacy.notesScope());
  // Los recuentos no declaran sus notas a la puerta final (`../privacy-gate.ts`): serían todas
  // las visibles, y juzgarlas allí volvería a cargar la biblioteca entera. Los cubre la época de
  // privacidad, que la llamada toma antes de su filtro: cualquier cambio de notas, carpetas o
  // memoria de carpetas privadas desde entonces hace que la puerta repita la llamada.
  const result: TagCount[] = [];
  const used = usageOf(ctx);
  for (const entry of tags) {
    const count = visibleCounts.get(entry.tag) ?? 0;
    if (count === 0) continue;
    // Y cada etiqueta que sale, contra la configuración de ahora (R3-7 de la 3.ª revisión).
    used.tag(entry.tag);
    result.push({ tag: entry.tag, count });
  }
  const page = slicePage(result, 't1', {
    limit: effectiveLimit(input.limit, LIMITS.listTags),
    cursor: input.cursor,
    keyOf: (entry) => entry.tag
  });
  return { tags: page.items, nextCursor: page.nextCursor };
}
