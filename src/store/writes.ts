/**
 * Las escrituras de hebra-mcp (D2, SPEC.md §5 «Detalle de las escrituras», ampliada el
 * 28 sep 2026 con la edición), sobre el almacén. NO son las herramientas MCP: aquí no
 * hay esquema de salida ni límites de longitud de la herramienta. Nada de borrar.
 *
 * - `createNote`: `noteCreate(folderId)` + `noteSave` con los derivados de
 *   `deriveNote(body)`, en UN turno de la cola del almacén (`writeExclusive`): una ronda
 *   de sync no puede colarse entre los dos pasos y subir la nota vacía.
 * - `appendToNote`: `noteRead` → `body + "\n\n" + text` → `noteSave` con
 *   `expectedLocalSeq` y `baseBodySha256` de lo leído. Si el almacén responde
 *   `redirected` (la nota cambió o es una lápida), el texto quedó en una copia de
 *   conflicto visible: `conflict_copy` con su id. Si el choque llega después, con la
 *   ronda (otro dispositivo editó la misma nota), lo resuelve la tabla de §7 del almacén
 *   con otra copia, y el motor lo avisa con `sync.conflict_copy` (`SyncRunner`).
 * - `editNote`: sustituciones puntuales (`./edits.ts`) sobre la versión que el agente
 *   leyó (`./revision.ts`), con el filtro de privados construido DENTRO del turno y la
 *   idempotencia de `./operations.ts`. Ver su comentario.
 *
 * Después de cada escritura, `onWritten` (la instancia lo conecta a
 * `SyncRunner.requestRound`, SPEC.md §8: «una ronda justo después de cada escritura»).
 */
import { createHash } from 'node:crypto';
import {
  deriveNote,
  LibraryError,
  type FoldersList,
  type NoteRow,
  type NoteSaveInput,
  type NoteSaveResult
} from '../hebra';
import type { PrivacyConfig } from '../privacy/config';
import { PrivacyFilter } from '../privacy/filter';
import { applyEdits, type TextEdit } from './edits';
import { writeRejected } from './errors';
import type { OperationStore } from './operations';
import { decodeRevision, encodeRevision } from './revision';
import type { NoteVisibilityEntry } from './types';

/** Acceso directo del motor dentro de un turno de la cola (`NodeLibraryPort`). */
export interface NoteWriteStore {
  noteCreate(folderId?: string | null): Promise<NoteRow>;
  noteRead(id: string): Promise<NoteRow | null>;
  noteSave(input: NoteSaveInput): Promise<NoteSaveResult>;
  /** `meta.library_id` del almacén (para la revisión). */
  libraryId(): string;
  /** Lo que lee el filtro de privados, en este mismo turno. */
  foldersList(): FoldersList;
  notesVisibilityIndex(): NoteVisibilityEntry[];
  /** Registro de idempotencia de `editNote`. */
  operations: OperationStore;
}

/** Lo que `NoteWriter` necesita del almacén: un turno exclusivo de la cola. Rechaza con
 *  `busy_other_instance` si esta instancia no es el escritor único. */
export interface NoteWriteTarget {
  writeExclusive<T>(operation: (store: NoteWriteStore) => Promise<T>): Promise<T>;
}

export interface CreateNoteInput {
  /** Markdown; el primer H1 es el título, como en Hebra. */
  body: string;
  /** Carpeta existente; `null`/ausente = la raíz. */
  folderId?: string | null;
}

export interface CreateNoteResult {
  id: string;
  title: string;
  folderId: string;
}

export interface AppendToNoteInput {
  id: string;
  text: string;
}

export type AppendToNoteResult =
  | { id: string; outcome: 'saved' }
  | { id: string; outcome: 'conflict_copy'; copyId: string };

/** Separador entre el cuerpo existente y lo añadido (SPEC.md §5). */
export const APPEND_SEPARATOR = '\n\n';

