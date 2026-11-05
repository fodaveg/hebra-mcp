/**
 * Arreglos de la revisión de D23 en propiedades y búsqueda (SPEC.md §5, §6.3): lo que cuesta una
 * llamada y lo que puede delatar un resto o un cambio entre páginas. Sin medir tiempos: cuentan
 * filas que llegan a JS, consultas y caracteres. Las medidas en ms están en SPEC.md §6.3.
 */
import { StatementSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivacyConfig } from '../../src/privacy';
import { PROPERTIES_RESPONSE_MAX_CHARS } from '../../src/store/props-limits';
import { auditHarness, createNote, lockedBody, saveBody } from './audit-harness';

const NO_TAGS: PrivacyConfig = { privateFolders: [['diario']], privateTags: [] };
const OPEN: PrivacyConfig = { privateFolders: [], privateTags: [] };

/** Cuenta las filas de `note_props` que llegan a JS por cualquiera de las dos vías de `node:sqlite`. */
function countPropRows(): { rows: () => number; plans: () => string[]; restore: () => void } {
  let rows = 0;
  const statements = new Set<string>();
  const onNoteProps = (statement: StatementSync): boolean => statement.sourceSQL.includes('note_props');
  type Bound = (...args: unknown[]) => unknown;
  const originalAll = StatementSync.prototype.all as unknown as Bound;
  const originalIterate = StatementSync.prototype.iterate as unknown as Bound;
  const all = vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (this: StatementSync, ...args: unknown[]) {
    const result = originalAll.apply(this, args) as unknown[];
    if (onNoteProps(this)) {
      rows += result.length;
      statements.add(this.sourceSQL);
    }
    return result;
  } as never);
  const iterate = vi.spyOn(StatementSync.prototype, 'iterate').mockImplementation(function (this: StatementSync, ...args: unknown[]) {
    const inner = originalIterate.apply(this, args) as Iterator<unknown>;
    if (!onNoteProps(this)) return inner;
    statements.add(this.sourceSQL);
    return {
      next() {
        const step = inner.next();
        if (!step.done) rows += 1;
        return step;
      },
      return() {
        return inner.return?.() ?? { done: true, value: undefined };
      },
      [Symbol.iterator]() {
        return this;
      }
    };
  } as never);
  return {
    rows: () => rows,
    plans: () => [...statements],
    restore: () => {
      all.mockRestore();
      iterate.mockRestore();
    }
  };
}

