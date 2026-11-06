/**
 * Índice de carpeta y etiquetas por nota (SPEC.md §5, §6.3), sobre consultas del almacén
 * (`HebraLibraryPort.notesVisibilityIndex()` y `notesVisibilityIndexFor(ids)`,
 * `src/store/node-port.ts`).
 *
 * Se construye en CADA llamada de herramienta y nunca se guarda entre llamadas: el sync
 * cambia el almacén mientras el proceso vive (`SyncRunner`, `src/sync/`), así que un índice
 * cacheado se queda obsoleto y puede enseñar (o esconder) una nota que ya no es así —
 * hallazgo del coordinador, 26 sep 2026.
 *
 * Perezoso desde la pieza A3 del plan de memoria (6 nov 2026). Cargar la biblioteca entera en
 * cada llamada NO es barato: a 30 000 notas son unos 40-50 MiB de JS y 0,2 s por llamada,
 * aunque la herramienta solo toque una nota (medido; un `Set` de etiquetas por nota). Así que
 * el índice nace vacío (`LibraryIndex.lazy()`) y se llena con lo que pide quien lo usa:
 * - `ensure(port, ids)` lee con `notesVisibilityIndexFor` las notas de `ids` que aún no pidió
 *   (una lectura por llamada a `ensure`, ninguna si ya estaban todas);
 * - `ensureAll(port)` lee la biblioteca entera como antes (el camino de transición mientras las
 *   herramientas no piden sus ids: `resolveToolContext`, `src/server/context.ts`).
 *
 * FALLA CERRANDO: `get` de una nota que nadie pidió devuelve `undefined`, lo mismo que una nota
 * que no existe, y el filtro la trata como OCULTA (`isHiddenNote`). Para cazar al consumidor
 * que se olvidó de `ensure`, cada una de esas preguntas suma en `unloadedLookups` (de este
 * índice) y en `unloadedLookupsTotal()` (del proceso), que los tests comprueban. Sin aviso por
 * stderr: los logs de §6.4 no llevan ids, y un contador no cuesta nada en producción.
 *
 * Soltar (M1 de la revisión de seguridad, 6 nov 2026): `forget(ids)` devuelve a NO cargadas
 * notas ya decididas, para que una herramienta que recorre la biblioteca por tramos no acumule
 * en el índice una entrada por nota. Una soltada se trata igual que una no pedida (oculta y con
 * rastro) hasta que otro `ensure` la vuelva a leer. Sin efecto en un índice entero.
 *
 * Solo cubre notas VIVAS (ni papelera ni lápida): las dos consultas ya las excluyen en SQL
 * (SPEC.md §5: «las notas en la papelera nunca se devuelven»). Una nota pedida que no sale es
 * desconocida (oculta), pero no cuenta como olvido: se preguntó por ella.
 */
import type { FolderRowFact, HebraLibraryPort, NoteVisibilityEntry } from '../store/types';

export interface NoteIndexEntry {
  folderId: string;
  /** Etiquetas canónicas de la nota, CON sus ancestros (`note_tags` las guarda así): útil
   *  para el filtro (una etiqueta privada oculta también a sus descendientes) y para
   *  enseñar (`visibleTagsOf` en `filter.ts` se queda solo con las hoja). */
  tags: Set<string>;
  /** Bloqueada (A1 del audit de privacidad): no deriva etiquetas. */
  locked: boolean;
  /** La carpeta guardada si no está viva, y las lápidas por encima (A2): ver
   *  `NoteVisibilityEntry` en `src/store/types.ts`. */
  storedFolderId?: string;
  folderTrail?: readonly FolderRowFact[];
  /** `notes.local_seq` de la fila leída, el sello de la puerta final. */
  localSeq?: number;
}

/** Lo que el índice lee del almacén. */
export type LibraryIndexSource = Pick<HebraLibraryPort, 'notesVisibilityIndex' | 'notesVisibilityIndexFor'>;

/** Preguntas por notas no cargadas en todo el proceso (ver `unloadedLookupsTotal`). */
let unloadedTotal = 0;

/**
 * Cuántas veces, en todo el proceso, se ha preguntado a un índice perezoso por una nota que
 * no se cargó con `ensure`/`ensureAll` (y se ha tratado como oculta). Para los tests: una
 * herramienta adaptada (A4-A8) no debe subirlo. Siempre crece; se compara antes y después.
 */
export function unloadedLookupsTotal(): number {
  return unloadedTotal;
}

function entryOf(row: NoteVisibilityEntry): NoteIndexEntry {
  const entry: NoteIndexEntry = { folderId: row.folderId, tags: new Set(row.tags), locked: row.locked === true };
  if (row.localSeq !== undefined) entry.localSeq = row.localSeq;
  if (row.storedFolderId !== undefined) {
    entry.storedFolderId = row.storedFolderId;
    entry.folderTrail = row.folderTrail ?? [];
  }
  return entry;
}

export class LibraryIndex {
  private readonly notes = new Map<string, NoteIndexEntry>();
  /** Ids por los que ya se preguntó al almacén, salieran o no (`ensure`). */
  private readonly requested = new Set<string>();
  /** Con la biblioteca entera cargada (`fromRows`, `ensureAll`): todo lo que no está, no existe. */
  private full: boolean;
  /** Preguntas por notas no cargadas en este índice (falla cerrando, ver arriba). */
  private unloaded = 0;

  private constructor(full: boolean) {
    this.full = full;
  }

