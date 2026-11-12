/**
 * «Versiones anteriores» de una nota (ampliación de D2, decisión de David del 30 sep
 * 2026): `hebra_list_versions`, `hebra_read_version` y `hebra_restore_version`.
 *
 * Qué versiones hay: las instantáneas LOCALES del almacén de hebra-mcp (`note_versions`
 * de Hebra, `note-versions-store.ts`): el cuerpo que un guardado o un cambio bajado por
 * el sync sustituyó, como mucho una cada 5 minutos. Las 5 más recientes de cada nota no
 * caducan y las demás caducan a los 7 días. Nunca viajan por el sync, así que no son las
 * del Mac: son las que este dispositivo ha visto.
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
 * la vez en otro dispositivo deja una copia de conflicto visible (`NoteWriter.restoreVersion`),
 * salvo en un espacio compartido, donde el motor combina y el resultado es `merged` (D25).
 *
 * Perezosas (A5b del plan de memoria, 6 nov 2026): las tres se registran con `privacyLoad:
 * 'lazy'` y solo cargan en el filtro la nota `id` (`requireLoadedVisibleNote`); lo que se juzga
 * de una versión (`versionIsHidden`) solo mira la configuración. Equivalencia con `'all'` en
 * `test/tools/note-writes-lazy.test.ts`.
 *
 * En un espacio compartido (`space`, HS-5, 12 nov 2026), las tres van por defecto al historial
 * del espacio en el relé (`./space-versions.ts`, §28 de Hebra): `versionId` es entonces el
 * `rev` de la versión y cada una dice quién la editó. Si el relé no lo da (404 con la función
 * apagada, sin red…), listar y leer sin `source` caen a estas versiones locales y la respuesta lo
 * dice (`source: "local"`, `sourceReason`). Con `source: "local"` se piden las locales a
 * propósito (las de un listado que ya cayó a ellas: sus `versionId` no son `rev` del relé).
 * Restaurar sin `source` (o con `"server"`) y leer con `source: "server"` nunca caen a lo
 * local: `history_unavailable` con `sourceReason`, porque la versión local con ese número es
 * otra, y restaurarla guardaría un texto que el agente no vio.
 */
import { deriveNote } from '../../hebra';
import { logEvent } from '../../log/logger';
import type { PrivacyFilter } from '../../privacy/filter';
import { LOCKED_BODY_PREFIX } from '../../store/writes';
import type { NoteVersion, NoteVersionSummary } from '../../store/types';
import { ToolError } from '../errors';
import { LIMITS, effectiveLimit, unwrapCursor, wrapCursor } from '../pagination';
import { usageOf, type ToolContext } from '../context';
import type { EditNoteOutcome } from '../write-context';
import { declareWriteUsage, requireLoadedVisibleNote, requireValidOperationId } from './guards';
import {
  isServerCursor,
  listServerVersions,
  readServerVersion,
  serverVersionBody,
  type LocalSourceReason,
  type ServerListOutput,
  type ServerReadOutput,
  type SpaceVersionsDeps
} from './space-versions';
import { mapWriteError } from './write-errors';

export interface ListedVersion {
  versionId: number;
  createdAt: string;
  byteLength: number;
}

export interface ReadVersionOutput extends ListedVersion {
  id: string;
  body: string;
  /** Solo en un espacio (HS-5): la versión es de este dispositivo, y por qué. */
  source?: 'local';
  sourceReason?: LocalSourceReason;
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
  input: { id: string; limit?: number; cursor?: string },
  space?: SpaceVersionsDeps
): Promise<LocalListOutput | ServerListOutput> {
  const limit = effectiveLimit(input.limit, LIMITS.listVersions);
  if (space && isServerCursor(input.cursor)) {
    await requireLoadedVisibleNote(ctx, input.id);
    const server = await listServerVersions(ctx, space, { id: input.id, limit, cursor: input.cursor });
    if (!('unavailable' in server)) return server;
    logEvent({ event: 'space.history_local', tool: 'hebra_list_versions', reason: server.unavailable });
    return {
      ...(await listLocalVersions(ctx, { id: input.id, limit })),
      source: 'local',
      sourceReason: server.unavailable
    };
  }
  // Con `space` y un cursor `v1.…`: se sigue con las locales de la página anterior.
  const local = await listLocalVersions(ctx, { id: input.id, limit, cursor: input.cursor });
  return space ? { ...local, source: 'local' } : local;
}

