/**
 * Filtro de privados (SPEC.md §6.3, D3): un único `isHidden`, usado por TODAS las
 * herramientas antes de devolver nada. Cerrado ante la duda: si una carpeta configurada
 * no existe hoy, `unresolved` queda `true` y el servidor responde `privacy_config_unresolved`
 * a toda herramienta (R5).
 *
 * `PrivacyFilter.build` es una instantánea del almacén EN ESE MOMENTO: NUNCA se guarda
 * entre llamadas de herramienta (`src/server/context.ts`, `resolveToolContext`,
 * reconstruye una por llamada). El sync cambia el almacén mientras el proceso vive
 * (`SyncRunner`, `src/sync/`): una instancia cacheada al arrancar se queda obsoleta y
 * puede enseñar, o esconder, una nota que ya no es así (hallazgo del coordinador, 26
 * sep 2026; reproducido en `test/privacy-live-refresh.test.ts`). Dos consultas del
 * almacén (`foldersList()` + `notesVisibilityIndex()`, ambas de una sola vuelta SQL)
 * lo hacen barato de sobra para pagarlo en cada llamada: medido en
 * `test/store/notes-visibility-index.node.test.ts` (milisegundos de un dígito con
 * 5 000 notas).
 *
 * Audit de privacidad adversarial del 10 oct 2026 (D16, `test/privacy/`): una nota
 * bloqueada se oculta mientras haya etiquetas privadas (A1), una nota viva cuya carpeta
 * guardada no está viva se juzga subiendo por las lápidas (A2, `./tombstones.ts`), y las
 * carpetas que una ruta privada resolvió antes siguen ocultas (A3, `knownPrivateFolderIds`,
 * que añade `./folder-memory.ts`).
 */
import { ROOT_FOLDER_ID, type FoldersList } from '../hebra';
import type {
  FolderRowFact,
  HebraLibraryPort,
  NoteVisibilityEntry,
  RememberedPrivateFolder
} from '../store/types';
import type { PrivacyConfig } from './config';
import { FolderIndex, privacyPathKey } from './folder-index';
import { LibraryIndex } from './library-index';
import { climbFolder, type LiveFolders } from './tombstones';

/** Lo que el filtro lee del almacén: carpetas y carpeta/etiquetas de cada nota viva. */
export type PrivacySource = Pick<HebraLibraryPort, 'foldersList' | 'notesVisibilityIndex'>;

export class PrivacyFilter implements LiveFolders {
  readonly unresolved: boolean;
  private readonly hiddenFolderIds: Set<string>;
  private readonly privateTags: Set<string>;
  /** Las rutas de `privateFolders` tal cual están configuradas (ya en minúsculas). */
  private readonly privateFolderPaths: readonly (readonly string[])[];
  /** Las mismas, como `privacyPathKey`, para subir por las lápidas. */
  private readonly privatePathKeys: ReadonlySet<string>;
  /** Las carpetas de las que cuelga lo privado: las que la configuración resuelve AHORA y
   *  las que resolvió antes (`knownPrivateFolderIds`, A3), vivas o ya lápidas. */
  private readonly privateRootIds: Set<string>;
  /** A qué carpetas resuelve ahora cada ruta configurada, para anotarlo (A3). */
  private readonly resolvedNow: RememberedPrivateFolder[] = [];
  /** Las lápidas por encima de las notas vivas cuya carpeta guardada no está viva (A2). */
  private readonly trailRows = new Map<string, FolderRowFact>();

  private constructor(
    private readonly folders: FolderIndex,
    private readonly library: LibraryIndex,
    config: PrivacyConfig
  ) {
    this.privateTags = new Set(config.privateTags);
    this.privateFolderPaths = config.privateFolders;
    this.privatePathKeys = new Set(config.privateFolders.map((segments) => privacyPathKey(segments)));
    let unresolved = false;
    const roots = new Set<string>();
    for (const segments of config.privateFolders) {
      // TODAS las carpetas con esa ruta, no una: el sync puede traer hermanas homónimas
      // (`Privado` y `privado`, o la misma con la tilde compuesta y descompuesta), y
      // cualquiera de ellas es la carpeta privada configurada.
      const folderIds = folders.idsForPath(segments).filter((id) => id !== ROOT_FOLDER_ID);
      if (folderIds.length === 0) {
        unresolved = true;
        continue;
      }
      const pathKey = privacyPathKey(segments);
      for (const folderId of folderIds) {
        roots.add(folderId);
        this.resolvedNow.push({ pathKey, folderId });
      }
    }
    // A3: las que resolvió antes una ruta aún configurada, aunque hoy esté en otra ruta.
    for (const folderId of config.knownPrivateFolderIds ?? []) {
      if (folderId !== ROOT_FOLDER_ID) roots.add(folderId);
    }
    const hidden = new Set<string>();
    for (const root of roots) {
      if (!folders.has(root)) continue;
      for (const id of folders.subtree(root)) hidden.add(id);
    }
    for (const [, entry] of library.entries()) {
      for (const row of entry.folderTrail ?? []) this.trailRows.set(row.id, row);
    }
    this.unresolved = unresolved;
    this.hiddenFolderIds = hidden;
    this.privateRootIds = roots;
  }

