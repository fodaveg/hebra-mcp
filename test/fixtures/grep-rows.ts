/**
 * Las filas de `hebra_grep` de todas las notas vivas, para los tests (M2 del plan de memoria,
 * 6 nov 2026). El puerto ya no las da todas de una vez (`grepNotesPage`, por páginas): esto las
 * recorre como lo hace `NoteRowsById`, en el orden de id de las herramientas.
 */
import type { GrepNoteRow } from '../../src/store/grep-sql';
import { NoteRowsById } from '../../src/store/grep-notes';
import type { HebraLibraryPort } from '../../src/store/types';

export async function liveNoteRows(
  port: Pick<HebraLibraryPort, 'grepNotesPage'>,
  pageSize = 100
): Promise<GrepNoteRow[]> {
  const source = new NoteRowsById(port, null, pageSize);
  const rows: GrepNoteRow[] = [];
  for (let page = await source.take(pageSize); page.length > 0; page = await source.take(pageSize)) rows.push(...page);
  return rows;
}
