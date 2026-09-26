/**
 * `hebra_read_note` (SPEC.md §5): `id` o `title`, exactamente uno. Por `id`,
 * `noteRead`; por `title`, coincidencia EXACTA (no el prefijo que da
 * `notesByTitlePrefix`, así que se filtra por `canonicalTitle`) entre las notas
 * VISIBLES. Una nota en la papelera, oculta por privacidad, o simplemente inexistente,
 * responde igual: `not_found` (SPEC.md §6.3: «igual que una inexistente»).
 */
import { canonicalTitle } from '$lib/library/derive';
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
}

const TITLE_CANDIDATES_LIMIT = 50;

async function resolveIdByTitle(ctx: ToolContext, title: string): Promise<string> {
  const target = canonicalTitle(title);
  const { items } = await ctx.port.notesByTitlePrefix(title, TITLE_CANDIDATES_LIMIT);
  const candidates = items.filter(
    (item) => canonicalTitle(item.title) === target && ctx.privacy.visibleMeta(item.id) !== undefined
  );
  if (candidates.length === 0) throw new ToolError('not_found');
  if (candidates.length > 1) {
    throw new ToolError('ambiguous_title', {
      candidates: candidates.map((candidate) => {
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

  const output: ReadNoteOutput = {
    id: note.id,
    title: note.title,
    body: note.body,
    folderPath: ctx.privacy.folderPath(meta.folderId),
    tags: meta.tags,
    createdAt: new Date(note.createdAt).toISOString(),
    updatedAt: new Date(note.updatedAt).toISOString(),
    isConflictCopy: note.conflictOf !== null
  };
  if (note.conflictOf !== null) output.conflictOf = note.conflictOf;
  return output;
}
