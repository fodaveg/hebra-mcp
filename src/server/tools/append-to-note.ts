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
 */
import { logEvent } from '../../log/logger';
import { APPEND_TEXT_MAX_LENGTH as TEXT_MAX_LENGTH, type AppendedProof } from '../../store/writes';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import { appendAndAwaitRound } from '../write-context';
import { requireVisibleNote } from './guards';
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
}

export async function runAppendToNote(
  ctx: ToolContext,
  input: { id: string; text: string; heading?: string; headingOccurrence?: number }
): Promise<AppendToNoteOutput> {
  if (!ctx.write) throw new ToolError('invalid_input');
  if (input.text.length > TEXT_MAX_LENGTH) throw new ToolError('invalid_input');
  requireValidHeadingInput(input);

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
    ...(input.heading !== undefined ? { heading: true } : {})
  });

  const output: AppendToNoteOutput = { id: input.id, outcome };
  if (copyId !== undefined) output.copyId = copyId;
  if (result.outcome === 'saved') {
    if (result.revision !== undefined) output.revision = result.revision;
    if (result.totalChars !== undefined) output.totalChars = result.totalChars;
    if (result.appended !== undefined) output.appended = result.appended;
  }
  return output;
}
