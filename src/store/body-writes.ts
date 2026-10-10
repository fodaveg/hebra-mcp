/**
 * Las escrituras de los ficheros de trabajo (SPEC.md §13, «D», 10 oct 2026), dentro de un
 * turno exclusivo del escritor, como las de `./writes.ts`. Son la ÚNICA vía de hebra-mcp
 * que reescribe el cuerpo entero de una nota: la excepción a D2 que decidió David para la
 * vía LOCAL (`hebra-mcp apply` y `undo`). Ninguna herramienta MCP manda un cuerpo entero.
 * Desde D14 (10 oct 2026), `hebra_replace_in_notes` reutiliza este mismo turno
 * (`./replace-batch.ts`) para escribir el cuerpo que salió de SUS sustituciones simuladas
 * (el escritor lo calculó y lo guardó en el plan; el agente no lo manda), y para deshacerlo.
 *
 * El motivo de D2 (que nadie machaque a ciegas lo que no vio) se cubre igual:
 * - comprobación de base del motor: `noteSave` con `expectedLocalSeq` y `baseBodySha256`
 *   de lo que se sacó; si la nota cambió por debajo, el motor no la toca y deja la copia
 *   de conflicto visible (`conflictOf`), o no se escribe nada (`reject`);
 * - instantánea forzada (`noteVersionSnapshot`) antes de reescribir el cuerpo;
 * - el cuerpo base guardado por lote en la carpeta de trabajo, para deshacerlo (`undo`).
 *
 * `replaceBodyInTurn`, en este orden (SPEC.md §13.4):
 * 1. Filtro de privados de quien pide, sobre el almacén de este turno. Una nota que no
 *    existe, está en la papelera u oculta, o un cuerpo que la dejaría con una etiqueta
 *    privada: `unavailable`, las cuatro igual (decisión 4 de D2: sin delatar qué es
 *    privado).
 * 2. Nota bloqueada (o un cuerpo nuevo que lo parece): `locked`, sin escribir.
 * 3. **«Ya estaba»**: si el cuerpo actual ya es el editado, no se escribe nada. Es lo que
 *    hace repetible un `apply` cortado: la nota que entró antes del corte no se vuelve a
 *    escribir ni sale como conflicto (`test/workdir/apply-corte.node.test.ts` lo ve fallar
 *    sin este paso).
 * 4. Si el cuerpo actual es la base: instantánea forzada y `noteSave`. `applied`.
 * 5. Si cambió por debajo (otro escritor): `reject` no escribe (`conflict_rejected`);
 *    `copy` busca antes una copia de conflicto viva de esta nota con el mismo cuerpo
 *    editado (un reintento tras un corte no crea otra) y, si no la hay, `noteSave` con la
 *    base vieja: el motor deja el texto en una copia nueva y no toca el original.
 *
 * `trashConflictCopiesInTurn`: manda a la papelera (reversible) las copias de conflicto de
 * una nota que siguen con el cuerpo que dejó un lote. Solo copias (`conflictOf` de esa
 * nota): no sirve para mandar a la papelera ninguna otra nota.
 *
 * Nunca se crea, borra ni purga una nota desde un fichero.
 */
import { createHash } from 'node:crypto';
import type { PrivacyConfig } from '../privacy/config';
import { TrashFilter } from '../privacy/trash-filter';
import {
  LOCKED_BODY_PREFIX,
  privacyInTurn,
  saveInputFor,
  type NoteWriteStore,
  type NoteWriteTarget
} from './writes';

/** Tope del cuerpo que se devuelve (`./writes.ts`, donde entra en el tope del socket). */
export { REPLACE_BODY_MAX_LENGTH } from './writes';

export type ConflictMode = 'copy' | 'reject';

/** `expectedLocalSeq` de un guardado que tiene que salir como copia de conflicto: el motor
 *  empieza en 1 y solo sube, así que -1 nunca coincide con el de la nota. */
const NO_LOCAL_SEQ = -1;

export interface ReplaceBodyInput {
  id: string;
  /** El cuerpo nuevo, entero. */
  body: string;
  /** SHA-256 hex del cuerpo sobre el que se editó (la base sacada). Es lo ÚNICO que decide
   *  si hay conflicto: el `local_seq` de la sacada no viaja (ver `NO_LOCAL_SEQ`). */
  baseBodySha256: string;
  onConflict: ConflictMode;
  /** Configuración de privados de quien pide (la del CLI, o la del lector por el socket). */
  privacy: PrivacyConfig;
}

