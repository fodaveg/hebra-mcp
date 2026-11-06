/**
 * `hebra_list_notes` perezosa (A4 del plan de memoria, 6 nov 2026): registrada con
 * `privacyLoad: 'lazy'`, carga en el filtro de privados solo las notas de cada página que
 * devuelve el motor (`notesPage`), también las que pide de más cuando las ocultas dejan la
 * página corta. Cada página pasa por `expectLazyEquivalent` (`test/fixtures/privacy-load.ts`):
 * sin preguntas por notas no cargadas y con la respuesta (cursor incluido) idéntica a la de
 * `'all'`; y además se comprueba QUÉ responde.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { expectLazyEquivalent } from '../fixtures/privacy-load';
import { lazyListsHarness, type LazyLists } from '../fixtures/lazy-lists-library';
import { createNote, type AuditHarness } from '../privacy/audit-harness';

type Harness = AuditHarness<LazyLists>;

/** Recorre todas las páginas, cada una comparada con `'all'`; devuelve los ids y cuántas. */
async function walk(h: Harness, args: Record<string, unknown>): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pages = 1; ; pages += 1) {
    const call = await expectLazyEquivalent(h.serverContext, 'hebra_list_notes', cursor ? { ...args, cursor } : args);
    expect(call.isError).toBe(false);
    ids.push(...(call.json.notes as Array<{ id: string }>).map((note) => note.id));
    if (call.json.nextCursor === null) return { ids, pages };
    cursor = call.json.nextCursor as string;
    expect(pages, 'demasiadas páginas').toBeLessThan(100);
  }
}

function sorted(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

describe('hebra_list_notes con privacyLoad lazy: igual que con la biblioteca entera', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('toda la biblioteca, página por defecto: ninguna oculta ni de la papelera', async () => {
    h = await lazyListsHarness();
    const { ids } = await walk(h, {});
    expect(ids).toEqual(expect.arrayContaining([...h.extra.visibleIds, h.library.publicNoteId]));
    for (const id of [...h.extra.hiddenIds, ...h.extra.trashedIds, h.library.privateFolderNoteId, h.library.privateTagNoteId]) {
      expect(ids).not.toContain(id);
    }
  });

  it('una carpeta en páginas pequeñas con ocultas por etiqueta y bloqueadas entre medias', async () => {
    h = await lazyListsHarness();
    const { ids, pages } = await walk(h, { folder: 'Huerto', limit: 3 });
    expect(sorted(ids)).toEqual(sorted(h.extra.visibleHuertoIds));
    expect(pages).toBeGreaterThan(2);
  });

  it('con subcarpetas', async () => {
    h = await lazyListsHarness();
    const { ids } = await walk(h, { folder: 'Huerto', subfolders: true, limit: 4 });
    expect(sorted(ids)).toEqual(sorted(h.extra.visibleIds));
  });

  it('por etiqueta: las ocultas por carpeta, por etiqueta y bloqueadas no salen', async () => {
    h = await lazyListsHarness();
    const { ids } = await walk(h, { tag: 'verdura', limit: 2 });
    expect(sorted(ids)).toEqual(sorted(h.extra.visibleTaggedIds));
  });

  it('carpeta y etiqueta a la vez (la etiqueta se mira nota a nota, `hasTag`)', async () => {
    h = await lazyListsHarness();
    const { ids } = await walk(h, { folder: 'Huerto', tag: 'verdura', limit: 2 });
    const expected = [...h.extra.visibleHuertoIds].filter((id) => h!.extra.visibleTaggedIds.has(id));
    expect(sorted(ids)).toEqual(sorted(expected));
  });

  it('con `fields` que piden el estado (`favorite`, `archivedAt`, `generalHidden`)', async () => {
    h = await lazyListsHarness();
    const { ids } = await walk(h, { folder: 'Huerto', limit: 3, fields: ['title', 'archivedAt', 'generalHidden'] });
    expect(sorted(ids)).toEqual(sorted(h.extra.visibleHuertoIds));
  });

  it('archivadas: solo las visibles', async () => {
    h = await lazyListsHarness();
    const archived = await h.mutate(async (engine, library) => {
      const ids: string[] = [];
      for (const body of ['# Archivada 1\nUna.\n', '# Archivada 2\n#secreto\nOculta.\n', '# Archivada 3\nOtra.\n']) {
        const note = await createNote(engine, null, body);
        await engine.noteArchive(note.id);
        ids.push(note.id);
      }
      const inPrivate = await createNote(engine, library.folders.diario2026, '# Archivada 4\nPrivada.\n');
      await engine.noteArchive(inPrivate.id);
      ids.push(inPrivate.id);
      return ids;
    });
    const { ids } = await walk(h, { archived: true, limit: 1 });
    expect(sorted(ids)).toEqual(sorted([archived[0]!, archived[2]!]));
  });

  it('etiqueta o carpeta privadas, inexistentes, y vacías: lista vacía', async () => {
    h = await lazyListsHarness();
    for (const args of [
      { tag: 'secreto' },
      { tag: 'secreto/personal' },
      { folder: 'Diario' },
      { folder: 'Diario/2026' },
      { tag: 'no-existe' },
      { folder: 'Huerto/No existe' }
    ]) {
      const call = await expectLazyEquivalent(h.serverContext, 'hebra_list_notes', args);
      expect(call.json, JSON.stringify(args)).toEqual({ notes: [], nextCursor: null });
    }
    await h.mutate((engine) => engine.folderCreate(null, 'Vacía'));
    const call = await expectLazyEquivalent(h.serverContext, 'hebra_list_notes', { folder: 'Vacía' });
    expect(call.json).toEqual({ notes: [], nextCursor: null });
  });

  it('bloqueadas sin etiquetas privadas: se ven, igual en las dos cargas', async () => {
    h = await lazyListsHarness({ privateFolders: [['diario']], privateTags: [] });
    const { ids } = await walk(h, { folder: 'Huerto', limit: 5 });
    // Sin etiquetas privadas solo se oculta la carpeta: todas las de `Huerto`.
    expect(ids).toHaveLength(24);
  });
});
