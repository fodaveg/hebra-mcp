/**
 * `hebra_edit_note` (D2 ampliada, decisiones de David del 28 sep 2026): sustituciones
 * puntuales `{find, replace}` sobre la versión de la nota que el agente leyó
 * (`expectedRevision`, de `hebra_read_note`), con `operationId` para poder reintentar sin
 * duplicar. Renombrar una nota es editar su H1.
 *
 * Límites (SPEC.md §5), comprobados ANTES de tocar el almacén, sin eco de la entrada:
 * entre 1 y `EDITS_MAX_COUNT` sustituciones, `find` no vacío, y `find` + `replace` de
 * todas sumando como mucho `EDITS_TOTAL_MAX_LENGTH` caracteres (lo mismo que el cuerpo de
 * `hebra_create_note`, así que cabe en los mismos topes de stdio, del socket y de HTTP).
 *
 * Privacidad: la nota tiene que ser visible para ESTA instancia (una oculta, en la
 * papelera o inexistente responde `not_found`, las tres igual), y el escritor lo vuelve
 * a comprobar con esta misma configuración dentro del turno en que escribe, junto con
 * que el resultado no deje la nota con una etiqueta privada (`NoteWriter.editNote`).
 *
 * La salida distingue el guardado local (`outcome`) del estado de sync (`sync`,
 * `../write-context.ts`). Una copia de conflicto (otro dispositivo editó a la vez)
 * llega como `outcome: "conflict_copy"` con `copyId`: sin reintento automático.
 */
import { logEvent } from '../../log/logger';
import { editsWithinLimits, type TextEdit } from '../../store/edits';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import type { EditNoteOutcome } from '../write-context';
import { requireValidOperationId, requireVisibleNote } from './guards';
import { mapWriteError } from './write-errors';

export async function runEditNote(
  ctx: ToolContext,
  input: { id: string; edits: TextEdit[]; expectedRevision: string; operationId: string }
): Promise<EditNoteOutcome> {
  if (!ctx.write) throw new ToolError('invalid_input');
  if (!editsWithinLimits(input.edits)) throw new ToolError('invalid_input');
  requireValidOperationId(input.operationId);
  requireVisibleNote(ctx, input.id);

  let result: EditNoteOutcome;
  try {
    result = await ctx.write.editNote({
      id: input.id,
      edits: input.edits.map(({ find, replace }) => ({ find, replace })),
      expectedRevision: input.expectedRevision,
      operationId: input.operationId,
      privacy: ctx.privacyConfig
    });
  } catch (error) {
    throw mapWriteError(error);
  }
  logEvent({
    event: 'note.edit',
    id: input.id,
    outcome: result.outcome,
    sync: result.sync,
    replayed: result.replayed === true
  });
  return result;
}
