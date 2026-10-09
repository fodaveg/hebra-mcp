/**
 * `hebra_create_folder` y `hebra_rename_folder` (D9, decisión de David del 3 oct 2026,
 * que sustituye en esto la opción A del 28 sep 2026). Mover y borrar carpetas siguen
 * fuera del MCP: no hay herramienta para ellas.
 *
 * Privacidad, en tres sitios, como la organización de notas (`./organize.ts`):
 * 1. Aquí, antes de escribir, con el filtro de esta llamada: el plan de
 *    `src/store/folders.ts` (nombre, carpeta de partida visible, ruta privada decidida
 *    desde la configuración, hermanas homónimas). Un rechazo sale sin molestar al
 *    escritor.
 * 2. En el escritor, dentro del turno en que escribe y con esta misma configuración
 *    (`NoteWriter.createFolderLocal`/`renameFolderLocal`), que rehace el plan.
 * 3. Sobre el resultado: la ruta que se devuelve sale de un filtro recalculado DESPUÉS de
 *    escribir; si para entonces la carpeta no fuera visible, `not_found` en vez de enseñar
 *    una ruta privada.
 *
 * `folder_unavailable` es UNO para todo lo que tenga que ver con lo privado (ruta privada
 * o debajo de una, una privada debajo de la que se renombra, un choque con algo oculto):
 * la misma respuesta exista o no la carpeta privada. `folder_name_taken` solo nombra
 * hermanas visibles.
 *
 * Logs (§6.4): `folder.create`/`folder.rename` con el id (opaco), si cambió algo y el
 * estado de sync. Nunca el nombre ni la ruta.
 */
import { ROOT_FOLDER_ID } from '../../hebra';
import { logEvent } from '../../log/logger';
import { PrivacyFilter } from '../../privacy/filter';
import { planCreateFolder, planRenameFolder } from '../../store/folders';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import { syncOf, type FolderOutcome, type SyncFields } from '../write-context';
import { mapWriteError } from './write-errors';

export type CreateFolderOutput = { id: string; path: string; created: boolean } & SyncFields;
export type RenameFolderOutput = { id: string; path: string; renamed: boolean } & SyncFields;

/** La ruta de la carpeta con el filtro de DESPUÉS de escribir (paso 3 de la cabecera). */
async function visiblePathAfter(ctx: ToolContext, id: string): Promise<string> {
  const after = await PrivacyFilter.build(ctx.port, ctx.privacyConfig);
  if (!after.folderExists(id) || after.isFolderHidden(id)) throw new ToolError('not_found');
  return after.folderPath(id);
}

/** El padre: `parentId` (`"root"` es la raíz) o `parent` (ruta, como `path` de
 *  `hebra_list_folders`), como mucho uno; sin ninguno, la raíz. Una ruta que no existe es
 *  `not_found`, igual que una oculta (lo decide el plan). */
function parentOf(ctx: ToolContext, input: { parent?: string; parentId?: string }): string {
  if (input.parent !== undefined && input.parentId !== undefined) {
    throw new ToolError('invalid_input');
  }
  if (input.parentId !== undefined) return input.parentId;
  if (input.parent === undefined) return ROOT_FOLDER_ID;
  const id = ctx.privacy.folderIdForPath(input.parent);
  if (!id) throw new ToolError('not_found');
  return id;
}

/** `hebra_create_folder`: una carpeta nueva dentro de una visible (o de la raíz).
 *  Idempotente: una hermana visible con ese nombre se devuelve con `created: false`. */
export async function runCreateFolder(
  ctx: ToolContext,
  input: { name: string; parent?: string; parentId?: string }
): Promise<CreateFolderOutput> {
  if (!ctx.write) throw new ToolError('invalid_input');
  const parentId = parentOf(ctx, input);
  const plan = planCreateFolder(ctx.privacy, parentId, input.name);
  if (plan.kind === 'reject') throw new ToolError(plan.code);

  let outcome: FolderOutcome;
  try {
    outcome = await ctx.write.createFolder({
      parentId,
      name: input.name,
      privacy: ctx.privacyConfig
    });
  } catch (error) {
    throw mapWriteError(error);
  }
  const path = await visiblePathAfter(ctx, outcome.id);
  logEvent({ event: 'folder.create', id: outcome.id, created: outcome.changed, sync: outcome.sync });
  return { id: outcome.id, path, created: outcome.changed, ...syncOf(outcome) };
}

/** `hebra_rename_folder`: renombra una carpeta visible. Idempotente: el nombre que ya
 *  tiene responde `renamed: false` sin escribir. */
export async function runRenameFolder(
  ctx: ToolContext,
  input: { folderId: string; name: string }
): Promise<RenameFolderOutput> {
  if (!ctx.write) throw new ToolError('invalid_input');
  const plan = planRenameFolder(ctx.privacy, input.folderId, input.name);
  if (plan.kind === 'reject') throw new ToolError(plan.code);

  let outcome: FolderOutcome;
  try {
    outcome = await ctx.write.renameFolder({
      id: input.folderId,
      name: input.name,
      privacy: ctx.privacyConfig
    });
  } catch (error) {
    throw mapWriteError(error);
  }
  const path = await visiblePathAfter(ctx, outcome.id);
  logEvent({ event: 'folder.rename', id: outcome.id, renamed: outcome.changed, sync: outcome.sync });
  return { id: outcome.id, path, renamed: outcome.changed, ...syncOf(outcome) };
}
