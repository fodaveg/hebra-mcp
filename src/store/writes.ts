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
 * - `organize`: mover, favorita, archivar y, desde el 30 sep 2026, mandar a la papelera
 *   y sacar de ella (`noteTrash`/`noteRestore`, reversibles). Nunca purga ni vacía la
 *   papelera.
 * - `restoreVersion` (30 sep 2026): restaurar una «versión anterior» es una edición
 *   nueva, con la revisión, la idempotencia y la copia de conflicto de `editNote`.
 *
 * Después de cada escritura, `onWritten` (la instancia lo conecta a
 * `SyncRunner.requestRound`, SPEC.md §8: «una ronda justo después de cada escritura»).
 */
import { createHash } from 'node:crypto';
import {
  deriveNote,
  LibraryError,
  ROOT_FOLDER_ID,
  type FoldersList,
  type NoteRow,
  type NoteSaveInput,
  type NoteSaveResult
} from '../hebra';
import type { PrivacyConfig } from '../privacy/config';
import { PrivacyFilter } from '../privacy/filter';
import { TrashFilter } from '../privacy/trash-filter';
import { applyEdits, type TextEdit } from './edits';
import { writeRejected } from './errors';
import type { OperationStore } from './operations';
import { decodeRevision, encodeRevision } from './revision';
import type { NoteVersion, NoteVisibilityEntry, TrashIndex } from './types';

/** Acceso directo del motor dentro de un turno de la cola (`NodeLibraryPort`). */
export interface NoteWriteStore {
  noteCreate(folderId?: string | null): Promise<NoteRow>;
  noteRead(id: string): Promise<NoteRow | null>;
  noteSave(input: NoteSaveInput): Promise<NoteSaveResult>;
  /** Organización de notas (D2 ampliada): los métodos del mismo nombre de
   *  `SqliteLibraryEngine`. Las carpetas NO se gestionan desde el MCP (opción A de David,
   *  28 sep 2026): sus errores revelarían carpetas privadas. */
  noteMove(id: string, folderId: string): Promise<NoteRow>;
  noteSetFavorite(id: string, favorite: boolean): Promise<NoteRow>;
  noteArchive(id: string): Promise<NoteRow>;
  noteUnarchive(id: string): Promise<NoteRow>;
  /** Papelera (ampliación de D2, 30 sep 2026): mandar y sacar, las dos reversibles e
   *  idempotentes en el motor. Purgar y vaciar la papelera NO están, ni aquí ni en
   *  ningún sitio de hebra-mcp (`test/store/surface.node.test.ts`). */
  noteTrash(id: string): Promise<NoteRow>;
  noteRestore(id: string): Promise<NoteRow>;
  /** «Versiones anteriores»: leer una, y la instantánea forzada del cuerpo actual que
   *  Hebra pide antes de restaurar (`noteVersionSnapshot`, no toca la fila de la nota). */
  noteVersionRead(versionId: number): NoteVersion | null;
  noteVersionSnapshot(noteId: string): Promise<void>;
  /** `meta.library_id` del almacén (para la revisión). */
  libraryId(): string;
  /** Lo que lee el filtro de privados, en este mismo turno. */
  foldersList(): FoldersList;
  notesVisibilityIndex(): NoteVisibilityEntry[];
  /** Lo que lee el filtro de la papelera (`src/privacy/trash-filter.ts`). */
  trashIndex(): TrashIndex;
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
  /** Igual que `EditNoteInput.privacy`: la configuración de quien pide, aplicada dentro
   *  del turno de la escritura. */
  privacy: PrivacyConfig;
}

export interface CreateNoteResult {
  id: string;
  title: string;
  folderId: string;
}

export interface AppendToNoteInput {
  id: string;
  text: string;
  /** Igual que `EditNoteInput.privacy`. */
  privacy: PrivacyConfig;
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
   * evalúa dentro del turno de la escritura. Obligatoria en el tipo (revisión del 28 sep
   * 2026): sin un valor por defecto, una llamada nueva que se olvide de pasarla no compila
   * en vez de escribir sin filtro. Quien de verdad no tenga privados pasa una
   * configuración vacía, explícita.
   */
  privacy: PrivacyConfig;
}

