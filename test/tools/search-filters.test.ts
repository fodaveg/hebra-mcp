/**
 * `hebra_search` con `props`, `linksTo` y `titleOnly` (D23, SPEC.md §5): pasan a `SearchFilters`
 * del motor, en las dos búsquedas (la del motor entera, sin nada privado, y la de solo título y
 * cuerpo, `src/store/search-safe.ts`, con su rama de subcadenas). Lo que no pueden delatar:
 * `../privacy/properties-oracles.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/server/context';
import { runSearch } from '../../src/server/tools/search';
import type { PrivacyConfig } from '../../src/privacy';
import { grepContext, GREP_PRIVACY } from '../fixtures/grep-library';
import { buildPropsLibraryPair, SHARED_TITLE, type PropsLibraryPair } from '../fixtures/props-library';

const OPEN: PrivacyConfig = { privateFolders: [], privateTags: [] };

describe('hebra_search con filtros de propiedad y enlace', () => {
  let pair: PropsLibraryPair;
  const contexts: Record<string, ToolContext> = {};
  const closers: Array<() => void> = [];

  beforeAll(async () => {
    pair = await buildPropsLibraryPair();
    // Sobre la copia sin ocultas: con privados configurados va por la búsqueda segura, sin ellos
    // por la del motor, y las dos tienen que dar lo mismo.
    for (const [name, config] of [['segura', GREP_PRIVACY], ['motor', OPEN]] as const) {
      const opened = await grepContext(pair.withoutPrivate, config);
      contexts[name] = opened.ctx;
      closers.push(() => opened.port.close());
    }
  });
  afterAll(() => {
    for (const close of closers) close();
    pair.close();
  });

  const nameOf = (id: string | undefined): string =>
    Object.entries(pair.ids).find(([, value]) => value === id)?.[0] ?? String(id);

  describe.each(['segura', 'motor'])('búsqueda %s', (name) => {
    async function names(input: Parameters<typeof runSearch>[1]): Promise<string[]> {
      const { results } = await runSearch(contexts[name]!, input);
      return results.map((result) => nameOf(result.id)).sort();
    }

    it('`props` con valor: el valor entero, sin mayúsculas ni tildes', async () => {
      expect(await names({ query: 'garbanzos', props: [{ key: 'ESTADO', value: 'activo' }] }))
        .toEqual(['alfa', 'beta', 'destino', 'enlaza', 'enlazaOculta', 'enlazaSolo']);
      expect(await names({ query: 'garbanzos', props: [{ key: 'estado', value: 'act' }] })).toEqual([]);
    });

    it('`props` con `null`: que tenga la clave, también definida sin valor', async () => {
      expect(await names({ query: 'garbanzos', props: [{ key: 'prioridad', value: null }] })).toEqual(['alfa', 'beta']);
      expect(await names({ query: 'garbanzos', props: [{ key: 'no_existe', value: null }] })).toEqual([]);
    });

    it('`props` se aplica a lo que casa por subcadena', async () => {
      expect(await names({ query: 'arbanz', props: [{ key: 'prioridad', value: '9' }] })).toEqual(['alfa']);
      expect(await names({ query: 'arbanz', props: [{ key: 'no_existe', value: null }] })).toEqual([]);
    });

    it('`linksTo`: por título entero, sin mayúsculas, y una nota no se enlaza a sí misma', async () => {
      expect(await names({ query: 'garbanzos', linksTo: ['destino'] })).toEqual(['enlaza']);
      expect(await names({ query: 'arbanz', linksTo: [SHARED_TITLE] })).toEqual(['enlaza']);
      expect(await names({ query: 'garbanzos', linksTo: ['Enlaza'] })).toEqual([]);
    });

    it('`linksTo` con un id no vale: espera un título', async () => {
      expect(await names({ query: 'garbanzos', linksTo: [pair.ids.destino] })).toEqual([]);
    });

    it('varios `linksTo` y `props` se combinan con Y', async () => {
      expect(await names({ query: 'garbanzos', linksTo: [SHARED_TITLE, 'No existe'] })).toEqual([]);
      expect(await names({ query: 'garbanzos', linksTo: [SHARED_TITLE], props: [{ key: 'estado', value: 'pausado' }] })).toEqual([]);
      expect(await names({
        query: 'garbanzos',
        props: [{ key: 'estado', value: 'activo' }, { key: 'prioridad', value: '10' }]
      })).toEqual(['beta']);
    });

    it('`titleOnly` busca solo en el título, también por subcadena', async () => {
      expect(await names({ query: 'alfa', titleOnly: true })).toEqual(['alfa']);
      expect(await names({ query: 'garbanzos', titleOnly: true })).toEqual([]);
      expect(await names({ query: 'lf', titleOnly: true })).toEqual([]);
      expect(await names({ query: 'alf', titleOnly: true })).toEqual(['alfa']);
      expect(await names({ query: 'nlaz', titleOnly: true })).toEqual(['enlaza', 'enlazaOculta', 'enlazaSolo']);
      expect(await names({ query: 'arbanz', titleOnly: true })).toEqual([]);
    });
  });

  it('sin estos parámetros, ni un filtro de más ni una consulta de más', async () => {
    const ctx = contexts.segura!;
    const search = vi.spyOn(ctx.port, 'search');
    const byTitle = vi.spyOn(ctx.port, 'notesByFoldedTitle');
    const backlinks = vi.spyOn(ctx.port, 'backlinks');
    try {
      await runSearch(ctx, { query: 'garbanzos' });
      expect(search.mock.calls[0]![3]).toEqual({});
      expect(byTitle).not.toHaveBeenCalled();
      expect(backlinks).not.toHaveBeenCalled();
    } finally {
      search.mockRestore();
      byTitle.mockRestore();
      backlinks.mockRestore();
    }
  });

  it('`linksTo` pagina con el mismo cursor de siempre', async () => {
    const ctx = contexts.segura!;
    const first = await runSearch(ctx, { query: 'garbanzos', props: [{ key: 'estado', value: 'activo' }], limit: 2 });
    expect(first.results).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await runSearch(ctx, {
      query: 'garbanzos',
      props: [{ key: 'estado', value: 'activo' }],
      limit: 100 > 50 ? 50 : 50,
      cursor: first.nextCursor!
    });
    const ids = [...first.results, ...second.results].map((result) => nameOf(result.id)).sort();
    expect(ids).toEqual(['alfa', 'beta', 'destino', 'enlaza', 'enlazaOculta', 'enlazaSolo']);
  });
});
