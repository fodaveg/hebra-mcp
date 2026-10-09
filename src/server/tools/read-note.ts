/**
 * `hebra_read_note` (SPEC.md §5): `id` o `title`, exactamente uno (la resolución es la de
 * `./note-ref.ts`, compartida con `hebra_note_outline`). Una nota en la papelera, oculta
 * por privacidad, o simplemente inexistente, responde igual: `not_found` (SPEC.md §6.3:
 * «igual que una inexistente»).
 *
 * `revision` (D2 ampliada, 28 sep 2026): la versión leída, opaca, que `hebra_edit_note`
 * pide como `expectedRevision`.
 *
 * Por apartados (D11, 9 oct 2026): con `heading` (y `headingOccurrence?`), `body` es SOLO
 * ese apartado (su línea de encabezado incluida, hasta su final, subapartados incluidos)
 * y la salida añade `section` y `totalChars` (el tamaño del cuerpo entero). `revision`
 * sigue siendo la de la NOTA entera. Una nota bloqueada, `note_locked`. Sin `heading`, la
 * salida es exactamente la de siempre.
 */
import { encodeRevision } from '../../store/revision';
import {
  parseHeadings,
  sectionRef,
  sectionText,
  selectSection,
  type SectionRef
} from '../../store/sections';
import { LOCKED_BODY_PREFIX } from '../../store/writes';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import { resolveNoteId } from './note-ref';

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
  /** Con `heading` (D11): el apartado leído, con el título tal como está en la nota. */
  section?: SectionRef;
  /** Con `heading` (D11): tamaño del cuerpo entero de la nota. */
  totalChars?: number;
}

/** Longitud máxima de `heading`: lo desmedido no es un título (`invalid_input`). */
export const HEADING_INPUT_MAX_LENGTH = 1_024;

/** Valida `heading`/`headingOccurrence` de una entrada (D11). */
export function requireValidHeadingInput(input: {
  heading?: string;
  headingOccurrence?: number;
}): void {
  if (input.heading === undefined) {
    if (input.headingOccurrence !== undefined) throw new ToolError('invalid_input');
    return;
  }
  if (input.heading.length > HEADING_INPUT_MAX_LENGTH) throw new ToolError('invalid_input');
  if (
    input.headingOccurrence !== undefined &&
    (!Number.isSafeInteger(input.headingOccurrence) || input.headingOccurrence < 1)
  ) {
    throw new ToolError('invalid_input');
  }
}

export async function runReadNote(
  ctx: ToolContext,
  input: { id?: string; title?: string; heading?: string; headingOccurrence?: number }
): Promise<ReadNoteOutput> {
  requireValidHeadingInput(input);
  const id = await resolveNoteId(ctx, input);
  const meta = ctx.privacy.visibleMeta(id);
  if (!meta) throw new ToolError('not_found');
  const note = await ctx.port.noteRead(id);
  if (!note || note.trashedAt !== null) throw new ToolError('not_found');
  const libraryId = await ctx.port.libraryId();

  let body = note.body;
  let section: SectionRef | undefined;
  if (input.heading !== undefined) {
    if (note.body.startsWith(LOCKED_BODY_PREFIX)) throw new ToolError('note_locked');
    const picked = selectSection(parseHeadings(note.body), input.heading, input.headingOccurrence);
    if (!picked.ok) {
      throw picked.code === 'ambiguous_heading'
        ? new ToolError('ambiguous_heading', { candidates: picked.candidates })
        : new ToolError('heading_not_found');
    }
    body = sectionText(note.body, picked.section);
    section = sectionRef(picked.section);
  }

  const output: ReadNoteOutput = {
    id: note.id,
    title: note.title,
    body,
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
  if (section !== undefined) {
    output.section = section;
    output.totalChars = note.body.length;
  }
  return output;
}
