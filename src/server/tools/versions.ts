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
import { LOCKED_BODY_PREFIX } from '../../store/writes';
import type { NoteVersion } from '../../store/types';
import { ToolError } from '../errors';
import { LIMITS, effectiveLimit, unwrapCursor, wrapCursor } from '../pagination';
import type { ToolContext } from '../context';
import type { EditNoteOutcome } from '../write-context';
import { requireValidOperationId, requireVisibleNote } from './guards';
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

/** Hebra no guarda versiones de una nota bloqueada; si alguna lo pareciera, no sale.
 *  `true` si el cuerpo de la versión no puede salir: etiqueta privada o bloqueado. */
function versionIsHidden(privacy: PrivacyFilter, version: NoteVersion): boolean {
  if (version.body.startsWith(LOCKED_BODY_PREFIX)) return true;
  return privacy.hidesAnyTag(deriveNote(version.body).tags.map(({ tag }) => tag));
}

function listed(version: NoteVersion): ListedVersion {
  return {
    versionId: version.id,
    createdAt: new Date(version.createdAt).toISOString(),
    byteLength: version.byteLength
  };
}

/**
 * `hebra_list_versions`: las versiones visibles de una nota visible, de la más reciente a
 * la más antigua, paginadas (`limit` 1-200, 50 por defecto; `cursor` `v1.…`, opaco, con el
 * id de la última versión devuelta). Sin cuerpo; sin recuento de las que se saltó.
 *
 * Solo se miran las versiones necesarias para llenar la página y saber si hay otra visible
 * detrás (una más): ni el tamaño de la página ni `nextCursor` dependen de cuántas versiones
 * ocultas hay. Con etiquetas privadas configuradas hay que leer el cuerpo (y analizarlo con
 * `deriveNote`) de cada versión mirada; sin ellas, solo se mira si el cuerpo es el de una
 * nota bloqueada, por su prefijo, sin leerlo entero ni analizarlo.
 */
export async function runListVersions(
  ctx: ToolContext,
  input: { id: string; limit?: number; cursor?: string }
): Promise<{ id: string; versions: ListedVersion[]; nextCursor: string | null }> {
  const limit = effectiveLimit(input.limit, LIMITS.listVersions);
  const after = input.cursor !== undefined ? Number(unwrapCursor('v1', input.cursor)) : null;
  if (after !== null && !Number.isInteger(after)) throw new ToolError('invalid_input');
  requireVisibleNote(ctx, input.id);
  const { items } = await ctx.port.noteVersionsList(input.id);

  let position = 0;
  if (after !== null) {
    const index = items.findIndex((item) => item.id === after);
    if (index < 0) throw new ToolError('invalid_input');
    position = index + 1;
  }
  const readBodies = ctx.privacyConfig.privateTags.length > 0;

  const visible: ListedVersion[] = [];
  let lastId: number | undefined;
  let hasMore = false;
  while (position < items.length && !hasMore) {
    // Lo que falta para la página más la de mirar por delante, de una vez.
    const chunk = items.slice(position, position + (limit - visible.length + 1));
    position += chunk.length;
    const ids = chunk.map((item) => item.id);
    const hidden = readBodies
      ? (await ctx.port.noteVersionsRead(ids)).map(
          (version) =>
            !version || version.noteId !== input.id || versionIsHidden(ctx.privacy, version)
        )
      : (await ctx.port.noteVersionsLocked(ids)).map(
          (locked, index) => locked !== false || chunk[index]!.noteId !== input.id
        );
    for (const [index, item] of chunk.entries()) {
      if (hidden[index]) continue;
      if (visible.length >= limit) {
        hasMore = true;
        break;
      }
      visible.push({
        versionId: item.id,
        createdAt: new Date(item.createdAt).toISOString(),
        byteLength: item.byteLength
      });
      lastId = item.id;
    }
  }
  return {
    id: input.id,
    versions: visible,
    nextCursor: hasMore && lastId !== undefined ? wrapCursor('v1', String(lastId)) : null
  };
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
  requireValidOperationId(input.operationId);
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
