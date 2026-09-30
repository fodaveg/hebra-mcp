/**
 * `hebra_search` (SPEC.md §5): FTS5 sobre el cuerpo, con `folder?`/`subfolders?`/`tag?`
 * de filtro, `limit`/`cursor` y `fields?`. El puerto (`search`) ya filtra por etiqueta
 * (`SearchFilters.tags`); `folder?` no tiene filtro nativo (`SearchHit` no lleva
 * `folderId`), así que se aplica aquí, igual que el filtro de privados: la paginación
 * interna sigue pidiendo páginas hasta reunir `limit` resultados visibles o agotar el
 * almacén (SPEC.md §6.3). El cursor es la clave `(updatedAt, id)` del último resultado
 * devuelto, envuelta (`pagination.ts`): reanuda exactamente tras él.
 */
import { canonicalTag, encodeCursor } from '../../hebra';
import type { ToolContext } from '../context';
import {
  LIMITS,
  effectiveLimit,
  fillPage,
  pickFields,
  unwrapCursor,
  wrapCursor
} from '../pagination';
import type { SEARCH_FIELDS } from '../schemas';

export interface SearchResult {
  id: string;
  title: string;
  folderPath: string;
  tags: string[];
  snippet: string;
  updatedAt: string;
}

const PAGE_SIZE = 50;

type SearchField = (typeof SEARCH_FIELDS)[number];

interface SearchInputBase {
  query: string;
  limit?: number;
  cursor?: string;
  folder?: string;
  subfolders?: boolean;
  tag?: string;
}

/** Sin `fields`, la salida completa; con `fields`, cada elemento solo lleva `id` y esos campos. */
export async function runSearch(
  ctx: ToolContext,
  input: SearchInputBase & { fields?: undefined }
): Promise<{ results: SearchResult[]; nextCursor: string | null }>;
export async function runSearch(
  ctx: ToolContext,
  input: SearchInputBase & { fields: readonly SearchField[] }
): Promise<{ results: Partial<SearchResult>[]; nextCursor: string | null }>;
export async function runSearch(
  ctx: ToolContext,
  input: SearchInputBase & { fields?: readonly SearchField[] }
): Promise<{ results: Partial<SearchResult>[]; nextCursor: string | null }>;
export async function runSearch(
  ctx: ToolContext,
  input: SearchInputBase & { fields?: readonly SearchField[] }
): Promise<{ results: Partial<SearchResult>[]; nextCursor: string | null }> {
  const limit = effectiveLimit(input.limit, LIMITS.search);
  const startCursor = input.cursor !== undefined ? unwrapCursor('s1', input.cursor) : null;
  const empty = { results: [], nextCursor: null };

  let tagFilter: string | undefined;
  if (input.tag !== undefined) {
    const canonical = canonicalTag(input.tag)?.tag;
    if (!canonical || ctx.privacy.isTagHidden(canonical)) return empty;
    tagFilter = canonical;
  }

  let folderId: string | undefined;
  let folderPath = '';
  if (input.folder !== undefined) {
    const resolved = ctx.privacy.folderIdForPath(input.folder);
    if (!resolved || ctx.privacy.isFolderHidden(resolved)) return empty;
    folderId = resolved;
    folderPath = ctx.privacy.folderPath(resolved);
  }
  const inFolder = (noteFolderId: string): boolean => {
    if (folderId === undefined) return true;
    if (noteFolderId === folderId) return true;
    if (!input.subfolders) return false;
    const path = ctx.privacy.folderPath(noteFolderId);
    return folderPath === '' || path.startsWith(`${folderPath}/`);
  };

  const page = await fillPage({
    limit,
    startCursor,
    fetch: (cursor) =>
      ctx.port.search(input.query, cursor, PAGE_SIZE, tagFilter ? { tags: [tagFilter] } : null),
    accept: (hit) => {
      const meta = ctx.privacy.visibleMeta(hit.id);
      if (!meta || !inFolder(meta.folderId)) return undefined;
      const result: SearchResult = {
        id: hit.id,
        title: hit.title,
        folderPath: ctx.privacy.folderPath(meta.folderId),
        tags: meta.tags,
        snippet: hit.snippet,
        updatedAt: new Date(hit.updatedAt).toISOString()
      };
      return pickFields(result, input.fields);
    },
    cursorAfter: (hit) => encodeCursor([hit.updatedAt], hit.id)
  });
  return {
    results: page.items,
    nextCursor: page.lastCursor === null ? null : wrapCursor('s1', page.lastCursor)
  };
}
