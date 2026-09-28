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
 * Decisión 4 de David (28 sep 2026): un texto que dejaría la nota con una etiqueta
 * privada se rechaza sin escribir, con `not_found`. Antes se escribía y la salida decía
 * `hidden: true`. Una nota bloqueada responde `note_locked`.
 */
import { logEvent } from '../../log/logger';
import { APPEND_TEXT_MAX_LENGTH as TEXT_MAX_LENGTH } from '../../store/writes';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import { appendAndAwaitRound } from '../write-context';
import { mapWriteError } from './write-errors';

export interface AppendToNoteOutput {
  id: string;
  outcome: 'saved' | 'conflict_copy';
  copyId?: string;
}

export async function runAppendToNote(
  ctx: ToolContext,
  input: { id: string; text: string }
): Promise<AppendToNoteOutput> {
  if (!ctx.write) throw new ToolError('invalid_input');
  if (input.text.length > TEXT_MAX_LENGTH) throw new ToolError('invalid_input');

  const meta = ctx.privacy.visibleMeta(input.id);
  if (!meta) throw new ToolError('not_found');

  let result;
  try {
    result = await appendAndAwaitRound(ctx.write, {
      id: input.id,
      text: input.text,
      privacy: ctx.privacyConfig
    });
  } catch (error) {
    throw mapWriteError(error);
  }

  const { outcome } = result;
  const copyId = result.outcome === 'conflict_copy' ? result.copyId : undefined;
  logEvent({ event: 'note.append', id: input.id, outcome });

  const output: AppendToNoteOutput = { id: input.id, outcome };
  if (copyId !== undefined) output.copyId = copyId;
  return output;
}
