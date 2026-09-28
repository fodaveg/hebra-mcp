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
  ROOT_FOLDER_ID,
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
  /** Organización (D2 ampliada): los métodos del mismo nombre de `SqliteLibraryEngine`.
   *  De las carpetas solo hace falta el id (`FolderRow` no lo exporta `node.ts`). */
  noteMove(id: string, folderId: string): Promise<NoteRow>;
  noteSetFavorite(id: string, favorite: boolean): Promise<NoteRow>;
  noteArchive(id: string): Promise<NoteRow>;
  noteUnarchive(id: string): Promise<NoteRow>;
  folderCreate(parentId: string | null, name: string): Promise<{ id: string }>;
  folderRename(id: string, name: string): Promise<{ id: string }>;
  folderMove(id: string, parentId: string | null): Promise<{ id: string }>;
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
  /** Igual que `EditNoteInput.privacy`: la configuración de quien pide, aplicada dentro
   *  del turno de la escritura. */
  privacy?: PrivacyConfig;
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
  privacy?: PrivacyConfig;
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

/**
 * Organización (D2 ampliada, 28 sep 2026): mover una nota, favorita, archivar y
 * desarchivar, y crear, renombrar y mover carpetas. Todo por id; la raíz es
 * `ROOT_FOLDER_ID` (`"root"`, la que lista `hebra_list_folders` con ruta vacía). Sin
 * papelera, versiones ni adjuntos (otro lote) y sin nada irreversible.
 */
export type OrganizeAction =
  | { action: 'moveNote'; id: string; folderId: string }
  | { action: 'setFavorite'; id: string; favorite: boolean }
  | { action: 'setArchived'; id: string; archived: boolean }
  | { action: 'createFolder'; parentId: string; name: string }
  | { action: 'renameFolder'; id: string; name: string }
  | { action: 'moveFolder'; id: string; parentId: string };

export type OrganizeActionName = OrganizeAction['action'];

/** Igual que `EditNoteInput.privacy`: la configuración de quien pide. */
export type OrganizeInput = OrganizeAction & { privacy?: PrivacyConfig };

/** Lo que queda tras organizar: la nota (carpeta efectiva, favorita, archivada) o la
 *  carpeta. La ruta para enseñar la calcula la herramienta con SU filtro. */
export type OrganizeSaved =
  | { kind: 'note'; id: string; folderId: string; favorite: boolean; archived: boolean }
  | { kind: 'folder'; id: string };

/** Nombre de carpeta: el motor exige no vacío y sin `/` (`validName`); esto acota el
 *  tamaño (lo comprueban la herramienta y el socket). */
export const FOLDER_NAME_MAX_LENGTH = 255;

/** Los errores del motor de Hebra que la organización puede dar, a su código cerrado. */
function organizeRejection(error: unknown): unknown {
  if (!(error instanceof LibraryError)) return error;
  switch (error.code) {
    case 'note_not_found':
    case 'folder_not_found':
      return writeRejected('not_found');
    case 'folder_name_taken':
      return writeRejected('folder_name_taken');
    case 'folder_cycle':
      return writeRejected('folder_cycle');
    case 'invalid_name':
    case 'root_folder_immutable':
      return writeRejected('invalid_input');
    default:
      return error;
  }
}

