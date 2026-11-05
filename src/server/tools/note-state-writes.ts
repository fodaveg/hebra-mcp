/**
 * `hebra_set_hidden` y `hebra_clear_conflict` (D23, decisión de David del 5 nov 2026), con la
 * misma privacidad en tres sitios que `./organize.ts`: aquí con el filtro de esta llamada, otra
 * vez en el escritor dentro de su turno (`../../store/note-state.ts`) y en la puerta final tras
 * la ronda. Oculta por privacidad, en la papelera o inexistente: `not_found`, las tres igual.
 *
 * Oculta, aquí, es del listado general: una preferencia de vista de Hebra, no privacidad
 * (SPEC.md §13.7). La nota sigue en su carpeta, sus etiquetas, la búsqueda, los enlaces y el MCP.
 */
import type { ToolContext } from '../context';
import { requireVisibleNote } from './guards';
import { noteOutput, noteState, type NoteOrganizeOutput } from './organize';

export type NoteHiddenOutput = NoteOrganizeOutput & { hidden: boolean };

/** `hebra_set_hidden`: oculta (`true`) o muestra (`false`). Idempotente; solo su marca propia. */
export async function runSetHidden(
  ctx: ToolContext,
  input: { id: string; hidden: boolean }
): Promise<NoteHiddenOutput> {
  requireVisibleNote(ctx, input.id);
  const outcome = await noteState(ctx, { action: 'setHidden', id: input.id, hidden: input.hidden });
  return { ...noteOutput(ctx, 'setHidden', outcome), hidden: outcome.hidden };
}

export type ClearConflictOutput = NoteOrganizeOutput & { cleared: boolean };

/** `hebra_clear_conflict`: la copia deja de serlo (`cleared: true`). Sobre una nota que no es
 *  copia, o una ya resuelta, `cleared: false` sin escribir. El cuerpo no cambia, y la respuesta
 *  no nombra la nota original, que puede no verse. */
export async function runClearConflict(
  ctx: ToolContext,
  input: { id: string }
): Promise<ClearConflictOutput> {
  requireVisibleNote(ctx, input.id);
  const outcome = await noteState(ctx, { action: 'clearConflict', id: input.id });
  return { ...noteOutput(ctx, 'clearConflict', outcome), cleared: outcome.changed };
}