/** Límite del cuerpo de `hebra_create_note` (SPEC.md §5), en unidades UTF-16
 *  (`string.length`). Lo comprueban la herramienta y, otra vez, el socket del escritor
 *  (`src/ipc/writer-socket.ts`), que no se fía de lo que le llega. */
export const CREATE_BODY_MAX_LENGTH = 100_000;

/** Límite del texto de `hebra_append_to_note` (SPEC.md §5), igual que el de arriba. */
export const APPEND_TEXT_MAX_LENGTH = 20_000;

export interface EditNoteInput {
  id: string;
  /** Sustituciones puntuales sobre el cuerpo LEÍDO (`./edits.ts`). */
  edits: TextEdit[];
  /** La `revision` que devolvió `hebra_read_note` (`./revision.ts`). */
  expectedRevision: string;
  /** Idempotencia (`./operations.ts`): el mismo id con la misma petición no se repite. */
  operationId: string;
  /**
   * Configuración de privados de QUIEN pide la edición: la herramienta que la recibe o,
   * por `writer.sock`, la del lector (el escritor no la conoce ni la supone igual). Se
   * evalúa dentro del turno de la escritura. Ausente = ninguna carpeta ni etiqueta
   * privada (llamadas internas y tests); las notas de la papelera siguen fuera igual.
   */
  privacy?: PrivacyConfig;
}

/** Resultado del guardado LOCAL de una edición (el estado de sync lo añade quien espera
 *  la ronda, `src/server/write-context.ts`). `replayed`: devuelto del registro de
 *  idempotencia, sin volver a escribir. */
export type EditNoteSaved =
  | { id: string; outcome: 'saved'; revision: string; replayed?: true }
  | { id: string; outcome: 'conflict_copy'; copyId: string; replayed?: true };

const OPEN_PRIVACY: PrivacyConfig = { privateFolders: [], privateTags: [] };

/** Prefijo de un cuerpo bloqueado (`LOCKED_MARK` de `sqlite-engine.ts`, Paridad Bear L
 *  §17). Una nota cuyo cuerpo empieza así no se edita, y una edición no puede producirlo. */
const LOCKED_BODY_PREFIX = 'hebra-locked:';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Huella de la petición: el mismo `operationId` con otra petición es un error. */
function editFingerprint(input: EditNoteInput): string {
  return sha256Hex(
    JSON.stringify([
      'editNote',
      input.id,
      input.expectedRevision,
      input.edits.map((edit) => [edit.find, edit.replace])
    ])
  );
}

function isEditNoteSaved(value: unknown): value is EditNoteSaved {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string') return false;
  if (record.outcome === 'saved') return typeof record.revision === 'string';
  return record.outcome === 'conflict_copy' && typeof record.copyId === 'string';
}

/**
 * El filtro de privados sobre el almacén TAL COMO ESTÁ en este turno de la cola (ni el
 * sync ni otra escritura pueden cambiarlo hasta que el turno acabe). Cerrado ante la
 * duda: una configuración que no se puede aplicar rechaza sin escribir.
 */
function privacyInTurn(store: NoteWriteStore, config: PrivacyConfig | undefined): PrivacyFilter {
  const filter = PrivacyFilter.fromSnapshot(
    store.foldersList(),
    store.notesVisibilityIndex(),
    config ?? OPEN_PRIVACY
  );
  if (filter.unresolved) throw writeRejected('privacy_config_unresolved');
  return filter;
}

/**
 * `NoteSaveInput` completo para `body`: TODOS los derivados de `deriveNote` y la base.
 * Se pasan todos, no una lista a mano: el almacén de Hebra reemplaza cada conjunto
 * derivado en cada guardado (`replaceNoteTasks` borra e inserta `tasks ?? []`), así que
 * uno que falte aquí vacía su índice (bug medido el 28 sep 2026 con `tasks`,
 * `hasOpenTasks` y `titleSort`; `test/store/writes-derived.node.test.ts`). `locked` viaja
 * también, aunque `noteSave` lo recalcula del cuerpo y no se fía de él.
 *
 * `base`: la versión sobre la que se escribe. Por defecto, la de `note` (lo recién
 * leído); `editNote` pasa la de la revisión que trae el agente.
 */