  /** Vacío: nada cargado hasta `ensure`/`ensureAll`. Lo que usa `PrivacyFilter.build`. */
  static lazy(): LibraryIndex {
    return new LibraryIndex(false);
  }

  /** La biblioteca entera de una vez, como antes de A3 (equivale a `lazy()` + `ensureAll`). */
  static async build(port: Pick<HebraLibraryPort, 'notesVisibilityIndex'>): Promise<LibraryIndex> {
    return LibraryIndex.fromRows(await port.notesVisibilityIndex());
  }

  /** Sobre filas ya leídas de la biblioteca ENTERA (el filtro de DENTRO de un turno de
   *  escritura, la puerta final): completo, nada que cargar después. */
  static fromRows(rows: readonly NoteVisibilityEntry[]): LibraryIndex {
    const index = new LibraryIndex(true);
    for (const row of rows) index.notes.set(row.id, entryOf(row));
    return index;
  }

  /** ¿Está cargada la biblioteca entera? */
  isFull(): boolean {
    return this.full;
  }

  /**
   * Carga las notas de `ids` que aún no se pidieron, en UNA lectura del almacén (ninguna si
   * no falta ninguna o el índice ya está entero). Devuelve las entradas recién cargadas (el
   * filtro recoge de ellas las lápidas, A2). Una nota que no sale (no existe, papelera,
   * lápida) queda pedida y desconocida: oculta, sin contar como olvido.
   */
  async ensure(port: LibraryIndexSource, ids: readonly string[]): Promise<NoteIndexEntry[]> {
    if (this.full) return [];
    const missing = [...new Set(ids)].filter((id) => !this.requested.has(id));
    if (missing.length === 0) return [];
    const rows = await port.notesVisibilityIndexFor(missing);
    // Tras el `await`: si entretanto otro `ensureAll` dejó el índice entero, lo suyo manda.
    if (this.full) return [];
    const loaded: NoteIndexEntry[] = [];
    for (const row of rows) {
      const entry = entryOf(row);
      this.notes.set(row.id, entry);
      loaded.push(entry);
    }
    for (const id of missing) this.requested.add(id);
    return loaded;
  }

  /**
   * La biblioteca entera en una lectura, como antes de A3; sustituye lo cargado por `ensure`
   * (una sola instantánea para todas). Sin efecto si ya estaba entera. Devuelve las entradas
   * cargadas.
   */
  async ensureAll(port: Pick<HebraLibraryPort, 'notesVisibilityIndex'>): Promise<NoteIndexEntry[]> {
    if (this.full) return [];
    const rows = await port.notesVisibilityIndex();
    if (this.full) return [];
    this.notes.clear();
    this.requested.clear();
    for (const row of rows) this.notes.set(row.id, entryOf(row));
    this.full = true;
    return [...this.notes.values()];
  }

  /**
   * Suelta las notas de `ids` ya decididas (M1 de la revisión de seguridad del plan de memoria,
   * 6 nov 2026): vuelven a estar NO cargadas, como si nadie las hubiera pedido. Es lo que deja la
   * memoria de una herramienta que recorre la biblioteca por tramos (`hebra_grep`) o por lotes
   * (`hebra_replace_in_notes` sin `ids`) acotada por el tramo y no por la biblioteca.
   *
   * Falla cerrando, como lo no pedido: `get` de una nota soltada devuelve `undefined` (oculta) y
   * suma en `unloadedLookups`; `ensure` la vuelve a leer. Quien suelta una nota ya no puede
   * preguntar por ella, tampoco por su sello (`sealOf`), sin volver a cargarla.
   *
   * Sin efecto con la biblioteca entera (`fromRows`, `ensureAll`): esa memoria ya está gastada,
   * y soltar de un índice entero dejaría la nota oculta para siempre (`ensure` no lee nada con
   * el índice entero). Devuelve cuántas se soltaron.
   */
  forget(ids: Iterable<string>): number {
    if (this.full) return 0;
    let forgotten = 0;
    for (const id of ids) {
      const loaded = this.notes.delete(id);
      if (this.requested.delete(id) || loaded) forgotten += 1;
    }
    return forgotten;
  }

  /** Cuántas notas guarda ahora el índice (cargadas o pedidas sin salir): lo que crece con
   *  `ensure` y baja con `forget`. Para los tests de memoria. */
  get retained(): number {
    return this.full ? this.notes.size : this.requested.size;
  }

  /** La entrada de una nota, o `undefined` si no existe O NO SE CARGÓ (falla cerrando: quien
   *  pregunta la trata como oculta; lo segundo suma en `unloadedLookups`). */
  get(id: string): NoteIndexEntry | undefined {
    const entry = this.notes.get(id);
    if (entry === undefined && !this.full && !this.requested.has(id)) this.noteUnloaded();
    return entry;
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  /** Las notas CARGADAS. Con el índice perezoso a medio cargar no es la biblioteca: quien
   *  necesita recorrerla entera (`visibleNotes`, `hasHiddenLockedNote`) mira `isFull()`. */
  entries(): IterableIterator<[string, NoteIndexEntry]> {
    return this.notes.entries();
  }

  /** Preguntas por notas no cargadas en este índice (falla cerrando). */
  get unloadedLookups(): number {
    return this.unloaded;
  }

  /** Anota un recorrido de la biblioteca entera sobre un índice que no lo está. */
  noteUnloaded(): void {
    this.unloaded += 1;
    unloadedTotal += 1;
  }
}