  static async build(port: PrivacySource, config: PrivacyConfig): Promise<PrivacyFilter> {
    const [folders, library] = await Promise.all([
      FolderIndex.build(port),
      LibraryIndex.build(port)
    ]);
    return new PrivacyFilter(folders, library, config);
  }

  /**
   * Sobre datos ya leídos, sin `await`: lo usa el escritor DENTRO del turno de la cola
   * en el que escribe (`src/store/writes.ts`), con el motor leído directamente, para que
   * ni el sync ni otra escritura cambien lo que es privado entre la comprobación y la
   * escritura (D2 ampliada, E).
   */
  static fromSnapshot(
    folders: FoldersList,
    notes: readonly NoteVisibilityEntry[],
    config: PrivacyConfig
  ): PrivacyFilter {
    return new PrivacyFilter(FolderIndex.fromList(folders), LibraryIndex.fromRows(notes), config);
  }

  /** ¿Alguna de estas etiquetas canónicas (con sus ancestros, como las da `deriveNote`)
   *  es privada? Para rechazar una escritura que dejaría la nota oculta (decisión 4). */
  hidesAnyTag(tags: Iterable<string>): boolean {
    for (const tag of tags) if (this.privateTags.has(tag)) return true;
    return false;
  }

  /** ¿Hay etiquetas privadas configuradas? Con ellas, una nota bloqueada se oculta (A1). */
  hasPrivateTags(): boolean {
    return this.privateTags.size > 0;
  }

  /**
   * `true` si la nota no debe salir por NINGUNA herramienta: en una carpeta privada (o
   * subcarpeta, también una a la que la ruta resolvió antes, A3), con una etiqueta privada
   * (o descendiente), bloqueada con etiquetas privadas configuradas (A1: una nota bloqueada
   * no deriva etiquetas y el MCP no puede leer su cuerpo para saber si llevaba una), con su
   * carpeta guardada ya borrada debajo de una privada o sin poder subir hasta una viva (A2,
   * la regla de la papelera, `climbFolder`), o desconocida para el índice (cerrado ante la
   * duda).
   */
  isHiddenNote(id: string): boolean {
    const entry = this.library.get(id);
    if (!entry) return true;
    if (entry.locked && this.privateTags.size > 0) return true;
    if (this.hiddenFolderIds.has(entry.folderId)) return true;
    if (
      entry.storedFolderId !== undefined &&
      climbFolder(entry.storedFolderId, this.trailRows, this, this.privatePathKeys) === undefined
    ) {
      return true;
    }
    for (const tag of entry.tags) {
      if (this.privateTags.has(tag)) return true;
    }
    return false;
  }

  /** ¿Hay alguna nota viva BLOQUEADA y oculta? Para la variante de A1 de los ficheros
   *  sueltos (`FileFilter`): lo que incrustaba por nombre va cifrado. */
  hasHiddenLockedNote(): boolean {
    for (const [id, entry] of this.library.entries()) {
      if (entry.locked && this.isHiddenNote(id)) return true;
    }
    return false;
  }

  isFolderHidden(folderId: string): boolean {
    return this.hiddenFolderIds.has(folderId);
  }

  /** ¿Es (viva o lápida) una carpeta de la que cuelga lo privado? Para la subida por las
   *  lápidas (`climbFolder`): una privada movida (A3) y después borrada sigue ocultando. */
  isPrivateFolderId(folderId: string): boolean {
    return this.privateRootIds.has(folderId);
  }

  /** A qué carpetas resuelve AHORA cada ruta configurada (`privacyPathKey`, id), para que
   *  `privacyWithMemory` las anote (A3). */
  resolvedPrivateFolders(): readonly RememberedPrivateFolder[] {
    return this.resolvedNow;
  }

  isTagHidden(tag: string): boolean {
    return this.privateTags.has(tag);
  }

  folderPath(folderId: string): string {
    return this.folders.path(folderId);
  }

  folderExists(folderId: string): boolean {
    return this.folders.has(folderId);
  }

  /**
   * ¿Es `segments` (una ruta en minúsculas y sin espacios en los extremos, como las de
   * `folderPathSegments`) una carpeta privada CONFIGURADA o algo debajo de una? Solo mira
   * la configuración, nunca el almacén: es lo que decide `folder_unavailable` al crear o
   * renombrar una carpeta (D9), con la misma respuesta exista o no esa carpeta.
   */
  isPrivateFolderPath(segments: readonly string[]): boolean {
    // En NFC los dos lados (`privacyPathKey`), igual que el índice de rutas.
    const wanted = segments.map((segment) => segment.normalize('NFC'));
    return this.privateFolderPaths.some(
      (path) =>
        path.length > 0 &&
        path.length <= wanted.length &&
        path.every((segment, index) => wanted[index] === segment.normalize('NFC'))
    );
  }

