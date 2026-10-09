/**
 * Cómo una herramienta de lectura de una nota resuelve su `id` o su `title`
 * (`hebra_read_note`, `hebra_note_outline`; SPEC.md §5): exactamente uno de los dos, la
 * misma resolución y los mismos errores en ambas.
 *
 * Por `id`, la nota tal cual; por `title`, coincidencia EXACTA (`title_norm =
 * canonicalTitle(title)`, `notesByExactTitle`) entre las notas VISIBLES. Una nota en la
 * papelera, oculta por privacidad, o simplemente inexistente, responde igual: `not_found`
 * (SPEC.md §6.3: «igual que una inexistente»).
 */
import { ToolError } from '../errors';
import type { ToolContext } from '../context';

/** Candidatas que enseña `ambiguous_title`: acotadas, pero DESPUÉS de filtrar las ocultas,
 *  así que ni su número ni cuáles salen dependen de cuántas notas ocultas comparten título. */
const AMBIGUOUS_CANDIDATES_MAX = 50;

/** Coincidencia EXACTA de título entre las notas visibles. Se piden TODAS las notas con ese
 *  título (`notesByExactTitle`) y se filtra después: con el prefijo del motor (cortado a 50)
 *  una visible podía quedar detrás de 50 ocultas y dar un `not_found` falso. */
export async function resolveIdByTitle(ctx: ToolContext, title: string): Promise<string> {
  const { items } = await ctx.port.notesByExactTitle(title);
  const candidates = items.filter((item) => ctx.privacy.visibleMeta(item.id) !== undefined);
  if (candidates.length === 0) throw new ToolError('not_found');
  if (candidates.length > 1) {
    throw new ToolError('ambiguous_title', {
      candidates: candidates.slice(0, AMBIGUOUS_CANDIDATES_MAX).map((candidate) => {
        const meta = ctx.privacy.visibleMeta(candidate.id)!;
        return { id: candidate.id, title: candidate.title, folderPath: ctx.privacy.folderPath(meta.folderId) };
      })
    });
  }
  return candidates[0]!.id;
}

/** El id de la nota pedida por `id` o por `title` (exactamente uno; si no,
 *  `invalid_input`). No comprueba la visibilidad del `id`: eso lo hace quien llama al
 *  leer la nota. */
export async function resolveNoteId(
  ctx: ToolContext,
  input: { id?: string; title?: string }
): Promise<string> {
  const hasId = input.id !== undefined;
  const hasTitle = input.title !== undefined;
  if (hasId === hasTitle) throw new ToolError('invalid_input');
  return hasId ? input.id! : resolveIdByTitle(ctx, input.title!);
}
