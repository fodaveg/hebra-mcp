/**
 * El `LibraryMovePort` del motor de mover de jdex-manager (`move-into-id.ts`, D19 de SPEC.md
 * §3) sobre el almacén de UN turno del escritor, con el filtro de privados de quien pide
 * rehecho en cada llamada. Es el `LibraryPort` de `./jd-port.ts` más lo de mover. Por aquí, y
 * solo por aquí, el MCP mueve carpetas (decisión de David del 19 oct 2026): no hay un
 * `hebra_move_folder` genérico, y `hebra_move_note` y `hebra_move_file` no cambian.
 *
 * Contrato pactado con la sesión de jdex-manager:
 * - Los `move*` devuelven `{ok: false}` sin lanzar cuando lo que se mueve ya no está como se
 *   esperaba (`expected`, comparado dentro del turno) o el destino no existe o no se ve: al
 *   aplicar es `plan_stale` y al deshacer, `skipped` con `refused`.
 * - Los demás rechazos de Hebra SE LANZAN (el motor no captura excepciones): un nombre que no
 *   vale (`invalid_name`), una nota bloqueada que habría que renombrar (`note_locked`) y, si el
 *   destino de una nota o un fichero no se puede usar por la privacidad (un nombre o unos bytes
 *   que dejarían oculto lo movido), UN error genérico, `destination_unavailable`, que no dice
 *   que hay algo oculto. Una CARPETA solo se rechaza por la configuración, con la regla y el
 *   error de `hebra_rename_folder` (`planRenameFolder`, D9; revisión de seguridad del 19 oct
 *   2026): una ruta privada configurada por debajo de la suya, su ruta nueva o la de una
 *   descendiente en una ruta privada, o un homónimo oculto en el destino, `folder_unavailable`.
 * - Renombrar y mover a la vez: una carpeta, si el nombre viejo está libre en el destino,
 *   primero se mueve y luego se renombra; si no, al revés (`folderMoveIfUnchanged` y
 *   `folderRenameIfUnchanged` del motor, con su guarda). Una nota se mueve con la guarda de
 *   revisión y carpeta de `noteMoveIfUnchanged` y se renombra editando su `title:`
 *   (`bodyWithFrontmatterTitle`); un fichero, sin guarda en el motor, se comprueba aquí.
 * - `hiddenInside(carpeta)` NO mira el contenido del almacén (revisión de seguridad del 19 oct
 *   2026: con él, simular era un oráculo de qué carpeta visible tiene algo oculto, y
 *   distinguía homónimas, deshaciendo M4). Responde la regla de configuración de
 *   `configRejects`: la misma para cualquier carpeta con la misma ruta, tenga lo que tenga
 *   dentro. Lo oculto que no depende de la ruta (notas por etiqueta privada, bloqueadas,
 *   ficheros ocultos por la regla (b) de D10, carpetas de la memoria de A3) viaja con la
 *   carpeta y sigue oculto, como al renombrarla con `hebra_rename_folder`; lo que depende de la
 *   ruta (una carpeta resuelta por una ruta configurada, y las notas y ficheros de A2 y de la
 *   papelera que se juzgan subiendo por las lápidas hasta una carpeta de dentro) siempre
 *   necesita una ruta privada configurada por debajo de la de la carpeta, y eso la rechaza.
 * Las comprobaciones de privacidad se hacen igual en la simulación (`preflight`), para no
 * dejar carpetas creadas antes de un rechazo, y otra vez al mover.
 */
import { bodyWithFrontmatterTitle, deriveNote, LibraryError, ROOT_FOLDER_ID } from '../hebra';
import type { EnsureResult, LibraryMovePort, MoveParent, MovePlan, PlanWrite } from '../jd';
import type { PrivacyConfig } from '../privacy/config';
import { FileFilter } from '../privacy/file-filter';
import type { PrivacyFilter } from '../privacy/filter';
import { StoreError, writeRejected } from './errors';
import { nameExtension, validFileName } from './file-content';
import { folderNameKey, planCreateFolder, validFolderName } from './folders';
import { JdLibraryPort } from './jd-port';
import { jdRejected, turnView, turnWrites } from './jd-new-id';
import { LOCKED_BODY_PREFIX, privacyInTurn, saveInputFor, type NoteWriteStore } from './writes';

