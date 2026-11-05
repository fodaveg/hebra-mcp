/**
 * Lo que las escrituras de D23 (5 nov 2026, SPEC.md §3 y §5) necesitan del motor dentro del
 * turno del escritor: ocultar del listado general, quitar la marca de conflicto, mandar y
 * sacar de la papelera con guarda, y renombrar un fichero suelto arreglando las notas que lo
 * incrustan. Fuera de `./node-port.ts` y de `./writes.ts` a propósito: los dos comparten con
 * Hebra casi todas las líneas que tolera `scripts/check-no-hebra-code.mjs`.
 *
 * Solo el turno de escritura (`NodeLibraryPort.writeExclusive`) los tiene, y solo los llaman
 * `./note-state.ts` y `./file-verbs.ts`, que antes aplican el filtro de privados dentro del
 * turno (`test/store/surface.node.test.ts`). Nada de esto purga.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { NoteRow, SqliteLibraryEngine } from '../hebra';
import { relinkNoteRows } from './file-sql';

type RenameAndRelink = SqliteLibraryEngine['fileRenameAndRelink'];

/** Los argumentos de renombrar con los enlaces, como los tipa el motor (`node.ts` no los
 *  reexporta). */
export type FileRelinkInput = Parameters<RenameAndRelink>[0];

/** La guarda de sacar de la papelera, como la tipa el motor. */
export type NoteRestoreGuard = Parameters<SqliteLibraryEngine['noteRestoreRowIfUnchanged']>[1];

export interface NoteStateEngine {
  /** «Ocultar del listado general» y su contrario: idempotentes en el motor, pero marcan la
   *  fila sucia y suben `local_seq` también al repetir (quien llama corta antes). */
  noteHide(id: string): Promise<NoteRow>;
  noteUnhide(id: string): Promise<NoteRow>;
  /** Quita `conflict_of`, `conflict_at` y `conflict_device`, sea o no una copia de conflicto:
   *  quien llama comprueba antes que lo es. */
  noteClearConflict(id: string): Promise<NoteRow>;
  /** `null` si la nota ya no está como se esperaba (o está bloqueada). */
  noteTrashIfUnchanged(id: string, expected: Parameters<SqliteLibraryEngine['noteTrashIfUnchanged']>[1]): Promise<NoteRow | null>;
  noteRestoreRowIfUnchanged(id: string, expected: NoteRestoreGuard): Promise<NoteRow | null>;
  /** El nombre y las notas que incrustan el fichero, en una sola transacción. */
  fileRenameAndRelink(input: FileRelinkInput): Promise<Awaited<ReturnType<RenameAndRelink>>>;
  /** Las notas cuyas revisiones exige `fileRenameAndRelink` (`relinkNoteRows`). */
  notesRelinkingFile(fileId: string, name: string, sha256: string): string[];
}

/** Las de arriba, sobre el motor de este puerto. */
export function noteStateEngineOf(engine: SqliteLibraryEngine, db: DatabaseSync): NoteStateEngine {
  return {
    noteHide: (id) => engine.noteHide(id),
    noteUnhide: (id) => engine.noteUnhide(id),
    noteClearConflict: (id) => engine.noteClearConflict(id),
    noteTrashIfUnchanged: (id, expected) => engine.noteTrashIfUnchanged(id, expected),
    noteRestoreRowIfUnchanged: (id, expected) => engine.noteRestoreRowIfUnchanged(id, expected),
    fileRenameAndRelink: (input) => engine.fileRenameAndRelink(input),
    notesRelinkingFile: (fileId, name, sha256) => relinkNoteRows(db, fileId, name, sha256)
  };
}
