/**
 * Lecturas de estado de D23 (5 nov 2026) sobre el motor de Hebra: favorita, archivada y
 * oculta del listado general de una nota (`noteSummary`), las carpetas de la papelera
 * (`foldersTrashList`) y los autores de una nota (`noteAuthors`). Solo LEEN; el filtro de
 * privados lo aplica quien llama (`src/server/tools/`), nunca esto.
 *
 * Viven aparte de `./node-port.ts` para no engordarlo: el puerto solo delega aquí.
 */
import type { NoteAuthors, SqliteLibraryEngine } from '../hebra';

/** `FolderTrashEntry` de Hebra: `node.ts` no lo reexporta, así que sale de la firma del motor. */
export type FolderTrashEntry = ReturnType<SqliteLibraryEngine['foldersTrashList']>['folders'][number];

/** Tope de ids que `noteSummary` del motor acepta por llamada (`NOTE_SUMMARY_MAX_IDS`). */
const NOTE_SUMMARY_CHUNK = 200;

/** El estado de una nota viva que `NoteListItem` no trae: lo que sale de `noteSummary`. */
export interface NoteStateRow {
  id: string;
  favorite: boolean;
  /** Epoch ms de cuando se archivó, o `null` si no lo está. */
  archivedAt: number | null;
  /** Oculta del listado general por su propia marca o por su carpeta (o una antecesora). */
  generalHidden: boolean;
  /** `notes.local_seq` de esta fila, si el motor la da. */
  localSeq?: number;
}

/** `noteSummary` del motor por tandas, reducido a lo que las herramientas enseñan. Una nota
 *  purgada o inexistente falta del resultado. */
export function noteStatesOf(engine: SqliteLibraryEngine, ids: readonly string[]): NoteStateRow[] {
  const out: NoteStateRow[] = [];
  for (let start = 0; start < ids.length; start += NOTE_SUMMARY_CHUNK) {
    for (const item of engine.noteSummary(ids.slice(start, start + NOTE_SUMMARY_CHUNK)).items) {
      out.push({
        id: item.id,
        favorite: item.favorite,
        archivedAt: item.archivedAt,
        generalHidden: item.generalHidden === true,
        ...(item.localSeq === undefined ? {} : { localSeq: item.localSeq })
      });
    }
  }
  return out;
}

/** Las carpetas de la papelera (`foldersTrashList`), de la última en entrar a la primera. */
export function foldersTrashOf(engine: SqliteLibraryEngine): FolderTrashEntry[] {
  return engine.foldersTrashList().folders;
}

/** Las dos columnas de autor de una nota viva o de la papelera (`noteAuthors`). */
export function noteAuthorsOf(engine: SqliteLibraryEngine, id: string): NoteAuthors {
  return engine.noteAuthors(id);
}
