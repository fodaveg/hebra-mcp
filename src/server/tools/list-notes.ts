/**
 * `hebra_list_notes` (SPEC.md §5): páginas de `notesPage`, orden `updatedAt` desc, con
 * `folder?`/`tag?`. `NotesScope` solo admite UN ámbito nativo a la vez; si la persona
 * da los dos, el más selectivo (`folder` si está, si no `tag`) es el ámbito nativo y el
 * otro se aplica aquí. El `nextCursor` que se devuelve es el cursor REAL del almacén
 * (`encodeCursor`, misma clave `favorite:updatedAt:id` que `notesPageQuery`): quien
 * llame puede seguir paginando aunque esta página haya tenido que saltar notas
 * ocultas o filtradas.
 *
 * Paginación común (`pagination.ts`): el `nextCursor` va envuelto (`n1.…`, opaco) y solo
 * existe si hay otra nota VISIBLE tras la página; un cursor sin envolver (los que
 * devolvía la versión anterior) se sigue aceptando. `fields?` recorta cada nota.
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
import {
  LIMITS,
  effectiveLimit,
  fillPage,
  pickFields,
  unwrapCursor,
  wrapCursor
} from '../pagination';
import type { LIST_NOTES_FIELDS } from '../schemas';

export interface ListedNote {
  id: string;
  title: string;
  folderPath: string;
  tags: string[];
  excerpt: string;
  updatedAt: string;
  isConflictCopy: boolean;
}

const PAGE_SIZE = 100;

type ListNotesField = (typeof LIST_NOTES_FIELDS)[number];

interface ListNotesInputBase {
  folder?: string;
  subfolders?: boolean;
  tag?: string;
  cursor?: string;
  limit?: number;
}

/** Sin `fields`, la salida completa; con `fields`, cada elemento solo lleva `id` y esos campos. */
export async function runListNotes(
  ctx: ToolContext,
  input: ListNotesInputBase & { fields?: undefined }
): Promise<{ notes: ListedNote[]; nextCursor: string | null }>;
export async function runListNotes(
  ctx: ToolContext,
  input: ListNotesInputBase & { fields: readonly ListNotesField[] }
): Promise<{ notes: Partial<ListedNote>[]; nextCursor: string | null }>;
export async function runListNotes(
  ctx: ToolContext,
  input: ListNotesInputBase & { fields?: readonly ListNotesField[] }
): Promise<{ notes: Partial<ListedNote>[]; nextCursor: string | null }>;
export async function runListNotes(
  ctx: ToolContext,
  input: ListNotesInputBase & { fields?: readonly ListNotesField[] }
): Promise<{ notes: Partial<ListedNote>[]; nextCursor: string | null }> {
  const limit = effectiveLimit(input.limit, LIMITS.listNotes);
  const startCursor =
    input.cursor === undefined
      ? null
      : input.cursor.startsWith('n1.')
        ? unwrapCursor('n1', input.cursor)
        : input.cursor;
  const empty = { notes: [], nextCursor: null };

  let tagFilter: string | undefined;
  if (input.tag !== undefined) {
    const canonical = canonicalTag(input.tag)?.tag;
    if (!canonical || ctx.privacy.isTagHidden(canonical)) return empty;
    tagFilter = canonical;
  }

  let folderId: string | undefined;
  if (input.folder !== undefined) {
    const resolved = ctx.privacy.folderIdForPath(input.folder);
    if (!resolved || ctx.privacy.isFolderHidden(resolved)) return empty;
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

  const page = await fillPage({
    limit,
    startCursor,
    fetch: (cursor) => ctx.port.notesPage(cursor, PAGE_SIZE, scope),
    accept: (item) => {
      const meta = ctx.privacy.visibleMeta(item.id);
      if (!meta) return undefined;
      if (extraTagFilter !== undefined && !ctx.privacy.hasTag(item.id, extraTagFilter)) {
        return undefined;
      }
      const note: ListedNote = {
        id: item.id,
        title: item.title,
        folderPath: ctx.privacy.folderPath(meta.folderId),
        tags: meta.tags,
        excerpt: item.excerpt,
        updatedAt: new Date(item.updatedAt).toISOString(),
        isConflictCopy: item.conflict
      };
      return pickFields(note, input.fields);
    },
    cursorAfter: (item) => encodeCursor([item.favorite ? 1 : 0, item.updatedAt], item.id)
  });
  return {
    notes: page.items,
    nextCursor: page.lastCursor === null ? null : wrapCursor('n1', page.lastCursor)
  };
}
