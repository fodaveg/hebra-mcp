/**
 * «Versiones anteriores» de una nota (ampliación de D2, decisión de David del 30 sep
 * 2026): `hebra_list_versions`, `hebra_read_version` y `hebra_restore_version`.
 *
 * Qué versiones hay: las instantáneas LOCALES del almacén de hebra-mcp (`note_versions`
 * de Hebra, `note-versions-store.ts`): el cuerpo que un guardado o un cambio bajado por
 * el sync sustituyó, como mucho una cada 5 minutos, durante 7 días. Nunca viajan por el
 * sync, así que no son las del Mac: son las que este dispositivo ha visto.
 *
 * Privacidad, sobre la nota y sobre cada versión:
 * - La nota tiene que ser visible (viva, ni oculta ni en la papelera); si no, `not_found`.
 * - Una versión cuyo cuerpo lleva una etiqueta privada (o descendiente) no se lista, no
 *   se lee y no se restaura: `not_found`, igual que una versión que no existe o que es
 *   de otra nota (regla 4 de D2: nunca llevar una nota a una etiqueta privada, y sin
 *   delatar que la versión lo era). Las etiquetas salen de `deriveNote`, las mismas que
 *   guardaría Hebra al restaurarla.
 * - No se devuelve `cause` (por qué se guardó la instantánea): en un renombrado de
 *   etiquetas en lote lleva los nombres de las etiquetas («Antes de renombrar #x → #y»),
 *   y podría nombrar una privada aunque el cuerpo ya no la lleve.
 *
 * Restaurar es una EDICIÓN nueva con el control de `hebra_edit_note`: `expectedRevision`
 * (la de `hebra_read_note`), `operationId` para reintentar sin repetir, y una edición a
 * la vez en otro dispositivo deja una copia de conflicto visible (`NoteWriter.restoreVersion`).
 */
import { deriveNote } from '../../hebra';
import { logEvent } from '../../log/logger';
import type { PrivacyFilter } from '../../privacy/filter';
import { OPERATION_ID_MAX_LENGTH } from '../../store/operations';
import type { NoteVersion } from '../../store/types';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import type { EditNoteOutcome } from '../write-context';
import { mapWriteError } from './write-errors';

export interface ListedVersion {
  versionId: number;
  createdAt: string;
  byteLength: number;
}

export interface ReadVersionOutput extends ListedVersion {
  id: string;
  body: string;
}

/** Prefijo de un cuerpo bloqueado (`LOCKED_MARK` de Hebra, igual que en
 *  `src/store/writes.ts`). Hebra no guarda versiones de una nota bloqueada; si alguna lo
 *  pareciera, no sale. */
const LOCKED_BODY_PREFIX = 'hebra-locked:';

/** `true` si el cuerpo de la versión no puede salir: etiqueta privada o bloqueado. */
function versionIsHidden(privacy: PrivacyFilter, version: NoteVersion): boolean {
  if (version.body.startsWith(LOCKED_BODY_PREFIX)) return true;
  return privacy.hidesAnyTag(deriveNote(version.body).tags.map(({ tag }) => tag));
}

function requireVisibleNote(ctx: ToolContext, id: string): void {
  if (!ctx.privacy.visibleMeta(id)) throw new ToolError('not_found');
}

function listed(version: NoteVersion): ListedVersion {
  return {
    versionId: version.id,
    createdAt: new Date(version.createdAt).toISOString(),
    byteLength: version.byteLength
  };
}

/** `hebra_list_versions`: las versiones visibles de una nota visible, de la más reciente
 *  a la más antigua. Sin cuerpo; sin recuento de las que se saltó. */
export async function runListVersions(
  ctx: ToolContext,
  input: { id: string }
): Promise<{ id: string; versions: ListedVersion[] }> {
  requireVisibleNote(ctx, input.id);
  const { items } = await ctx.port.noteVersionsList(input.id);
  const versions: ListedVersion[] = [];
  for (const item of items) {
    const version = await ctx.port.noteVersionRead(item.id);
    if (!version || version.noteId !== input.id || versionIsHidden(ctx.privacy, version)) continue;
    versions.push(listed(version));
  }
  return { id: input.id, versions };
}

/** `hebra_read_version`: una versión con su cuerpo. `not_found` si la nota no es visible,
 *  si la versión no existe o es de otra nota, o si su cuerpo es privado. */
export async function runReadVersion(
  ctx: ToolContext,
  input: { id: string; versionId: number }
): Promise<ReadVersionOutput> {
  requireVisibleNote(ctx, input.id);
  const version = await ctx.port.noteVersionRead(input.versionId);
  if (!version || version.noteId !== input.id || versionIsHidden(ctx.privacy, version)) {
    throw new ToolError('not_found');
  }
  return { id: input.id, ...listed(version), body: version.body };
}

/** `hebra_restore_version`: deja el cuerpo de la versión como una edición nueva sobre la
 *  revisión leída. La misma salida y los mismos errores que `hebra_edit_note`. */
export async function runRestoreVersion(
  ctx: ToolContext,
  input: { id: string; versionId: number; expectedRevision: string; operationId: string }
): Promise<EditNoteOutcome> {
  if (!ctx.write) throw new ToolError('invalid_input');
  if (input.operationId.length === 0 || input.operationId.length > OPERATION_ID_MAX_LENGTH) {
    throw new ToolError('invalid_input');
  }
  requireVisibleNote(ctx, input.id);

  let result: EditNoteOutcome;
  try {
    result = await ctx.write.restoreVersion({
      id: input.id,
      versionId: input.versionId,
      expectedRevision: input.expectedRevision,
      operationId: input.operationId,
      privacy: ctx.privacyConfig
    });
  } catch (error) {
    throw mapWriteError(error);
  }
  logEvent({
    event: 'note.restore_version',
    id: input.id,
    outcome: result.outcome,
    sync: result.sync,
    replayed: result.replayed === true
  });
  return result;
}
