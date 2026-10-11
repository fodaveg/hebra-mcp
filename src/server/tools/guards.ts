/**
 * Comprobaciones previas que comparten varias herramientas (visibilidad de la nota y
 * longitud de `operationId`). Cada una lanza `ToolError`, igual que antes estaban copiadas.
 */
import { OPERATION_ID_MAX_LENGTH } from '../../store/operations';
import { usageOf, type ToolContext } from '../context';
import { ToolError } from '../errors';

/** La nota existe y es visible para el filtro de privados; si no, `not_found`. */
export function requireVisibleNote(ctx: ToolContext, id: string): void {
  if (!ctx.privacy.visibleMeta(id)) throw new ToolError('not_found');
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

/** `operationId` no vacío y de a lo sumo `OPERATION_ID_MAX_LENGTH`; si no, `invalid_input`. */
export function requireValidOperationId(operationId: string): void {
  if (operationId.length === 0 || operationId.length > OPERATION_ID_MAX_LENGTH) {
    throw new ToolError('invalid_input');
  }
}
