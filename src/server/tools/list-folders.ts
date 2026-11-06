/**
 * `hebra_list_folders` (SPEC.md §5, §6.3): `{folders:[{id,path,count}]}`. Las carpetas
 * privadas (y su subárbol) no aparecen; el recuento de las demás es de notas VISIBLES,
 * no el `noteCount` de `foldersList()` (que no descuenta las ocultas por etiqueta:
 * aceptación #5, una nota oculta por etiqueta tampoco cuenta en una carpeta visible).
 * `limit`/`cursor` paginan la lista ya filtrada (cursor = el id de la última carpeta
 * devuelta); sin `limit`, todas.
 *
 * Los recuentos se agrupan en SQLite con las reglas del filtro de la llamada
 * (`visibleFolderCounts`, `src/store/visible-sql.ts`; pieza A7 del plan de memoria, 6 nov
 * 2026): a JS llega una fila por carpeta, no una por nota, y el filtro no carga ninguna nota
 * (`privacyLoad: 'lazy'`).
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
  const visibleCounts = await ctx.port.visibleFolderCounts(ctx.privacy.notesScope());
  // Cada carpeta con la ruta que sale: la puerta final (`../privacy-gate.ts`) la vuelve a juzgar
  // con el árbol de ahora, y si una carpeta ya es privada (también una que nació dentro de una
  // privada después del filtro de la llamada) o cambió de ruta, repite la llamada. Los recuentos
  // no declaran sus notas (serían todas las visibles): los cubre la época de privacidad, que la
  // llamada toma antes de su filtro (como en `hebra_list_tags`).
  const used = usageOf(ctx);
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