const NOT_OK = { ok: false } as const;
const OK = { ok: true } as const;

/** El segmento de ruta de un nombre, como lo compara la configuración de privados. */
function pathSegment(name: string): string {
  return name.trim().toLowerCase();
}

function visibleFolder(live: PrivacyFilter, id: string): boolean {
  return live.folderExists(id) && !live.isFolderHidden(id);
}

function unavailable(): StoreError {
  return writeRejected('destination_unavailable');
}

/** El rechazo de mover una carpeta por la privacidad: el de `hebra_rename_folder` (D9). */
function folderUnavailable(): StoreError {
  return writeRejected('folder_unavailable');
}

/**
 * ¿No se puede mover la carpeta `id` desde aquí? Solo por la CONFIGURACIÓN, como
 * `planRenameFolder`: no se ve, o hay una ruta privada configurada por debajo de la suya (o es
 * la suya). Nunca mira lo que tiene dentro: dos carpetas con la misma ruta responden igual.
 */
export function configRejects(live: PrivacyFilter, id: string): boolean {
  if (id === ROOT_FOLDER_ID || !visibleFolder(live, id)) return true;
  const segments = live.folderSegments(id);
  return live.isPrivateFolderPath(segments) || live.isPrivatePathPrefix(segments);
}

/** Lo que mover una carpeta puede dar del motor de Hebra: lo que ya no está o un nombre
 *  ocupado, `{ok: false}`; un nombre que no vale, `invalid_name`. */
function folderFailure(error: unknown): { ok: false } {
  if (error instanceof LibraryError) {
    switch (error.code) {
      case 'invalid_name':
        throw jdRejected('invalid_name');
      // Un nombre ocupado (lo visible ya lo miró el motor JD: un homónimo que llegó entre medias,
      // o uno oculto) cuenta como «ya no está como se esperaba».
      case 'folder_name_taken':
      case 'folder_not_found':
      case 'folder_cycle':
      case 'root_folder_immutable':
        return NOT_OK;
    }
  }
  throw error;
}

export class JdMovePort extends JdLibraryPort implements LibraryMovePort {
  /** Escrituras de mover y renombrar hechas (para pedir la ronda aunque el turno se corte). */
  moves = 0;

  constructor(
    private readonly store: NoteWriteStore,
    private readonly privacy: PrivacyConfig,
    options: { jdexFolderId?: string } = {}
  ) {
    super(turnView(store, privacy), turnWrites(store), options);
  }

  private live(): PrivacyFilter {
    return privacyInTurn(this.store, this.privacy);
  }

  private filesFilter(live: PrivacyFilter): FileFilter {
    return FileFilter.fromSnapshot(live, this.store.filesIndex(), this.privacy);
  }

  /** La subcarpeta y la carpeta de un ID que crea el plan, como `hebra_create_folder`: un
   *  homónimo oculto o una ruta privada son su `folder_unavailable` (D9), y un nombre que no
   *  vale, `invalid_name`. */
  override async ensureFolder(parentId: string | null, name: string): Promise<EnsureResult> {
    try {
      return await super.ensureFolder(parentId, name);
    } catch (error) {
      if (error instanceof StoreError && error.code === 'invalid_input') throw jdRejected('invalid_name');
      throw error;
    }
  }

