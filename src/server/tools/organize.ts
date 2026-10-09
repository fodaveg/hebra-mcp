/**
 * Organización de notas por id (D2 ampliada, decisiones de David del 28 sep 2026):
 * `hebra_move_note` (a una carpeta que ya existe), `hebra_set_favorite` y
 * `hebra_set_archived`. Desde el 30 sep 2026 («acepto tus recomendaciones»), también
 * `hebra_trash_note` y `hebra_restore_note`: mandar una nota visible a la papelera y
 * sacarla, las dos reversibles desde Hebra y desde el MCP. Sin adjuntos (otro lote) y
 * sin nada irreversible: ni purga ni vaciar la papelera.
 *
 * Papelera y privacidad: una nota de la papelera cuenta como visible solo si la deja ver
 * el filtro de la papelera (`TrashFilter`, `src/privacy/trash-filter.ts`), que comprueba
 * también su carpeta de antes aunque se haya borrado, y así el destino de restaurarla.
 * Oculta o inexistente, `not_found`, igual en los dos casos.
 *
 * Crear, renombrar y mover CARPETAS no están en el MCP (opción A de David, 28 sep 2026):
 * sus errores (`folder_name_taken`, y el `not_found` de renombrar o mover una carpeta
 * visible con una privada dentro) revelaban carpetas privadas. Las carpetas se crean
 * desde la app Hebra.
 *
 * Privacidad, en tres sitios:
 * 1. Aquí, antes de escribir, con el filtro de esta llamada: la nota y la carpeta de
 *    destino tienen que ser visibles; si no, `not_found` (una carpeta privada responde
 *    igual que una que no existe, decisión 4).
 * 2. En el escritor, dentro del turno en que escribe y con esta misma configuración
 *    (`NoteWriter.organize`).
 * 3. Sobre el resultado: la ruta que se devuelve sale de un filtro recalculado DESPUÉS de
 *    escribir. Si para entonces el sync hubiera dejado oculta la nota, se responde
 *    `not_found` en vez de enseñar una ruta privada.
 *
 * La salida lleva el estado de sync (`../write-context.ts`, `SyncFields`).
 */
import { logEvent } from '../../log/logger';
import { PrivacyFilter } from '../../privacy/filter';
import { TrashFilter } from '../../privacy/trash-filter';
import type { OrganizeAction } from '../../store/writes';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import { syncOf, type OrganizeOutcome, type SyncFields } from '../write-context';
import { requireVisibleNote } from './guards';
import { mapWriteError } from './write-errors';

export type NoteOrganizeOutput = {
  id: string;
  folderPath: string;
  favorite: boolean;
  archived: boolean;
} & SyncFields;

/** Viva y visible, o en la papelera y visible para el filtro de la papelera. */
async function requireVisibleLiveOrTrashed(ctx: ToolContext, id: string): Promise<void> {
  if (ctx.privacy.visibleMeta(id)) return;
  const trash = await TrashFilter.build(ctx.port, ctx.privacy, ctx.privacyConfig);
  if (!trash.isVisible(id)) throw new ToolError('not_found');
}

function requireVisibleFolder(ctx: ToolContext, id: string): void {
  if (!ctx.privacy.folderExists(id) || ctx.privacy.isFolderHidden(id)) {
    throw new ToolError('not_found');
  }
}

async function organize(ctx: ToolContext, action: OrganizeAction): Promise<OrganizeOutcome> {
  if (!ctx.write) throw new ToolError('invalid_input');
  try {
    return await ctx.write.organize({ ...action, privacy: ctx.privacyConfig });
  } catch (error) {
    throw mapWriteError(error);
  }
}

/** Filtro de DESPUÉS de escribir (paso 3 de la cabecera) y la salida con la ruta. */
async function noteOutput(
  ctx: ToolContext,
  action: OrganizeAction['action'],
  outcome: OrganizeOutcome
): Promise<NoteOrganizeOutput> {
  const after = await PrivacyFilter.build(ctx.port, ctx.privacyConfig);
  const meta = after.visibleMeta(outcome.id);
  if (!meta) throw new ToolError('not_found');
  logEvent({ event: 'note.organize', id: outcome.id, action, sync: outcome.sync });
  return {
    id: outcome.id,
    folderPath: after.folderPath(meta.folderId),
    favorite: outcome.favorite,
    archived: outcome.archived,
    ...syncOf(outcome)
  };
}

/** `hebra_move_note`: a otra carpeta visible que ya exista (`"root"` es la raíz). */
export async function runMoveNote(
  ctx: ToolContext,
  input: { id: string; folderId: string }
): Promise<NoteOrganizeOutput> {
  requireVisibleNote(ctx, input.id);
  requireVisibleFolder(ctx, input.folderId);
  const action = { action: 'moveNote', id: input.id, folderId: input.folderId } as const;
  return noteOutput(ctx, action.action, await organize(ctx, action));
}

/** `hebra_set_favorite`: marca o desmarca. Idempotente. */
export async function runSetFavorite(
  ctx: ToolContext,
  input: { id: string; favorite: boolean }
): Promise<NoteOrganizeOutput> {
  requireVisibleNote(ctx, input.id);
  const action = { action: 'setFavorite', id: input.id, favorite: input.favorite } as const;
  return noteOutput(ctx, action.action, await organize(ctx, action));
}

/** `hebra_set_archived`: archiva (`true`) o desarchiva (`false`). Idempotente. */
export async function runSetArchived(
  ctx: ToolContext,
  input: { id: string; archived: boolean }
): Promise<NoteOrganizeOutput> {
  requireVisibleNote(ctx, input.id);
  const action = { action: 'setArchived', id: input.id, archived: input.archived } as const;
  return noteOutput(ctx, action.action, await organize(ctx, action));
}

export type NoteTrashOutput = { id: string; trashed: true } & SyncFields;

/** `hebra_trash_note`: manda una nota visible a la papelera (reversible con
 *  `hebra_restore_note` o desde Hebra). Idempotente: una que ya está en la papelera y
 *  es visible allí se queda como está. La salida no lleva ruta ni título. */
export async function runTrashNote(
  ctx: ToolContext,
  input: { id: string }
): Promise<NoteTrashOutput> {
  await requireVisibleLiveOrTrashed(ctx, input.id);
  const outcome = await organize(ctx, { action: 'trashNote', id: input.id });
  logEvent({ event: 'note.organize', id: outcome.id, action: 'trashNote', sync: outcome.sync });
  return { id: outcome.id, trashed: true, ...syncOf(outcome) };
}

/** `hebra_restore_note`: saca una nota de la papelera, a su carpeta si sigue viva o a la
 *  raíz (como Hebra). Idempotente: una nota viva y visible se queda como está. La ruta
 *  de la salida sale del filtro de DESPUÉS de escribir, como mover. */
export async function runRestoreNote(
  ctx: ToolContext,
  input: { id: string }
): Promise<NoteOrganizeOutput> {
  await requireVisibleLiveOrTrashed(ctx, input.id);
  const action = { action: 'restoreNote', id: input.id } as const;
  return noteOutput(ctx, action.action, await organize(ctx, action));
}
