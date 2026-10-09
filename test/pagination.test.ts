/**
 * Paginación común (`src/server/pagination.ts`, SPEC.md §5): unitarios sobre un almacén
 * simulado con notas OCULTAS intercaladas, para fijar que la página no delata cuántas
 * hay ni dónde están.
 */
import { describe, expect, it } from 'vitest';
import {
  effectiveLimit,
  fillPage,
  pickFields,
  sliceAfterKey,
  slicePage,
  STORE_PAGE_MAX,
  storePageSize,
  unwrapCursor,
  wrapCursor
} from '../src/server/pagination';

interface Item {
  id: string;
  hidden: boolean;
}

/** Almacén de juguete: páginas de `size`, cursor = índice del último elemento ya visto. */
function fakeStore(items: Item[], size: number) {
  return async (cursor: string | null) => {
    const start = cursor === null ? 0 : Number(cursor) + 1;
    const slice = items.slice(start, start + size);
    const end = start + slice.length - 1;
    return { items: slice, nextCursor: start + slice.length < items.length ? String(end) : null };
  };
}

function build(pattern: string): Item[] {
  return [...pattern].map((c, i) => ({ id: `n${i}`, hidden: c === 'h' }));
}

async function pageThrough(items: Item[], limit: number, storePage = 2) {
  const pages: string[][] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const page: { items: string[]; lastCursor: string | null } = await fillPage({
      limit,
      startCursor: cursor,
      fetch: fakeStore(items, storePage),
      accept: (item) => (item.hidden ? undefined : item.id),
      cursorAfter: (item) => String(items.indexOf(item))
    });
    pages.push(page.items);
    if (page.lastCursor === null) return pages;
    cursor = page.lastCursor;
  }
  throw new Error('no termina');
}

describe('fillPage', () => {
  it('rellena hasta `limit` con visibles, salte las ocultas que salte', async () => {
    const pages = await pageThrough(build('hvhhvhvh'), 2);
    expect(pages).toEqual([['n1', 'n4'], ['n6']]);
  });

  it('el reparto en páginas no depende de dónde están las ocultas', async () => {
    const shapeA = (await pageThrough(build('vhhhhvhhvhhv'), 2)).map((page) => page.length);
    const shapeB = (await pageThrough(build('vvvvhhhhhhhh'), 2)).map((page) => page.length);
    expect(shapeA).toEqual([2, 2]);
    // mismas 4 visibles, ocultas repartidas distinto: mismas páginas, ninguna vacía de cola
    expect(shapeB).toEqual(shapeA);
  });

  it('sin más visibles tras la página no hay cursor, aunque queden ocultas', async () => {
    const pages = await pageThrough(build('vvhhhh'), 2);
    expect(pages).toEqual([['n0', 'n1']]);
  });

  it('una biblioteca solo de ocultas da una página vacía y sin cursor', async () => {
    expect(await pageThrough(build('hhh'), 5)).toEqual([[]]);
  });

  it('pide al almacén lo que falta más uno, y `storePageSize` lo acota al máximo del motor', async () => {
    const wants: number[] = [];
    const items = build('hhvhhvhvvv');
    const store = fakeStore(items, 2);
    const page = await fillPage({
      limit: 3,
      startCursor: null,
      fetch: (cursor, want) => {
        wants.push(want);
        return store(cursor);
      },
      accept: (item) => (item.hidden ? undefined : item.id),
      cursorAfter: (item) => String(items.indexOf(item))
    });
    expect(page.items).toEqual(['n2', 'n5', 'n7']);
    // limit + 1 la primera vez; luego lo que falta + 1 (sin depender de cuántas ocultas hay
    // por el camino: solo de lo ya aceptado).
    expect(wants).toEqual([4, 4, 3, 2, 1]);
    expect(storePageSize(Number.POSITIVE_INFINITY)).toBe(STORE_PAGE_MAX);
    expect(storePageSize(101)).toBe(101);
    expect(storePageSize(0)).toBe(1);
    expect(storePageSize(10_000)).toBe(200);
  });
});

