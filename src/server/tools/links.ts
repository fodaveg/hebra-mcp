/**
 * `hebra_links` (SPEC.md §5, §6.3): `outgoing` (en bruto, resuelto solo si apunta a una
 * nota VISIBLE, y por título decidido solo entre las visibles: M1 del audit de privacidad)
 * y `backlinks` (notas visibles que enlazan aquí). Una nota oculta o inexistente responde
 * `not_found`.
 *
 * Paginación (`pagination.ts`): `limit` vale para cada lista y `cursor` es UNO para las
 * dos (`l1.…`, opaco: posición en `outgoing` y cursor de backlinks). `nextCursor` existe
 * si a alguna le queda algo; la que ya terminó sale vacía en las páginas siguientes.
 * `outgoing` no delata nada por su tamaño (lista todos los enlaces del cuerpo, resueltos
 * o no) y `backlinks` se rellena solo con notas visibles.
 */
import { encodeCursor, parseLinkRef } from '../../hebra';
import { ToolError } from '../errors';
import { usageOf, type ToolContext } from '../context';
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

/**
 * La nota a la que lleva un enlace por título, mirando SOLO las visibles (M1 del audit de
 * privacidad, 10 oct 2026). `resolveLink` del motor cuenta también las ocultas: una
 * homónima oculta convertía «resuelto» en «ambiguo», y crear una nota con un título
 * adivinado y enlazarla confirmaba que existía una oculta con ese título. Aquí, como
 * `resolveIdByTitle` (`./note-ref.ts`): todas las notas con ese título exacto
 * (`notesByExactTitle`), las ocultas fuera, y la ruta escrita en el enlace (`targetPath`)
 * solo desempata entre las que quedan (por el final de su ruta, como el motor; si no casa
 * ninguna, se queda con todas). Resuelto si queda una.
 */
async function visibleTitleTarget(
  ctx: ToolContext,
  title: string,
  targetPath: string | null
): Promise<{ id: string; title: string } | undefined> {
  const { items } = await ctx.port.notesByExactTitle(title);
  let visible = items.filter((item) => ctx.privacy.visibleMeta(item.id) !== undefined);
  // Todas las visibles deciden entre «resuelto» y «ambiguo» (y la ruta de cada una, el
  // desempate): la puerta final las vuelve a juzgar, y si una ya no se ve, repite la llamada
  // en vez de dejar un ambiguo que solo lo era por ella.
  const used = usageOf(ctx);
  for (const item of visible) used.note(item.id);
  if (visible.length > 1 && targetPath) {
    const wanted = targetPath.split('/');
    const endsWithPath = (folderId: string): boolean => {
      const own = ctx.privacy.folderSegments(folderId);
      return own.length >= wanted.length && wanted.every((part, i) => own[own.length - wanted.length + i] === part);
    };
    const narrowed = visible.filter((item) => endsWithPath(ctx.privacy.visibleMeta(item.id)!.folderId));
    if (narrowed.length > 0) visible = narrowed;
  }
  return visible.length === 1 ? { id: visible[0]!.id, title: visible[0]!.title } : undefined;
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
  // La nota (los enlaces salen de su cuerpo tal como se leyó), las que resuelve, las
  // candidatas por título y las que la enlazan: la puerta final (`../privacy-gate.ts`) las
  // vuelve a juzgar con el filtro de ahora y sus sellos antes de responder, y si alguna ya no
  // se ve o cambió, repite la llamada entera: el cursor de los backlinks sale de la última
  // DEVUELTA, que ella ha juzgado (C1, y la 2.ª revisión de Codex).
  const used = usageOf(ctx);
  used.note(note.id, note.localSeq);

  // Outgoing: la lista de refs sale del cuerpo entero; solo se resuelven los de la página.
  const outgoing: OutgoingLink[] = [];
  let nextOutgoing: number | undefined;
  if (!position.outDone) {
    const refs = scanOutgoingRefs(note.body);
    const start = Math.min(position.o, refs.length);
    const page = slicePage(refs.slice(start), 'l1', { limit });
    // Las refs por título se resuelven solo entre las visibles (M1, abajo); las demás (por
    // id), con el motor, todas en UN turno de la cola del almacén.
    const queries = page.items.map((ref) => parseLinkRef(ref));
    const byEngine = page.items.filter((_ref, index) => queries[index]?.targetKind !== 'title');
    const resolutions = await ctx.port.resolveLinks(byEngine);
    let engineIndex = 0;
    for (const [index, ref] of page.items.entries()) {
      const query = queries[index];
      if (query?.targetKind === 'title') {
        const target = await visibleTitleTarget(ctx, query.target, query.targetPath);
        outgoing.push(target ? { ref, resolvedId: target.id, title: target.title } : { ref });
        continue;
      }
      const resolution = resolutions[engineIndex++]!;
      const candidate = resolution.status === 'resolved' ? resolution.candidates[0] : undefined;
      if (candidate && candidate.kind === 'note' && ctx.privacy.visibleMeta(candidate.id)) {
        used.note(candidate.id);
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
      accept: (item) => {
        if (!ctx.privacy.visibleMeta(item.id)) return undefined;
        // También la de mirar por delante: decide si hay `nextCursor`.
        used.note(item.id);
        return { id: item.id, title: item.title };
      },
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
