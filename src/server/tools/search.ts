/**
 * `hebra_search` (SPEC.md §5): FTS5 sobre el cuerpo, con `folder?`/`tag?` de filtro. El
 * puerto (`search`) ya filtra por etiqueta (`SearchFilters.tags`); `folder?` no tiene
 * filtro nativo (`SearchHit` no lleva `folderId`), así que se aplica aquí, igual que el
 * filtro de privados: la paginación interna sigue pidiendo páginas hasta reunir `limit`
 * resultados visibles o agotar el almacén (SPEC.md §6.3).
 */
import { canonicalTag } from '$lib/notes/tags';
import type { ToolContext } from '../context';

export interface SearchResult {
  id: string;
  title: string;
  folderPath: string;
  tags: string[];
  snippet: string;
  updatedAt: string;
}

const DEFAULT_LIMIT = 20;
const PAGE_SIZE = 50;

export async function runSearch(
  ctx: ToolContext,
  input: { query: string; limit?: number; folder?: string; tag?: string }
): Promise<{ results: SearchResult[] }> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 50);

  let tagFilter: string | undefined;
  if (input.tag !== undefined) {
    const canonical = canonicalTag(input.tag)?.tag;
    if (!canonical || ctx.privacy.isTagHidden(canonical)) return { results: [] };
    tagFilter = canonical;
  }

  let folderId: string | undefined;
  if (input.folder !== undefined) {
    const resolved = ctx.privacy.folderIdForPath(input.folder);
    if (!resolved || ctx.privacy.isFolderHidden(resolved)) return { results: [] };
    folderId = resolved;
  }

  const results: SearchResult[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await ctx.port.search(
      input.query,
      cursor,
      PAGE_SIZE,
      tagFilter ? { tags: [tagFilter] } : null
    );
    for (const hit of page.items) {
      const meta = ctx.privacy.visibleMeta(hit.id);
      if (!meta) continue;
      if (folderId !== undefined && meta.folderId !== folderId) continue;
      results.push({
        id: hit.id,
        title: hit.title,
        folderPath: ctx.privacy.folderPath(meta.folderId),
        tags: meta.tags,
        snippet: hit.snippet,
        updatedAt: new Date(hit.updatedAt).toISOString()
      });
      if (results.length >= limit) return { results };
    }
    if (!page.nextCursor) return { results };
    cursor = page.nextCursor;
  }
}