describe('cursores', () => {
  it('envuelve y desenvuelve, y rechaza el de otra herramienta o uno ilegible', () => {
    const cursor = wrapCursor('s1', '123:abc:def');
    expect(unwrapCursor('s1', cursor)).toBe('123:abc:def');
    expect(() => unwrapCursor('n1', cursor)).toThrowError();
    expect(() => unwrapCursor('s1', 's1.***')).toThrowError();
    expect(() => unwrapCursor('s1', 'suelto')).toThrowError();
  });

  it('`limit` se acota y sin él vale el defecto (o todo)', () => {
    expect(effectiveLimit(undefined, { default: 20, max: 50 })).toBe(20);
    expect(effectiveLimit(undefined, { default: null, max: 50 })).toBe(Infinity);
    expect(effectiveLimit(999, { default: 20, max: 50 })).toBe(50);
    expect(effectiveLimit(0, { default: 20, max: 50 })).toBe(1);
  });
});

describe('slicePage', () => {
  const all = ['a', 'b', 'c', 'd', 'e'];

  it('por clave: recorre la lista y termina con null', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = slicePage(all, 't1', { limit: 2, cursor, keyOf: (x) => x });
      seen.push(...page.items);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(all);
  });

  it('sin `limit` (Infinity) devuelve todo y sin cursor', () => {
    expect(slicePage(all, 't1', { limit: Infinity })).toEqual({ items: all, nextCursor: null });
  });

  it('una clave que ya no está: invalid_input', () => {
    const cursor = wrapCursor('t1', 'zzz');
    expect(() => slicePage(all, 't1', { limit: 2, cursor, keyOf: (x) => x })).toThrowError();
  });

  it('por posición cuando no hay clave', () => {
    const first = slicePage(all, 'l1', { limit: 3 });
    const second = slicePage(all, 'l1', { limit: 3, cursor: first.nextCursor! });
    expect(second).toEqual({ items: ['d', 'e'], nextCursor: null });
  });
});

describe('sliceAfterKey (cursor posicional por clave de orden, D10)', () => {
  const sorted = ['b', 'd', 'f', 'h'];
  const page = (limit: number, after: string | null, list = sorted) =>
    sliceAfterKey(list, {
      limit,
      after,
      keyOf: (item) => item,
      compare: (left, right) => (left < right ? -1 : left > right ? 1 : 0)
    });

  it('recorre la lista y la última clave es null solo cuando no queda nada detrás', () => {
    expect(page(2, null)).toEqual({ items: ['b', 'd'], lastKey: 'd' });
    expect(page(2, 'd')).toEqual({ items: ['f', 'h'], lastKey: null });
    expect(page(3, null)).toEqual({ items: ['b', 'd', 'f'], lastKey: 'f' });
    expect(page(4, null)).toEqual({ items: sorted, lastKey: null });
    expect(page(Infinity, null)).toEqual({ items: sorted, lastKey: null });
  });

  it('una clave que ya no está en la lista no es un error: sigue por donde tocaba', () => {
    // `d` se quitó entre dos páginas (el fichero se fue a la papelera).
    expect(page(2, 'd', ['b', 'f', 'h'])).toEqual({ items: ['f', 'h'], lastKey: null });
    // Una clave entre dos elementos, antes del primero o después del último.
    expect(page(1, 'e')).toEqual({ items: ['f'], lastKey: 'f' });
    expect(page(1, 'a')).toEqual({ items: ['b'], lastKey: 'b' });
    expect(page(2, 'z')).toEqual({ items: [], lastKey: null });
    expect(page(2, 'h')).toEqual({ items: [], lastKey: null });
    expect(page(2, null, [])).toEqual({ items: [], lastKey: null });
  });
});

describe('pickFields', () => {
  it('deja `id` y lo pedido, y sin `fields` no toca nada', () => {
    const item = { id: 'x', title: 't', tags: ['a'] };
    expect(pickFields(item, ['title'])).toEqual({ id: 'x', title: 't' });
    expect(pickFields(item, undefined)).toBe(item);
  });
});
