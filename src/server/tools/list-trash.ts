/**
 * `hebra_list_trash` (ampliación de D2, decisión de David del 30 sep 2026): las notas de
 * la papelera, de la última en entrar a la primera (el orden de `notesPage({kind:
 * 'trash'})` del motor), con la carpeta a la que volverían al restaurarlas.
 *
 * Privacidad (`TrashFilter`, `src/privacy/trash-filter.ts`): una nota de la papelera de
 * una carpeta privada (o subcarpeta, también si la carpeta ya se borró) o con una
 * etiqueta privada (o descendiente) no sale. Tampoco se deja adivinar cuántas hay:
 * no hay recuento, la página se rellena hasta `limit` con notas visibles, y `nextCursor`
 * solo es distinto de `null` si detrás queda al menos otra nota VISIBLE (se mira una de
 * más), para que una página final vacía no delate una cola de notas ocultas.
 *
 * Paginación común (`pagination.ts`): `nextCursor` va envuelto (`r1.…`, opaco) sobre la
 * clave `trashedAt:id` del motor, como en `hebra_list_notes`.
 */
import { encodeCursor } from '../../hebra';
import { TrashFilter } from '../../privacy/trash-filter';
import type { ToolContext } from '../context';
import { LIMITS, effectiveLimit, fillPage, unwrapCursor, wrapCursor } from '../pagination';

export interface TrashedNote {
  id: string;
  title: string;
  /** Donde quedará al restaurarla (vacío = la raíz). */
  folderPath: string;
  tags: string[];
  excerpt: string;
  trashedAt: string;
  updatedAt: string;
  isConflictCopy: boolean;
}

const PAGE_SIZE = 100;

export async function runListTrash(
  ctx: ToolContext,
  input: { cursor?: string; limit?: number }
): Promise<{ notes: TrashedNote[]; nextCursor: string | null }> {
  const limit = effectiveLimit(input.limit, LIMITS.listTrash);
  const startCursor = input.cursor === undefined ? null : unwrapCursor('r1', input.cursor);
  const trash = await TrashFilter.build(ctx.port, ctx.privacy, ctx.privacyConfig);

  const page = await fillPage({
    limit,
    startCursor,
    fetch: (cursor) => ctx.port.notesPage(cursor, PAGE_SIZE, { kind: 'trash' }),
    accept: (item): TrashedNote | undefined => {
      const meta = trash.visibleMeta(item.id);
      if (!meta) return undefined;
      return {
        id: item.id,
        title: item.title,
        folderPath: ctx.privacy.folderPath(meta.folderId),
        tags: meta.tags,
        excerpt: item.excerpt,
        trashedAt: new Date(meta.trashedAt).toISOString(),
        updatedAt: new Date(item.updatedAt).toISOString(),
        isConflictCopy: item.conflict
      };
    },
    cursorAfter: (item) => encodeCursor([trash.visibleMeta(item.id)!.trashedAt], item.id)
  });
  return {
    notes: page.items,
    nextCursor: page.lastCursor === null ? null : wrapCursor('r1', page.lastCursor)
  };
}
