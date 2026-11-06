/**
 * `hebra_search` perezosa (A4 del plan de memoria, 6 nov 2026): registrada con
 * `privacyLoad: 'lazy'`, carga en el filtro de privados solo las notas de cada página que
 * devuelve el motor (también las que pide de más cuando las ocultas dejan la página corta) y,
 * con `linksTo`, las homónimas de cada destino (`search-filters.ts`). Cada página pasa por
 * `expectLazyEquivalent` (`test/fixtures/privacy-load.ts`): sin preguntas por notas no cargadas
 * y con la respuesta (cursor incluido) idéntica a la de `'all'`; y además se comprueba QUÉ
 * responde.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { expectLazyEquivalent } from '../fixtures/privacy-load';
import { lazyListsHarness, WORD, type LazyLists } from '../fixtures/lazy-lists-library';
import type { AuditHarness } from '../privacy/audit-harness';

type Harness = AuditHarness<LazyLists>;

/** Recorre todas las páginas, cada una comparada con `'all'`; devuelve los ids y cuántas. */
async function walk(h: Harness, args: Record<string, unknown>): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pages = 1; ; pages += 1) {
    const call = await expectLazyEquivalent(h.serverContext, 'hebra_search', cursor ? { ...args, cursor } : args);
    expect(call.isError).toBe(false);
    ids.push(...(call.json.results as Array<{ id: string }>).map((result) => result.id));
    if (call.json.nextCursor === null) return { ids, pages };
    cursor = call.json.nextCursor as string;
    expect(pages, 'demasiadas páginas').toBeLessThan(100);
  }
}

function sorted(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

describe('hebra_search con privacyLoad lazy: igual que con la biblioteca entera', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('en toda la biblioteca, en páginas pequeñas con ocultas entre medias', async () => {
    h = await lazyListsHarness();
    const { ids, pages } = await walk(h, { query: WORD, limit: 3 });
    expect(sorted(ids)).toEqual(sorted([...h.extra.visibleIds, h.extra.destinoVisibleId]));
    expect(pages).toBeGreaterThan(2);
  });

  it('página por defecto, con `heading`', async () => {
    h = await lazyListsHarness();
    const call = await expectLazyEquivalent(h.serverContext, 'hebra_search', { query: WORD });
    const ids = (call.json.results as Array<{ id: string }>).map((result) => result.id);
    for (const id of [...h.extra.hiddenIds, ...h.extra.trashedIds]) expect(ids).not.toContain(id);
  });

  it('por carpeta, con y sin subcarpetas', async () => {
    h = await lazyListsHarness();
    expect(sorted((await walk(h, { query: WORD, folder: 'Huerto', limit: 2 })).ids)).toEqual(
      sorted(h.extra.visibleHuertoIds)
    );
    expect(sorted((await walk(h, { query: WORD, folder: 'Huerto', subfolders: true, limit: 4 })).ids)).toEqual(
      sorted(h.extra.visibleIds)
    );
  });

  it('por etiqueta', async () => {
    h = await lazyListsHarness();
    const { ids } = await walk(h, { query: WORD, tag: 'verdura', limit: 3 });
    expect(sorted(ids)).toEqual(sorted(h.extra.visibleTaggedIds));
  });

  it('`props`: las ocultas con la misma propiedad no salen', async () => {
    h = await lazyListsHarness();
    const { ids } = await walk(h, { query: WORD, props: [{ key: 'estado', value: 'listo' }], limit: 2 });
    expect(sorted(ids)).toEqual(sorted(h.extra.visibleReadyIds));
  });

  it('`linksTo` con una homónima oculta del destino y enlazantes ocultas', async () => {
    h = await lazyListsHarness();
    const { ids } = await walk(h, { query: WORD, linksTo: ['Destino zanahoria'], limit: 2 });
    expect(sorted(ids)).toEqual(sorted(h.extra.visibleLinkingIds));
  });

  it('`linksTo` a un destino que solo existe oculto: vacía', async () => {
    h = await lazyListsHarness();
    const call = await expectLazyEquivalent(h.serverContext, 'hebra_search', { query: WORD, linksTo: ['Destino oculto'] });
    expect(call.json).toEqual({ results: [], nextCursor: null });
  });

  it('`titleOnly` y `fields` sin `heading`', async () => {
    h = await lazyListsHarness();
    const { ids } = await walk(h, { query: 'Huerto', titleOnly: true, fields: ['title', 'tags'], limit: 3 });
    expect(sorted(ids)).toEqual(sorted(h.extra.visibleHuertoIds));
  });

  it('etiqueta o carpeta privadas, inexistentes, y una búsqueda sin aciertos: vacía', async () => {
    h = await lazyListsHarness();
    for (const args of [
      { query: WORD, tag: 'secreto' },
      { query: WORD, folder: 'Diario' },
      { query: WORD, folder: 'Diario/2026', subfolders: true },
      { query: WORD, tag: 'no-existe' },
      { query: WORD, folder: 'No existe' },
      { query: 'palabraquenoesta' }
    ]) {
      const call = await expectLazyEquivalent(h.serverContext, 'hebra_search', args);
      expect(call.json, JSON.stringify(args)).toEqual({ results: [], nextCursor: null });
    }
  });

  it('bloqueadas sin etiquetas privadas: igual en las dos cargas', async () => {
    h = await lazyListsHarness({ privateFolders: [['diario']], privateTags: [] });
    const { ids } = await walk(h, { query: WORD, folder: 'Huerto', limit: 4 });
    expect(ids.length).toBeGreaterThan(h.extra.visibleHuertoIds.size);
  });
});
