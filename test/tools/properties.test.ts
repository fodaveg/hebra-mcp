/**
 * `hebra_list_properties` y `hebra_query_properties` (D23, SPEC.md §5): el contrato de cada una,
 * sobre la copia sin notas ocultas de `../fixtures/props-library.ts`, con los operadores, el orden
 * y la paginación. Lo que no pueden delatar: `../privacy/properties-oracles.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteLibraryEngine } from '../../src/hebra';
import type { ToolContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import { wrapCursor } from '../../src/server/pagination';
import { runListProperties } from '../../src/server/tools/list-properties';
import { runQueryProperties, type QueryPropertiesInput } from '../../src/server/tools/query-properties';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { grepContext, GREP_PRIVACY } from '../fixtures/grep-library';
import { buildPropsLibraryPair, LONG_VALUE, type PropsLibraryPair } from '../fixtures/props-library';

describe('propiedades del frontmatter', () => {
  let pair: PropsLibraryPair;
  let ctx: ToolContext;
  let close: () => void;

  beforeAll(async () => {
    pair = await buildPropsLibraryPair();
    const opened = await grepContext(pair.withoutPrivate);
    ctx = opened.ctx;
    close = () => opened.port.close();
  });
  afterAll(() => {
    close();
    pair.close();
  });

  const nameOf = (id: string): string =>
    Object.entries(pair.ids).find(([, value]) => value === id)?.[0] ?? id;

  async function names(input: QueryPropertiesInput): Promise<string[]> {
    return (await runQueryProperties(ctx, input)).notes.map((note) => nameOf(note.id));
  }

  describe('hebra_list_properties', () => {
    it('sin `key`, las claves con su recuento de notas, en orden binario', async () => {
      const result = await runListProperties(ctx);
      expect(result).toEqual({
        keys: [
          { key: 'estado', count: 6 },
          { key: 'fecha', count: 1 },
          { key: 'largo', count: 2 },
          { key: 'prioridad', count: 4 },
          { key: 'tipo', count: 1 },
          { key: 'vacia', count: 1 }
        ],
        nextCursor: null
      });
    });

    it('con `key`, los valores con su recuento; una clave en mayúsculas vale, y una sin valor no da ninguno', async () => {
      expect(await runListProperties(ctx, { key: 'Estado' })).toEqual({
        values: [
          { value: 'Activo', count: 1 },
          { value: 'activo', count: 4 },
          { value: 'pausado', count: 1 }
        ],
        nextCursor: null
      });
      expect(await runListProperties(ctx, { key: 'vacia' })).toEqual({ values: [], nextCursor: null });
      expect(await runListProperties(ctx, { key: 'no_existe' })).toEqual({ values: [], nextCursor: null });
    });

    it('pagina las dos listas, también con valores más largos que el tope del cursor', async () => {
      const first = await runListProperties(ctx, { limit: 4 });
      expect('keys' in first && first.keys.map((entry) => entry.key)).toEqual(['estado', 'fecha', 'largo', 'prioridad']);
      const second = await runListProperties(ctx, { limit: 4, cursor: first.nextCursor! });
      expect('keys' in second && second.keys.map((entry) => entry.key)).toEqual(['tipo', 'vacia']);
      expect(second.nextCursor).toBeNull();

      const values = await runListProperties(ctx, { key: 'largo', limit: 1 });
      expect(values.nextCursor!.length).toBeLessThan(2_048);
      const rest = await runListProperties(ctx, { key: 'largo', limit: 1, cursor: values.nextCursor! });
      expect('values' in rest && rest.values).toEqual([{ value: `${LONG_VALUE}b`, count: 1 }]);
    });

    it('un cursor de la otra lista o ilegible es invalid_input', async () => {
      const first = await runListProperties(ctx, { limit: 1 });
      await expect(runListProperties(ctx, { key: 'estado', cursor: first.nextCursor! })).rejects.toBeInstanceOf(ToolError);
      await expect(runListProperties(ctx, { cursor: 'pk1.no-es-un-numero' })).rejects.toBeInstanceOf(ToolError);
    });
  });

  describe('hebra_query_properties', () => {
    it('devuelve id, título, carpeta y los valores de las claves de los filtros y del orden', async () => {
      const { notes, nextCursor } = await runQueryProperties(ctx, {
        filters: [{ key: 'Fecha', op: 'exists' }]
      });
      expect(notes).toEqual([
        { id: pair.ids.gamma, title: 'Gamma', folderPath: 'proyectos/lumbre', properties: { fecha: ['2026-03-01'] } }
      ]);
      expect(nextCursor).toBeNull();
    });

    it('`properties` elige las claves, en orden binario, y `[]` si la nota no tiene valor', async () => {
      const { notes } = await runQueryProperties(ctx, {
        filters: [{ key: 'tipo', op: 'contains', value: 'X' }],
        properties: ['tipo', 'estado', 'fecha']
      });
      expect(notes[0]!.properties).toEqual({ tipo: ['x', 'y'], estado: ['activo'], fecha: [] });
    });

    it('`fields` deja `id` y lo pedido', async () => {
      const { notes } = await runQueryProperties(ctx, {
        filters: [{ key: 'fecha', op: 'exists' }],
        fields: ['title']
      });
      expect(notes).toEqual([{ id: pair.ids.gamma, title: 'Gamma' }]);
    });

    it.each([
      ['equals', { key: 'estado', op: 'equals', value: 'ACTIVO' }, ['alfa', 'beta', 'destino', 'enlaza', 'enlazaOculta', 'enlazaSolo']],
      ['not-equals', { key: 'estado', op: 'not-equals', value: 'activo' }, ['gamma']],
      ['contains', { key: 'estado', op: 'contains', value: 'USA' }, ['gamma']],
      ['not-contains', { key: 'estado', op: 'not-contains', value: 'acti' }, ['gamma']],
      ['greater-than', { key: 'prioridad', op: 'greater-than', value: '9' }, ['beta']],
      ['greater-or-equal', { key: 'prioridad', op: 'greater-or-equal', value: '9' }, ['alfa', 'beta']],
      ['less-than', { key: 'prioridad', op: 'less-than', value: '9' }, ['gamma']],
      ['less-or-equal', { key: 'fecha', op: 'less-or-equal', value: '2026-12-31' }, ['gamma']],
      ['exists: `null` de YAML no es un valor', { key: 'prioridad', op: 'exists' }, ['alfa', 'beta', 'gamma']],
      ['missing', { key: 'estado', op: 'missing' }, ['delta', 'eco', 'largoA', 'largoB']]
    ] as const)('operador %s', async (_name, filter, expected) => {
      expect((await names({ filters: [filter] })).sort()).toEqual([...expected].sort());
    });

    it('varios filtros se combinan con Y, y con la carpeta', async () => {
      expect(await names({ filters: [{ key: 'estado', op: 'equals', value: 'activo' }, { key: 'prioridad', op: 'exists' }] }))
        .toEqual(['alfa', 'beta']);
      const scoped = { filters: [{ key: 'prioridad', op: 'exists' as const }] };
      expect(await names({ ...scoped, folder: 'proyectos' })).toEqual(['beta']);
      expect(await names({ ...scoped, folder: 'proyectos', subfolders: true })).toEqual(['beta', 'gamma']);
      expect(await names({ ...scoped, folder: '' })).toEqual(['alfa']);
      expect(await names({ ...scoped, folder: '', subfolders: true })).toEqual(['alfa', 'beta', 'gamma']);
      expect(await names({ ...scoped, folder: 'no/existe' })).toEqual([]);
    });

    it('por título por defecto; un número se ordena como número y una fecha como texto', async () => {
      expect((await names({})).slice(0, 3)).toEqual(['alfa', 'beta', 'delta']);
      expect(await names({ filters: [{ key: 'prioridad', op: 'exists' }], sort: { key: 'prioridad' } }))
        .toEqual(['gamma', 'alfa', 'beta']);
      expect(await names({ filters: [{ key: 'prioridad', op: 'exists' }], sort: { key: 'prioridad', direction: 'descending' } }))
        .toEqual(['beta', 'alfa', 'gamma']);
    });

    it('sin mayúsculas ni filtros que cambien el modo: el modo se decide con toda la clave', async () => {
      // Solo `alfa` (9) pasa el filtro junto a `beta` (10); el orden sigue siendo numérico.
      expect(await names({
        filters: [{ key: 'estado', op: 'equals', value: 'activo' }],
        sort: { key: 'prioridad', direction: 'descending', empty: 'last' }
      })).toEqual(['beta', 'alfa', 'destino', 'enlaza', 'enlazaSolo', 'enlazaOculta']);
    });

    it('las notas sin la propiedad van al final por título, o al principio con `empty: first`', async () => {
      const last = await names({ sort: { key: 'fecha' } });
      expect(last[0]).toBe('gamma');
      expect(last.slice(1, 3)).toEqual(['alfa', 'beta']);
      const first = await names({ sort: { key: 'fecha', empty: 'first' } });
      expect(first.at(-1)).toBe('gamma');
      expect(first.slice(0, 2)).toEqual(['alfa', 'beta']);
    });

    it.each([
      ['título', null],
      ['título al revés', { key: null, direction: 'descending' }],
      ['número', { key: 'prioridad', direction: 'ascending' }],
      ['número al revés', { key: 'prioridad', direction: 'descending' }],
      ['número, vacías primero', { key: 'prioridad', direction: 'ascending', empty: 'first' }],
      ['texto', { key: 'estado', direction: 'ascending' }],
      ['texto al revés', { key: 'estado', direction: 'descending' }],
      ['varios valores', { key: 'tipo', direction: 'descending' }]
    ] as const)('sin nada oculto, el orden es el del motor: %s', async (_name, sort) => {
      const { db, conn } = openNodeSqliteConn(pair.withoutPrivate);
      try {
        const engine = await SqliteLibraryEngine.open(conn, 'props-orden');
        const fromEngine = engine.propsQuery(null, sort as never, null, 200).items.map((row) => row.id);
        const input = sort === null ? {} : { sort: sort as QueryPropertiesInput['sort'] };
        const page = await runQueryProperties(ctx, { ...input, limit: 100 });
        expect(page.notes.map((note) => nameOf(note.id))).toEqual(fromEngine.map(nameOf));
      } finally {
        db.close();
      }
    });

    it('recorre todas las páginas sin saltar ni repetir, con cada orden', async () => {
      for (const sort of [undefined, { key: 'prioridad' }, { key: 'estado', empty: 'first' as const }, { key: 'largo', direction: 'descending' as const }]) {
        const whole = await names({ sort, limit: 100 });
        const walked: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await runQueryProperties(ctx, { sort, limit: 2, ...(cursor ? { cursor } : {}) });
          walked.push(...page.notes.map((note) => nameOf(note.id)));
          expect((page.nextCursor ?? '').length).toBeLessThan(2_048);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(walked).toEqual(whole);
      }
    });

    it('rechaza una comparación sin valor y un cursor que no vale', async () => {
      await expect(runQueryProperties(ctx, { filters: [{ key: 'estado', op: 'equals' }] })).rejects.toBeInstanceOf(ToolError);
      await expect(runQueryProperties(ctx, { cursor: 'n1.abc' })).rejects.toBeInstanceOf(ToolError);
      const invalid = [
        wrapCursor('pq1', 'no es json'),
        wrapCursor('pq1', JSON.stringify(['t', null, 'a'])),
        wrapCursor('pq1', JSON.stringify(['v', null, 'a', 'id'])),
        wrapCursor('pq1', JSON.stringify(['t', 'x', 'a', 'id']))
      ];
      for (const cursor of invalid) {
        await expect(runQueryProperties(ctx, { cursor })).rejects.toBeInstanceOf(ToolError);
      }
    });

    it('la consulta funciona en un lector de solo lectura', async () => {
      const reader = await grepContext(pair.withoutPrivate, GREP_PRIVACY, 'readOnly');
      try {
        const { notes } = await runQueryProperties(reader.ctx, { filters: [{ key: 'fecha', op: 'exists' }] });
        expect(notes.map((note) => note.id)).toEqual([pair.ids.gamma]);
        const listed = await runListProperties(reader.ctx);
        expect('keys' in listed && listed.keys.length).toBe(6);
      } finally {
        reader.port.close();
      }
    });
  });
});
