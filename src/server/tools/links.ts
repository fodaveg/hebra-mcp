/**
 * `hebra_links` (SPEC.md §5, §6.3): `outgoing` (en bruto, resuelto solo si apunta a una
 * nota VISIBLE) y `backlinks` (notas visibles que enlazan aquí). Una nota oculta o
 * inexistente responde `not_found`.
 *
 * Paginación (`pagination.ts`): `limit` vale para cada lista y `cursor` es UNO para las
 * dos (`l1.…`, opaco: posición en `outgoing` y cursor de backlinks). `nextCursor` existe
 * si a alguna le queda algo; la que ya terminó sale vacía en las páginas siguientes.
 * `outgoing` no delata nada por su tamaño (lista todos los enlaces del cuerpo, resueltos
 * o no) y `backlinks` se rellena solo con notas visibles.
 */
import { encodeCursor } from '../../hebra';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import {
  LIMITS,
  effectiveLimit,
  fillPage,
  slicePage,
  storePageSize,
  unwrapCursor,
  wrapCursor
} from '../pagination';
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

/** Contenido del cursor: `o` = posición en `outgoing`, `b` = cursor de backlinks del
 *  almacén. Una parte ausente = esa lista ya terminó (en la primera página, ambas
 *  empiezan desde el principio). */
interface LinksCursor {
  o?: number;
  b?: string;
}

function parseCursor(cursor: string | undefined): { o: number; b: string | null; outDone: boolean; backDone: boolean } {
  if (cursor === undefined) return { o: 0, b: null, outDone: false, backDone: false };
  let parsed: LinksCursor;
  try {
    parsed = JSON.parse(unwrapCursor('l1', cursor)) as LinksCursor;
  } catch {
    throw new ToolError('invalid_input');
  }
  if (!parsed || typeof parsed !== 'object') throw new ToolError('invalid_input');
  if (parsed.o !== undefined && (!Number.isInteger(parsed.o) || parsed.o < 0)) {
    throw new ToolError('invalid_input');
  }
  if (parsed.b !== undefined && typeof parsed.b !== 'string') throw new ToolError('invalid_input');
  return {
    o: parsed.o ?? 0,
    b: parsed.b ?? null,
    outDone: parsed.o === undefined,
    backDone: parsed.b === undefined
  };
}

export async function runLinks(
  ctx: ToolContext,
  input: { id: string; limit?: number; cursor?: string }
): Promise<{ outgoing: OutgoingLink[]; backlinks: BacklinkNote[]; nextCursor: string | null }> {
  const limit = effectiveLimit(input.limit, LIMITS.links);
  const position = parseCursor(input.cursor);
  const meta = ctx.privacy.visibleMeta(input.id);
  if (!meta) throw new ToolError('not_found');
  const note = await ctx.port.noteRead(input.id);
  if (!note || note.trashedAt !== null) throw new ToolError('not_found');

  // Outgoing: la lista de refs sale del cuerpo entero; solo se resuelven los de la página.
  const outgoing: OutgoingLink[] = [];
  let nextOutgoing: number | undefined;
  if (!position.outDone) {
    const refs = scanOutgoingRefs(note.body);
    const start = Math.min(position.o, refs.length);
    const page = slicePage(refs.slice(start), 'l1', { limit });
    // Todas las refs de la página, en UN turno de la cola del almacén.
    const resolutions = await ctx.port.resolveLinks(page.items);
    for (const [index, ref] of page.items.entries()) {
      const resolution = resolutions[index]!;
      const candidate = resolution.status === 'resolved' ? resolution.candidates[0] : undefined;
      if (candidate && candidate.kind === 'note' && ctx.privacy.visibleMeta(candidate.id)) {
        outgoing.push({ ref, resolvedId: candidate.id, title: candidate.title });
      } else {
        outgoing.push({ ref });
      }
    }
    if (page.nextCursor !== null) nextOutgoing = start + page.items.length;
  }

  const backlinks: BacklinkNote[] = [];
  let nextBacklinks: string | undefined;
  if (!position.backDone) {
    const page = await fillPage({
      limit,
      startCursor: position.b,
      fetch: (cursor, want) => ctx.port.backlinks(input.id, cursor, storePageSize(want)),
      accept: (item) =>
        ctx.privacy.visibleMeta(item.id) ? { id: item.id, title: item.title } : undefined,
      cursorAfter: (item) => encodeCursor([item.favorite ? 1 : 0, item.updatedAt], item.id)
    });
    backlinks.push(...page.items);
    if (page.lastCursor !== null) nextBacklinks = page.lastCursor;
  }

  if (nextOutgoing === undefined && nextBacklinks === undefined) {
    return { outgoing, backlinks, nextCursor: null };
  }
  const payload: LinksCursor = {};
  if (nextOutgoing !== undefined) payload.o = nextOutgoing;
  if (nextBacklinks !== undefined) payload.b = nextBacklinks;
  return { outgoing, backlinks, nextCursor: wrapCursor('l1', JSON.stringify(payload)) };
}
