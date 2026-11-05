/**
 * `hebra_list_trash` con `kind: "folders"` (D23, 5 nov 2026): las carpetas de la papelera
 * (`foldersTrashList` del motor, vía `HebraLibraryPort.foldersTrash`), de la última en entrar
 * a la primera. Sin `kind`, o con `"notes"`, la herramienta lista notas (`./list-trash.ts`).
 *
 * Privacidad (SPEC.md §6.3): se juzga con `TrashFilter.restoreFolderOf`, la misma subida por
 * las filas de carpeta (lápidas incluidas) que las notas y los ficheros de la papelera. Una
 * carpeta de la papelera no sale si ella o una antecesora (viva o también en la papelera) es
 * una ruta privada configurada, una carpeta a la que resolvió una ruta privada antes (A3), o
 * si no se puede saber (cerrado ante la duda). Lo oculto no deja huella: la lista ya sale
 * filtrada, sin recuento, y `nextCursor` solo existe si detrás queda otra carpeta VISIBLE.
 *
 * El motor no pagina esta lista, así que se pagina aquí, sobre la lista ya filtrada. El
 * cursor (`r1.…`, el mismo prefijo que el de las notas de la papelera, pero con un payload
 * `f.<trashedAt>.<id>` que el de notas no tiene, así que no se aceptan entre sí) lleva la
 * clave de orden de la última devuelta: reanuda tras ella aunque se restaure o se borre.
 *
 * La puerta final (`../privacy-gate.ts`) no tiene una declaración para carpetas de la
 * papelera; las protege la ÉPOCA de privacidad (carpetas incluidas), que repite la llamada si
 * algo cambió entre el principio y la respuesta.
 */
import { TrashFilter } from '../../privacy/trash-filter';
import type { FolderTrashEntry } from '../../store/state-reads';
import type { ToolContext } from '../context';
import { ToolError } from '../errors';
import {
  LIMITS,
  effectiveLimit,
  sliceAfterKey,
  unwrapCursor,
  wrapCursor
} from '../pagination';

export interface TrashedFolder {
  id: string;
  name: string;
  /** Ruta que tenía al borrarla (en minúsculas, como `path` de `hebra_list_folders`): desde
   *  la carpeta viva más cercana hacia abajo. Un antecesor ya purgado no consta. */
  path: string;
  trashedAt: string;
}

interface OrderKey {
  trashedAt: number;
  id: string;
}

/** Orden de la lista: la última en entrar primero y, a igual fecha, por id ascendente (el
 *  del motor, `ORDER BY trashed_at DESC, id`). */
function compareKeys(left: OrderKey, right: OrderKey): number {
  if (left.trashedAt !== right.trashedAt) return right.trashedAt - left.trashedAt;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function decodeCursor(cursor: string): OrderKey {
  const match = /^f\.(\d{1,16})\.(.+)$/su.exec(unwrapCursor('r1', cursor));
  if (!match) throw new ToolError('invalid_input');
  return { trashedAt: Number(match[1]), id: match[2]! };
}

/** La ruta original: nombres de las antecesoras que también están en la papelera hasta una
 *  carpeta viva (su ruta de ahora) o hasta donde ya no hay fila (una purgada). */
function originalPath(
  entry: FolderTrashEntry,
  byId: ReadonlyMap<string, FolderTrashEntry>,
  ctx: ToolContext
): string {
  const names = [entry.name.trim().toLowerCase()];
  const seen = new Set([entry.id]);
  let prefix = '';
  for (let parent = entry.parentId; parent !== null && !seen.has(parent); ) {
    const above = byId.get(parent);
    if (above) {
      seen.add(parent);
      names.unshift(above.name.trim().toLowerCase());
      parent = above.parentId;
      continue;
    }
    if (ctx.privacy.folderExists(parent)) prefix = ctx.privacy.folderPath(parent);
    break;
  }
  return [prefix, ...names].filter((segment) => segment !== '').join('/');
}

export async function runListTrashFolders(
  ctx: ToolContext,
  input: { cursor?: string; limit?: number }
): Promise<{ folders: TrashedFolder[]; nextCursor: string | null }> {
  const limit = effectiveLimit(input.limit, LIMITS.listTrash);
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const trash = await TrashFilter.build(ctx.port, ctx.privacy, ctx.privacyConfig);
  const entries = await ctx.port.foldersTrash();
  const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
  const visible = entries
    .filter((entry) => trash.restoreFolderOf(entry.id) !== undefined)
    .sort(compareKeys);
  const page = sliceAfterKey(visible, {
    limit,
    after,
    keyOf: (entry): OrderKey => ({ trashedAt: entry.trashedAt, id: entry.id }),
    compare: compareKeys
  });
  return {
    folders: page.items.map((entry) => ({
      id: entry.id,
      name: entry.name,
      path: originalPath(entry, byId, ctx),
      trashedAt: new Date(entry.trashedAt).toISOString()
    })),
    nextCursor:
      page.lastKey === null ? null : wrapCursor('r1', `f.${page.lastKey.trashedAt}.${page.lastKey.id}`)
  };
}
