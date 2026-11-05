/**
 * `hebra_list_notes` (SPEC.md §5): páginas de `notesPage`, orden `updatedAt` desc, con
 * `folder?`/`tag?`. `NotesScope` solo admite UN ámbito nativo a la vez; si la persona
 * da los dos, el más selectivo (`folder` si está, si no `tag`) es el ámbito nativo y el
 * otro se aplica aquí. El `nextCursor` que se devuelve es el cursor REAL del almacén
 * (`encodeCursor`, misma clave `banda:updatedAt:id` que `notesPageQuery`, con la banda «anclada aquí» (`pinned`, §26.3)): quien
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
 *
 * Estado (D23, 5 nov 2026): cada nota lleva `favorite`, `archivedAt` y `generalHidden`
 * (`./note-state.ts`). Los ámbitos `all`, `folder` y `tag` del motor NO listan las
 * archivadas (`archived_at IS NULL`) y SÍ las ocultas del listado general (el motor solo las
 * quita con `excludeHidden`, que aquí no se pide): salen con `generalHidden: true`.
 * `archived: true` cambia al ámbito `{kind: 'archive'}`, de la última archivada a la
 * primera; el motor no lo combina con carpeta ni etiqueta, así que con `folder` o `tag` es
 * `invalid_input` (y `subfolders` no tiene efecto sin `folder`).
 */
import { canonicalTag, encodeCursor, type NotesScope } from '../../hebra';
import { usageOf, type ToolContext } from '../context';
import {
  LIMITS,
  effectiveLimit,
  fillPage,
  storePageSize,
  pickFields,
  unwrapCursor,
  wrapCursor
} from '../pagination';
import type { NoteStateRow } from '../../store/state-reads';
import { ToolError } from '../errors';
import type { LIST_NOTES_FIELDS } from '../schemas';
import { fieldsNeedNoteState, loadNoteStates, stateFields } from './note-state';

export interface ListedNote {
  id: string;
  title: string;
  folderPath: string;
  tags: string[];
  excerpt: string;
  updatedAt: string;
  isConflictCopy: boolean;
  favorite: boolean;
  archivedAt: string | null;
  generalHidden: boolean;
}

type ListNotesField = (typeof LIST_NOTES_FIELDS)[number];

interface ListNotesInputBase {
  folder?: string;
  subfolders?: boolean;
  tag?: string;
  archived?: boolean;
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
  // El ámbito `archive` del motor no admite carpeta ni etiqueta.
  if (input.archived === true && (input.folder !== undefined || input.tag !== undefined)) {
    throw new ToolError('invalid_input');
  }

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
    input.archived === true
      ? { kind: 'archive' }
      : folderId !== undefined
      ? input.subfolders
        ? { kind: 'folder', folderId, subfolders: true }
        : { kind: 'folder', folderId }
      : tagFilter !== undefined
        ? { kind: 'tag', tag: tagFilter }
        : { kind: 'all' };
  // Ámbito ya consumido por `scope`: el otro filtro, si lo hay, se aplica en JS.
  const extraTagFilter = scope.kind === 'folder' ? tagFilter : undefined;
  // D23: el estado (`noteSummary`) de las notas de cada página del almacén; el cursor del
  // ámbito `archive` lo necesita siempre (su clave es la fecha de archivo).
  const archive = scope.kind === 'archive';
  const needsState = archive || fieldsNeedNoteState(input.fields);
  const states = new Map<string, NoteStateRow>();

  // Cada fila que sale, con su carpeta, para la puerta final (`../privacy-gate.ts`): antes de
  // responder la vuelve a juzgar con el filtro de ahora y el sello de la fila con la que se
  // decidió que se veía; si ya no se ve o cambió (también si se leyó privada y volvió a ser
  // pública), repite la llamada (C1, y la 2.ª revisión de Codex).
  const used = usageOf(ctx);
  const page = await fillPage({
    limit,
    startCursor,
    fetch: async (cursor, want) => {
      const stored = await ctx.port.notesPage(cursor, storePageSize(want), scope);
      if (needsState) {
        const visible = stored.items.filter((item) => ctx.privacy.visibleMeta(item.id));
        for (const [id, row] of await loadNoteStates(ctx.port, visible.map((item) => item.id))) {
          states.set(id, row);
        }
      }
      return stored;
    },
    accept: (item) => {
      const meta = ctx.privacy.visibleMeta(item.id);
      if (!meta) return undefined;
      const state = states.get(item.id);
      // Purgada entre la página y su estado, o (en `archive`) desarchivada entre medias.
      if (needsState && (!state || (archive && state.archivedAt === null))) return undefined;
      if (extraTagFilter !== undefined && !ctx.privacy.hasTag(item.id, extraTagFilter)) {
        return undefined;
      }
      // También la de mirar por delante: decide si hay `nextCursor`.
      const folderPath = ctx.privacy.folderPath(meta.folderId);
      used.note(item.id);
      used.folder(meta.folderId, folderPath);
      const note: ListedNote = {
        id: item.id,
        title: item.title,
        folderPath,
        tags: meta.tags,
        excerpt: item.excerpt,
        updatedAt: new Date(item.updatedAt).toISOString(),
        isConflictCopy: item.conflict,
        favorite: item.favorite,
        archivedAt: state ? stateFields(state).archivedAt : null,
        generalHidden: state?.generalHidden ?? false
      };
      return pickFields(note, input.fields);
    },
    // La banda es "anclada aquí" (`pinned`, §26.3), no `favorite`: una nota anclada solo en otro
    // sitio no sube en esta lista y su cursor llevaría una banda que el motor no usa.
    cursorAfter: (item) =>
      archive
        ? encodeCursor([states.get(item.id)!.archivedAt!], item.id)
        : encodeCursor([item.pinned === true ? 1 : 0, item.updatedAt], item.id)
  });
  return {
    notes: page.items,
    nextCursor: page.lastCursor === null ? null : wrapCursor('n1', page.lastCursor)
  };
}
