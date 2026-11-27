/**
 * Comprobaciones previas que comparten varias herramientas (visibilidad de la nota y
 * longitud de `operationId`). Cada una lanza `ToolError`, igual que antes estaban copiadas.
 */
import { ROOT_FOLDER_ID } from '../../hebra';
import { OPERATION_ID_MAX_LENGTH } from '../../store/operations';
import { REVISION_MAX_LENGTH } from '../../store/revision';
import { usageOf, type ToolContext } from '../context';
import { ToolError, tooLarge } from '../errors';

/**
 * La nota existe y es visible para el filtro de privados; si no, `not_found`. Visible, queda
 * declarada para la puerta final (`../privacy-gate.ts`) desde YA, antes de escribir o de
 * leerla: un error posterior que dependa de ella (`note_locked`, `ambiguous_heading` con sus
 * candidatos, `no_match`…) también la necesita visible y sin cambios al salir (R3-1 de la 3.ª
 * revisión de Codex).
 *
 * Juzga con lo que el filtro ya tenga cargado: en una herramienta perezosa (`privacyLoad:
 * 'lazy'`) sin `ensure` previo, la nota cuenta como oculta (`not_found`, falla cerrando). Las
 * perezosas usan `requireLoadedVisibleNote`.
 */
export function requireVisibleNote(ctx: ToolContext, id: string): void {
  if (!ctx.privacy.visibleMeta(id)) throw new ToolError('not_found');
  usageOf(ctx).note(id);
}

/**
 * `requireVisibleNote` para una herramienta perezosa (`privacyLoad: 'lazy'`, pieza A5b del plan
 * de memoria, 6 nov 2026): carga antes esa nota en el filtro (`ctx.privacy.ensure([id])`, que
 * con `'all'` no lee nada) y la juzga después igual. Es la única nota que decide: el escritor
 * vuelve a comprobarlo todo dentro de su turno con su propia lectura, y la puerta final con la
 * suya.
 */
export async function requireLoadedVisibleNote(ctx: ToolContext, id: string): Promise<void> {
  await ctx.privacy.ensure([id]);
  requireVisibleNote(ctx, id);
}

/**
 * Lo que nombra el informe de una escritura sobre una nota (`hebra_edit_note`,
 * `hebra_restore_version`, `hebra_add_attachment`): la nota y, si la hay, su copia de
 * conflicto. La puerta final (`../privacy-gate.ts`) los juzga tras la ronda: la nota oculta,
 * `not_found`; solo la copia, el informe sin su id.
 */
export function declareWriteUsage(
  ctx: ToolContext,
  result: { id: string; outcome: string; copyId?: string }
): void {
  const used = usageOf(ctx);
  used.note(result.id);
  if (result.outcome === 'conflict_copy' && result.copyId !== undefined) used.noteInAnyState(result.copyId);
}

/** `expectedRevision` opcional de a lo sumo `REVISION_MAX_LENGTH` (D23); si no, `invalid_input`,
 *  aquí y antes de mirar ninguna nota: en un lector, el socket la rechazaría como
 *  `invalid_request`, que esas ops traducen a `writer_outdated`. No va en el esquema: un `.max()`
 *  saldría como el error de validación del SDK (`-32602`, con eco), no como `invalid_input`. */
export function requireValidRevision(revision: string | undefined): void {
  if (revision !== undefined && revision.length > REVISION_MAX_LENGTH) throw tooLarge('expectedRevision', REVISION_MAX_LENGTH, revision.length);
}

/** `operationId` no vacío y de a lo sumo `OPERATION_ID_MAX_LENGTH`; si no, `invalid_input`. */
export function requireValidOperationId(operationId: string): void {
  if (operationId.length === 0) throw new ToolError('invalid_input');
  if (operationId.length > OPERATION_ID_MAX_LENGTH) {
    throw tooLarge('operationId', OPERATION_ID_MAX_LENGTH, operationId.length);
  }
}

/** Texto del error `folder_required`, sin eco de la entrada. */
export const FOLDER_REQUIRED_MESSAGE =
  'La raíz de la biblioteca no se ve en la app de Hebra: elige una carpeta (`folder` o `folderId`, de hebra_list_folders).';

/**
 * Un fichero de trabajo (hoja, .base, .json…) nunca vive en la raíz: la app de Hebra no deja
 * seleccionarla y el fichero quedaría invisible (H-MCP-SIN-RAIZ, 23 nov 2026). `id` es la
 * carpeta ya resuelta (por `folderId`, por ruta o por defecto); la raíz, o ninguna carpeta
 * donde hacía falta una, es `folder_required`, sin tocar el almacén. Las notas no pasan por aquí.
 */
export function requireNonRootFolder(id: string | undefined): asserts id is string {
  if (id === undefined || id === ROOT_FOLDER_ID) {
    throw new ToolError('folder_required', { message: FOLDER_REQUIRED_MESSAGE });
  }
}
