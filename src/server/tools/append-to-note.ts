/**
 * `hebra_append_to_note` (SPEC.md §5, D2): añade `text` al final de la nota `id`
 * (`body + "\n\n" + text`, `NoteWriter.appendToNote`). Límite de 20 000 caracteres,
 * comprobado ANTES de tocar el almacén, igual que `create-note.ts`.
 *
 * Conflicto (SPEC.md §5, §8): se suscribe a `onConflictCopy` ANTES de escribir, para no
 * perderse una copia que la ronda produzca mientras el guardado ya está en marcha.
 * - Si el propio guardado sale `redirected` (`conflict_copy` local), se responde YA con
 *   su `copyId`: ni siquiera hace falta esperar una ronda.
 * - Si sale `saved`, se pide una ronda y se espera hasta 10 s (`awaitRound`): si durante
 *   esa espera llega una copia de conflicto PARA ESTA nota (otro dispositivo la editó a
 *   la vez, SPEC.md §7 de la spec de Hebra), la salida es igual `conflict_copy`; si no
 *   llegó ninguna, `saved`.
 * El listener se da de baja siempre (`finally`), gane o pierda la carrera.
 *
 * `hidden: true` sobre el CUERPO RESULTANTE (el de la nota final: la copia si hubo
 * conflicto, la original si no), igual criterio que `create-note.ts`.
 */
import { deriveNote } from '../../hebra';
import { logEvent } from '../../log/logger';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import { mapWriteError } from './write-errors';

const TEXT_MAX_LENGTH = 20_000;
const AWAIT_ROUND_TIMEOUT_MS = 10_000;

export interface AppendToNoteOutput {
  id: string;
  outcome: 'saved' | 'conflict_copy';
  copyId?: string;
  hidden?: true;
}

export async function runAppendToNote(
  ctx: ToolContext,
  input: { id: string; text: string }
): Promise<AppendToNoteOutput> {
  if (!ctx.write) throw new ToolError('invalid_input');
  if (input.text.length > TEXT_MAX_LENGTH) throw new ToolError('invalid_input');

  const meta = ctx.privacy.visibleMeta(input.id);
  if (!meta) throw new ToolError('not_found');

  let raceCopyId: string | undefined;
  const unsubscribe = ctx.write.onConflictCopy((copy) => {
    if (copy.recordId === input.id && raceCopyId === undefined) raceCopyId = copy.copyId;
  });

  try {
    let saved;
    try {
      saved = await ctx.write.appendToNote({ id: input.id, text: input.text });
    } catch (error) {
      throw mapWriteError(error);
    }

    let outcome: 'saved' | 'conflict_copy';
    let copyId: string | undefined;
    let finalId: string;

    if (saved.outcome === 'conflict_copy') {
      outcome = 'conflict_copy';
      copyId = saved.copyId;
      finalId = saved.copyId;
    } else {
      await ctx.write.awaitRound(AWAIT_ROUND_TIMEOUT_MS);
      if (raceCopyId !== undefined) {
        outcome = 'conflict_copy';
        copyId = raceCopyId;
        finalId = raceCopyId;
      } else {
        outcome = 'saved';
        finalId = input.id;
      }
    }

    const note = await ctx.port.noteRead(finalId);
    const hidden = note
      ? deriveNote(note.body).tags.some(({ tag }) => ctx.privacy.isTagHidden(tag))
      : false;
    logEvent({ event: 'note.append', id: input.id, outcome, hidden });

    const output: AppendToNoteOutput = { id: input.id, outcome };
    if (copyId !== undefined) output.copyId = copyId;
    if (hidden) output.hidden = true;
    return output;
  } finally {
    unsubscribe();
  }
}
