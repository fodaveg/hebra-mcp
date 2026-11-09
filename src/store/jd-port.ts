/**
 * El `LibraryPort` del motor JD de jdex-manager (`../jd.ts`, D18 de SPEC.md §3) sobre la
 * biblioteca de Hebra, con el filtro de privados de QUIEN PIDE. El motor habla en ids y
 * reconstruye las rutas por la cadena de `parentId`; aquí se le da solo lo visible y, para
 * escribir, las mismas puertas que el resto de hebra-mcp.
 *
 * Se construye por turno (`JdView`): en el escritor, sobre el almacén de ESE turno de la
 * cola (`./jd-new-id.ts`), con el filtro recalculado en cada llamada (`privacyInTurnFor`), de
 * modo que un `ensureFolder` ve la carpeta que acaba de crear el anterior; en un lector, sobre
 * el puerto de la llamada y su filtro (`hebra_jd_audit`, que no escribe).
 *
 * Ninguna pregunta carga la biblioteca entera (pieza A9a del plan de memoria, 6 nov 2026):
 * `JdView.filter(ids)` da un filtro que conoce las carpetas, la configuración y SOLO las notas de
 * `ids`, y cada método pide las que decide (las candidatas de una carpeta, la nota que lee, las
 * de `hasHidden`). Antes, cada llamada del escritor leía la visibilidad de todas las notas vivas
 * y `hasHidden` las recorría en JS: a 30 000 notas, simular un ID nuevo asignaba 366 MiB.
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
  extractJdPrefix,
  type EnsureResult,
  type LibraryPort,
  type PortFolder,
  type PortNote
} from '../jd';
import type { FileFilter } from '../privacy/file-filter';
import type { PrivacyFilter } from '../privacy/filter';
import { writeRejected } from './errors';
import { planCreateFolder } from './folders';
import type { FilesIndex } from './types';
import type { FolderNoteTitle } from './visible-sql';
import { folderRejection, LOCKED_BODY_PREFIX, saveInputFor, type FolderRow } from './writes';

/** Lo que el puerto lee: el árbol SIN filtrar, las notas candidatas de unas carpetas (sin
 *  filtrar ni leer el cuerpo), las filas de las notas y el filtro de privados de quien pide
 *  sobre ese mismo estado. */
export interface JdView {
  folders(): FoldersList | Promise<FoldersList>;
  noteRead(id: string): Promise<NoteRow | null>;
  /** Las notas vivas (ni papelera ni lápida) de una carpeta EFECTIVA, con su título y SIN
   *  filtrar ni leer el cuerpo (`titlesInFolderRows` de `./visible-sql.ts`): las candidatas de
   *  `listNotes`. */
  folderNotes(folderId: string): readonly FolderNoteTitle[] | Promise<readonly FolderNoteTitle[]>;
  /**
   * El filtro de privados de quien pide: las carpetas y la configuración siempre, y de las notas
   * al menos las de `ids` (sin `ids`, ninguna). Una nota que no está en `ids` puede ser
   * desconocida para él, y desconocida es OCULTA: cada método pasa todas las que va a juzgar. En
   * el escritor, `privacyInTurnFor` (rehecho en cada llamada); en un lector, `ensure(ids)` del
   * filtro de la llamada.
   */
  filter(ids?: readonly string[]): PrivacyFilter | Promise<PrivacyFilter>;
  /** Las notas vivas cuya carpeta EFECTIVA es una de `folderIds`, con su título y SIN filtrar ni
   *  leer el cuerpo (`titlesInFoldersRows` de `./visible-sql.ts`): las candidatas de `hasHidden`
   *  (el tiempo de respuesta no puede depender del tamaño de lo oculto). Sin él, `hasHidden`
   *  responde `true` (cerrado ante la duda). */
  notesInFolders?(folderIds: readonly string[]): readonly FolderNoteTitle[] | Promise<readonly FolderNoteTitle[]>;
  /** Los ficheros sueltos sin filtrar y su filtro, para `hasHidden`. Sin él, `true`. */
  files?(): { index: FilesIndex; filter: FileFilter } | Promise<{ index: FilesIndex; filter: FileFilter }>;
}

