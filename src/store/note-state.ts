/**
 * Cambios de estado de una nota de D23 (5 nov 2026; SPEC.md §3, §5 y §6.3), en un turno
 * exclusivo del escritor, como `NoteWriter.organize` de `./writes.ts` y con el filtro de
 * privados de quien pide construido DENTRO del turno:
 *
 * - `moveNote`, `trashNote` y `restoreNote` con `expectedRevision`: las versiones con guarda
 *   del motor (`noteMoveIfUnchanged`, `noteTrashIfUnchanged`, `noteRestoreRowIfUnchanged`). Sin
 *   `expectedRevision` no pasan por aquí: siguen por `organize`, igual que antes.
 * - `setHidden`: ocultar del listado general (`noteHide`, `noteUnhide`). Es una preferencia
 *   de vista, no privacidad (SPEC.md §13.7): la nota sigue saliendo por el MCP. Viaja por sync
 *   como un metadato más, y en un espacio compartido vale para todos sus miembros.
 * - `clearConflict`: quita la marca de una copia de conflicto (`noteClearConflict`). El motor
 *   la escribe sea o no una copia, así que aquí se corta antes: sobre otra nota no escribe. El
 *   filtro de D3 no mira esa marca (una copia hereda carpeta y etiquetas al nacer, y se juzga
 *   por las suyas), así que quitarla no cambia qué se ve.
 *
 * Qué compara `expectedRevision`: el SHA-256 del cuerpo, como `hebra_edit_note`
 * (`./revision.ts`). Favorita, carpeta o papelera suben `local_seq` sin cambiar el texto, y no
 * cuentan como que la nota cambió; por eso la revisión que se leyó antes de mandar una nota a
 * la papelera sigue valiendo para sacarla. La guarda del motor se pide con la fila de ESTE
 * turno, como `./jd-move-port.ts`.
 *
 * El orden, para no revelar nada: visibilidad (`not_found`, igual para oculta, inexistente o
 * lápida); revisión ilegible o de otra nota (`invalid_input`); ya en el estado pedido, sin
 * escribir, aunque la revisión sea vieja (un reintento tras un corte no es un conflicto);
 * bloqueada (`note_locked`: el motor no las mueve con guarda); y la revisión
 * (`revision_conflict`). Nada de esto purga.
 *
 * Estas acciones van por una op propia de `writer.sock` (`noteState`): un escritor anterior la
 * rechaza sin escribir (`writer_outdated`), en vez de ignorar `expectedRevision` y mover la
 * nota sin guarda.
 */
import { LibraryError, type NoteRow } from '../hebra';
import type { PrivacyConfig } from '../privacy/config';
import { TrashFilter } from '../privacy/trash-filter';
import { writeRejected } from './errors';
import { decodeRevision } from './revision';
import {
  LOCKED_BODY_PREFIX,
  privacyInTurn,
  type LocalWrite,
  type NoteWriteStore,
  type NoteWriteTarget,
  type OrganizeSaved
} from './writes';

export type NoteStateAction =
  | { action: 'moveNote'; id: string; folderId: string; expectedRevision: string }
  | { action: 'trashNote'; id: string; expectedRevision: string }
  | { action: 'restoreNote'; id: string; expectedRevision: string }
  | { action: 'setHidden'; id: string; hidden: boolean }
  | { action: 'clearConflict'; id: string };

export type NoteStateActionName = NoteStateAction['action'];

/** Igual que `EditNoteInput.privacy`: la configuración de quien pide. */
export type NoteStateInput = NoteStateAction & { privacy: PrivacyConfig };

/** `OrganizeSaved` y lo que estas acciones añaden: la marca propia de oculta del listado
 *  general, si es copia de conflicto y si esta llamada cambió algo. */
export interface NoteStateSaved extends OrganizeSaved {
  hidden: boolean;
  isConflictCopy: boolean;
  changed: boolean;
}

function savedOf(row: NoteRow, changed: boolean): NoteStateSaved {
  return {
    id: row.id,
    folderId: row.effectiveFolderId,
    favorite: row.favorite,
    archived: row.archivedAt !== null,
    trashed: row.trashedAt !== null,
    hidden: row.hiddenAt !== null && row.hiddenAt !== undefined,
    isConflictCopy: row.conflictOf !== null,
    changed
  };
}

/** La revisión, legible y de ESTA nota; si no, `invalid_input`, como `hebra_edit_note`. */
function decoded(raw: string, id: string): NonNullable<ReturnType<typeof decodeRevision>> {
  const revision = decodeRevision(raw);
  if (!revision || revision.noteId !== id) throw writeRejected('invalid_input');
  return revision;
}