function noteSaved(row: NoteRow): OrganizeSaved {
  return {
    kind: 'note',
    id: row.id,
    folderId: row.effectiveFolderId,
    favorite: row.favorite,
    archived: row.archivedAt !== null
  };
}

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

  /**
   * Crea una nota. Dentro del turno, con la configuración de privados de quien pide: la
   * carpeta tiene que existir y ser visible, y el cuerpo no puede llevar una etiqueta
   * privada (decisión 4 de David, 28 sep 2026: el MCP no le pone una etiqueta privada a
   * ninguna nota). Si no, `not_found` sin crear nada.
   */
  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    const result = await this.target.writeExclusive(async (store) => {
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
   * Organización (D2 ampliada, 28 sep 2026), en UN turno de la cola del almacén, con el
   * filtro de privados de quien pide construido sobre el almacén de ESTE turno:
   * - La nota o carpeta de origen tiene que ser visible: oculta, en la papelera o
   *   inexistente es `not_found`, las tres igual.
   * - El destino (carpeta a la que se mueve una nota, padre de una carpeta nueva o
   *   movida) también: una carpeta privada responde `not_found`, igual que una que no
   *   existe (decisión 4 de David: sin revelar que el destino es privado).
   * - Renombrar o mover una carpeta visible no puede cambiar QUÉ es privado: se simula
   *   el árbol resultante y, si oculta otras carpetas o una ruta de `privateFolders` deja
   *   de existir (había una carpeta privada dentro), `not_found` sin escribir.
   * - Un ciclo (mover una carpeta dentro de sí misma o de una descendiente) es
   *   `folder_cycle`; un nombre ya usado por una hermana, `folder_name_taken`; un nombre
   *   vacío o con `/`, o tocar la raíz, `invalid_input`. Las tres reglas son del motor.
   * Favorita y archivar son idempotentes (fijan un estado). Crear una carpeta no: un
   * reintento choca con `folder_name_taken`, nunca duplica.
   * Una nota bloqueada se puede organizar: nada de esto toca su cuerpo.
   */
  async organize(input: OrganizeInput): Promise<OrganizeSaved> {
    const result = await this.target.writeExclusive(async (store) => {
      const folders = store.foldersList();
      const notes = store.notesVisibilityIndex();
      const config = input.privacy ?? OPEN_PRIVACY;
      const filter = PrivacyFilter.fromSnapshot(folders, notes, config);
      if (filter.unresolved) throw writeRejected('privacy_config_unresolved');

      const requireVisibleFolder = (id: string): void => {
        if (!filter.folderExists(id) || filter.isFolderHidden(id)) throw writeRejected('not_found');
      };
      const requireVisibleNote = async (id: string): Promise<void> => {
        const row = await store.noteRead(id);
        if (!row || row.trashedAt !== null || filter.isHiddenNote(id)) {
          throw writeRejected('not_found');
        }
      };
      /** Mismo filtro sobre el árbol de carpetas tras el cambio: si no oculta lo mismo,
       *  la operación cambiaría qué es privado. */
      const requireSamePrivacyAfter = (
        change: (entry: FoldersList['folders'][number]) => FoldersList['folders'][number]
      ): void => {
        const simulated: FoldersList = {
          folders: folders.folders.map((entry) => (entry.id === targetId ? change(entry) : entry))
        };
        const after = PrivacyFilter.fromSnapshot(simulated, notes, config);
        if (!after.hidesSameFoldersAs(filter)) throw writeRejected('not_found');
      };
      const targetId = 'id' in input ? input.id : '';

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
          case 'createFolder': {
            requireVisibleFolder(input.parentId);
            const created = await store.folderCreate(input.parentId, input.name);
            return { kind: 'folder' as const, id: created.id };
          }
          case 'renameFolder': {
            if (input.id === ROOT_FOLDER_ID) throw writeRejected('invalid_input');
            requireVisibleFolder(input.id);
            requireSamePrivacyAfter((entry) => ({ ...entry, name: input.name.trim() }));
            const renamed = await store.folderRename(input.id, input.name);
            return { kind: 'folder' as const, id: renamed.id };
          }
          case 'moveFolder': {
            if (input.id === ROOT_FOLDER_ID) throw writeRejected('invalid_input');
            requireVisibleFolder(input.id);
            requireVisibleFolder(input.parentId);
            // Antes de simular: el árbol simulado con un ciclo no tendría ruta.
            const parents = new Map(folders.folders.map((entry) => [entry.id, entry.parentId]));
            for (let cursor: string | null = input.parentId; cursor !== null; ) {
              if (cursor === input.id) throw writeRejected('folder_cycle');
              cursor = parents.get(cursor) ?? null;
            }
            requireSamePrivacyAfter((entry) => ({
              ...entry,
              parentId: input.parentId,
              parentState: 'ok'
            }));
            const moved = await store.folderMove(input.id, input.parentId);
            return { kind: 'folder' as const, id: moved.id };
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