describe('hebra_list_properties no trae las filas a JS', () => {
  it('una página de 2 claves lee 3 filas agrupadas, sin ordenar aparte, con 300 claves en 3 notas', async () => {
    const frontmatter = Array.from({ length: 300 }, (_, index) => `clave${String(index).padStart(3, '0')}: v`).join('\n');
    const h = await auditHarness(async (engine) => {
      for (const title of ['Una', 'Dos', 'Tres']) await createNote(engine, null, `---\n${frontmatter}\n---\n# ${title}\n`);
    });
    const counter = countPropRows();
    try {
      const first = await h.call('hebra_list_properties', { limit: 2 });
      expect(first.json.keys).toEqual([{ key: 'clave000', count: 3 }, { key: 'clave001', count: 3 }]);
      expect(counter.rows()).toBe(3);
      const second = await h.call('hebra_list_properties', { limit: 2, cursor: first.json.nextCursor });
      expect(second.json.keys.map((entry: { key: string }) => entry.key)).toEqual(['clave002', 'clave003']);
      expect(counter.rows()).toBe(6);
      const db = (h.port as unknown as { db: { prepare(sql: string): StatementSync } }).db;
      counter.restore();
      for (const sql of counter.plans().filter((text) => text.includes('GROUP BY'))) {
        const explain = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('[]', 1, 0) as Array<{ detail: string }>;
        const plan = explain.map((row) => row.detail).join('\n');
        expect(plan).toContain('note_props_by_key_value');
        expect(plan).not.toContain('TEMP B-TREE FOR GROUP BY');
        expect(plan).not.toContain('TEMP B-TREE FOR ORDER BY');
      }
    } finally {
      counter.restore();
      await h.close();
    }
  });

  it('los valores de una clave se agrupan igual: 3 filas para una página de 2 entre 200 valores', async () => {
    const list = Array.from({ length: 200 }, (_, index) => `  - v${String(index).padStart(3, '0')}`).join('\n');
    const h = await auditHarness(async (engine) => {
      await createNote(engine, null, `---\nmuchos:\n${list}\n---\n# Una\n`);
    });
    const counter = countPropRows();
    try {
      const first = await h.call('hebra_list_properties', { key: 'muchos', limit: 2 });
      expect(first.json.values).toEqual([{ value: 'v000', count: 1 }, { value: 'v001', count: 1 }]);
      expect(counter.rows()).toBe(3);
    } finally {
      counter.restore();
      await h.close();
    }
  });

  it('el tope de caracteres corta la página con `nextCursor`, sin perder ni repetir nada', async () => {
    const values = Array.from({ length: 30 }, (_, index) => `${String(index).padStart(2, '0')}${'x'.repeat(8_000)}`);
    const h = await auditHarness(async (engine, _library, db) => {
      const note = await createNote(engine, null, '# Larga\n');
      const insert = db.prepare('INSERT INTO note_props(note_id, key, value) VALUES (?, ?, ?)');
      for (const value of values) insert.run(note.id, 'larga', value);
    });
    try {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await h.call('hebra_list_properties', { key: 'larga', limit: 500, ...(cursor ? { cursor } : {}) });
        expect(page.json.values.length).toBeGreaterThan(0);
        expect(page.raw.length).toBeLessThanOrEqual(PROPERTIES_RESPONSE_MAX_CHARS + 200);
        seen.push(...page.json.values.map((entry: { value: string }) => entry.value));
        cursor = page.json.nextCursor ?? undefined;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toEqual(values);
    } finally {
      await h.close();
    }
  });

  it('un elemento más largo que el tope sale solo, y la página no se queda vacía', async () => {
    const big = `a${'x'.repeat(PROPERTIES_RESPONSE_MAX_CHARS + 500)}`;
    const h = await auditHarness(async (engine, _library, db) => {
      const note = await createNote(engine, null, '# Larga\n');
      const insert = db.prepare('INSERT INTO note_props(note_id, key, value) VALUES (?, ?, ?)');
      insert.run(note.id, 'larga', big);
      insert.run(note.id, 'larga', 'b');
    });
    try {
      const first = await h.call('hebra_list_properties', { key: 'larga' });
      expect(first.json.values).toEqual([{ value: big, count: 1 }]);
      expect(first.json.nextCursor).not.toBeNull();
      const second = await h.call('hebra_list_properties', { key: 'larga', cursor: first.json.nextCursor });
      expect(second.json).toEqual({ values: [{ value: 'b', count: 1 }], nextCursor: null });
    } finally {
      await h.close();
    }
  });
});

describe('hebra_query_properties no guarda los valores de todas las notas', () => {
  it('ordenar por una clave de muchos valores no trae más que una página de valores en memoria', async () => {
    const list = Array.from({ length: 500 }, (_, index) => `  - v${String(index).padStart(3, '0')}`).join('\n');
    const h = await auditHarness(async (engine) => {
      await createNote(engine, null, `---\nmuchos:\n${list}\n---\n# Una\n`);
      await createNote(engine, null, `---\nmuchos:\n${list}\n---\n# Dos\n`);
    });
    const allSpy = vi.spyOn(StatementSync.prototype, 'all');
    try {
      const page = await h.call('hebra_query_properties', { sort: { key: 'muchos' }, limit: 1, fields: ['title'] });
      expect(page.json.notes).toHaveLength(1);
      const onProps = allSpy.mock.contexts.filter((statement) => (statement as StatementSync).sourceSQL.includes('FROM note_props'));
      expect(onProps).toEqual([]);
    } finally {
      allSpy.mockRestore();
      await h.close();
    }
  });

  it('el tope de caracteres corta la página entre notas, con `nextCursor`', async () => {
    const h = await auditHarness(async (engine, _library, db) => {
      const insert = db.prepare('INSERT INTO note_props(note_id, key, value) VALUES (?, ?, ?)');
      for (const title of ['Una', 'Dos', 'Tres']) {
        const note = await createNote(engine, null, `---\nmarca: si\n---\n# ${title}\n`);
        for (let index = 0; index < 8; index += 1) insert.run(note.id, 'larga', `${index}${'x'.repeat(8_000)}`);
      }
    });
    try {
      const args = { filters: [{ key: 'marca', op: 'exists' }], properties: ['larga'], limit: 100 };
      const first = await h.call('hebra_query_properties', args);
      expect(first.json.notes.length).toBeLessThan(3);
      expect(first.json.notes.length).toBeGreaterThan(0);
      expect(first.json.nextCursor).not.toBeNull();
      for (const note of first.json.notes) expect(note.properties.larga).toHaveLength(8);
      const titles = first.json.notes.map((note: { title: string }) => note.title);
      let cursor = first.json.nextCursor;
      while (cursor) {
        const page = await h.call('hebra_query_properties', { ...args, cursor });
        titles.push(...page.json.notes.map((note: { title: string }) => note.title));
        cursor = page.json.nextCursor;
      }
      expect(titles).toEqual(['Dos', 'Tres', 'Una']);
    } finally {
      await h.close();
    }
  });
});