  async listFiles(folderId: string): Promise<{ id: string; name: string }[]> {
    const live = this.live();
    if (!visibleFolder(live, folderId)) return [];
    return this.filesFilter(live)
      .visibleFiles()
      .filter((file) => file.trashedAt === null && file.folderId === folderId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((file) => ({ id: file.id, name: file.name }));
  }

  /** La regla de configuración (`configRejects`), nunca el contenido: la simulación ya rechaza
   *  con `folder_unavailable` antes de llegar al motor, así que aquí solo es verdadero si la
   *  configuración cambió entre simular y aplicar (`plan_stale`). */
  async hiddenInside(folderId: string): Promise<boolean> {
    return configRejects(this.live(), folderId);
  }

  async moveNote(
    id: string,
    expected: { folderId: string; title: string },
    to: { folderId: string; title?: string }
  ): Promise<{ ok: boolean }> {
    const live = this.live();
    const meta = live.visibleMeta(id);
    if (!meta || meta.folderId !== expected.folderId || !visibleFolder(live, to.folderId)) return NOT_OK;
    const row = await this.store.noteRead(id);
    if (!row || row.trashedAt !== null || row.title.normalize('NFC') !== expected.title.normalize('NFC')) return NOT_OK;
    // El cuerpo renombrado se decide ANTES de mover: un rechazo no deja la nota a medias.
    const renamed = to.title !== undefined && to.title.normalize('NFC') !== expected.title.normalize('NFC')
      ? renamedNoteBody(live, row.body, to.title)
      : null;
    let current = row;
    if (to.folderId !== meta.folderId) {
      // Una nota cuya carpeta guardada no es la efectiva (una lápida) no se toca.
      if (row.folderId !== meta.folderId) return NOT_OK;
      const moved = await this.store.noteMoveIfUnchanged(id, to.folderId, {
        folderId: row.folderId,
        revision: { localSeq: row.localSeq, bodySha256: row.bodySha256 }
      });
      if (!moved) return NOT_OK;
      this.moves += 1;
      current = moved;
    }
    if (renamed !== null) {
      const saved = await this.store.noteSave(saveInputFor(current, renamed.body, current, renamed.derived));
      this.moves += 1;
      if (saved.outcome !== 'saved') return NOT_OK;
    }
    return OK;
  }

  async moveFile(
    id: string,
    expected: { folderId: string; name: string },
    to: { folderId: string; name?: string }
  ): Promise<{ ok: boolean }> {
    const live = this.live();
    const files = this.filesFilter(live);
    const content = files.contentOf(id);
    if (
      !content ||
      content.file.trashedAt !== null ||
      content.file.folderId !== expected.folderId ||
      content.file.name.normalize('NFC') !== expected.name.normalize('NFC') ||
      !visibleFolder(live, to.folderId)
    ) {
      return NOT_OK;
    }
    const name = to.name === undefined ? content.file.name : checkFileName(content.file.name, to.name);
    // Un homónimo VISIBLE en el destino ya lo mira el motor JD; si aparece ahora, ya no es lo
    // planeado. Uno oculto no cuenta (como en D17).
    const key = name.normalize('NFC').toLowerCase();
    if (
      files
        .visibleFiles()
        .some((file) => file.id !== id && file.trashedAt === null && file.folderId === to.folderId && file.name.normalize('NFC').toLowerCase() === key)
    ) {
      return NOT_OK;
    }
    if (wouldHideFile(this.store, files, name, content.sha256)) throw unavailable();
    try {
      if (to.folderId !== content.file.folderId) {
        await this.store.fileMove(id, to.folderId);
        this.moves += 1;
      }
      if (name !== content.file.name) {
        await this.store.fileRename(id, name);
        this.moves += 1;
      }
    } catch (error) {
      if (error instanceof LibraryError && (error.code === 'file_not_found' || error.code === 'folder_not_found')) return NOT_OK;
      if (error instanceof LibraryError && error.code === 'invalid_name') throw jdRejected('invalid_name');
      throw error;
    }
    return OK;
  }

  async moveFolder(
    id: string,
    expected: { parentId: string; name: string },
    to: { parentId: string; name?: string }
  ): Promise<{ ok: boolean }> {
    const live = this.live();
    if (id === ROOT_FOLDER_ID || !visibleFolder(live, id) || to.parentId === ROOT_FOLDER_ID) return NOT_OK;
    const entry = this.store.foldersList().folders.find((folder) => folder.id === id);
    const parent = live.folderParent(id) ?? ROOT_FOLDER_ID;
    const currentName = live.folderName(id) ?? '';
    if (
      !entry ||
      entry.parentState !== 'ok' ||
      parent === ROOT_FOLDER_ID ||
      parent !== expected.parentId ||
      currentName.normalize('NFC') !== expected.name.normalize('NFC') ||
      !visibleFolder(live, to.parentId)
    ) {
      return NOT_OK;
    }
    const newName = to.name === undefined ? currentName : checkFolderName(to.name);
    // Solo la configuración, como `planRenameFolder` (nunca lo que haya dentro), y un homónimo
    // en el destino: no se mueve (`plan_stale` al aplicar, `refused` al deshacer). La
    // simulación ya respondió `folder_unavailable` con esto mismo (`preflight`).
    if (configRejects(live, id) || folderTargetRejects(live, id, live.folderSegments(to.parentId), newName)) {
      return NOT_OK;
    }
    const homonyms = live
      .folderChildren(to.parentId)
      .filter((child) => child.id !== id && folderNameKey(child.name) === folderNameKey(newName));
    if (homonyms.length > 0) return NOT_OK;
    const moving = to.parentId !== parent;
    const renaming = newName !== currentName;
    const oldNameFree = !live
      .folderChildren(to.parentId)
      .some((child) => child.id !== id && folderNameKey(child.name) === folderNameKey(currentName));
    const move = async (name: string): Promise<boolean> => {
      const row = await this.store.folderMoveIfUnchanged(id, to.parentId, { name, parentId: parent });
      if (row) this.moves += 1;
      return row !== null;
    };
    const rename = async (parentId: string): Promise<boolean> => {
      const row = await this.store.folderRenameIfUnchanged(id, newName, { name: currentName, parentId });
      if (row) this.moves += 1;
      return row !== null;
    };
    try {
      if (moving && (!renaming || oldNameFree)) {
        if (!(await move(currentName))) return NOT_OK;
        if (renaming && !(await rename(to.parentId))) return NOT_OK;
      } else {
        if (renaming && !(await rename(parent))) return NOT_OK;
        if (moving && !(await move(newName))) return NOT_OK;
      }
    } catch (error) {
      return folderFailure(error);
    }
    return OK;
  }

  /**
   * Lo que Hebra rechazaría al aplicar, mirado en la simulación con el filtro del turno y sin
   * escribir nada: las carpetas que crea el plan (`planCreateFolder`) y, de cada pieza, el
   * nombre y la privacidad del destino (ruta privada, homónimo oculto, que quede oculta).
   */
  async preflight(plan: MovePlan): Promise<void> {
    const live = this.live();
    const segmentsOf = writeSegments(live, plan.writes);
    for (const [position, write] of plan.writes.entries()) {
      if (write.kind !== 'ensure_folder') continue;
      if ('folderId' in write.parent) {
        const planned = planCreateFolder(live, write.parent.folderId, write.name);
        if (planned.kind === 'reject') {
          throw planned.code === 'invalid_input' ? jdRejected('invalid_name') : writeRejected(planned.code);
        }
      } else if (validFolderName(write.name) === null) {
        throw jdRejected('invalid_name');
      } else if (live.isPrivateFolderPath(segmentsOf(position))) {
        throw folderUnavailable();
      }
    }
    const files = this.filesFilter(live);
    for (const move of plan.moves) {
      const parentSegments = parentSegmentsOf(live, move.to.parentId, segmentsOf);
      const renamed = move.to.name !== move.from.name;
      if (move.kind === 'folder') {
        // La regla de `planRenameFolder` y su error (D9): por la configuración, o un homónimo
        // oculto en el destino.
        const name = renamed ? checkFolderName(move.to.name) : move.to.name;
        if (configRejects(live, move.id) || folderTargetRejects(live, move.id, parentSegments, name)) {
          throw folderUnavailable();
        }
        if (typeof move.to.parentId === 'string') {
          const hidden = live
            .folderChildren(move.to.parentId)
            .some((child) => child.id !== move.id && child.hidden && folderNameKey(child.name) === folderNameKey(name));
          if (hidden) throw folderUnavailable();
        }
      } else if (move.kind === 'file') {
        const content = files.contentOf(move.id);
        if (!content) continue; // el motor ya lo comprobó; si cambió, plan_stale al aplicar.
        const name = renamed ? checkFileName(content.file.name, move.to.name) : content.file.name;
        if (wouldHideFile(this.store, files, name, content.sha256)) throw unavailable();
      } else if (renamed) {
        const row = await this.store.noteRead(move.id);
        if (row) renamedNoteBody(live, row.body, move.to.name);
      }
    }
  }
}

/** El cuerpo de una nota con el título nuevo (y sus derivados), o el rechazo: bloqueada,
 *  `note_locked`; un título que Hebra no deriva así, `invalid_name`; con una etiqueta
 *  privada, el error genérico (decisión 4 de D2, sin decir por qué). */
function renamedNoteBody(live: PrivacyFilter, body: string, title: string) {
  if (body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('note_locked');
  const next = bodyWithFrontmatterTitle(body, title);
  if (next === null) throw jdRejected('invalid_name');
  const derived = deriveNote(next);
  if (live.hidesAnyTag((derived.tags ?? []).map(({ tag }) => tag))) throw unavailable();
  return { body: next, derived };
}

/** El nombre nuevo de un fichero: válido y con la misma extensión (como D17); si no,
 *  `invalid_name`. */
function checkFileName(current: string, raw: string): string {
  const name = validFileName(raw);
  if (name === null || nameExtension(name) !== nameExtension(current)) throw jdRejected('invalid_name');
  return name;
}

function checkFolderName(raw: string): string {
  const name = validFolderName(raw);
  if (name === null) throw jdRejected('invalid_name');
  return name;
}

/**
 * ¿Cae la carpeta `id` en una ruta privada al quedar en `parentSegments` + `name`? Desde la
 * configuración, con la misma regla que `planRenameFolder` (D9): su ruta nueva privada, o la de
 * una descendiente.
 */
function folderTargetRejects(live: PrivacyFilter, id: string, parentSegments: readonly string[], name: string): boolean {
  const target = [...parentSegments, pathSegment(name)];
  if (live.isPrivateFolderPath(target)) return true;
  const depth = live.folderSegments(id).length;
  for (const below of live.folderSubtree(id)) {
    if (below === id) continue;
    if (live.isPrivateFolderPath([...target, ...live.folderSegments(below).slice(depth)])) return true;
  }
  return false;
}

/** ¿Quedaría oculto un fichero con ese nombre y esos bytes? (regla (b) de D10 y la variante
 *  de las bloqueadas de D16, como `./file-verbs.ts`). */
function wouldHideFile(store: NoteWriteStore, files: FileFilter, name: string, sha256: string): boolean {
  return files.wouldHide(name, [...store.notesLinkingFileName(name), ...store.notesLinkingBlob(sha256)]);
}

/** Los segmentos de ruta de cada carpeta que crea el plan (las que cuelgan de otra que crea
 *  también, encadenadas). */
function writeSegments(live: PrivacyFilter, writes: readonly PlanWrite[]): (position: number) => string[] {
  const cache = new Map<number, string[]>();
  const of = (position: number): string[] => {
    const known = cache.get(position);
    if (known) return known;
    const write = writes[position];
    if (!write || write.kind !== 'ensure_folder') return [];
    const parent = 'folderId' in write.parent ? live.folderSegments(write.parent.folderId) : of(write.parent.write);
    const segments = [...parent, pathSegment(write.name)];
    cache.set(position, segments);
    return segments;
  };
  return of;
}

function parentSegmentsOf(live: PrivacyFilter, parent: MoveParent, segmentsOf: (position: number) => string[]): string[] {
  return typeof parent === 'string' ? live.folderSegments(parent) : segmentsOf(parent.write);
}
