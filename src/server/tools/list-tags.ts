/**
 * `hebra_list_tags` (SPEC.md §5, §6.3): `{tags:[{tag,count}]}`, anidadas como `a/b`. El
 * recuento se recalcula sobre notas VISIBLES (no el de `tagsList()`, que cuenta TODA la
 * biblioteca): una etiqueta privada, o que solo tienen notas ocultas por carpeta o por
 * otra etiqueta, sale con recuento 0 y se omite.
 */
import type { ServerContext } from '../context';

export interface TagCount {
  tag: string;
  count: number;
}

export async function runListTags(ctx: ServerContext): Promise<{ tags: TagCount[] }> {
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
  return { tags: result };
}
