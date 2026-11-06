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
 *
 * `kind: "folders"` (D23, 5 nov 2026) lista las carpetas de la papelera en vez de las notas
 * (`./list-trash-folders.ts`); sin `kind`, o con `"notes"`, todo sigue igual.
 *
 * Perezosa (A6 del plan de memoria, 6 nov 2026): `privacyLoad: 'lazy'` sin ningún `ensure`.
 * Las notas de la papelera las juzga `TrashFilter` con su propio índice, y de `ctx.privacy`
 * solo usa carpetas y configuración (cabecera de `../../privacy/trash-filter.ts`).
 */
import { encodeCursor } from '../../hebra';
import { TrashFilter } from '../../privacy/trash-filter';
import { usageOf, type ToolContext } from '../context';
import {
  LIMITS,
  effectiveLimit,
  fillPage,
  storePageSize,
  unwrapCursor,
  wrapCursor
} from '../pagination';
import { runListTrashFolders, type TrashedFolder } from './list-trash-folders';

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

export async function runListTrash(
  ctx: ToolContext,
  input: { kind?: 'notes'; cursor?: string; limit?: number }
): Promise<{ notes: TrashedNote[]; nextCursor: string | null }>;
export async function runListTrash(
  ctx: ToolContext,
  input: { kind: 'folders'; cursor?: string; limit?: number }
): Promise<{ folders: TrashedFolder[]; nextCursor: string | null }>;
export async function runListTrash(
  ctx: ToolContext,
  input: { kind?: 'notes' | 'folders'; cursor?: string; limit?: number }
): Promise<
  | { notes: TrashedNote[]; nextCursor: string | null }
  | { folders: TrashedFolder[]; nextCursor: string | null }
>;
export async function runListTrash(
  ctx: ToolContext,
  input: { kind?: 'notes' | 'folders'; cursor?: string; limit?: number }
): Promise<
  | { notes: TrashedNote[]; nextCursor: string | null }
  | { folders: TrashedFolder[]; nextCursor: string | null }
> {
  if (input.kind === 'folders') return runListTrashFolders(ctx, input);
  const limit = effectiveLimit(input.limit, LIMITS.listTrash);
  const startCursor = input.cursor === undefined ? null : unwrapCursor('r1', input.cursor);
  const trash = await TrashFilter.build(ctx.port, ctx.privacy, ctx.privacyConfig);

  // Cada nota que sale (también la de mirar por delante, que decide `nextCursor`) con el
  // sello de la fila con la que se juzgó y la carpeta a la que volvería: la puerta final
  // (`../privacy-gate.ts`) los vuelve a juzgar con la papelera de ahora, y si una ya no se ve
  // o cambió (el título y el extracto se leen después del filtro), repite la llamada.
  const used = usageOf(ctx);
  const page = await fillPage({
    limit,
    startCursor,
    fetch: (cursor, want) => ctx.port.notesPage(cursor, storePageSize(want), { kind: 'trash' }),
    accept: (item): TrashedNote | undefined => {
      const meta = trash.visibleMeta(item.id);
      if (!meta) return undefined;
      const folderPath = ctx.privacy.folderPath(meta.folderId);
      used.trashedNote(item.id, trash.sealOf(item.id));
      used.folder(meta.folderId, folderPath);
      return {
        id: item.id,
        title: item.title,
        folderPath,
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
