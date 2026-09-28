/**
 * Índice de carpeta y etiquetas por nota (SPEC.md §5, §6.3), sobre UNA consulta del
 * almacén (`HebraLibraryPort.notesVisibilityIndex()`, `src/store/node-port.ts`).
 *
 * Antes se componía nota a nota (`notesPage`/`noteRead`/`tagsList`, O(notas) + O(etiquetas)
 * consultas) y se construía UNA vez al arrancar. Las dos cosas eran un problema: el sync
 * cambia el almacén mientras el proceso vive (`SyncRunner`, `src/sync/`), así que un
 * índice cacheado se queda obsoleto y puede enseñar (o esconder) una nota que ya no es
 * así — hallazgo del coordinador, 26 sep 2026. `PrivacyFilter.build` reconstruye este
 * índice en CADA llamada de herramienta (`src/server/register-tools.ts`): sin la
 * consulta de una sola vuelta esto no habría sido viable.
 *
 * Solo cubre notas VIVAS (ni papelera ni lápida): `notesVisibilityIndex()` ya las
 * excluye en SQL (SPEC.md §5: «las notas en la papelera nunca se devuelven»).
 */
import type { HebraLibraryPort, NoteVisibilityEntry } from '../store/types';

export interface NoteIndexEntry {
  folderId: string;
  /** Etiquetas canónicas de la nota, CON sus ancestros (`note_tags` las guarda así): útil
   *  para el filtro (una etiqueta privada oculta también a sus descendientes) y para
   *  enseñar (`visibleTagsOf` en `filter.ts` se queda solo con las hoja). */
  tags: Set<string>;
}

export class LibraryIndex {
  private readonly notes: ReadonlyMap<string, NoteIndexEntry>;

  private constructor(notes: ReadonlyMap<string, NoteIndexEntry>) {
    this.notes = notes;
  }

  static async build(port: Pick<HebraLibraryPort, 'notesVisibilityIndex'>): Promise<LibraryIndex> {
    return LibraryIndex.fromRows(await port.notesVisibilityIndex());
  }

  /** Sobre filas ya leídas (el filtro de DENTRO de un turno de escritura). */
  static fromRows(rows: readonly NoteVisibilityEntry[]): LibraryIndex {
    const notes = new Map<string, NoteIndexEntry>();
    for (const row of rows) notes.set(row.id, { folderId: row.folderId, tags: new Set(row.tags) });
    return new LibraryIndex(notes);
  }

  get(id: string): NoteIndexEntry | undefined {
    return this.notes.get(id);
  }

  has(id: string): boolean {
    return this.notes.has(id);
  }

  entries(): IterableIterator<[string, NoteIndexEntry]> {
    return this.notes.entries();
  }
}
