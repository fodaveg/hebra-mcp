/**
 * `hebra_read_note` (SPEC.md §5): `id` o `title`, exactamente uno. Por `id`,
 * `noteRead`; por `title`, coincidencia EXACTA (`title_norm = canonicalTitle(title)`,
 * `notesByExactTitle`) entre las notas VISIBLES. Una nota en la papelera, oculta por privacidad, o simplemente inexistente,
 * responde igual: `not_found` (SPEC.md §6.3: «igual que una inexistente»).
 *
 * `revision` (D2 ampliada, 28 sep 2026): la versión leída, opaca, que `hebra_edit_note`
 * pide como `expectedRevision`.
 */
import { encodeRevision } from '../../store/revision';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';

export interface ReadNoteOutput {
  id: string;
  title: string;
  body: string;
  folderPath: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  isConflictCopy: boolean;
  conflictOf?: string;
  /** Opaca: la versión leída, para `expectedRevision` de `hebra_edit_note`. */
  revision: string;
}

/** Candidatas que enseña `ambiguous_title`: acotadas, pero DESPUÉS de filtrar las ocultas,
 *  así que ni su número ni cuáles salen dependen de cuántas notas ocultas comparten título. */
const AMBIGUOUS_CANDIDATES_MAX = 50;

/** Coincidencia EXACTA de título entre las notas visibles. Se piden TODAS las notas con ese
 *  título (`notesByExactTitle`) y se filtra después: con el prefijo del motor (cortado a 50)
 *  una visible podía quedar detrás de 50 ocultas y dar un `not_found` falso. */
async function resolveIdByTitle(ctx: ToolContext, title: string): Promise<string> {
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

export async function runReadNote(
  ctx: ToolContext,
  input: { id?: string; title?: string }
): Promise<ReadNoteOutput> {
  const hasId = input.id !== undefined;
  const hasTitle = input.title !== undefined;
  if (hasId === hasTitle) throw new ToolError('invalid_input');

  const id = hasId ? input.id! : await resolveIdByTitle(ctx, input.title!);
  const meta = ctx.privacy.visibleMeta(id);
  if (!meta) throw new ToolError('not_found');
  const note = await ctx.port.noteRead(id);
  if (!note || note.trashedAt !== null) throw new ToolError('not_found');
  const libraryId = await ctx.port.libraryId();

  const output: ReadNoteOutput = {
    id: note.id,
    title: note.title,
    body: note.body,
    folderPath: ctx.privacy.folderPath(meta.folderId),
    tags: meta.tags,
    createdAt: new Date(note.createdAt).toISOString(),
    updatedAt: new Date(note.updatedAt).toISOString(),
    isConflictCopy: note.conflictOf !== null,
    // De la fila que se acaba de leer, la misma cuyo `body` sale arriba: es la base que
    // `hebra_edit_note` exigirá (`src/store/revision.ts`).
    revision: encodeRevision({
      libraryId,
      noteId: note.id,
      localSeq: note.localSeq,
      bodySha256: note.bodySha256
    })
  };
  if (note.conflictOf !== null) output.conflictOf = note.conflictOf;
  return output;
}