export type ReplaceBodyResult =
  | { outcome: 'applied'; localSeq: number; bodySha256: string }
  | { outcome: 'already'; localSeq: number; bodySha256: string }
  | { outcome: 'conflict_copy'; copyId: string; reused: boolean }
  | { outcome: 'conflict_rejected' }
  | { outcome: 'unavailable' }
  | { outcome: 'locked' };

/** Solo para tests (SPEC.md §13.8, sabotaje): nunca llega del socket ni de la línea de
 *  órdenes. */
export interface ReplaceBodyTestHooks {
  /** Se salta el paso «ya estaba» para ver fallar el test que lo protege. */
  skipAlreadyApplied?: boolean;
}

export interface TrashConflictCopiesInput {
  /** La nota de la que son copia. */
  originalId: string;
  /** El cuerpo que dejó el lote en la copia: solo se tocan las que siguen así. */
  bodySha256: string;
  /** Si el diario sabe qué copia fue, solo esa; si no (corte antes de anotarla), las de
   *  esa nota con ese cuerpo que cumplan `notBefore` y `exclude`. */
  copyId?: string;
  /** Sin `copyId`: solo copias creadas desde este instante (epoch ms, el del intento). */
  notBefore?: number;
  /** Sin `copyId`: copias que no se tocan (las que anotaron otros lotes). */
  exclude?: string[];
  privacy: PrivacyConfig;
}

export interface TrashConflictCopiesResult {
  /** Mandadas ahora a la papelera. */
  trashed: number;
  /** Ya estaban en la papelera. */
  already: number;
  /** La copia nombrada cambió después (o no está disponible): no se toca. */
  changed: number;
}

/** Lo que estas escrituras necesitan del escritor: el turno exclusivo. */
export type BodyWriteTarget = NoteWriteTarget;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Copia viva de `originalId` con ese cuerpo, si la hay (para no crear otra). */
async function findCopy(
  store: NoteWriteStore,
  originalId: string,
  bodySha256: string
): Promise<string | null> {
  for (const copyId of store.conflictCopyIds(originalId)) {
    const copy = await store.noteRead(copyId);
    if (copy && copy.trashedAt === null && copy.conflictOf === originalId && copy.bodySha256 === bodySha256) {
      return copyId;
    }
  }
  return null;
}

/** El turno de `replaceBody` (ver la cabecera). Devuelve también si escribió. */
export async function replaceBodyInTurn(
  store: NoteWriteStore,
  input: ReplaceBodyInput,
  hooks: ReplaceBodyTestHooks = {}
): Promise<{ result: ReplaceBodyResult; wrote: boolean }> {
  const filter = privacyInTurn(store, input.privacy);
  const note = await store.noteRead(input.id);
  if (!note || note.trashedAt !== null || filter.isHiddenNote(note.id)) {
    return { result: { outcome: 'unavailable' }, wrote: false };
  }
  if (note.body.startsWith(LOCKED_BODY_PREFIX) || input.body.startsWith(LOCKED_BODY_PREFIX)) {
    return { result: { outcome: 'locked' }, wrote: false };
  }
  const editedSha = sha256Hex(input.body);
  if (!hooks.skipAlreadyApplied && note.bodySha256 === editedSha) {
    return {
      result: { outcome: 'already', localSeq: note.localSeq, bodySha256: note.bodySha256 },
      wrote: false
    };
  }
  const changedUnderneath = note.bodySha256 !== input.baseBodySha256;
  if (changedUnderneath && input.onConflict === 'reject') {
    return { result: { outcome: 'conflict_rejected' }, wrote: false };
  }
  if (changedUnderneath) {
    const existing = await findCopy(store, note.id, editedSha);
    if (existing) return { result: { outcome: 'conflict_copy', copyId: existing, reused: true }, wrote: false };
  }
  // Base del guardado: la actual si el cuerpo sigue siendo la base (solo cambiaron
  // metadatos, o nada). Si cambió por debajo, el SHA de la sacada con un `local_seq` que no
  // puede coincidir: el motor escribe in situ si `local_seq` coincide AUNQUE el cuerpo sea
  // otro, y un `rev` de la sacada que coincidiera por casualidad (carpeta copiada de otra
  // máquina, biblioteca re-emparejada) pisaría la edición ajena sin copia ni instantánea.
  const base = changedUnderneath ? { localSeq: NO_LOCAL_SEQ, bodySha256: input.baseBodySha256 } : note;
  const saveInput = saveInputFor(note, input.body, base);
  if (filter.hidesAnyTag((saveInput.tags ?? []).map(({ tag }) => tag))) {
    return { result: { outcome: 'unavailable' }, wrote: false };
  }
  // La instantánea guarda el cuerpo que se va a sustituir; con una copia de conflicto el
  // original no se toca y no hace falta.
  if (!changedUnderneath) await store.noteVersionSnapshot(note.id);
  const saved = await store.noteSave(saveInput);
  if (saved.outcome === 'redirected') {
    return {
      result: { outcome: 'conflict_copy', copyId: saved.redirectedTo, reused: false },
      wrote: true
    };
  }
  return {
    result: { outcome: 'applied', localSeq: saved.localSeq, bodySha256: saved.bodySha256 },
    wrote: true
  };
}

