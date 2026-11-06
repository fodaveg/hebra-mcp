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
 * sep 2026; reproducido en `test/privacy-live-refresh.test.ts`).
 *
 * Lo que NO es barato es cargar todas las notas en cada llamada: a 30 000 notas son unos
 * 40-50 MiB de JS y 0,2 s por llamada, aunque la herramienta solo toque una nota (medido,
 * pieza A3 del plan de memoria, 6 nov 2026). Por eso `build` solo lee lo que no crece con
 * las notas (las carpetas, y de la configuración las etiquetas privadas y las carpetas
 * recordadas) y las notas se cargan a petición, en el índice de ESTA instancia
 * (`./library-index.ts`):
 * - `await filter.ensure(ids)` carga las notas de `ids` que falten (una lectura de
 *   `notesVisibilityIndexFor`);
 * - `await filter.ensureAll()` carga la biblioteca entera, como antes.
 * Preguntar por una nota que no se cargó la trata como OCULTA (falla cerrando) y deja rastro
 * en `unloadedLookups` (y en `unloadedLookupsTotal()` del índice) para los tests.
 *
 * Cómo se adapta una herramienta (A4-A8): hoy `resolveToolContext` llama a `ensureAll()` por
 * todas (transición). Para una herramienta concreta, se quita esa dependencia y, ANTES de la
 * primera pregunta sobre una nota (`isHiddenNote`, `visibleMeta`, `visibleTagsOf`, `hasTag`,
 * `isLockedNote`, `sealOf`), se hace `await ctx.privacy.ensure(idsQueVaATocar)` con todos los
 * ids que decidirá (los de la página leída, la nota pedida, las homónimas…). Se puede llamar
 * más de una vez (solo lee los que falten). Su test comprueba que `unloadedLookupsTotal()` no
 * sube al llamarla. Las que recorren la biblioteca (`hasHiddenLockedNote`) siguen necesitando
 * `ensureAll()` hasta que pasen a SQL (A6). Los recuentos y listados (A7) ya no recorren nada en
 * JS: aplican las reglas del filtro dentro de la consulta con `notesScope()`
 * (`src/store/visible-sql.ts`); `visibleNotes()` queda solo como oráculo de los tests.
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
import type { VisibleNotesScope } from '../store/visible-sql';
import type { PrivacyConfig } from './config';
import { FolderIndex, privacyPathKey } from './folder-index';
import { LibraryIndex, type NoteIndexEntry } from './library-index';
import { climbFolder, type LiveFolders } from './tombstones';

/** Lo que el filtro lee del almacén: carpetas y carpeta/etiquetas de las notas vivas (todas
 *  con `ensureAll`, las pedidas con `ensure`). */
export type PrivacySource = Pick<
  HebraLibraryPort,
  'foldersList' | 'notesVisibilityIndex' | 'notesVisibilityIndexFor'
