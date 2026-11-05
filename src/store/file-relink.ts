/**
 * Qué notas arregla renombrar un fichero suelto (D23, 5 nov 2026; SPEC.md §5 y §6.3), dentro
 * del turno del escritor y antes de escribir nada. El cuerpo nuevo de cada nota lo calcula
 * aquí el motor de Hebra (`renameFileEmbedInMarkdown`, el mismo escáner que deriva los
 * enlaces), nunca lo manda el agente: la regla de D2, como en D14.
 *
 * Lo que `fileRenameAndRelink` del motor reescribiría, y por qué ninguna nota oculta entra:
 * - Mira las notas VIVAS con un enlace `file` con ese nombre o uno `blob` con esos bytes, sin
 *   ningún filtro. Las mismas que la regla (b) de D10, y el fichero solo llega hasta aquí si
 *   el filtro de ESTE turno lo deja ver: ninguna de ellas puede ser oculta. Se comprueba otra
 *   vez nota a nota (cerrado ante la duda) con el mismo filtro: una que lo sea, `not_found`
 *   sin escribir, sin decir cuál ni cuántas.
 * - Una nota que cruce a privada no puede colarse entre esta comprobación y la escritura: el
 *   filtro se construye en el mismo turno de la cola, y el sync espera su propio turno. Si
 *   cruza DESPUÉS, enlaza ya el nombre nuevo, así que el fichero queda oculto por la regla (b)
 *   y la puerta final responde `not_found`, sin `relinked`.
 * - Una BLOQUEADA no deriva enlaces, y lo que incrusta va cifrado: no se puede arreglar. Si es
 *   oculta y el nombre se puede incrustar, el fichero ya es oculto (variante de D16). Si es
 *   visible (sin etiquetas privadas configuradas), se queda sin tocar, como una que no lo
 *   incrusta, y `relinked` no la cuenta.
 * - Una de la papelera no la mira el motor: se queda con el nombre anterior. Una oculta ya
 *   habría ocultado el fichero; una visible no se cuenta.
 *
 * Solo se reescribe `![[nombre]]` con el nombre exacto, también con alias o tamaño detrás del
 * `|`. Un `[[nombre]]`, una ruta escrita a mano (`![[carpeta/nombre]]`) o un `![[sha256:…]]`
 * se quedan como están, como en Hebra.
 *
 * Homónimos: un enlace por nombre resuelve al fichero vivo de menor id, en cualquier carpeta
 * (`resolveLink` del motor). Si el nombre anterior resuelve a OTRO fichero visible, esas notas
 * no incrustan este y no se tocan. Si el nombre nuevo lo tiene otro fichero visible de otra
 * carpeta, reescribirlas podría apuntarlas a ese: `file_exists` con su id. Uno oculto no
 * cuenta: la respuesta no puede depender de él.
 */
import { deriveNoteKeepingTitle, renameFileEmbedInMarkdown } from '../hebra';
import type { FileFilter } from '../privacy/file-filter';
import type { PrivacyFilter } from '../privacy/filter';
import { existingFileRejected, writeRejected } from './errors';
import type { FileRelinkInput } from './note-state-engine';
import type { FilesIndex } from './types';
import { LOCKED_BODY_PREFIX, type NoteWriteStore } from './writes';

/** Lo del turno que hace falta para decidir. */
export interface RelinkTurn {
  store: NoteWriteStore;
  files: FileFilter;
  live: PrivacyFilter;
  index: FilesIndex;
}

/** El fichero como está GUARDADO: la fila, no lo que se enseña de ella (`fileRenameAndRelink`
 *  compara con su carpeta guardada). */
export interface RelinkFile {
  id: string;
  name: string;
  sha256: string;
  folderId: string;
}

export type RelinkPlan = Pick<FileRelinkInput, 'noteRevisions' | 'entries'>;

/** Prepara el renombrado sin escribir nada; rechaza (`not_found`, `file_exists`) sin escribir. */
export async function planRelink(turn: RelinkTurn, file: RelinkFile, newName: string): Promise<RelinkPlan> {
  const { store, live, files, index } = turn;
  const noteIds = store.notesRelinkingFile(file.id, file.name, file.sha256);
  if (noteIds.some((id) => live.isHiddenNote(id))) throw writeRejected('not_found');

  const others = files.visibleFiles().filter((other) => other.trashedAt === null && other.id !== file.id);
  const resolvesToAnother = others.some((other) => other.name === file.name && other.id < file.id);

  const noteRevisions: RelinkPlan['noteRevisions'] = [];
  const entries: RelinkPlan['entries'] = [];
  for (const id of noteIds) {
    const note = await store.noteRead(id);
    if (!note) throw writeRejected('not_found');
    noteRevisions.push({ id, localSeq: note.localSeq, bodySha256: note.bodySha256 });
    if (resolvesToAnother || note.body.startsWith(LOCKED_BODY_PREFIX)) continue;
    const body = renameFileEmbedInMarkdown(note.body, file.name, newName);
    if (body === note.body) continue;
    const derived = deriveNoteKeepingTitle(body, note);
    // El nombre no puede traer una etiqueta (`#` no vale en él), pero es la regla de toda
    // escritura: el cuerpo resultante no deja la nota oculta (decisión 4 de D2).
    if (live.hidesAnyTag((derived.tags ?? []).map(({ tag }) => tag))) throw writeRejected('not_found');
    entries.push({
      id,
      body,
      ...derived,
      baseLocalSeq: note.localSeq,
      baseBodySha256: note.bodySha256
    });
  }

  if (entries.length > 0) {
    const homonym = others.find((other) => other.name === newName);
    if (homonym) throw existingFileRejected(homonym.id);
    // Un homónimo exacto en la misma carpeta que no se ve: el motor no renombra con los
    // enlaces (`file_name_taken`), y el visible ya lo rechazó quien llama.
    const hiddenTwin = index.files.some(
      (other) =>
        other.id !== file.id && other.trashedAt === null && other.folderId === file.folderId && other.name === newName
    );
    if (hiddenTwin) throw writeRejected('not_found');
  }
  return { noteRevisions, entries };
}