/** El turno de `trashConflictCopies` (ver la cabecera). */
export async function trashConflictCopiesInTurn(
  store: NoteWriteStore,
  input: TrashConflictCopiesInput
): Promise<{ result: TrashConflictCopiesResult; wrote: boolean }> {
  const filter = privacyInTurn(store, input.privacy);
  // La papelera tiene su propio filtro (`isHiddenNote` solo conoce las notas vivas).
  const trash = TrashFilter.fromSnapshot(filter, store.trashIndex(), input.privacy);
  const result: TrashConflictCopiesResult = { trashed: 0, already: 0, changed: 0 };
  const named = input.copyId !== undefined;
  const excluded = new Set(input.exclude ?? []);
  const ids = named ? [input.copyId!] : store.conflictCopyIds(input.originalId);
  for (const id of ids) {
    const copy = await store.noteRead(id);
    // Solo copias de conflicto de ESA nota: con otra nota no hace nada.
    if (!copy || copy.conflictOf !== input.originalId) {
      if (named) result.changed += 1;
      continue;
    }
    // La privacidad, antes de decir nada de la copia (tampoco si está en la papelera).
    const hidden = copy.trashedAt !== null ? !trash.isVisible(copy.id) : filter.isHiddenNote(copy.id);
    if (hidden) {
      if (named) result.changed += 1;
      continue;
    }
    // Sin id anotado (lote cortado): ni las que otro lote anotó como suyas ni las de antes
    // del intento.
    if (!named && (excluded.has(copy.id) || (input.notBefore !== undefined && copy.createdAt < input.notBefore))) {
      continue;
    }
    if (copy.trashedAt !== null) {
      if (copy.bodySha256 === input.bodySha256) result.already += 1;
      continue;
    }
    if (copy.bodySha256 !== input.bodySha256) {
      if (named) result.changed += 1;
      continue;
    }
    await store.noteTrash(copy.id);
    result.trashed += 1;
  }
  return { result, wrote: result.trashed > 0 };
}

/**
 * Las dos escrituras sobre el escritor (`LibraryInstance`): el turno exclusivo y, si
 * escribió, `onWritten` (la ronda de después, sin esperarla: la espera quien cierra el
 * lote, una vez).
 */
export async function replaceBody(
  target: BodyWriteTarget,
  input: ReplaceBodyInput,
  onWritten: () => void,
  hooks: ReplaceBodyTestHooks = {}
): Promise<ReplaceBodyResult> {
  const { result, wrote } = await target.writeExclusive((store) => replaceBodyInTurn(store, input, hooks));
  if (wrote) onWritten();
  return result;
}

export async function trashConflictCopies(
  target: BodyWriteTarget,
  input: TrashConflictCopiesInput,
  onWritten: () => void
): Promise<TrashConflictCopiesResult> {
  const { result, wrote } = await target.writeExclusive((store) => trashConflictCopiesInTurn(store, input));
  if (wrote) onWritten();
  return result;
}