describe('el modo del orden cambia entre dos páginas', () => {
  const values = (notes: Array<{ properties: { rank: string[] } }>): string[] => notes.flatMap((note) => note.properties.rank);
  const query = { filters: [{ key: 'marca', op: 'exists' }], sort: { key: 'rank' }, properties: ['rank'], limit: 1 };

  async function numericLibrary() {
    return auditHarness(async (engine) => {
      for (const rank of ['2', '10', '20']) await createNote(engine, null, `---\nmarca: si\nrank: ${rank}\n---\n# Rango ${rank}\n`);
    });
  }

  it('de número a texto, por un valor visible de una nota ajena al filtro: invalid_input, no se pierde el 10', async () => {
    const h = await numericLibrary();
    try {
      const first = await h.call('hebra_query_properties', query);
      expect(values(first.json.notes)).toEqual(['2']);
      await h.mutate(async (engine) => createNote(engine, null, '---\nrank: texto\n---\n# Ajena\n'));
      const next = await h.call('hebra_query_properties', { ...query, cursor: first.json.nextCursor });
      expect(next.isError).toBe(true);
      expect(next.json).toMatchObject({ error: 'invalid_input' });
    } finally {
      await h.close();
    }
  });

  it('de texto a número, al desaparecer el único valor de texto: invalid_input', async () => {
    const h = await auditHarness(async (engine) => {
      for (const rank of ['10', '9']) await createNote(engine, null, `---\nmarca: si\nrank: ${rank}\n---\n# Rango ${rank}\n`);
      return (await createNote(engine, null, '---\nrank: texto\n---\n# Ajena\n')).id;
    });
    try {
      const first = await h.call('hebra_query_properties', query);
      expect(values(first.json.notes)).toEqual(['10']);
      await h.mutate(async (engine) => saveBody(engine, h.extra, '---\nrank: 30\n---\n# Ajena\n'));
      const next = await h.call('hebra_query_properties', { ...query, cursor: first.json.nextCursor });
      expect(next.isError).toBe(true);
      expect(next.json).toMatchObject({ error: 'invalid_input' });
      // Volviendo a empezar, el orden nuevo sale entero.
      const again = await h.call('hebra_query_properties', { ...query, limit: 10 });
      expect(values(again.json.notes)).toEqual(['9', '10']);
    } finally {
      await h.close();
    }
  });

  it('un valor en una nota oculta no cambia el modo ni da error: la página siguiente sigue en su sitio', async () => {
    const h = await numericLibrary();
    try {
      const first = await h.call('hebra_query_properties', query);
      await h.mutate(async (engine) => createNote(engine, null, '---\nrank: texto\n---\n# Oculta\n#secreto\n'));
      const second = await h.call('hebra_query_properties', { ...query, cursor: first.json.nextCursor });
      expect(second.isError).toBe(false);
      expect(values(second.json.notes)).toEqual(['10']);
      const third = await h.call('hebra_query_properties', { ...query, cursor: second.json.nextCursor });
      expect(values(third.json.notes)).toEqual(['20']);
      expect(third.json.nextCursor).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('un cursor de la parte sin valor no depende del modo', async () => {
    const h = await auditHarness(async (engine) => {
      await createNote(engine, null, '---\nmarca: si\nrank: 1\n---\n# Con rango\n');
      await createNote(engine, null, '---\nmarca: si\n---\n# Sin rango A\n');
      await createNote(engine, null, '---\nmarca: si\n---\n# Sin rango B\n');
    });
    try {
      const first = await h.call('hebra_query_properties', query);
      const second = await h.call('hebra_query_properties', { ...query, cursor: first.json.nextCursor });
      expect(second.json.notes[0].title).toBe('Sin rango A');
      await h.mutate(async (engine) => createNote(engine, null, '---\nrank: texto\n---\n# Ajena\n'));
      const third = await h.call('hebra_query_properties', { ...query, cursor: second.json.nextCursor });
      expect(third.json.notes[0].title).toBe('Sin rango B');
    } finally {
      await h.close();
    }
  });
});

describe('una fila de `note_props` de una nota bloqueada no cuenta', () => {
  const LOCKED_TITLE = 'Bloqueada con resto';
  let h: Awaited<ReturnType<typeof scenario>>;

  async function scenario(config: PrivacyConfig) {
    return auditHarness(async (engine, _library, db) => {
      const note = await createNote(engine, null, lockedBody(LOCKED_TITLE, []));
      db.prepare('INSERT INTO note_props(note_id, key, value) VALUES (?, ?, ?)').run(note.id, 'resto', 'cebo_resto');
      return note.id;
    }, config);
  }

  beforeEach(async () => {
    h = await scenario(NO_TAGS);
  });
  afterEach(async () => {
    await h.close();
  });

  const ids = (notes: Array<{ id: string }>): string[] => notes.map((note) => note.id);

  it('hebra_query_properties: el mismo resultado con el valor acertado y con otro', async () => {
    for (const filter of [
      { key: 'resto', op: 'equals', value: 'cebo_resto' },
      { key: 'resto', op: 'equals', value: 'otro' },
      { key: 'resto', op: 'contains', value: 'cebo' },
      { key: 'resto', op: 'exists' },
      { key: 'resto', op: 'not-equals', value: 'otro' }
    ]) {
      const found = await h.call('hebra_query_properties', { filters: [filter], limit: 100 });
      expect(found.json.notes, JSON.stringify(filter)).toEqual([]);
    }
  });

  it('sigue saliendo como una nota sin propiedades: sin filtros, con `missing` y por título', async () => {
    const all = await h.call('hebra_query_properties', { limit: 100, properties: ['resto'] });
    const mine = all.json.notes.find((note: { id: string }) => note.id === h.extra);
    expect(mine).toMatchObject({ title: LOCKED_TITLE, properties: { resto: [] } });
    expect(all.raw).not.toContain('cebo_resto');
    const missing = await h.call('hebra_query_properties', { filters: [{ key: 'resto', op: 'missing' }], limit: 100 });
    expect(ids(missing.json.notes)).toContain(h.extra);
    const byTitle = await h.call('hebra_query_properties', { filters: [{ key: 'note.title', op: 'equals', value: LOCKED_TITLE }] });
    expect(ids(byTitle.json.notes)).toEqual([h.extra]);
    const byTitleAndValue = await h.call('hebra_query_properties', {
      filters: [{ key: 'note.title', op: 'equals', value: LOCKED_TITLE }, { key: 'resto', op: 'exists' }]
    });
    expect(byTitleAndValue.json.notes).toEqual([]);
  });

  it('ordenar por esa clave no la pone entre las que tienen valor ni cambia el modo', async () => {
    const sorted = await h.call('hebra_query_properties', {
      filters: [{ key: 'note.title', op: 'equals', value: LOCKED_TITLE }],
      sort: { key: 'resto' }
    });
    expect(ids(sorted.json.notes)).toEqual([h.extra]);
    expect(sorted.raw).not.toContain('cebo_resto');
  });

  it('hebra_list_properties no la cuenta', async () => {
    expect((await h.call('hebra_list_properties')).raw).not.toContain('resto');
    expect((await h.call('hebra_list_properties', { key: 'resto' })).json.values).toEqual([]);
  });

  it.each([
    ['con algo privado, por palabra', NO_TAGS, 'Bloqueada'],
    ['con algo privado, por subcadena', NO_TAGS, 'loquead'],
    ['sin nada privado, por palabra', OPEN, 'Bloqueada'],
    ['sin nada privado, por subcadena', OPEN, 'loquead']
  ])('hebra_search con `props`, %s: el resto no la hace casar', async (_name, config, query) => {
    const local = await scenario(config);
    try {
      const plain = await local.call('hebra_search', { query, limit: 50 });
      expect(ids(plain.json.results), 'sin `props` sí la encuentra por su título').toContain(local.extra);
      for (const props of [[{ key: 'resto', value: 'cebo_resto' }], [{ key: 'resto', value: null }], [{ key: 'resto', value: 'otro' }]]) {
        const found = await local.call('hebra_search', { query, props, limit: 50 });
        expect(found.json.results, JSON.stringify(props)).toEqual([]);
      }
    } finally {
      await local.close();
    }
  });
});
