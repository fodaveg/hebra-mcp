/**
 * `hebra_note_outline` (D11, SPEC.md §5): el esquema de una nota, sin su cuerpo. Sirve
 * para elegir un apartado antes de leerlo (`hebra_read_note` con `heading`) o de añadirle
 * texto (`hebra_append_to_note` con `heading`).
 *
 * Entrada: `id` o `title` (la resolución y los errores son los de `hebra_read_note`,
 * `./note-ref.ts`), `maxLevel?` (solo encabezados de ese nivel o menor), `limit?` y
 * `cursor?`. Una nota oculta, en la papelera o inexistente: `not_found`; una bloqueada,
 * `note_locked`.
 *
 * Salida: `{id, title, revision, totalChars, sections, nextCursor}`. `chars` es el tamaño
 * del apartado tal como lo devuelve `hebra_read_note` con ese `heading` (subapartados
 * incluidos). `occurrence` solo sale en los títulos que se repiten en la nota, y se
 * cuenta sobre TODOS los encabezados, no sobre los filtrados por `maxLevel` ni sobre la
 * página: es el valor que hay que pasar como `headingOccurrence`.
 *
 * Paginación: cursor propio (`o1`) atado a la `revision` de la nota. Si la nota cambió
 * entre dos páginas, `invalid_input`: las posiciones ya no valen.
 */
import { encodeRevision } from '../../store/revision';
import { parseHeadings } from '../../store/sections';
import { LOCKED_BODY_PREFIX } from '../../store/writes';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import { LIMITS, effectiveLimit, unwrapCursor, wrapCursor } from '../pagination';
import { resolveNoteId } from './note-ref';

export interface OutlineSection {
  heading: string;
  level: number;
  line: number;
  chars: number;
  occurrence?: number;
}

export interface NoteOutlineOutput {
  id: string;
  title: string;
  revision: string;
  totalChars: number;
  sections: OutlineSection[];
  nextCursor: string | null;
}

/** `{revision}:{maxLevel}:{posición}`: la revisión no lleva `:` (base64url y un punto).
 *  Atado también a `maxLevel`: con otro filtro las posiciones no coinciden. */
function parseCursor(cursor: string, revision: string, maxLevel: number): number {
  const payload = unwrapCursor('o1', cursor);
  const separator = payload.lastIndexOf(':');
  if (separator < 0 || payload.slice(0, separator) !== `${revision}:${maxLevel}`) {
    throw new ToolError('invalid_input');
  }
  const text = payload.slice(separator + 1);
  if (!/^[0-9]{1,9}$/.test(text)) throw new ToolError('invalid_input');
  return Number(text);
}

export async function runNoteOutline(
  ctx: ToolContext,
  input: { id?: string; title?: string; maxLevel?: number; limit?: number; cursor?: string }
): Promise<NoteOutlineOutput> {
  if (
    input.maxLevel !== undefined &&
    (!Number.isSafeInteger(input.maxLevel) || input.maxLevel < 1 || input.maxLevel > 6)
  ) {
    throw new ToolError('invalid_input');
  }
  const limit = effectiveLimit(input.limit, LIMITS.noteOutline);
  const id = await resolveNoteId(ctx, input);
  if (!ctx.privacy.visibleMeta(id)) throw new ToolError('not_found');
  const note = await ctx.port.noteRead(id);
  if (!note || note.trashedAt !== null) throw new ToolError('not_found');
  if (note.body.startsWith(LOCKED_BODY_PREFIX)) throw new ToolError('note_locked');
  const libraryId = await ctx.port.libraryId();
  const revision = encodeRevision({
    libraryId,
    noteId: note.id,
    localSeq: note.localSeq,
    bodySha256: note.bodySha256
  });

  const all = parseHeadings(note.body)
    .filter((entry) => entry.level <= (input.maxLevel ?? 6))
    .map((entry): OutlineSection => {
      const section: OutlineSection = {
        heading: entry.heading,
        level: entry.level,
        line: entry.line,
        chars: entry.end - entry.start
      };
      if (entry.sameTitleCount > 1) section.occurrence = entry.occurrence;
      return section;
    });

  const maxLevel = input.maxLevel ?? 6;
  const start = input.cursor === undefined ? 0 : parseCursor(input.cursor, revision, maxLevel);
  if (start > all.length) throw new ToolError('invalid_input');
  const end = Math.min(start + limit, all.length);
  return {
    id: note.id,
    title: note.title,
    revision,
    totalChars: note.body.length,
    sections: all.slice(start, end),
    nextCursor: end < all.length ? wrapCursor('o1', `${revision}:${maxLevel}:${end}`) : null
  };
}
