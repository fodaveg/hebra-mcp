/**
 * `hebra_list_notes` (SPEC.md §5): páginas de `notesPage`, orden `updatedAt` desc, con
 * `folder?`/`tag?`. `NotesScope` solo admite UN ámbito nativo a la vez; si la persona
 * da los dos, el más selectivo (`folder` si está, si no `tag`) es el ámbito nativo y el
 * otro se aplica aquí. El `nextCursor` que se devuelve es el cursor REAL del almacén
 * (`encodeCursor`, misma clave `favorite:updatedAt:id` que `notesPageQuery`): quien
 * llame puede seguir paginando aunque esta página haya tenido que saltar notas
 * ocultas o filtradas.
 *
 * `subfolders?` (carpetas reales, decisión de David del 27 sep 2026): con `folder` y
 * `true`, el ámbito nativo pasa a `{kind: 'folder', folderId, subfolders: true}` y el
 * almacén ya devuelve las notas de todo el subárbol EFECTIVO (`folderSubtree`, §3). El
 * filtro de privados no cambia por esto: sigue mirando nota a nota
 * (`ctx.privacy.visibleMeta`), así que una subcarpeta privada dentro de un ámbito
 * público sigue sin salir. Ausente o `false`: solo las notas directas, como siempre.
 */
import { canonicalTag, encodeCursor, type NotesScope } from '../../hebra';
import type { ToolContext } from '../context';

export interface ListedNote {
  id: string;
  title: string;
  folderPath: string;
  tags: string[];
  excerpt: string;
  updatedAt: string;
  isConflictCopy: boolean;
}

const DEFAULT_LIMIT = 50;
const PAGE_SIZE = 100;

export async function runListNotes(
  ctx: ToolContext,
  input: {
    folder?: string;
    subfolders?: boolean;
    tag?: string;
    cursor?: string;
    limit?: number;
  }
): Promise<{ notes: ListedNote[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 100);

  let tagFilter: string | undefined;
  if (input.tag !== undefined) {
    const canonical = canonicalTag(input.tag)?.tag;
    if (!canonical || ctx.privacy.isTagHidden(canonical)) return { notes: [], nextCursor: null };
    tagFilter = canonical;
  }

  let folderId: string | undefined;
  if (input.folder !== undefined) {
    const resolved = ctx.privacy.folderIdForPath(input.folder);
    if (!resolved || ctx.privacy.isFolderHidden(resolved)) return { notes: [], nextCursor: null };
    folderId = resolved;
  }

  const scope: NotesScope =
    folderId !== undefined
      ? input.subfolders
        ? { kind: 'folder', folderId, subfolders: true }
        : { kind: 'folder', folderId }
      : tagFilter !== undefined
        ? { kind: 'tag', tag: tagFilter }
        : { kind: 'all' };
  // Ámbito ya consumido por `scope`: el otro filtro, si lo hay, se aplica en JS.
  const extraTagFilter = scope.kind === 'folder' ? tagFilter : undefined;

  const notes: ListedNote[] = [];
  let cursor: string | null = input.cursor ?? null;
  for (;;) {
    const page = await ctx.port.notesPage(cursor, PAGE_SIZE, scope);
    for (const item of page.items) {
      const meta = ctx.privacy.visibleMeta(item.id);
      if (!meta) continue;
      if (extraTagFilter !== undefined && !ctx.privacy.hasTag(item.id, extraTagFilter)) continue;
      notes.push({
        id: item.id,
        title: item.title,
        folderPath: ctx.privacy.folderPath(meta.folderId),
        tags: meta.tags,
        excerpt: item.excerpt,
        updatedAt: new Date(item.updatedAt).toISOString(),
        isConflictCopy: item.conflict
      });
      if (notes.length >= limit) {
        return {
          notes,
          nextCursor: encodeCursor([item.favorite ? 1 : 0, item.updatedAt], item.id)
        };
      }
    }
    if (!page.nextCursor) return { notes, nextCursor: null };
    cursor = page.nextCursor;
  }
}