>;

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
  /** Las lápidas por encima de cada nota viva cuya carpeta guardada no está viva (A2), como
   *  mapa por id, hecho la primera vez que se juzga esa nota. Cada nota se sube con SUS filas
   *  (`folderTrail` llega hasta la primera viva o hasta donde falta una fila): antes de A3 era
   *  la unión de las de todas las notas, que leídas a la vez dan lo mismo; con notas cargadas
   *  en momentos distintos (`ensure`), una fila vieja de otra nota podría continuar una subida
   *  que la suya corta. */
  private readonly trails = new WeakMap<NoteIndexEntry, ReadonlyMap<string, FolderRowFact>>();

  private constructor(
    private readonly folders: FolderIndex,
    private readonly library: LibraryIndex,
    config: PrivacyConfig,
    /** De dónde cargar las notas (`ensure`/`ensureAll`); sin él (`fromSnapshot`), el índice
     *  ya viene entero. */
    private readonly source?: PrivacySource
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
    this.unresolved = unresolved;
    this.hiddenFolderIds = hidden;
    this.privateRootIds = roots;
  }

  /**
   * El filtro de una llamada SIN notas cargadas: lee las carpetas (O(carpetas)) y aplica la
   * configuración (etiquetas privadas y carpetas recordadas, que ya trae `config`). Todo lo que
   * depende solo de carpetas y configuración (`unresolved`, `isFolderHidden`, `folderPath`,
   * `hidesAnyTag`, `isTagHidden`…) ya funciona; para juzgar notas, antes `ensure(ids)` o
   * `ensureAll()` (comentario de cabecera). Nunca se guarda entre llamadas.
   */
  static async build(port: PrivacySource, config: PrivacyConfig): Promise<PrivacyFilter> {
    const folders = await FolderIndex.build(port);
    return new PrivacyFilter(folders, LibraryIndex.lazy(), config, port);
  }

  /**
   * Carga las notas de `ids` que aún no se cargaron, en UNA lectura del almacén
   * (`notesVisibilityIndexFor`); ninguna si ya estaban todas (o con `ensureAll` hecho). Después,
   * cada una se juzga igual que con el filtro entero. Un id que no existe, en la papelera o
   * purgado queda como desconocido: oculto. Devuelve el propio filtro, para encadenar.
   */
  async ensure(ids: readonly string[]): Promise<this> {
    if (this.source) await this.library.ensure(this.source, ids);
    return this;
  }

  /**
   * TRANSICIÓN (A3 del plan de memoria): carga la biblioteca entera como antes de A3. Lo
   * llama `resolveToolContext` para que todas las herramientas sigan igual mientras A4-A8 las
   * pasan, una a una, a `ensure(ids)`; y quien recorre la biblioteca (`hasHiddenLockedNote`, y
   * `visibleNotes` en los tests). Devuelve el propio filtro.
   */
  async ensureAll(): Promise<this> {
    if (this.source) await this.library.ensureAll(this.source);
    return this;
  }

  /** Preguntas a ESTE filtro por notas que no se cargaron (tratadas como ocultas): el rastro
   *  de un consumidor que se olvidó de `ensure`. */
  get unloadedLookups(): number {
    return this.library.unloadedLookups;
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
    // `notes` es la biblioteca entera leída en el turno: el índice ya viene completo.
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
      climbFolder(entry.storedFolderId, this.trailOf(entry), this, this.privatePathKeys) === undefined
    ) {
      return true;
    }
    for (const tag of entry.tags) {
      if (this.privateTags.has(tag)) return true;
    }
    return false;
  }

  /** Las filas de lápida de la subida de UNA nota, como mapa (ver `trails`). */
  private trailOf(entry: NoteIndexEntry): ReadonlyMap<string, FolderRowFact> {
    let rows = this.trails.get(entry);
    if (rows === undefined) {
      rows = new Map((entry.folderTrail ?? []).map((row) => [row.id, row]));
      this.trails.set(entry, rows);
    }
    return rows;
  }

  /** `local_seq` de la fila de la nota con la que se construyó este filtro (`undefined` si
   *  no la conoce, no se cargó o la fila no lo trae): el sello por defecto de la puerta final
   *  (`src/server/privacy-gate.ts`). */
  sealOf(id: string): number | undefined {
    return this.library.get(id)?.localSeq;
  }

  /** ¿Hay alguna nota viva BLOQUEADA y oculta? Para la variante de A1 de los ficheros
   *  sueltos (`FileFilter`): lo que incrustaba por nombre va cifrado.
   *
   *  Recorre la biblioteca entera: necesita `ensureAll()`. Sin él responde `true` (falla
   *  cerrando: se ocultan los ficheros que se pueden incrustar por nombre) y deja rastro.
   *  A6/A7 lo pasarán a SQL (una consulta de «existe una bloqueada oculta») y dejará de
   *  depender del índice. */
  hasHiddenLockedNote(): boolean {
    if (!this.library.isFull()) {
      this.library.noteUnloaded();
      return true;
    }
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

  /** ¿Está bloqueada? Sin decir si se ve: una bloqueada visible no tiene propiedades, aunque
   *  quede una fila de antes de bloquearla (D23). */
  isLockedNote(id: string): boolean {
    return this.library.get(id)?.locked === true;
  }

  /**
   * Las reglas de `isHiddenNote` para aplicarlas DENTRO de una consulta, sin cargar ninguna nota
   * (`VisibleNotesScope`, `src/store/visible-sql.ts`): las carpetas ocultas, las etiquetas
   * privadas, si se ocultan las bloqueadas (A1) y la subida por las lápidas de una carpeta
   * guardada que no está viva (A2, con `climbFolder` y las rutas privadas de este filtro). Lo
   * usan los recuentos y listados que antes recorrían `visibleNotes()` (pieza A7 del plan de
   * memoria): `hebra_list_tags`, `hebra_list_folders`, `hebra_list_properties` y
   * `hebra_query_properties`. Solo crece con las carpetas ocultas y las etiquetas privadas.
   */
  notesScope(): VisibleNotesScope {
    return {
      hiddenFolderIds: [...this.hiddenFolderIds],
      privateTags: [...this.privateTags],
      hideLocked: this.privateTags.size > 0,
      storedFolderVisible: (storedFolderId, trail) =>
        climbFolder(storedFolderId, new Map(trail.map((row) => [row.id, row])), this, this.privatePathKeys) !==
        undefined
    };
  }

  /** SOLO PARA TESTS: notas visibles con su carpeta y etiquetas, el oráculo con el que se
   *  comparan los recuentos en SQL (`notesScope`). Ningún código de producción lo usa desde la
   *  pieza A7 del plan de memoria (6 nov 2026): copiaba la biblioteca entera en cada llamada.
   *
   *  Recorre la biblioteca entera: necesita `ensureAll()`. Sin él solo devuelve las visibles
   *  de las cargadas con `ensure` (falla cerrando: lo no cargado no cuenta, nunca se enseña de
   *  más) y deja rastro. */
  visibleNotes(): Map<string, { folderId: string; tags: readonly string[] }> {
    if (!this.library.isFull()) this.library.noteUnloaded();
    const result = new Map<string, { folderId: string; tags: readonly string[] }>();
    for (const [id, entry] of this.library.entries()) {
      if (this.isHiddenNote(id)) continue;
      result.set(id, { folderId: entry.folderId, tags: [...entry.tags] });
    }
    return result;
  }
}
