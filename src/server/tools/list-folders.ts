/**
 * `hebra_list_folders` (SPEC.md §5, §6.3): `{folders:[{id,path,count}]}`. Las carpetas
 * privadas (y su subárbol) no aparecen; el recuento de las demás es de notas VISIBLES,
 * no el `noteCount` de `foldersList()` (que no descuenta las ocultas por etiqueta:
 * aceptación #5, una nota oculta por etiqueta tampoco cuenta en una carpeta visible).
 */
import type { ServerContext } from '../context';

export interface FolderCount {
  id: string;
  path: string;
  count: number;
}

export async function runListFolders(ctx: ServerContext): Promise<{ folders: FolderCount[] }> {
  const { folders } = await ctx.port.foldersList();
  const visibleCounts = new Map<string, number>();
  for (const { folderId } of ctx.privacy.visibleNotes().values()) {
    visibleCounts.set(folderId, (visibleCounts.get(folderId) ?? 0) + 1);
  }
  const result: FolderCount[] = [];
  for (const folder of folders) {
    if (ctx.privacy.isFolderHidden(folder.id)) continue;
    result.push({
      id: folder.id,
      path: ctx.privacy.folderPath(folder.id),
      count: visibleCounts.get(folder.id) ?? 0
    });
  }
  return { folders: result };
}