export function saveInputFor(
  note: NoteRow,
  body: string,
  base: { localSeq: number; bodySha256: string } = note
): NoteSaveInput {
  return {
    ...deriveNote(body),
    id: note.id,
    body,
    expectedLocalSeq: base.localSeq,
    baseBodySha256: base.bodySha256
  };
}

export interface NoteWriterOptions {
  /** Tras cada escritura confirmada. Un fallo aquí no deshace ni oculta la escritura. */
  onWritten?: () => void;
}

export class NoteWriter {
  constructor(
    private readonly target: NoteWriteTarget,
    private readonly options: NoteWriterOptions = {}
  ) {}

  private written(): void {
    try {
      this.options.onWritten?.();
    } catch {
      // La escritura ya está en disco; la ronda periódica la subirá.
    }
  }

  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    const result = await this.target.writeExclusive(async (store) => {
      const note = await store.noteCreate(input.folderId ?? null);
      const saved = await store.noteSave(saveInputFor(note, input.body));
      // Recién creada, nadie más la conoce: `redirected` aquí sería un fallo del motor,
      // no un conflicto. Se devuelve igual el id donde quedó el texto.
      const id = saved.outcome === 'saved' ? note.id : saved.redirectedTo;
      const row = await store.noteRead(id);
      return { id, title: row?.title ?? '', folderId: row?.folderId ?? note.folderId };
    });
    this.written();
    return result;
  }

  /**
   * Añade `text` al final de la nota `id`. `note_not_found` (`LibraryError` de Hebra) si
   * no existe o está en la papelera: las herramientas nunca devuelven notas de la
   * papelera (SPEC.md §5), así que tampoco se escribe en ellas.
   */
  async appendToNote(input: AppendToNoteInput): Promise<AppendToNoteResult> {
    const result = await this.target.writeExclusive(async (store) => {
      const note = await store.noteRead(input.id);
      if (!note || note.trashedAt !== null) throw new LibraryError('note_not_found');
      const saved = await store.noteSave(
        saveInputFor(note, `${note.body}${APPEND_SEPARATOR}${input.text}`)
      );
      return saved.outcome === 'saved'
        ? ({ id: input.id, outcome: 'saved' } as const)
        : ({ id: input.id, outcome: 'conflict_copy', copyId: saved.redirectedTo } as const);
    });
    this.written();
    return result;
  }

  /**
   * Sustituciones puntuales sobre la versión que el agente leyó (D2 ampliada, 28 sep
   * 2026). Todo en UN turno de la cola del almacén, así que ni una ronda de sync ni otra
   * escritura se cuelan entre la comprobación y el guardado:
   * 1. Registro de idempotencia: el mismo `operationId` ya terminado devuelve lo que
   *    devolvió (`replayed`); con otra petición, `operation_id_reused`; a medias
   *    (`started`), el SHA-256 del cuerpo dice si llegó a guardarse.
   * 2. Filtro de privados del que pide, sobre el almacén de ESTE turno: una nota oculta,
   *    en la papelera o inexistente es `not_found`, las tres igual.
   * 3. Nota bloqueada: `note_locked`.
   * 4. Revisión: tiene que ser de esta nota (si no, `invalid_input`) y de esta biblioteca
   *    con el MISMO cuerpo que hay ahora (si no, `revision_conflict`). La base del guardado
   *    es la de la revisión, no la de la nota actual.
   * 5. Sustituciones (`applyEdits`): cualquier fallo rechaza sin escribir.
   * 6. Resultado: si dejaría la nota con una etiqueta privada, `not_found` sin escribir
   *    (decisión 4 de David).
   * 7. `begin` → `noteSave` → `finish` (`./operations.ts`).
   * Un conflicto con otro dispositivo llega DESPUÉS, en la ronda: lo resuelve el motor
   * con una copia visible, y quien espera la ronda lo anota con `recordEditConflict`.
   */
  async editNote(input: EditNoteInput): Promise<EditNoteSaved> {
    const { result, wrote } = await this.target.writeExclusive(async (store) => {
      const now = Date.now();
      const log = store.operations;
      log.purgeExpired(now);
      const fingerprint = editFingerprint(input);
      const previous = log.lookup(input.operationId);
      if (previous && previous.fingerprint !== fingerprint) {
        throw writeRejected('operation_id_reused');
      }
      const filter = privacyInTurn(store, input.privacy);
      const note = await store.noteRead(input.id);
      if (!note || note.trashedAt !== null || filter.isHiddenNote(note.id)) {
        throw writeRejected('not_found');
      }
      const libraryId = store.libraryId();
      const revisionOf = (row: { localSeq: number; bodySha256: string }): string =>
        encodeRevision({
          libraryId,
          noteId: input.id,
          localSeq: row.localSeq,
          bodySha256: row.bodySha256
        });

      if (previous?.state === 'done' && isEditNoteSaved(previous.result)) {
        return { result: { ...previous.result, replayed: true as const }, wrote: false };
      }
      if (previous?.state === 'started' && note.bodySha256 === previous.targetBodySha256) {
        // Murió entre el guardado y `finish`: se guardó. Se completa el registro.
        const saved: EditNoteSaved = { id: input.id, outcome: 'saved', revision: revisionOf(note) };
        log.finish(input.operationId, saved);
        return { result: { ...saved, replayed: true as const }, wrote: false };
      }

      if (note.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('note_locked');
      const revision = decodeRevision(input.expectedRevision);
      if (!revision || revision.noteId !== input.id) throw writeRejected('invalid_input');
      if (revision.libraryId !== libraryId || revision.bodySha256 !== note.bodySha256) {
        throw writeRejected('revision_conflict');
      }
      const applied = applyEdits(note.body, input.edits);
      if (!applied.ok) throw writeRejected(applied.code, applied.editIndex);
      if (applied.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('invalid_input');
      if (applied.body === note.body) {
        // Nada que guardar: ni sube `local_seq` ni hay ronda que pedir.
        const unchanged: EditNoteSaved = { id: input.id, outcome: 'saved', revision: revisionOf(note) };
        return { result: unchanged, wrote: false };
      }

      const saveInput = saveInputFor(note, applied.body, revision);
      if (filter.hidesAnyTag((saveInput.tags ?? []).map(({ tag }) => tag))) {
        throw writeRejected('not_found');
      }
      log.begin({
        operationId: input.operationId,
        fingerprint,
        noteId: input.id,
        targetBodySha256: sha256Hex(applied.body),
        now
      });
      const saved = await store.noteSave(saveInput);
      const outcome: EditNoteSaved =
        saved.outcome === 'saved'
          ? { id: input.id, outcome: 'saved', revision: revisionOf(saved) }
          : { id: input.id, outcome: 'conflict_copy', copyId: saved.redirectedTo };
      log.finish(input.operationId, outcome);
      return { result: outcome, wrote: true };
    });
    if (wrote) this.written();
    return result;
  }

  /**
   * La ronda de después de una edición produjo una copia de conflicto para esa nota (otro
   * dispositivo la cambió a la vez): se anota en el registro de idempotencia, para que un
   * reintento con el mismo `operationId` devuelva `conflict_copy` y no un `saved` con una
   * revisión que ya no casa. Si el registro no existe o no terminó, no hace nada.
   */
  async recordEditConflict(operationId: string, id: string, copyId: string): Promise<void> {
    await this.target.writeExclusive(async (store) => {
      const record = store.operations.lookup(operationId);
      if (record?.state !== 'done' || record.noteId !== id) return;
      const conflict: EditNoteSaved = { id, outcome: 'conflict_copy', copyId };
      store.operations.finish(operationId, conflict);
    });
  }
}
