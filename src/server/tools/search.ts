/**
 * `hebra_search` (SPEC.md §5): FTS5 sobre el cuerpo, con `folder?`/`subfolders?`/`tag?`
 * de filtro, `limit`/`cursor` y `fields?`. El puerto (`search`) filtra EN LA CONSULTA por
 * etiqueta (`SearchFilters.tags`) y por carpeta (`NotesScope` de carpeta, con `subfolders`
 * el subárbol efectivo de `folderSubtree`, el mismo de `hebra_list_notes`); solo el filtro
 * de privados se aplica aquí, nota a nota: la paginación interna sigue pidiendo páginas
 * hasta reunir `limit` resultados visibles o agotar el almacén (SPEC.md §6.3). El cursor
 * es la clave `(updatedAt, id)` del último resultado devuelto, envuelta (`pagination.ts`):
 * reanuda exactamente tras él.
 *
 * `heading` (D11): el título del apartado más interno que contiene el fragmento del
 * `snippet` (`headingOfSnippet`, `../../store/sections.ts`), o `null`. Se lee el cuerpo
 * (`noteRead`) solo de los resultados visibles que se devuelven y solo si `heading` está
 * entre los campos pedidos; nunca el de una nota oculta ni el de una bloqueada.
 *
 * Carpeta: el ámbito del motor compara la carpeta GUARDADA de la nota con la carpeta pedida
 * (o con su subárbol efectivo) y trata como raíz las notas cuya carpeta es lápida o
 * desconocida, igual que la carpeta efectiva con la que filtraba esta herramienta. Con
 * `subfolders`, el ámbito sigue el árbol de padres efectivos y no la coincidencia de
 * prefijo de la ruta por nombre (que, con dos carpetas hermanas del mismo nombre, mezclaba
 * sus notas).
 */
import { canonicalTag, encodeCursor, type NotesScope } from '../../hebra';
import type { ToolContext } from '../context';
import {
  LIMITS,
  effectiveLimit,
  fillPage,
  pickFields,
  storePageSize,
  unwrapCursor,
  wrapCursor
} from '../pagination';
import { headingOfSnippet } from '../../store/sections';
import { LOCKED_BODY_PREFIX } from '../../store/writes';
import type { SEARCH_FIELDS } from '../schemas';

export interface SearchResult {
  id: string;
  title: string;
  folderPath: string;
  tags: string[];
  snippet: string;
  /** El apartado más interno que contiene el fragmento de `snippet` (D11), o `null`. */
  heading: string | null;
  updatedAt: string;
  isConflictCopy: boolean;
}

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

  let scope: NotesScope | null = null;
  if (input.folder !== undefined) {
    const resolved = ctx.privacy.folderIdForPath(input.folder);
    if (!resolved || ctx.privacy.isFolderHidden(resolved)) return empty;
    scope = input.subfolders
      ? { kind: 'folder', folderId: resolved, subfolders: true }
      : { kind: 'folder', folderId: resolved };
  }

  const page = await fillPage({
    limit,
    startCursor,
    fetch: (cursor, want) =>
      ctx.port.search(
        input.query,
        cursor,
        storePageSize(want),
        tagFilter ? { tags: [tagFilter] } : null,
        scope
      ),
    accept: (hit) => {
      const meta = ctx.privacy.visibleMeta(hit.id);
      if (!meta) return undefined;
      const result: SearchResult = {
        id: hit.id,
        title: hit.title,
        folderPath: ctx.privacy.folderPath(meta.folderId),
        tags: meta.tags,
        snippet: hit.snippet,
        heading: null,
        updatedAt: new Date(hit.updatedAt).toISOString(),
        isConflictCopy: hit.conflict
      };
      return result;
    },
    cursorAfter: (hit) => encodeCursor([hit.updatedAt], hit.id)
  });

  // El cuerpo solo se lee de los resultados VISIBLES que se devuelven (`accept` ya
  // descartó los ocultos) y solo si `heading` está entre los campos pedidos (D11).
  const wantsHeading = input.fields === undefined || input.fields.includes('heading');
  if (wantsHeading) {
    for (const result of page.items) {
      const note = await ctx.port.noteRead(result.id);
      if (!note || note.body.startsWith(LOCKED_BODY_PREFIX)) continue;
      result.heading = headingOfSnippet(note.body, result.snippet);
    }
  }
  return {
    results: page.items.map((result) => pickFields(result, input.fields)),
    nextCursor: page.lastCursor === null ? null : wrapCursor('s1', page.lastCursor)
  };
}