  /** Segmentos de la ruta de una carpeta, para componer la ruta de una nueva. */
  folderSegments(folderId: string): string[] {
    return this.folders.segments(folderId);
  }

  /** Padre efectivo de una carpeta (`null` para la raíz). */
  folderParent(folderId: string): string | null {
    return this.folders.parentOf(folderId);
  }

  /** Nombre guardado de una carpeta. */
  folderName(folderId: string): string | undefined {
    return this.folders.name(folderId);
  }

  /** Hijas de una carpeta, VISIBLES u ocultas (quien llama decide qué hacer con cada
   *  una; nunca se devuelven a la IA). */
  folderChildren(parentId: string): Array<{ id: string; name: string; hidden: boolean }> {
    return this.folders
      .children(parentId)
      .map((child) => ({ ...child, hidden: this.hiddenFolderIds.has(child.id) }));
  }

  /** Ella y todas sus descendientes. */
  folderSubtree(folderId: string): string[] {
    return this.folders.subtree(folderId);
  }

  /**
   * ¿Hay alguna ruta privada CONFIGURADA estrictamente por debajo de `segments` (en
   * minúsculas, como `isPrivateFolderPath`)? Renombrar esa carpeta cambiaría la ruta por la
   * que se resuelve (D9). Solo mira la configuración, nunca el almacén (M4 del audit de
   * privacidad, 10 oct 2026): antes se miraba si había una carpeta oculta debajo, y
   * renombrar una carpeta a su mismo nombre decía cuál de las visibles (también entre
   * homónimas) tenía una privada dentro.
   */
  isPrivatePathPrefix(segments: readonly string[]): boolean {
    const wanted = segments.map((segment) => segment.normalize('NFC'));
    return this.privateFolderPaths.some(
      (path) =>
        path.length > wanted.length &&
        wanted.every((segment, index) => path[index]!.normalize('NFC') === segment)
    );
  }

  /** Id de la carpeta que corresponde a una ruta escrita por la persona (`folder?` de
   *  `hebra_search`/`hebra_list_notes`, SPEC.md §5), o `undefined` si no existe. */
  folderIdForPath(path: string): string | undefined {
    const segments = path
      .split('/')
      .map((segment) => segment.trim().toLowerCase())
      .filter((segment) => segment.length > 0);
    if (segments.length === 0) return ROOT_FOLDER_ID;
    return this.folders.idForPath(segments);
  }

  /** Etiquetas HOJA de una nota (sin los ancestros que `note_tags` guarda de más), para
   *  enseñar en `hebra_search`/`hebra_list_notes`/`hebra_read_note`. */
  visibleTagsOf(id: string): string[] {
    const entry = this.library.get(id);
    if (!entry) return [];
    const tags = [...entry.tags];
    return tags.filter((tag) => !tags.some((other) => other !== tag && other.startsWith(`${tag}/`)));
  }

  /** Si una nota VISIBLE lleva `tag` (canónica), con sus ancestros (igual que
   *  `note_tags`): para combinar el filtro `folder?`+`tag?` de `hebra_list_notes`
   *  cuando el ámbito nativo del almacén ya usó el otro. */
  hasTag(id: string, tag: string): boolean {
    if (this.isHiddenNote(id)) return false;
    return this.library.get(id)?.tags.has(tag) ?? false;
  }

  /** Carpeta y etiquetas hoja de una nota VISIBLE, para las salidas de `hebra_search`,
   *  `hebra_list_notes` y `hebra_read_note`. `undefined` si la nota está oculta o no
   *  existe: quien llama debe tratarlo como si la nota no estuviera. */
  visibleMeta(id: string): { folderId: string; tags: string[] } | undefined {
    if (this.isHiddenNote(id)) return undefined;
    const entry = this.library.get(id)!;
    return { folderId: entry.folderId, tags: this.visibleTagsOf(id) };
  }

  /** Notas visibles con su carpeta y etiquetas, para recalcular recuentos (SPEC.md §6.3:
   *  «Recuentos de `hebra_list_tags` y `hebra_list_folders`… las etiquetas privadas o
   *  solo presentes en notas ocultas tampoco» — y por la aceptación #5, una nota oculta
   *  por ETIQUETA tampoco cuenta en el recuento de una CARPETA visible). */
  visibleNotes(): Map<string, { folderId: string; tags: readonly string[] }> {
    const result = new Map<string, { folderId: string; tags: readonly string[] }>();
    for (const [id, entry] of this.library.entries()) {
      if (this.isHiddenNote(id)) continue;
      result.set(id, { folderId: entry.folderId, tags: [...entry.tags] });
    }
    return result;
  }
}
