/**
 * `hebra_search` no le pasa nunca al motor un par de `props` con valor: los comprueba
 * `searchCheckingValues` (`src/store/search-safe.ts`) sobre cada página de la búsqueda interna, y la
 * rama de subcadenas lleva `linksTo` en su SQL. Aquí se compara con el motor, llamándolo directamente
 * con el par con valor: el mismo orden, el mismo cursor y los mismos resultados, caso a caso.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SearchFilters, SearchPage, SqliteLibraryEngine } from '../../src/hebra';
import { auditHarness, createNote } from '../privacy/audit-harness';

const FILTERS: Array<[string, SearchFilters]> = [
  ['clave con valor', { props: [{ key: 'ciudad', value: 'madrid' }] }],
  ['valor sin acentos contra uno con ellos', { props: [{ key: 'ciudad', value: 'cadiz' }] }],
  ['valor con acentos y mayúsculas', { props: [{ key: 'ciudad', value: 'CÁDIZ' }] }],
  ['clave en mayúsculas', { props: [{ key: 'CIUDAD', value: 'cádiz' }] }],
  ['ñ y diéresis', { props: [{ key: 'ciudad', value: 'pinguino nono' }] }],
  ['un trozo del valor no vale', { props: [{ key: 'ciudad', value: 'cad' }] }],
  ['que tenga la clave', { props: [{ key: 'ciudad', value: null }] }],
  ['clave definida sin valor', { props: [{ key: 'vacia', value: null }] }],
  ['valor vacío', { props: [{ key: 'vacia', value: '' }] }],
  ['clave que no existe', { props: [{ key: 'no_existe', value: null }] }],
  ['varias a la vez', { props: [{ key: 'ciudad', value: 'cadiz' }, { key: 'estado', value: 'activo' }] }],
  ['con varios valores', { props: [{ key: 'tipo', value: 'y' }] }],
  ['enlace por título', { linksTo: ['Destino'] }],
  ['enlace sin mayúsculas', { linksTo: ['destino'] }],
  ['enlace con título sin acentos', { linksTo: ['cafe'] }],
  ['enlace con título con acentos', { linksTo: ['CAFÉ'] }],
  ['homónimas', { linksTo: ['Doble'] }],
  ['enlace a sí misma', { linksTo: ['Sí misma'] }],
  ['título que nadie tiene', { linksTo: ['No existe'] }],
  ['título vacío', { linksTo: [''] }],
  ['dos títulos', { linksTo: ['Destino', 'cafe'] }],
  ['un título que falta entre dos', { linksTo: ['Destino', 'No existe'] }],
  ['propiedad y enlace', { props: [{ key: 'estado', value: 'activo' }], linksTo: ['Destino'] }],
  ['solo título', { titleOnly: true }],
  ['solo título y propiedad', { titleOnly: true, props: [{ key: 'ciudad', value: null }] }],
  ['solo título y enlace', { titleOnly: true, linksTo: ['Destino'] }]
];

async function library() {
  return auditHarness(async (engine) => {
    await createNote(engine, null, '# Destino\ncuerpo\n');
    await createNote(engine, null, '# Café\ncuerpo\n');
    const one = await createNote(engine, null, '# Doble\nprimera\n');
    await createNote(engine, null, '# Doble\nsegunda\n');
    const bodies = [
      '---\nciudad: Madrid\nestado: activo\n---\n# Garbanzos uno\ngarbanzos [[Destino]]\n',
      '---\nciudad: Cádiz\nestado: activo\n---\n# Garbanzos dos\ngarbanzos [[Café]] [[Destino]]\n',
      '---\nciudad: CADIZ\nestado: pausado\n---\n# Garbanzos tres\ngarbanzos [[cafe]]\n',
      '---\nciudad: cádiz\n---\n# Garbanzos cuatro\ngarbanzos [[Doble]]\n',
      `---\nciudad: Pingüino ñoño\n---\n# Garbanzos cinco\ngarbanzos [[id:${one.id}]]\n`,
      '---\nvacia:\ntipo:\n  - x\n  - y\n---\n# Garbanzos seis\ngarbanzos\n',
      '# Garbanzos siete\ngarbanzos sin nada\n',
      '# Sí misma\ngarbanzos [[Sí misma]]\n'
    ];
    for (const body of bodies) await createNote(engine, null, body);
  });
}

const ids = (page: { items: Array<{ id: string }> }): string[] => page.items.map((item) => item.id).sort();

describe('la rama de subcadenas aplica `props` y `linksTo` como el motor', () => {
  it.each(FILTERS)('%s', async (_name, filters) => {
    const h = await library();
    try {
      for (const query of ['arbanz', 'garbanzos', 'anzos -siete']) {
        const safe = await h.port.search(query, null, 50, filters, null);
        const engine = await h.port.search(query, null, 50, filters, null, { embedded: true });
        expect(ids(safe), query).toEqual(ids(engine));
      }
    } finally {
      await h.close();
    }
  });

  it('los casos no están vacíos: hay de los dos', async () => {
    const h = await library();
    try {
      const counts = new Map<string, number>();
      for (const [name, filters] of FILTERS) {
        counts.set(name, (await h.port.search('arbanz', null, 50, filters, null)).items.length);
      }
      expect(counts.get('valor sin acentos contra uno con ellos')).toBe(3);
      expect(counts.get('ñ y diéresis')).toBe(1);
      expect(counts.get('enlace con título sin acentos')).toBeGreaterThan(0);
      expect(counts.get('un trozo del valor no vale')).toBe(0);
    } finally {
      await h.close();
    }
  });

  it.each(FILTERS.filter(([, filters]) => filters.props?.some((prop) => prop.value !== null)))(
    'comprobar los pares fuera del motor da su mismo orden, cursor y resultados, por los dos caminos: %s',
    async (_name, filters) => {
      const h = await library();
      try {
        const { engine } = h.port as unknown as { engine: SqliteLibraryEngine };
        for (const embedded of [true, false]) {
          for (const query of ['garbanzos', 'arbanz', '', '   ']) {
            for (const want of [1, 2, 50]) {
              const label = `${embedded ? 'motor' : 'segura'} ${JSON.stringify(query)} ${want}`;
              let cursor: string | null = null;
              do {
                const own: SearchPage = await h.port.search(query, cursor, want, filters, null, { embedded });
                const direct: SearchPage = await engine.search(query, cursor, want, filters, null);
                expect(own.items.map((item) => item.id), label).toEqual(direct.items.map((item) => item.id));
                expect(own.nextCursor, label).toBe(direct.nextCursor);
                cursor = own.nextCursor;
              } while (cursor);
            }
          }
        }
      } finally {
        await h.close();
      }
    }
  );

  it('no recorre la búsqueda sin texto del motor: una consulta por página, con y sin filtros', async () => {
    const h = await library();
    try {
      const engine = (h.port as unknown as { engine: SqliteLibraryEngine }).engine;
      const search = vi.spyOn(engine, 'search');
      try {
        await h.port.search('arbanz', null, 2, { props: [{ key: 'ciudad', value: 'cadiz' }], linksTo: ['Destino'] }, null);
        expect(search).toHaveBeenCalledTimes(1);
        expect(search.mock.calls[0]![0]).toBe('arbanz');
      } finally {
        search.mockRestore();
      }
    } finally {
      await h.close();
    }
  });
});
