/**
 * El `LibraryPort` del motor JD de jdex-manager (`../jd.ts`, D18 de SPEC.md §3) sobre la
 * biblioteca de Hebra, con el filtro de privados de QUIEN PIDE. El motor habla en ids y
 * reconstruye las rutas por la cadena de `parentId`; aquí se le da solo lo visible y, para
 * escribir, las mismas puertas que el resto de hebra-mcp.
 *
 * Se construye por turno (`JdView`): en el escritor, sobre el almacén de ESE turno de la
 * cola (`./jd-new-id.ts`), con el filtro recalculado en cada llamada (`privacyInTurn`), de
 * modo que un `ensureFolder` ve la carpeta que acaba de crear el anterior; en un lector, sobre
 * el puerto de la llamada y su filtro (`hebra_jd_audit`, que no escribe).
 *
 * Reglas del contrato cerrado con la sesión de jdex-manager:
 * - `parentId: null` del motor es `ROOT_FOLDER_ID` de Hebra, en los dos sentidos.
 * - `listFolders`: solo las carpetas visibles. `listNotes`: las notas visibles, fuera de la
 *   papelera, de esa carpeta. `readNote`: el cuerpo de una visible, o `{body: null}` para
 *   una que no lo es (el motor la salta como plantilla).
 * - `ensureFolder`: el plan de `./folders.ts` (`planCreateFolder`), rehecho con el filtro de
 *   ahora: una hermana visible con ese nombre se devuelve con `created: false`; un rechazo
 *   (`folder_unavailable`, `not_found`, `invalid_input`) se LANZA, sin escribir.
 * - `ensureNote`: una nota visible de esa carpeta con ese título exacto (NFC) se devuelve con
 *   `created: false`; si no, se crea como `hebra_create_note` (`noteCreate` + `noteSave` en
 *   el mismo turno), con el cuerpo pasado por `bodyWithFrontmatterTitle` del motor de Hebra
 *   para que derive exactamente ese título (si no puede, el cuerpo tal cual). Un cuerpo con
 *   una etiqueta privada se rechaza con `not_found` y uno con el prefijo de nota bloqueada,
 *   con `invalid_input`, como `createNote` (decisión 4 de D2).
 * - `hasHidden(categoría)`: sobre los datos SIN filtrar y con el filtro de quien pide (ver su
 *   comentario). Es lo único que el motor sabe de lo oculto: un booleano.
 * El motor no captura las excepciones de `applyPlan` (contrato con jdex-manager): llegan tal
 * cual a quien lo llama, que las traduce a los errores de la herramienta.
 */
import {
  bodyWithFrontmatterTitle,
  deriveNote,
  ROOT_FOLDER_ID,
  type FoldersList,
  type NoteRow,
  type NoteSaveInput,
  type NoteSaveResult
} from '../hebra';
import {
  detectFolders,
  extractJdPrefix,
  type EnsureResult,
  type LibraryPort,
  type PortFolder,
  type PortNote
} from '../jd';
import type { PrivacyFilter } from '../privacy/filter';
import { writeRejected } from './errors';
import { planCreateFolder } from './folders';
import type { NoteVisibilityEntry } from './types';
import { folderRejection, LOCKED_BODY_PREFIX, saveInputFor, type FolderRow } from './writes';

/** Lo que el puerto lee: el árbol y el índice de visibilidad SIN filtrar, las filas de las
 *  notas y el filtro de privados de quien pide sobre ese mismo estado. */
export interface JdView {
  folders(): FoldersList | Promise<FoldersList>;
  notes(): readonly NoteVisibilityEntry[] | Promise<readonly NoteVisibilityEntry[]>;
  noteRead(id: string): Promise<NoteRow | null>;
  filter(): PrivacyFilter | Promise<PrivacyFilter>;
}

/** Lo que el puerto escribe, solo dentro de un turno del escritor. */
export interface JdWrites {
  noteCreate(folderId: string): Promise<NoteRow>;
  noteSave(input: NoteSaveInput): Promise<NoteSaveResult>;
  folderCreate(parentId: string, name: string): Promise<FolderRow>;
}

/** Lo que el motor ve como padre de una carpeta: `null` es la raíz de Hebra. */
function portParent(parentId: string | null): string | null {
  return parentId === null || parentId === ROOT_FOLDER_ID ? null : parentId;
}