/** Lo que sale de las versiones locales; en un espacio, con `source` y el motivo. */
export interface LocalListOutput {
  id: string;
  versions: ListedVersion[];
  nextCursor: string | null;
  source?: 'local';
  sourceReason?: LocalSourceReason;
}

/** Las versiones locales (la herramienta de siempre, sin `space`). */
async function listLocalVersions(
  ctx: ToolContext,
  input: { id: string; limit: number; cursor?: string }
): Promise<{ id: string; versions: ListedVersion[]; nextCursor: string | null }> {
  const limit = input.limit;
  const after = input.cursor !== undefined ? Number(unwrapCursor('v1', input.cursor)) : null;
  if (after !== null && !Number.isInteger(after)) throw new ToolError('invalid_input');
  await requireLoadedVisibleNote(ctx, input.id);
  const { items } = await ctx.port.noteVersionsList(input.id);

  const readBodies = ctx.privacyConfig.privateTags.length > 0;
  /** Cuáles de `chunk` no pueden salir: cuerpo con etiqueta privada, bloqueado, ya no
   *  existe o es de otra nota. */
  const hiddenOf = async (chunk: readonly NoteVersionSummary[]): Promise<boolean[]> => {
    const ids = chunk.map((item) => item.id);
    return readBodies
      ? (await ctx.port.noteVersionsRead(ids)).map(
          (version) =>
            !version || version.noteId !== input.id || versionIsHidden(ctx.privacy, version)
        )
      : (await ctx.port.noteVersionsLocked(ids)).map(
          (locked, index) => locked !== false || chunk[index]!.noteId !== input.id
        );
  };

  let position = 0;
  if (after !== null) {
    const index = items.findIndex((item) => item.id === after);
    // Un cursor solo puede llevar una versión ya devuelta, así que una oculta es tan
    // inválida como una que no existe (M2 del audit de privacidad, 10 oct 2026): antes
    // daba una página vacía, y recorriendo ids se sabía cuántas privadas tuvo y dónde.
    if (index < 0 || (await hiddenOf([items[index]!]))[0]) throw new ToolError('invalid_input');
    position = index + 1;
  }

  const visible: ListedVersion[] = [];
  let lastId: number | undefined;
  let hasMore = false;
  while (position < items.length && !hasMore) {
    // Lo que falta para la página más la de mirar por delante, de una vez.
    const chunk = items.slice(position, position + (limit - visible.length + 1));
    position += chunk.length;
    const hidden = await hiddenOf(chunk);
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
  // La nota: la puerta final (`../privacy-gate.ts`) la vuelve a juzgar con el filtro de
  // ahora y su sello antes de responder (C1, y la 2.ª revisión de Codex).
  usageOf(ctx).note(input.id);
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
  input: { id: string; versionId: number; authors?: boolean; source?: VersionSource },
  space?: SpaceVersionsDeps
): Promise<ReadVersionOutput | ServerReadOutput> {
  if (!space && input.source === 'server') throw new ToolError('invalid_input');
  if (space && input.source !== 'local') {
    await requireLoadedVisibleNote(ctx, input.id);
    const server = await readServerVersion(ctx, space, input);
    if (!('unavailable' in server)) return server;
    // Pedida al servidor a propósito: nunca otra versión con el mismo número (D26).
    if (input.source === 'server') throw historyUnavailable('hebra_read_version', server.unavailable);
    // Sin `source`, una lectura (no escribe) cae a la de este dispositivo y lo dice.
    logEvent({ event: 'space.history_local', tool: 'hebra_read_version', reason: server.unavailable });
    return { ...(await readLocalVersion(ctx, input)), source: 'local', sourceReason: server.unavailable };
  }
  const local = await readLocalVersion(ctx, input);
  return space ? { ...local, source: 'local' } : local;
}

/** De dónde sale la versión en un espacio: el historial del relé o este dispositivo. */
export type VersionSource = 'server' | 'local';

/** El relé no dio la versión que se pidió al servidor (D26): `history_unavailable` con el
 *  motivo, en vez de tomar la versión local con el mismo número, que es otra (los `versionId`
 *  locales y los `rev` del relé no son del mismo espacio de nombres). */
function historyUnavailable(tool: string, sourceReason: LocalSourceReason): ToolError {
  logEvent({ event: 'space.history_unavailable', tool, reason: sourceReason });
  return new ToolError('history_unavailable', { sourceReason });
}

async function readLocalVersion(
  ctx: ToolContext,
  input: { id: string; versionId: number }
): Promise<ReadVersionOutput> {
  await requireLoadedVisibleNote(ctx, input.id);
  const version = await ctx.port.noteVersionRead(input.versionId);
  if (!version || version.noteId !== input.id || versionIsHidden(ctx.privacy, version)) {
    throw new ToolError('not_found');
  }
  // La nota: la puerta final la vuelve a juzgar antes de responder (C1 de la revisión de
  // Codex).
  usageOf(ctx).note(input.id);
  return { id: input.id, ...listed(version), body: version.body };
}

/** `hebra_restore_version`: deja el cuerpo de la versión como una edición nueva sobre la
 *  revisión leída. La misma salida y los mismos errores que `hebra_edit_note`. En un espacio,
 *  una versión local solo con `source: "local"` explícito: sin `source` o con `"server"`, si el
 *  relé no la da, `history_unavailable` sin escribir nada (D26). */
export async function runRestoreVersion(
  ctx: ToolContext,
  input: {
    id: string;
    versionId: number;
    expectedRevision: string;
    operationId: string;
    source?: VersionSource;
  },
  space?: SpaceVersionsDeps
): Promise<EditNoteOutcome | (EditNoteOutcome & { source: VersionSource })> {
  if (!ctx.write) throw new ToolError('invalid_input');
  if (!space && input.source === 'server') throw new ToolError('invalid_input');
  requireValidOperationId(input.operationId);
  await requireLoadedVisibleNote(ctx, input.id);

  // HS-5: en un espacio, la versión del relé (por defecto) se lee y descifra aquí y el
  // escritor la restaura como una edición nueva, con las mismas comprobaciones que una local.
  // Si el relé no la da, NO se cae a la local con el mismo número: sería otra versión, y el
  // escritor guardaría un texto que el agente nunca vio.
  let serverVersion: { body: string } | undefined;
  if (space && input.source !== 'local') {
    const read = await serverVersionBody(ctx, space, input);
    if ('unavailable' in read) throw historyUnavailable('hebra_restore_version', read.unavailable);
    serverVersion = read;
  }

  let result: EditNoteOutcome;
  try {
    result = await ctx.write.restoreVersion({
      id: input.id,
      versionId: input.versionId,
      expectedRevision: input.expectedRevision,
      operationId: input.operationId,
      privacy: ctx.privacyConfig,
      ...(serverVersion ? { serverVersion } : {})
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
  // Tras la ronda, la nota puede haber pasado a oculta: la respuesta de una que no existe
  // (C3 de la revisión de Codex; la escritura ya está hecha). Lo juzga la puerta final.
  declareWriteUsage(ctx, result);
  if (!space) return result;
  return { ...result, source: serverVersion ? 'server' : 'local' };
}
