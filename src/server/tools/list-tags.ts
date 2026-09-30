/**
 * `hebra_list_tags` (SPEC.md §5, §6.3): `{tags:[{tag,count}]}`, anidadas como `a/b`. El
 * recuento se recalcula sobre notas VISIBLES (no el de `tagsList()`, que cuenta TODA la
 * biblioteca): una etiqueta privada, o que solo tienen notas ocultas por carpeta o por
 * otra etiqueta, sale con recuento 0 y se omite. `limit`/`cursor` paginan esa lista ya
 * filtrada (cursor = la última etiqueta devuelta); sin `limit`, todas.
 */
import type { ToolContext } from '../context';
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
  const visibleCounts = new Map<string, number>();
  for (const { tags: noteTags } of ctx.privacy.visibleNotes().values()) {
    for (const tag of noteTags) visibleCounts.set(tag, (visibleCounts.get(tag) ?? 0) + 1);
  }
  const result: TagCount[] = [];
  for (const entry of tags) {
    const count = visibleCounts.get(entry.tag) ?? 0;
    if (count > 0) result.push({ tag: entry.tag, count });
  }
  const page = slicePage(result, 't1', {
    limit: effectiveLimit(input.limit, LIMITS.listTags),
    cursor: input.cursor,
    keyOf: (entry) => entry.tag
  });
  return { tags: page.items, nextCursor: page.nextCursor };
}