/** Ruta de cada carpeta por nombres (como la reconstruye el motor), sin la raíz. */
function namePaths(list: FoldersList): Map<string, string> {
  const byId = new Map(list.folders.map((folder) => [folder.id, folder]));
  const paths = new Map<string, string>();
  const visiting = new Set<string>();
  const pathOf = (id: string): string => {
    const known = paths.get(id);
    if (known !== undefined) return known;
    const folder = byId.get(id);
    if (!folder || id === ROOT_FOLDER_ID || visiting.has(id)) return '';
    visiting.add(id);
    const parent = folder.parentId === null ? '' : pathOf(folder.parentId);
    visiting.delete(id);
    const name = folder.name.normalize('NFC');
    const path = parent ? `${parent}/${name}` : name;
    paths.set(id, path);
    return path;
  };
  for (const folder of list.folders) pathOf(folder.id);
  return paths;
}

/** La categoría (`"21"`) del prefijo JD de un nombre de carpeta o un título, o `null`. */
function categoryOfName(name: string): string | null {
  const prefix = extractJdPrefix(name);
  if (!prefix) return null;
  const number = prefix.number;
  return number.kind === 'id' || number.kind === 'category' ? number.category : null;
}

export interface JdPortOptions {
  /** La carpeta del JDex que se usa (la que resolvió el motor o la del plan): una nota oculta
   *  suya cuenta en `hasHidden`, y si ella misma no se ve, todo está oculto. */
  jdexFolderId?: string;
}

/**
 * `LibraryPort` sobre `view`. Con `writes`, escribe (solo en un turno del escritor); sin
 * ellas, `ensureFolder` y `ensureNote` lanzan `invalid_input` sin tocar nada. `created`
 * cuenta lo que creó, para pedir la ronda de sync aunque `applyPlan` se corte a mitad.
 */
export class JdLibraryPort implements LibraryPort {
  /** Lo que creó este puerto (notas y carpetas), en orden. */
  readonly created: Array<{ kind: 'folder' | 'note'; id: string }> = [];
  private jdexFolderId: string | undefined;

  constructor(
    private readonly view: JdView,
    private readonly writes: JdWrites | null,
    options: JdPortOptions = {}
  ) {
    this.jdexFolderId = options.jdexFolderId;
  }

  /** Fija la carpeta del JDex cuando la resuelve el motor (`resolveSettings`). */
  useJdexFolder(id: string): void {
    this.jdexFolderId = id;
  }

  async listFolders(): Promise<PortFolder[]> {
    const [list, filter] = await Promise.all([this.view.folders(), this.view.filter()]);
    return list.folders
      .filter((folder) => folder.id !== ROOT_FOLDER_ID && !filter.isFolderHidden(folder.id))
      .map((folder) => ({ id: folder.id, parentId: portParent(folder.parentId), name: folder.name }));
  }

  /** Las notas visibles y vivas de la carpeta, con su título, por id. */
  async listNotes(folderId: string): Promise<PortNote[]> {
    const filter = await this.view.filter();
    const wanted = folderId;
    if (wanted !== ROOT_FOLDER_ID && (!filter.folderExists(wanted) || filter.isFolderHidden(wanted))) return [];
    const ids = [...filter.visibleNotes()]
      .filter(([, meta]) => meta.folderId === wanted)
      .map(([id]) => id)
      .sort();
    const notes: PortNote[] = [];
    for (const id of ids) {
      const row = await this.view.noteRead(id);
      if (!row || row.trashedAt !== null) continue;
      notes.push({ id, title: row.title });
    }
    return notes;
  }

  async readNote(id: string): Promise<{ body: string | null }> {
    const filter = await this.view.filter();
    if (!filter.visibleMeta(id)) return { body: null };
    const row = await this.view.noteRead(id);
    if (!row || row.trashedAt !== null || row.body.startsWith(LOCKED_BODY_PREFIX)) return { body: null };
    return { body: row.body };
  }

  async ensureFolder(parentId: string | null, name: string): Promise<EnsureResult> {
    if (!this.writes) throw writeRejected('invalid_input');
    const plan = planCreateFolder(await this.view.filter(), parentId ?? ROOT_FOLDER_ID, name);
    switch (plan.kind) {
      case 'reject':
        throw writeRejected(plan.code);
      case 'existing':
        return { id: plan.id, created: false };
      case 'create': {
        let row: FolderRow;
        try {
          row = await this.writes.folderCreate(plan.parentId, plan.name);
        } catch (error) {
          throw folderRejection(error);
        }
        this.created.push({ kind: 'folder', id: row.id });
        return { id: row.id, created: true };
      }
    }
  }

