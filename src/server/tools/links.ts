/**
 * `hebra_links` (SPEC.md §5, §6.3): `outgoing` (en bruto, resuelto solo si apunta a una
 * nota VISIBLE) y `backlinks` (notas visibles que enlazan aquí). Una nota oculta o
 * inexistente responde `not_found`.
 */
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import { scanOutgoingRefs } from './link-scan';

export interface OutgoingLink {
  ref: string;
  resolvedId?: string;
  title?: string;
}

export interface BacklinkNote {
  id: string;
  title: string;
}

const BACKLINKS_PAGE_SIZE = 100;

export async function runLinks(
  ctx: ToolContext,
  input: { id: string }
): Promise<{ outgoing: OutgoingLink[]; backlinks: BacklinkNote[] }> {
  const meta = ctx.privacy.visibleMeta(input.id);
  if (!meta) throw new ToolError('not_found');
  const note = await ctx.port.noteRead(input.id);
  if (!note || note.trashedAt !== null) throw new ToolError('not_found');

  const outgoing: OutgoingLink[] = [];
  for (const ref of scanOutgoingRefs(note.body)) {
    const resolution = await ctx.port.resolveLink(ref);
    const candidate = resolution.status === 'resolved' ? resolution.candidates[0] : undefined;
    if (candidate && candidate.kind === 'note' && ctx.privacy.visibleMeta(candidate.id)) {
      outgoing.push({ ref, resolvedId: candidate.id, title: candidate.title });
    } else {
      outgoing.push({ ref });
    }
  }

  const backlinks: BacklinkNote[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await ctx.port.backlinks(input.id, cursor, BACKLINKS_PAGE_SIZE);
    for (const item of page.items) {
      if (!ctx.privacy.visibleMeta(item.id)) continue;
      backlinks.push({ id: item.id, title: item.title });
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return { outgoing, backlinks };
}
