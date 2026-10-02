/**
 * Comprobaciones previas que comparten varias herramientas (visibilidad de la nota y
 * longitud de `operationId`). Cada una lanza `ToolError`, igual que antes estaban copiadas.
 */
import { OPERATION_ID_MAX_LENGTH } from '../../store/operations';
import type { ToolContext } from '../context';
import { ToolError } from '../errors';

/** La nota existe y es visible para el filtro de privados; si no, `not_found`. */
export function requireVisibleNote(ctx: ToolContext, id: string): void {
  if (!ctx.privacy.visibleMeta(id)) throw new ToolError('not_found');
}

/** `operationId` no vacío y de a lo sumo `OPERATION_ID_MAX_LENGTH`; si no, `invalid_input`. */
export function requireValidOperationId(operationId: string): void {
  if (operationId.length === 0 || operationId.length > OPERATION_ID_MAX_LENGTH) {
    throw new ToolError('invalid_input');
  }
}