  async ensureNote(folderId: string, title: string, body: string): Promise<EnsureResult> {
    if (!this.writes) throw writeRejected('invalid_input');
    // Antes de `noteCreate`, como `createNote`: el MCP nunca crea notas bloqueadas.
    if (body.startsWith(LOCKED_BODY_PREFIX)) throw writeRejected('invalid_input');
    const filter = await this.view.filter();
    if (!filter.folderExists(folderId) || filter.isFolderHidden(folderId)) throw writeRejected('not_found');
    const wanted = title.normalize('NFC');
    for (const note of await this.listNotes(folderId)) {
      if (note.title.normalize('NFC') === wanted) return { id: note.id, created: false };
    }
    const text = bodyWithFrontmatterTitle(body, title) ?? body;
    const derived = deriveNote(text);
    if (filter.hidesAnyTag((derived.tags ?? []).map(({ tag }) => tag))) throw writeRejected('not_found');
    const note = await this.writes.noteCreate(folderId);
    this.created.push({ kind: 'note', id: note.id });
    const saved = await this.writes.noteSave(saveInputFor(note, text, note, derived));
    // Recién creada, nadie más la conoce: `redirected` sería un fallo del motor, no un
    // conflicto. Se devuelve igual el id donde quedó el texto.
    const id = saved.outcome === 'saved' ? note.id : saved.redirectedTo;
    if (id !== note.id) this.created.push({ kind: 'note', id });
    return { id, created: true };
  }

  /**
   * ¿Tiene la categoría algo que quien pide no ve? Sobre el árbol y las notas SIN filtrar,
   * con el filtro de quien pide («oculto» es lo que ese filtro esconde). Verdadero si:
   * (a) hay una carpeta oculta en el árbol de una carpeta de esa categoría;
   * (b) hay una carpeta oculta, en cualquier parte, cuyo prefijo JD es de esa categoría (un
   *     ID `21.xx` o la propia categoría `21`, de cualquier sistema: cerrado ante la duda);
   * (c) hay una nota oculta en la carpeta del JDex cuyo título tiene un prefijo de esa
   *     categoría;
   * (d) la carpeta del JDex (la que usa este puerto, o la `00.00` que se detecta sobre el árbol
   *     entero) está oculta: entonces lo es para todas las categorías.
   * Nunca dice qué ni cuántos: el motor solo recibe el booleano.
   */
  async hasHidden(category: string): Promise<boolean> {
    const [list, filter] = await Promise.all([this.view.folders(), this.view.filter()]);
    const hidden = (id: string): boolean => !filter.folderExists(id) || filter.isFolderHidden(id);
    const paths = namePaths(list);
    const pathToId = new Map<string, string>();
    for (const [id, path] of [...paths].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (!pathToId.has(path)) pathToId.set(path, id);
    }
    const jdexIds = new Set<string>();
    const detected = detectFolders([...paths.values()]).jdex;
    if (detected !== null) {
      const id = pathToId.get(detected);
      if (id !== undefined) jdexIds.add(id);
    }
    if (this.jdexFolderId !== undefined) jdexIds.add(this.jdexFolderId);
    // (d)
    for (const id of jdexIds) if (hidden(id)) return true;
    for (const folder of list.folders) {
      if (folder.id === ROOT_FOLDER_ID) continue;
      const own = categoryOfName(folder.name) === category;
      // (b)
      if (own && filter.isFolderHidden(folder.id)) return true;
      // (a): solo las carpetas de la categoría, no las de sus IDs (su árbol ya está dentro).
      const prefix = extractJdPrefix(folder.name);
      if (own && prefix?.number.kind === 'category') {
        if (filter.folderSubtree(folder.id).some((id) => filter.isFolderHidden(id))) return true;
      }
    }
    // (c)
    for (const entry of await this.view.notes()) {
      if (!jdexIds.has(entry.folderId) || !filter.isHiddenNote(entry.id)) continue;
      const row = await this.view.noteRead(entry.id);
      if (row && categoryOfName(row.title) === category) return true;
    }
    return false;
  }
}