/**
 * ¿Es `id` una carpeta que se puede usar como JDex indicada por el agente (`jdexFolderId`)?
 * Visible para quien pide y con el prefijo JD `00.00` de algún sistema en su nombre. Si no,
 * quien llama responde `jdex_not_found`, lo mismo que sin JDex: una carpeta cualquiera como
 * JDex convertía la regla (c) de `hasHidden` en un oráculo de las notas ocultas de ESA carpeta.
 */
export function isJdexFolderCandidate(filter: PrivacyFilter, id: string): boolean {
  if (id === ROOT_FOLDER_ID || !filter.folderExists(id) || filter.isFolderHidden(id)) return false;
  const prefix = extractJdPrefix(filter.folderName(id) ?? '');
  return prefix?.number.kind === 'id' && prefix.number.id === '00.00' && !prefix.number.extension;
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
      // Visible y conocida por el filtro, como en `listNotes` y `ensureNote`.
      .filter(
        (folder) => folder.id !== ROOT_FOLDER_ID && filter.folderExists(folder.id) && !filter.isFolderHidden(folder.id)
      )
      .map((folder) => ({ id: folder.id, parentId: portParent(folder.parentId), name: folder.name }));
  }

  /**
   * Las notas visibles y vivas de la carpeta, con su título, por id. Las candidatas son las notas
   * vivas de esa carpeta, con su título y sin el cuerpo (`JdView.folderNotes`, una consulta), y
   * cada una la juzga el filtro de quien pide, que además tiene que verla en esa misma carpeta.
   * Coste O(notas de la carpeta) (pieza A7 del plan de memoria, 6 nov 2026): antes copiaba todas
   * las visibles de la biblioteca (`visibleNotes()`) y leía la fila entera, con el cuerpo, de cada
   * nota de la carpeta. El filtro que las juzga conoce solo esas notas (A9a).
   */
  async listNotes(folderId: string): Promise<PortNote[]> {
    const folders = await this.view.filter();
    const wanted = folderId;
    if (wanted !== ROOT_FOLDER_ID && (!folders.folderExists(wanted) || folders.isFolderHidden(wanted))) return [];
    const candidates = await this.view.folderNotes(wanted);
    const filter = await this.view.filter(candidates.map((note) => note.id));
    return candidates
      .filter((note) => filter.visibleMeta(note.id)?.folderId === wanted)
      .map((note) => ({ id: note.id, title: note.title }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  async readNote(id: string): Promise<{ body: string | null }> {
    const filter = await this.view.filter([id]);
    // `visibleMeta` es `undefined` también para una nota que el filtro no conoce.
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
    const id = saved.outcome === 'redirected' ? saved.redirectedTo : note.id;
    if (id !== note.id) this.created.push({ kind: 'note', id });
    return { id, created: true };
  }

  /**
   * ¿Tiene la categoría algo que quien pide no ve? Sobre el árbol y las notas SIN filtrar,
   * con el filtro de quien pide («oculto» es lo que ese filtro esconde). Verdadero si:
   * (a) hay, en el árbol de una carpeta de esa categoría, una carpeta oculta, o una nota o un
   *     fichero suelto vivo ocultos cuyo prefijo JD es de esa categoría (cerrado ante la duda);
   * (b) hay una carpeta oculta, en cualquier parte, cuyo prefijo JD es de esa categoría (un
   *     ID `21.xx` o la propia categoría `21`, de cualquier sistema: cerrado ante la duda);
   * (c) hay una nota oculta en la carpeta del JDex QUE USA ESTE PUERTO cuyo título tiene un
   *     prefijo de esa categoría (solo esa carpeta: la indicada por el agente ya se validó
   *     como `00.00` visible, `isJdexFolderCandidate`);
   * (d) la carpeta del JDex que usa este puerto está oculta, o, si el puerto aún no tiene
   *     JDex, hay alguna carpeta `00.00` oculta: entonces lo es para todas las categorías. Sin
   *     mirar el orden de las carpetas: una `00.00` oculta duplicada no decide nada si el JDex
   *     que se usa es otro, visible.
   * De las notas solo se leen los TÍTULOS (`JdView.notesInFolders`, sin el cuerpo), para que el
   * tiempo de respuesta no dependa del tamaño de lo oculto. Nunca dice qué ni cuántos: el motor
   * solo recibe el booleano.
   *
   * Sin recorrer la biblioteca (pieza A9a del plan de memoria, 6 nov 2026): antes juzgaba con el
   * filtro TODAS las notas vivas para quedarse con las de esas carpetas. Ahora las candidatas son
   * las notas vivas de las carpetas de (a) y (c) (una consulta por el índice de carpeta), y de
   * ellas solo las que tienen el prefijo de la categoría en el título pasan por el filtro
   * (`JdView.filter(ids)`), con las mismas reglas que cualquier otra nota (`isHiddenNote`:
   * carpetas privadas y recordadas, lápidas, bloqueadas y etiquetas privadas). «Oculta y con el
   * prefijo» no depende del orden en que se miren las dos cosas. Coste O(notas de esas carpetas).
   * Equivalencia con el recorrido entero en `test/privacy/jd-lazy.test.ts`.
   */
  async hasHidden(category: string): Promise<boolean> {
    const [list, filter] = await Promise.all([this.view.folders(), this.view.filter()]);
    if (!this.view.notesInFolders || !this.view.files) return true;
    const hidden = (id: string): boolean => !filter.folderExists(id) || filter.isFolderHidden(id);
    const isJdexName = (name: string): boolean => {
      const prefix = extractJdPrefix(name);
      return prefix?.number.kind === 'id' && prefix.number.id === '00.00' && !prefix.number.extension;
    };
    // (d)
    if (this.jdexFolderId !== undefined) {
      if (hidden(this.jdexFolderId)) return true;
    } else if (list.folders.some((folder) => folder.id !== ROOT_FOLDER_ID && isJdexName(folder.name) && hidden(folder.id))) {
      return true;
    }
    const categoryTrees = new Set<string>();
    for (const folder of list.folders) {
      if (folder.id === ROOT_FOLDER_ID) continue;
      const own = categoryOfName(folder.name) === category;
      // (b)
      if (own && filter.isFolderHidden(folder.id)) return true;
      // (a): las carpetas de la categoría (su árbol incluye las de sus IDs).
      const prefix = extractJdPrefix(folder.name);
      if (own && prefix?.number.kind === 'category') {
        const tree = filter.folderSubtree(folder.id);
        if (tree.some((id) => filter.isFolderHidden(id))) return true;
        for (const id of tree) categoryTrees.add(id);
      }
    }
    // (a), ficheros sueltos vivos ocultos del árbol con el prefijo de la categoría.
    const files = await this.view.files();
    for (const file of files.index.files) {
      if (file.trashedAt !== null || !categoryTrees.has(file.folderId)) continue;
      if (!files.filter.isVisible(file.id) && categoryOfName(file.name) === category) return true;
    }
    // (a) y (c): notas ocultas del árbol de la categoría o del JDex, por su título.
    const scope = [...categoryTrees];
    if (this.jdexFolderId !== undefined) scope.push(this.jdexFolderId);
    const prefixed = (await this.view.notesInFolders(scope))
      .filter((note) => categoryOfName(note.title) === category)
      .map((note) => note.id);
    if (prefixed.length === 0) return false;
    const judged = await this.view.filter(prefixed);
    return prefixed.some((id) => judged.isHiddenNote(id));
  }
}
