/**
 * `hebra_append_to_note` (SPEC.md §5, D2): añade `text` al final de la nota `id`
 * (`body + "\n\n" + text`, `NoteWriter.appendToNote`). Límite de 20 000 caracteres,
 * comprobado ANTES de tocar el almacén, igual que `create-note.ts`.
 *
 * Conflicto (SPEC.md §5, §8): `appendAndAwaitRound` (`../write-context.ts`) escribe y
 * espera la ronda hasta 10 s; si el guardado sale `redirected` o la ronda produce una
 * copia de conflicto PARA ESTA nota, la salida es `conflict_copy` con su `copyId`.
 *
 * En una instancia lectora, `ctx.write` reenvía la escritura al escritor único
 * (`../forward.ts`), que hace allí la escritura y la espera de la ronda: el filtro de
 * privados y el límite de tamaño de aquí se aplican ANTES, con la configuración de
 * privados de ESTA instancia, y el escritor vuelve a aplicar esa configuración dentro del
 * turno en que escribe.
 *
 * Por apartados (D11): con `heading` (y `headingOccurrence?`) el texto va al FINAL de ese
 * apartado, subapartados incluidos; el apartado lo resuelve el escritor dentro del turno
 * (`heading_not_found`, `ambiguous_heading` con sus `candidates`). Con `saved`, la salida
 * trae la prueba de lo guardado (`revision`, `totalChars`, `appended`), leída del cuerpo
 * guardado.
 *
 * Decisión 4 de David (28 sep 2026): un texto que dejaría la nota con una etiqueta
 * privada se rechaza sin escribir, con `not_found`. Antes se escribía y la salida decía
 * `hidden: true`. Una nota bloqueada responde `note_locked`.
 *
 * `operationId` opcional (10 oct 2026, ampliación de D2 y D11 decidida por delegación de
 * David, tras el audit de robustez: un despliegue o una caída del escritor cortaba la
 * respuesta de un append ya guardado y el reintento lo duplicaba). Con él, el mismo id con
 * la misma petición no vuelve a añadir el texto y devuelve la misma respuesta con
 * `replayed: true`; con otra petición, `operation_id_reused`. Sin él, como siempre.
 */
import { logEvent } from '../../log/logger';
import { APPEND_TEXT_MAX_LENGTH as TEXT_MAX_LENGTH, type AppendedProof } from '../../store/writes';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import { appendAndAwaitRound } from '../write-context';
import { requireValidOperationId, requireVisibleNote } from './guards';
import { requireValidHeadingInput } from './read-note';
import { mapWriteError } from './write-errors';

export interface AppendToNoteOutput {
  id: string;
  outcome: 'saved' | 'conflict_copy';
  copyId?: string;
  /** Con `saved` (D11), la prueba de lo guardado: la nueva revisión, el tamaño del
   *  cuerpo guardado y lo insertado (tamaño, final leído del cuerpo guardado, línea y
   *  apartado). Con `conflict_copy` no hay: el texto fue a la copia. */
  revision?: string;
  totalChars?: number;
  appended?: AppendedProof;
  /** Reintento con el mismo `operationId`: lo que se guardó la primera vez, sin volver a
   *  escribir. Si aquel guardado no llegó a anotarse entero, sin `appended`. */
  replayed?: true;
}

export async function runAppendToNote(
  ctx: ToolContext,
  input: {
    id: string;
    text: string;
    heading?: string;
    headingOccurrence?: number;
    operationId?: string;
  }
): Promise<AppendToNoteOutput> {
  if (!ctx.write) throw new ToolError('invalid_input');
  if (input.text.length > TEXT_MAX_LENGTH) throw new ToolError('invalid_input');
  requireValidHeadingInput(input);
  if (input.operationId !== undefined) requireValidOperationId(input.operationId);

  requireVisibleNote(ctx, input.id);

  let result;
  try {
    result = await appendAndAwaitRound(ctx.write, {
      id: input.id,
      text: input.text,
      ...(input.heading !== undefined ? { heading: input.heading } : {}),
      ...(input.headingOccurrence !== undefined
        ? { headingOccurrence: input.headingOccurrence }
        : {}),
      ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
      privacy: ctx.privacyConfig
    });
  } catch (error) {
    throw mapWriteError(error);
  }

  const { outcome } = result;
  const copyId = result.outcome === 'conflict_copy' ? result.copyId : undefined;
  // Nunca el título del apartado ni el texto (§6.4): como mucho un booleano.
  logEvent({
    event: 'note.append',
    id: input.id,
    outcome,
    ...(input.heading !== undefined ? { heading: true } : {}),
    ...(input.operationId !== undefined ? { replayed: result.replayed === true } : {})
  });

  const output: AppendToNoteOutput = { id: input.id, outcome };
  if (copyId !== undefined) output.copyId = copyId;
  if (result.outcome === 'saved') {
    if (result.revision !== undefined) output.revision = result.revision;
    if (result.totalChars !== undefined) output.totalChars = result.totalChars;
    if (result.appended !== undefined) output.appended = result.appended;
  }
  if (result.replayed) output.replayed = true;
  return output;
}
