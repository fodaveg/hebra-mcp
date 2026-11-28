/**
 * `hebra_trash_folder` y `hebra_restore_folder` (D29, 28 nov 2026): mandar una carpeta a la
 * papelera de Hebra, con sus subcarpetas, notas y ficheros sueltos (como «Enviar a la
 * papelera…» de la app), y sacarla. Reversibles; nada purga. Con `space`, en la papelera de ese
 * espacio, como la app. Las reglas y su orden están en `../../store/folder-trash.ts`.
 *
 * Privacidad, en tres sitios, como `./folders.ts`:
 * 1. Aquí, antes de escribir, con el filtro de esta llamada y la papelera de ahora: el plan de
 *    `planFolderTrash`. Un rechazo sale sin molestar al escritor.
 * 2. En el escritor, dentro del turno en que escribe y con esta misma configuración
 *    (`writeFolderTrash`), que rehace el plan.
 * 3. Al sacarla, la ruta que se devuelve sale de un filtro recalculado DESPUÉS de escribir y se
 *    declara a la puerta final (`../privacy-gate.ts`): si para entonces no se ve, `not_found`. Al
 *    mandarla, la respuesta no lleva ruta ni nombre, y no se declara la carpeta (ya no está viva);
 *    la puerta final no tiene declaración para carpetas de la papelera y las protege la ÉPOCA de
 *    privacidad, como `hebra_list_trash` con `kind: "folders"`.
 *
 * Perezosas (`privacyLoad: 'lazy'`): solo preguntan por carpetas y por la configuración; la
 * papelera la juzga `TrashFilter`, que no usa el índice de notas vivas.
 *
 * Logs (§6.4): `folder.trash` y `folder.restore` con el id (opaco), si cambió algo y el estado de
 * sync. Nunca el nombre ni la ruta.
 */
import { logEvent } from '../../log/logger';
import { PrivacyFilter } from '../../privacy/filter';
import { TrashFilter } from '../../privacy/trash-filter';
import { planFolderTrash, type FolderTrashActionName } from '../../store/folder-trash';
import { usageOf, type ToolContext } from '../context';
import { ToolError } from '../errors';
import { syncOf, type FolderOutcome, type SyncFields } from '../write-context';
import { mapWriteError } from './write-errors';

export type TrashFolderOutput = { id: string; trashed: true; changed: boolean } & SyncFields;
export type RestoreFolderOutput = { id: string; path: string; restored: boolean } & SyncFields;

/** Paso 1 de la cabecera y la escritura. */
async function folderTrashWrite(
  ctx: ToolContext,
  action: FolderTrashActionName,
  id: string
): Promise<FolderOutcome> {
  if (!ctx.write?.organizeFolder) throw new ToolError('invalid_input');
  const view = {
    trashed: await ctx.port.foldersTrash(),
    trash: await TrashFilter.build(ctx.port, ctx.privacy, ctx.privacyConfig)
  };
  const plan = planFolderTrash(ctx.privacy, view, action, id);
  if (plan.kind === 'reject') throw new ToolError(plan.code);
  try {
    return await ctx.write.organizeFolder({ action, id, privacy: ctx.privacyConfig });
  } catch (error) {
    throw mapWriteError(error);
  }
}

/** `hebra_trash_folder`: manda a la papelera una carpeta visible con todo lo que tiene.
 *  Idempotente: una que ya está en la papelera (y se ve en ella) responde `changed: false`. */
export async function runTrashFolder(
  ctx: ToolContext,
  input: { folderId: string }
): Promise<TrashFolderOutput> {
  const outcome = await folderTrashWrite(ctx, 'trashFolder', input.folderId);
  logEvent({ event: 'folder.trash', id: outcome.id, changed: outcome.changed, sync: outcome.sync });
  return { id: outcome.id, trashed: true, changed: outcome.changed, ...syncOf(outcome) };
}

/** `hebra_restore_folder`: saca de la papelera una carpeta visible en ella. Idempotente: una viva
 *  y visible responde `restored: false`. `path` es su ruta de ahora (vacía si ya no se ve: lo
 *  decide la puerta final con `not_found`). */
export async function runRestoreFolder(
  ctx: ToolContext,
  input: { folderId: string }
): Promise<RestoreFolderOutput> {
  const outcome = await folderTrashWrite(ctx, 'restoreFolder', input.folderId);
  logEvent({ event: 'folder.restore', id: outcome.id, changed: outcome.changed, sync: outcome.sync });
  const after = await PrivacyFilter.build(ctx.port, ctx.privacyConfig);
  const visible = after.folderExists(outcome.id) && !after.isFolderHidden(outcome.id);
  const path = visible ? after.folderPath(outcome.id) : '';
  // La puerta final la vuelve a juzgar con esta ruta: si ya no se ve, `not_found`.
  usageOf(ctx).folder(outcome.id, path);
  return { id: outcome.id, path, restored: outcome.changed, ...syncOf(outcome) };
}
