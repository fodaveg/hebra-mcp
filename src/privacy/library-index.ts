/**
 * Índice de carpeta y etiquetas por nota, construido UNA vez sobre `HebraLibraryPort`
 * (SPEC.md §5, §6.3). El puerto no da un método «carpeta y etiquetas de esta nota»
 * (`NoteListItem`/`SearchHit` no llevan `folderId` ni `tags`, y `NoteRow` tampoco lleva
 * `tags`): esto lo compone leyendo con lo que el puerto YA da —
 * `notesPage`/`noteRead`/`tagsList` — sin tocar `src/store`. Ver el informe de cierre de
 * L1 para el coste (N+1 `noteRead` y una `notesPage` paginada por etiqueta): con una
 * biblioteca real esto puede pedir un método nuevo del almacén en un lote futuro.
 *
 * Solo cubre notas VIVAS (ni papelera ni lápida): las páginas de `notesPage` con ámbito
 * `all`/`tag` ya las excluyen en SQL (SPEC.md §5: «las notas en la papelera nunca se
 * devuelven»).
 */
import type { NotesScope } from '$lib/library/types';
import type { HebraLibraryPort } from '../store/types';

export interface NoteIndexEntry {
  folderId: string;
  /** Etiquetas canónicas de la nota, CON sus ancestros (`note_tags` las guarda así): útil
   *  para el filtro (una etiqueta privada oculta también a sus descendientes) y para
   *  enseñar (`visibleTagsOf` en `filter.ts` se queda solo con las hoja). */
  tags: Set<string>;
}

const PAGE_LIMIT = 100;

async function collectAllIds(port: HebraLibraryPort, scope: NotesScope): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await port.notesPage(cursor, PAGE_LIMIT, scope);
    for (const item of page.items) ids.push(item.id);
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
}

export class LibraryIndex {
  private readonly notes = new Map<string, NoteIndexEntry>();

  private constructor() {}

  static async build(port: HebraLibraryPort): Promise<LibraryIndex> {
    const index = new LibraryIndex();
    const allIds = await collectAllIds(port, { kind: 'all' });
    for (const id of allIds) {
      const note = await port.noteRead(id);
      if (!note || note.trashedAt !== null) continue;
      index.notes.set(id, { folderId: note.effectiveFolderId, tags: new Set() });
    }
    const { tags } = await port.tagsList();
    for (const entry of tags) {
      const ids = await collectAllIds(port, { kind: 'tag', tag: entry.tag });
      for (const id of ids) index.notes.get(id)?.tags.add(entry.tag);
    }
    return index;
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