/** Bloqueada, `note_locked`; otro cuerpo u otra biblioteca, `revision_conflict`. */
function requireUnchanged(store: NoteWriteStore, row: NoteRow, revision: { libraryId: string; bodySha256: string }): void {
  if (row.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('note_locked');
  if (revision.libraryId !== store.libraryId() || revision.bodySha256 !== row.bodySha256) {
    throw writeRejected('revision_conflict');
  }
}

/** La guarda del motor: la fila de este turno. `null` del motor, `revision_conflict`. */
function guardOf(row: NoteRow): { folderId: string; revision: { localSeq: number; bodySha256: string } } {
  return { folderId: row.folderId, revision: { localSeq: row.localSeq, bodySha256: row.bodySha256 } };
}

function written(row: NoteRow | null): LocalWrite<NoteStateSaved> {
  if (!row) throw writeRejected('revision_conflict');
  return { result: savedOf(row, true), wrote: true };
}

function rejection(error: unknown): unknown {
  if (error instanceof LibraryError && (error.code === 'note_not_found' || error.code === 'folder_not_found')) {
    return writeRejected('not_found');
  }
  return error;
}

/** Aplica una acción (ver la cabecera). `onWritten` pide la ronda de después. */
export async function writeNoteState(
  target: NoteWriteTarget,
  input: NoteStateInput,
  onWritten: () => void
): Promise<LocalWrite<NoteStateSaved>> {
  const outcome = await target.writeExclusive(async (store): Promise<LocalWrite<NoteStateSaved>> => {
    const filter = privacyInTurn(store, input.privacy);
    const unchanged = (row: NoteRow): LocalWrite<NoteStateSaved> => ({ result: savedOf(row, false), wrote: false });
    /** Viva y visible; oculta, en la papelera o inexistente, `not_found`, las tres igual. */
    const visibleLive = async (id: string): Promise<NoteRow> => {
      const row = await store.noteRead(id);
      if (!row || row.trashedAt !== null || filter.isHiddenNote(id)) throw writeRejected('not_found');
      return row;
    };
    /** Viva y visible, o en la papelera y visible para el filtro de la papelera. */
    const visibleLiveOrTrashed = async (id: string): Promise<NoteRow> => {
      const row = await store.noteRead(id);
      if (!row) throw writeRejected('not_found');
      const visible =
        row.trashedAt === null
          ? !filter.isHiddenNote(id)
          : TrashFilter.fromSnapshot(filter, store.trashIndex(), input.privacy).isVisible(id);
      if (!visible) throw writeRejected('not_found');
      return row;
    };

    try {
      switch (input.action) {
        case 'moveNote': {
          const row = await visibleLive(input.id);
          if (!filter.folderExists(input.folderId) || filter.isFolderHidden(input.folderId)) {
            throw writeRejected('not_found');
          }
          const revision = decoded(input.expectedRevision, input.id);
          if (row.folderId === input.folderId) return unchanged(row);
          requireUnchanged(store, row, revision);
          return written(await store.noteMoveIfUnchanged(input.id, input.folderId, guardOf(row)));
        }
        case 'trashNote': {
          const row = await visibleLiveOrTrashed(input.id);
          const revision = decoded(input.expectedRevision, input.id);
          if (row.trashedAt !== null) return unchanged(row);
          requireUnchanged(store, row, revision);
          return written(await store.noteTrashIfUnchanged(input.id, guardOf(row)));
        }
        case 'restoreNote': {
          const row = await visibleLiveOrTrashed(input.id);
          const revision = decoded(input.expectedRevision, input.id);
          if (row.trashedAt === null) return unchanged(row);
          requireUnchanged(store, row, revision);
          return written(
            await store.noteRestoreRowIfUnchanged(input.id, {
              trashedAt: row.trashedAt,
              revision: guardOf(row).revision
            })
          );
        }
        case 'setHidden': {
          const row = await visibleLive(input.id);
          if ((row.hiddenAt !== null && row.hiddenAt !== undefined) === input.hidden) return unchanged(row);
          return written(input.hidden ? await store.noteHide(input.id) : await store.noteUnhide(input.id));
        }
        case 'clearConflict': {
          const row = await visibleLive(input.id);
          if (row.conflictOf === null) return unchanged(row);
          return written(await store.noteClearConflict(input.id));
        }
      }
    } catch (error) {
      throw rejection(error);
    }
  });
  if (outcome.wrote) {
    try {
      onWritten();
    } catch {
      // Ya está en disco; la ronda periódica lo subirá.
    }
  }
  return outcome;
}
