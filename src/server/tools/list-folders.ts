/**
 * `hebra_list_folders` (SPEC.md §5, §6.3): `{folders:[{id,path,count}]}`. Las carpetas
 * privadas (y su subárbol) no aparecen; el recuento de las demás es de notas VISIBLES,
 * no el `noteCount` de `foldersList()` (que no descuenta las ocultas por etiqueta:
 * aceptación #5, una nota oculta por etiqueta tampoco cuenta en una carpeta visible).
 * `limit`/`cursor` paginan la lista ya filtrada (cursor = el id de la última carpeta
 * devuelta); sin `limit`, todas.
 */
import { usageOf, type ToolContext } from '../context';
import { LIMITS, effectiveLimit, slicePage } from '../pagination';

export interface FolderCount {
  id: string;
  path: string;
  count: number;
}

export async function runListFolders(
  ctx: ToolContext,
  input: { limit?: number; cursor?: string } = {}
): Promise<{ folders: FolderCount[]; nextCursor: string | null }> {
  const { folders } = await ctx.port.foldersList();
  const visibleCounts = new Map<string, number>();
  const visible = ctx.privacy.visibleNotes();
  for (const { folderId } of visible.values()) {
    visibleCounts.set(folderId, (visibleCounts.get(folderId) ?? 0) + 1);
  }
  // Los recuentos y cada carpeta con la ruta que sale: la puerta final
  // (`../privacy-gate.ts`) los vuelve a juzgar con el árbol de ahora, y si una carpeta ya es
  // privada (también una que nació dentro de una privada después del filtro de la llamada)
  // o cambió de ruta, repite la llamada.
  const used = usageOf(ctx);
  used.visibleNotes(visible.keys());
  const result: FolderCount[] = [];
  for (const folder of folders) {
    if (ctx.privacy.isFolderHidden(folder.id)) continue;
    const path = ctx.privacy.folderPath(folder.id);
    used.folder(folder.id, path);
    result.push({ id: folder.id, path, count: visibleCounts.get(folder.id) ?? 0 });
  }
  const page = slicePage(result, 'f1', {
    limit: effectiveLimit(input.limit, LIMITS.listFolders),
    cursor: input.cursor,
    keyOf: (entry) => entry.id
  });
  return { folders: page.items, nextCursor: page.nextCursor };
}
