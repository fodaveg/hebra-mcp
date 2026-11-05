/**
 * Estado de una nota que `hebra_list_notes` y `hebra_read_note` enseñan desde D23 (5 nov
 * 2026): si es favorita, cuándo se archivó y si está oculta del listado general. Sale de
 * `noteSummary` del motor (`HebraLibraryPort.noteStates`), que es quien resuelve la herencia
 * de «ocultar» por carpeta; ni `NoteListItem` ni `NoteRow` la traen.
 *
 * Solo lee. Quien llama decide antes qué notas se ven (`ctx.privacy`): aquí no se filtra.
 */
import type { HebraLibraryPort } from '../../store/types';
import type { NoteStateRow } from '../../store/state-reads';

/** Los campos de estado, tal como salen en las notas de las dos herramientas. */
export interface NoteStateFields {
  favorite: boolean;
  /** ISO 8601 de cuando se archivó; `null` si no está archivada. */
  archivedAt: string | null;
  /** Oculta del listado general, por su marca o por la de su carpeta (o una antecesora). */
  generalHidden: boolean;
}

/** ¿Hace falta `noteSummary` para estos `fields`? `favorite` ya viene en la página. */
export function fieldsNeedNoteState(fields: readonly string[] | undefined): boolean {
  return fields === undefined || fields.includes('archivedAt') || fields.includes('generalHidden');
}

/** El estado de `ids` por id. Una nota que falta (purgada entre medias) no está en el mapa. */
export async function loadNoteStates(
  port: Pick<HebraLibraryPort, 'noteStates'>,
  ids: readonly string[]
): Promise<Map<string, NoteStateRow>> {
  const states = new Map<string, NoteStateRow>();
  if (ids.length === 0) return states;
  for (const row of await port.noteStates(ids)) states.set(row.id, row);
  return states;
}

export function stateFields(row: NoteStateRow): NoteStateFields {
  return {
    favorite: row.favorite,
    archivedAt: row.archivedAt === null ? null : new Date(row.archivedAt).toISOString(),
    generalHidden: row.generalHidden
  };
}
