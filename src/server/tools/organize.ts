/**
 * Organización por id (D2 ampliada, decisiones de David del 28 sep 2026):
 * `hebra_move_note`, `hebra_set_favorite`, `hebra_set_archived`, `hebra_create_folder`,
 * `hebra_rename_folder` y `hebra_move_folder`. Sin papelera, versiones ni adjuntos (otro
 * lote) y sin nada irreversible.
 *
 * Privacidad, en tres sitios:
 * 1. Aquí, antes de escribir, con el filtro de esta llamada: el origen y el destino
 *    tienen que ser visibles; si no, `not_found` (una carpeta privada responde igual que
 *    una que no existe, decisión 4).
 * 2. En el escritor, dentro del turno en que escribe y con esta misma configuración
 *    (`NoteWriter.organize`), que además simula el árbol resultante para que renombrar o
 *    mover una carpeta no cambie qué es privado.
 * 3. Sobre el resultado: la ruta que se devuelve sale de un filtro recalculado DESPUÉS de
 *    escribir. Si para entonces el sync hubiera dejado oculto lo organizado, se responde
 *    `not_found` en vez de enseñar una ruta privada.
 *
 * La salida lleva el estado de sync (`../write-context.ts`, `SyncFields`).
 */
import { ROOT_FOLDER_ID } from '../../hebra';
import { logEvent } from '../../log/logger';
import { PrivacyFilter } from '../../privacy/filter';
import { FOLDER_NAME_MAX_LENGTH, type OrganizeAction } from '../../store/writes';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import type { OrganizeOutcome, SyncFields } from '../write-context';
import { mapWriteError } from './write-errors';

export type NoteOrganizeOutput = {
  id: string;
  folderPath: string;
  favorite: boolean;
  archived: boolean;
} & SyncFields;

export type FolderOrganizeOutput = { id: string; path: string } & SyncFields;

function syncOf(outcome: SyncFields): SyncFields {
  return outcome.syncError === undefined
    ? { sync: outcome.sync }
    : { sync: outcome.sync, syncError: outcome.syncError };
}

function requireVisibleNote(ctx: ToolContext, id: string): void {
  if (!ctx.privacy.visibleMeta(id)) throw new ToolError('not_found');
}

function requireVisibleFolder(ctx: ToolContext, id: string): void {
  if (!ctx.privacy.folderExists(id) || ctx.privacy.isFolderHidden(id)) {
    throw new ToolError('not_found');
  }
}

function requireFolderName(name: string): void {
  if (name.trim().length === 0 || name.length > FOLDER_NAME_MAX_LENGTH) {
    throw new ToolError('invalid_input');
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

/** El filtro de DESPUÉS de escribir (paso 3 de la cabecera). */
function freshPrivacy(ctx: ToolContext): Promise<PrivacyFilter> {
  return PrivacyFilter.build(ctx.port, ctx.privacyConfig);
}

async function noteOutput(
  ctx: ToolContext,
  action: OrganizeAction['action'],
  outcome: OrganizeOutcome
): Promise<NoteOrganizeOutput> {
  if (outcome.kind !== 'note') throw new ToolError('invalid_input');
  const after = await freshPrivacy(ctx);
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

async function folderOutput(
  ctx: ToolContext,
  action: OrganizeAction['action'],
  outcome: OrganizeOutcome
): Promise<FolderOrganizeOutput> {
  if (outcome.kind !== 'folder') throw new ToolError('invalid_input');
  const after = await freshPrivacy(ctx);
  if (!after.folderExists(outcome.id) || after.isFolderHidden(outcome.id)) {
    throw new ToolError('not_found');
  }
  logEvent({ event: 'folder.organize', id: outcome.id, action, sync: outcome.sync });
  return { id: outcome.id, path: after.folderPath(outcome.id), ...syncOf(outcome) };
}

/** `hebra_move_note`: a otra carpeta visible (`"root"` es la raíz). */
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

/** `hebra_create_folder`: dentro de `parentId` (por defecto, la raíz). */
export async function runCreateFolder(
  ctx: ToolContext,
  input: { name: string; parentId?: string }
): Promise<FolderOrganizeOutput> {
  requireFolderName(input.name);
  const parentId = input.parentId ?? ROOT_FOLDER_ID;
  requireVisibleFolder(ctx, parentId);
  const action = { action: 'createFolder', parentId, name: input.name } as const;
  return folderOutput(ctx, action.action, await organize(ctx, action));
}

/** `hebra_rename_folder`. */
export async function runRenameFolder(
  ctx: ToolContext,
  input: { id: string; name: string }
): Promise<FolderOrganizeOutput> {
  requireFolderName(input.name);
  requireVisibleFolder(ctx, input.id);
  const action = { action: 'renameFolder', id: input.id, name: input.name } as const;
  return folderOutput(ctx, action.action, await organize(ctx, action));
}

/** `hebra_move_folder`: dentro de `parentId` (`"root"` es la raíz); nunca en sí misma
 *  ni en una descendiente (`folder_cycle`). */
export async function runMoveFolder(
  ctx: ToolContext,
  input: { id: string; parentId: string }
): Promise<FolderOrganizeOutput> {
  requireVisibleFolder(ctx, input.id);
  requireVisibleFolder(ctx, input.parentId);
  const action = { action: 'moveFolder', id: input.id, parentId: input.parentId } as const;
  return folderOutput(ctx, action.action, await organize(ctx, action));
}