/** Resultado del guardado LOCAL de una edición (el estado de sync lo añade quien espera
 *  la ronda, `src/server/write-context.ts`). `replayed`: devuelto del registro de
 *  idempotencia, sin volver a escribir. */
export type EditNoteSaved =
  | { id: string; outcome: 'saved'; revision: string; replayed?: true }
  | { id: string; outcome: 'conflict_copy'; copyId: string; replayed?: true };

/**
 * Organización de notas (D2 ampliada, 28 sep 2026): mover una nota a una carpeta que ya
 * existe, favorita, archivar y desarchivar. Todo por id; la raíz es `ROOT_FOLDER_ID`
 * (`"root"`, la que lista `hebra_list_folders` con ruta vacía). Desde el 30 sep 2026
 * (ampliación de D2), también mandar una nota a la papelera (`trashNote`) y sacarla
 * (`restoreNote`): cada una se deshace con la otra, desde Hebra o desde el MCP. Sin
 * adjuntos (otro lote) y sin nada irreversible: ni purga ni vaciar la papelera.
 *
 * Crear, renombrar y mover CARPETAS quedan fuera del MCP (opción A de David, 28 sep
 * 2026): `folder_name_taken` delataba el nombre de una hermana privada, y renombrar o
 * mover una carpeta visible con una privada dentro respondía distinto que sin ella. Las
 * carpetas se crean desde la app Hebra.
 */
export type OrganizeAction =
  | { action: 'moveNote'; id: string; folderId: string }
  | { action: 'setFavorite'; id: string; favorite: boolean }
  | { action: 'setArchived'; id: string; archived: boolean }
  | { action: 'trashNote'; id: string }
  | { action: 'restoreNote'; id: string };

export type OrganizeActionName = OrganizeAction['action'];

/** Igual que `EditNoteInput.privacy`: la configuración de quien pide. */
export type OrganizeInput = OrganizeAction & { privacy: PrivacyConfig };

/** Lo que queda tras organizar una nota: carpeta efectiva, favorita, archivada y si está
 *  en la papelera. La ruta para enseñar la calcula la herramienta con SU filtro. */
export interface OrganizeSaved {
  id: string;
  folderId: string;
  favorite: boolean;
  archived: boolean;
  trashed: boolean;
}

export interface RestoreVersionInput {
  id: string;
  /** Id de la versión (`hebra_list_versions`). Tiene que ser de ESTA nota. */
  versionId: number;
  /** Igual que en `EditNoteInput`: la `revision` que el agente leyó. */
  expectedRevision: string;
  /** Igual que en `EditNoteInput`: idempotencia, en el mismo registro. */
  operationId: string;
  /** Igual que `EditNoteInput.privacy`. */
  privacy: PrivacyConfig;
}

/** Los errores del motor de Hebra que la organización de notas puede dar. */
function organizeRejection(error: unknown): unknown {
  if (!(error instanceof LibraryError)) return error;
  if (error.code === 'note_not_found' || error.code === 'folder_not_found') {
    return writeRejected('not_found');
  }
  return error;
}

function noteSaved(row: NoteRow): OrganizeSaved {
  return {
    id: row.id,
    folderId: row.effectiveFolderId,
    favorite: row.favorite,
    archived: row.archivedAt !== null,
    trashed: row.trashedAt !== null
  };
}

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

/** Igual que `editFingerprint`: comparten registro, así que la operación va en la huella
 *  y un `operationId` de una edición no vale para restaurar (`operation_id_reused`). */
