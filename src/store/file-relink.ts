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
 *   cruza DESPUÉS, aunque además le quiten el enlace, la herramienta declara a la puerta final
 *   los ids de las notas reescritas (`relinkedNotesOf`, nunca salen en la respuesta), y responde
 *   `not_found`. También al reintentar: los ids se guardan en el registro de la operación.
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
 * carpeta, reescribirlas podría apuntarlas a ese: `file_exists` con su id.
 *
 * Homónimo oculto, dos efectos declarados (SPEC.md §6.3; David delegó la decisión, 5 nov 2026):
 * - Oráculo. Renombrar al nombre exacto de un fichero oculto vivo de la MISMA carpeta, con notas
 *   que arreglar, responde `not_found`; con ese nombre libre, renombra. Se queda: el motor no
 *   renombra con ese homónimo al lado (`file_name_taken`), y renombrar sin arreglar las notas
 *   también lo delataría y dejaría enlaces rotos. NO es el coste asumido de D17: D17 responde si
 *   alguna nota oculta enlaza ese nombre o esos bytes; esto responde si existe un fichero oculto
 *   con ese nombre en esa carpeta, aunque nada enlace ese nombre. El agente puede provocar la
 *   condición creando una nota visible con el incrustado. Límites: hay que adivinar el nombre y
 *   la extensión exactos, hace falta un fichero visible de esa extensión en esa carpeta, un
 *   intento que falla no escribe, y uno que acierta un nombre libre sí escribe (renombra,
 *   reescribe la nota, deja versión y sync).
 * - Integridad, sin arreglar. Si el fichero F pasa a llamarse N y hay un H con el nombre N en una
 *   carpeta privada y con menor id, la nota visible queda con el incrustado de N y `resolveLink`
 *   la resuelve a H: en la app esa nota enseñaría H a la persona dueña; por el MCP no sale nada.
 *   El caso inverso, un H de menor id con el nombre ANTERIOR: la nota se reescribe igualmente.
 *   Rechazar cualquiera de los dos sería otro oráculo.
 */
import { deriveNoteKeepingTitle, renameFileEmbedInMarkdown } from '../hebra';
import type { FileFilter } from '../privacy/file-filter';
import type { PrivacyFilter } from '../privacy/filter';
import { existingFileRejected, writeRejected } from './errors';
import { RELINKED_NOTES_MAX } from './file-content';
import type { FileRelinkInput } from './note-state-engine';
import type { FilesIndex } from './types';
import { LOCKED_BODY_PREFIX, type NoteWriteStore } from './writes';

/** Lo del turno que hace falta para decidir. */
export interface RelinkTurn {
  store: NoteWriteStore;
  files: FileFilter;
  live: PrivacyFilter;
  index: FilesIndex;
  /** El filtro de privados del turno con SOLO esas notas (`privacyInTurnFor`, A8 del plan de
   *  memoria): si está, las notas que se reenlazan se juzgan con él, porque `live` puede ser
   *  uno hecho solo con las notas de los ficheros. Sin él, con `live`. */
  liveFor?: (noteIds: readonly string[]) => PrivacyFilter;
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

/** Los ids de las notas reescritas, para la puerta final y el registro de la operación.
 *  `planRelink` ya rechazó un plan de más de `RELINKED_NOTES_MAX`. */
export function relinkedNotesOf(plan: Pick<RelinkPlan, 'entries'>): string[] {
  return plan.entries.map((entry) => entry.id);
}

/** Prepara el renombrado sin escribir nada; rechaza (`not_found`, `file_exists`,
 *  `too_many_linked_notes`) sin escribir. El tope va después de mirar que ninguna nota sea
 *  oculta, así que solo cuenta visibles, y corta en cuanto se pasa, sin derivar el resto. */
export async function planRelink(turn: RelinkTurn, file: RelinkFile, newName: string): Promise<RelinkPlan> {
  const { store, live, files, index } = turn;
  const noteIds = store.notesRelinkingFile(file.id, file.name, file.sha256);
  const judge = turn.liveFor ? turn.liveFor(noteIds) : live;
  if (noteIds.some((id) => judge.isHiddenNote(id))) throw writeRejected('not_found');

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
    if (entries.length >= RELINKED_NOTES_MAX) throw writeRejected('too_many_linked_notes');
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
