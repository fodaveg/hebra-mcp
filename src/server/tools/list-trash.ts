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
 * `nextCursor` es el cursor REAL del almacén (misma clave `trashedAt:id` que el motor),
 * como en `hebra_list_notes`.
 */
import { encodeCursor } from '../../hebra';
import { TrashFilter } from '../../privacy/trash-filter';
import type { ToolContext } from '../context';

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

const DEFAULT_LIMIT = 50;
const PAGE_SIZE = 100;

export async function runListTrash(
  ctx: ToolContext,
  input: { cursor?: string; limit?: number }
): Promise<{ notes: TrashedNote[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 100);
  const trash = await TrashFilter.build(ctx.port, ctx.privacy, ctx.privacyConfig);

  const notes: TrashedNote[] = [];
  let lastCursor: string | null = null;
  let cursor: string | null = input.cursor ?? null;
  for (;;) {
    const page = await ctx.port.notesPage(cursor, PAGE_SIZE, { kind: 'trash' });
    for (const item of page.items) {
      const meta = trash.visibleMeta(item.id);
      if (!meta) continue;
      // Ya hay `limit`: esta es la de más, y solo dice que hay página siguiente.
      if (notes.length === limit) return { notes, nextCursor: lastCursor };
      notes.push({
        id: item.id,
        title: item.title,
        folderPath: ctx.privacy.folderPath(meta.folderId),
        tags: meta.tags,
        excerpt: item.excerpt,
        trashedAt: new Date(meta.trashedAt).toISOString(),
        updatedAt: new Date(item.updatedAt).toISOString(),
        isConflictCopy: item.conflict
      });
      lastCursor = encodeCursor([meta.trashedAt], item.id);
    }
    if (!page.nextCursor) return { notes, nextCursor: null };
    cursor = page.nextCursor;
  }
}