function restoreVersionFingerprint(input: RestoreVersionInput): string {
  return sha256Hex(
    JSON.stringify(['restoreVersion', input.id, input.expectedRevision, input.versionId])
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
function privacyInTurn(store: NoteWriteStore, config: PrivacyConfig): PrivacyFilter {
  const filter = PrivacyFilter.fromSnapshot(store.foldersList(), store.notesVisibilityIndex(), config);
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

  /**
   * Crea una nota. Dentro del turno, con la configuración de privados de quien pide: la
   * carpeta tiene que existir y ser visible, y el cuerpo no puede llevar una etiqueta
   * privada (decisión 4 de David, 28 sep 2026: el MCP no le pone una etiqueta privada a
   * ninguna nota). Si no, `not_found` sin crear nada.
   */
  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    const result = await this.target.writeExclusive(async (store) => {
      // Antes de `noteCreate`, que confirma su propia transacción: si `noteSave` fallara
      // después (`invalid_locked_body`), quedaría una nota vacía huérfana; y con una
      // cabecera v1 válida, una nota «bloqueada» con lo que el agente escribió. El MCP
      // nunca crea notas bloqueadas.
      if (input.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('invalid_input');
      const filter = privacyInTurn(store, input.privacy);
      const folderId = input.folderId ?? ROOT_FOLDER_ID;
      if (!filter.folderExists(folderId) || filter.isFolderHidden(folderId)) {
        throw writeRejected('not_found');
      }
      const derived = deriveNote(input.body);
      if (filter.hidesAnyTag((derived.tags ?? []).map(({ tag }) => tag))) {
        throw writeRejected('not_found');
      }
      const note = await store.noteCreate(folderId);
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
   * papelera (SPEC.md §5), así que tampoco se escribe en ellas. Dentro del turno, con la
   * configuración de privados de quien pide: una nota oculta, o un texto que la dejaría
   * con una etiqueta privada (decisión 4), es `not_found` sin escribir; una nota
   * bloqueada, `note_locked`.
   */
  async appendToNote(input: AppendToNoteInput): Promise<AppendToNoteResult> {
    const result = await this.target.writeExclusive(async (store) => {
      const filter = privacyInTurn(store, input.privacy);
      const note = await store.noteRead(input.id);
      if (!note || note.trashedAt !== null) throw new LibraryError('note_not_found');
      if (filter.isHiddenNote(note.id)) throw writeRejected('not_found');
      if (note.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('note_locked');
      const saveInput = saveInputFor(note, `${note.body}${APPEND_SEPARATOR}${input.text}`);
      if (filter.hidesAnyTag((saveInput.tags ?? []).map(({ tag }) => tag))) {
        throw writeRejected('not_found');
      }
      const saved = await store.noteSave(saveInput);
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
   * Restaurar una «versión anterior» (ampliación de D2, 30 sep 2026): una edición NUEVA
   * que deja el cuerpo de la versión, como «Restaurar» en Hebra (`restoreVersion` de
   * `LibraryEditor.svelte`: instantánea YA del cuerpo actual y guardado normal). Mismo
   * turno y mismos pasos que `editNote`, con la versión en lugar de las sustituciones:
   * 1. Idempotencia, en el mismo registro (huella propia, `restoreVersionFingerprint`).
   * 2. Nota visible para quien pide (oculta, en la papelera o inexistente: `not_found`).
   * 3. Nota bloqueada: `note_locked`.
   * 4. Revisión: igual que `editNote` (`invalid_input` / `revision_conflict`).
   * 5. La versión tiene que existir y ser de ESTA nota; si su cuerpo lleva una etiqueta
   *    privada (o descendiente), tampoco vale: `not_found` en los tres casos, igual que
   *    una versión que no existe (regla 4 de D2: nunca llevar una nota a una etiqueta
   *    privada por ninguna vía, y sin delatar que la versión era privada).
   * 6. Instantánea forzada del cuerpo actual (`noteVersionSnapshot`), para que lo que
   *    había se pueda recuperar, y `noteSave` con la base de la revisión: si otro
   *    dispositivo la cambió a la vez, copia de conflicto visible, como `editNote`.
   */
  async restoreVersion(input: RestoreVersionInput): Promise<EditNoteSaved> {
    const { result, wrote } = await this.target.writeExclusive(async (store) => {
      const now = Date.now();
      const log = store.operations;
      log.purgeExpired(now);
      const fingerprint = restoreVersionFingerprint(input);
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
      const version = store.noteVersionRead(input.versionId);
      if (!version || version.noteId !== input.id) throw writeRejected('not_found');
      if (version.body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('invalid_input');
      const saveInput = saveInputFor(note, version.body, revision);
      if (filter.hidesAnyTag((saveInput.tags ?? []).map(({ tag }) => tag))) {
        throw writeRejected('not_found');
      }
      if (version.body === note.body) {
        const unchanged: EditNoteSaved = { id: input.id, outcome: 'saved', revision: revisionOf(note) };
        return { result: unchanged, wrote: false };
      }

      log.begin({
        operationId: input.operationId,
        fingerprint,
        noteId: input.id,
        targetBodySha256: sha256Hex(version.body),
        now
      });
      await store.noteVersionSnapshot(input.id);
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
   * Organización de notas (D2 ampliada, 28 sep 2026), en UN turno de la cola del
   * almacén, con el filtro de privados de quien pide construido sobre el almacén de ESTE
   * turno:
   * - La nota tiene que ser visible: oculta, en la papelera o inexistente es
   *   `not_found`, las tres igual.
   * - La carpeta de destino de `moveNote` también: una carpeta privada responde
   *   `not_found`, igual que una que no existe (decisión 4 de David: sin revelar que el
   *   destino es privado).
   * Favorita y archivar son idempotentes (fijan un estado). Una nota bloqueada se puede
   * organizar: nada de esto toca su cuerpo.
   *
   * Papelera (ampliación de D2, 30 sep 2026), también idempotentes:
   * - `trashNote`: una nota visible va a la papelera; una que ya está en la papelera y
   *   el filtro de la papelera deja ver (`TrashFilter`) se queda como está.
   * - `restoreNote`: una nota de la papelera visible para el filtro de la papelera sale
   *   de ella; una nota viva y visible se queda como está. El filtro de la papelera ya
   *   comprueba el DESTINO (su carpeta si sigue viva, si no la raíz): nunca deja la nota
   *   en una carpeta privada ni con una etiqueta privada.
   * Lo demás (oculta, inexistente, lápida), `not_found`, sin distinguir.
   */
  async organize(input: OrganizeInput): Promise<OrganizeSaved> {
    const result = await this.target.writeExclusive(async (store) => {
      const filter = privacyInTurn(store, input.privacy);

      const requireVisibleFolder = (id: string): void => {
        if (!filter.folderExists(id) || filter.isFolderHidden(id)) throw writeRejected('not_found');
      };
      const requireVisibleNote = async (id: string): Promise<void> => {
        const row = await store.noteRead(id);
        if (!row || row.trashedAt !== null || filter.isHiddenNote(id)) {
          throw writeRejected('not_found');
        }
      };
      /** La nota, viva y visible, o en la papelera y visible para el filtro de la
       *  papelera; si no, `not_found`. */
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
          case 'moveNote':
            await requireVisibleNote(input.id);
            requireVisibleFolder(input.folderId);
            return noteSaved(await store.noteMove(input.id, input.folderId));
          case 'setFavorite':
            await requireVisibleNote(input.id);
            return noteSaved(await store.noteSetFavorite(input.id, input.favorite));
          case 'setArchived':
            await requireVisibleNote(input.id);
            return noteSaved(
              input.archived ? await store.noteArchive(input.id) : await store.noteUnarchive(input.id)
            );
          case 'trashNote': {
            const row = await visibleLiveOrTrashed(input.id);
            return noteSaved(row.trashedAt === null ? await store.noteTrash(input.id) : row);
          }
          case 'restoreNote': {
            const row = await visibleLiveOrTrashed(input.id);
            return noteSaved(row.trashedAt === null ? row : await store.noteRestore(input.id));
          }
        }
      } catch (error) {
        throw organizeRejection(error);
      }
    });
    this.written();
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
