/**
 * Las propiedades del frontmatter y lo oculto (D23, SPEC.md §6.3). El método es el de `hebra_grep`
 * (`../fixtures/grep-library.ts`): la misma biblioteca con y sin notas ocultas, y cada respuesta,
 * página a página, tiene que ser IDÉNTICA en las dos, cursores incluidos. Las ocultas llevan una
 * clave y un valor que no tiene nadie más, un valor no numérico en la clave por la que se ordena,
 * una homónima de una nota visible y un título que solo tienen ellas.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrivacyConfig } from '../../src/privacy';
import type { ToolContext } from '../../src/server/context';
import { wrapCursor } from '../../src/server/pagination';
import { runListProperties } from '../../src/server/tools/list-properties';
import { runQueryProperties, type QueryPropertiesInput } from '../../src/server/tools/query-properties';
import { runSearch } from '../../src/server/tools/search';
import { grepContext } from '../fixtures/grep-library';
import {
  buildPropsLibraryPair,
  ONLY_HIDDEN_TITLE,
  PROPS_BAIT_KEY,
  PROPS_BAIT_VALUE,
  SHARED_TITLE,
  type PropsLibraryPair
} from '../fixtures/props-library';
import { auditHarness, createNote, lockedBody, saveBody, withEngine } from './audit-harness';

interface Paged {
  nextCursor: string | null;
}

/** Todas las páginas de una lista: el JSON de cada una, para compararlo tal cual. */
async function walk<T extends Paged>(page: (cursor?: string) => Promise<T>): Promise<T[]> {
  const pages: T[] = [];
  let cursor: string | undefined;
  do {
    const current = await page(cursor);
    pages.push(current);
    cursor = current.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}

describe('con y sin notas ocultas, la misma respuesta', () => {
  let pair: PropsLibraryPair;
  let shown: ToolContext;
  let bare: ToolContext;
  let close: () => void;

  beforeAll(async () => {
    pair = await buildPropsLibraryPair();
    const left = await grepContext(pair.withPrivate);
    const right = await grepContext(pair.withoutPrivate);
    shown = left.ctx;
    bare = right.ctx;
    close = () => {
      left.port.close();
      right.port.close();
    };
  });
  afterAll(() => {
    close();
    pair.close();
  });

  async function sameInBoth<T extends Paged>(run: (ctx: ToolContext, cursor?: string) => Promise<T>): Promise<T[]> {
    const withHidden = await walk((cursor) => run(shown, cursor));
    const withoutHidden = await walk((cursor) => run(bare, cursor));
    expect(withHidden).toEqual(withoutHidden);
    const raw = JSON.stringify(withHidden);
    // La clave no se comprueba aquí: una consulta devuelve `[]` para la que pidió el cliente.
    expect(raw).not.toContain('valor_oculto');
    expect(raw).not.toContain(PROPS_BAIT_VALUE);
    expect(raw).not.toContain('no-numero');
    for (const id of pair.privateIds) expect(raw).not.toContain(id);
    return withHidden;
  }

  it.each([undefined, 1, 2])('hebra_list_properties, sin `key`, página de %s: una clave solo de ocultas no sale', async (limit) => {
    const pages = await sameInBoth((ctx, cursor) => runListProperties(ctx, {
      ...(limit ? { limit } : {}),
      ...(cursor ? { cursor } : {})
    }));
    const keys = pages.flatMap((page) => ('keys' in page ? page.keys : []));
    expect(keys.map((entry) => entry.key)).not.toContain(PROPS_BAIT_KEY);
  });

  it.each(['estado', 'prioridad', PROPS_BAIT_KEY, 'no_existe', 'largo'])(
    'hebra_list_properties, `key: %s`: el recuento cuenta solo visibles, y un valor solo de ocultas no sale',
    async (key) => {
      await sameInBoth((ctx, cursor) => runListProperties(ctx, { key, limit: 2, ...(cursor ? { cursor } : {}) }));
    }
  );

  it('una clave con notas visibles y ocultas cuenta solo las visibles', async () => {
    const result = await runListProperties(shown, { key: 'estado' });
    expect('values' in result && result.values).toEqual([
      { value: 'Activo', count: 1 },
      { value: 'activo', count: 5 },
      { value: 'pausado', count: 1 }
    ]);
    const keys = await runListProperties(shown);
    expect('keys' in keys && keys.keys.find((entry) => entry.key === 'estado')?.count).toBe(7);
  });

  const QUERIES: Array<[string, QueryPropertiesInput]> = [
    ['sin filtros', {}],
    ['por título al revés', { sort: { key: null, direction: 'descending' } }],
    ['por número, con un valor oculto que no lo es', { sort: { key: 'prioridad' } }],
    ['por número al revés', { sort: { key: 'prioridad', direction: 'descending' } }],
    ['por número, vacías primero', { sort: { key: 'prioridad', empty: 'first' } }],
    ['por una clave solo de ocultas', { sort: { key: PROPS_BAIT_KEY } }],
    ['filtro por una clave solo de ocultas', { filters: [{ key: PROPS_BAIT_KEY, op: 'exists' }] }],
    ['filtro por que falte una clave solo de ocultas', { filters: [{ key: PROPS_BAIT_KEY, op: 'missing' }] }],
    ['filtro por un valor solo de ocultas', { filters: [{ key: 'estado', op: 'equals', value: PROPS_BAIT_VALUE }] }],
    ['filtro por un trozo de un valor oculto', { filters: [{ key: 'prioridad', op: 'contains', value: 'numero' }] }],
    ['filtro negativo', { filters: [{ key: 'estado', op: 'not-equals', value: PROPS_BAIT_VALUE }] }],
    ['filtro por título de una oculta', { filters: [{ key: 'note.title', op: 'equals', value: ONLY_HIDDEN_TITLE }] }],
    ['carpeta privada', { folder: 'diario' }],
    ['subcarpeta privada', { folder: 'diario/2026', subfolders: true }],
    ['carpeta que no existe', { folder: 'no-existe' }],
    ['clave oculta pedida', { properties: [PROPS_BAIT_KEY, 'estado'] }]
  ];

  it.each(QUERIES)('hebra_query_properties, %s', async (_name, input) => {
    for (const limit of [1, 3, 100]) {
      await sameInBoth((ctx, cursor) => runQueryProperties(ctx, { ...input, limit, ...(cursor ? { cursor } : {}) }));
    }
  });

  it('el motor sí cambia de orden con el valor oculto; la herramienta, no', async () => {
    const sort = { key: 'prioridad', direction: 'ascending' as const };
    const filters = { props: [{ key: 'prioridad', op: 'greater-than' as const, value: '0' }] };
    // Texto: «10» antes que «2». Es lo que delataría que hay una oculta con otro valor.
    const raw = await withEngine(pair.withPrivate, async (engine) =>
      engine.propsQuery(filters, sort, null, 50).items.map((row) => row.title)
    );
    expect(raw.filter((title) => ['Alfa', 'Beta', 'Gamma'].includes(title))).toEqual(['Beta', 'Gamma', 'Alfa']);
    const tool = await runQueryProperties(shown, { filters: [{ key: 'prioridad', op: 'greater-than', value: '0' }], sort });
    expect(tool.notes.map((note) => note.title)).toEqual(['Gamma', 'Alfa', 'Beta']);
  });

  it('un cursor forjado con el id de una oculta responde como con cualquier otro id', async () => {
    const cursorFor = (id: string): string => wrapCursor('pq1', JSON.stringify(['t', null, 'e', id]));
    const hidden = await runQueryProperties(shown, { cursor: cursorFor(pair.privateIds[0]!), limit: 3 });
    const unknown = await runQueryProperties(shown, { cursor: cursorFor('00000000-no-existe'), limit: 3 });
    expect(hidden.notes).toEqual(unknown.notes);
    expect(hidden.nextCursor).toEqual(unknown.nextCursor);
  });

  const SEARCHES: Array<[string, Parameters<typeof runSearch>[1]]> = [
    ['`props` con una clave solo de ocultas', { query: 'garbanzos', props: [{ key: PROPS_BAIT_KEY, value: null }] }],
    ['`props` con un valor solo de ocultas', { query: 'garbanzos', props: [{ key: 'estado', value: PROPS_BAIT_VALUE }] }],
    ['`props` y subcadena', { query: 'arbanz', props: [{ key: 'estado', value: 'activo' }] }],
    ['`props` con hueco de ocultas', { query: 'garbanzos', props: [{ key: 'estado', value: 'activo' }] }],
    ['`linksTo` a una privada', { query: 'garbanzos', linksTo: [ONLY_HIDDEN_TITLE] }],
    ['`linksTo` a una inexistente', { query: 'garbanzos', linksTo: ['No existe en ningún sitio'] }],
    ['`linksTo` con homónima oculta', { query: 'garbanzos', linksTo: [SHARED_TITLE] }],
    ['`linksTo` con homónima oculta y subcadena', { query: 'arbanz', linksTo: [SHARED_TITLE] }],
    ['`titleOnly` con el título de una oculta', { query: ONLY_HIDDEN_TITLE, titleOnly: true }],
    ['`titleOnly` con subcadena de una oculta', { query: 'iario', titleOnly: true }]
  ];

  it.each(SEARCHES)('hebra_search, %s', async (_name, input) => {
    for (const limit of [1, 2, 20]) {
      await sameInBoth((ctx, cursor) => runSearch(ctx, { ...input, limit, fields: ['title', 'folderPath', 'heading'], ...(cursor ? { cursor } : {}) }));
    }
  });

  it('`linksTo` a una privada y a una inexistente: la misma respuesta vacía, aunque una visible la enlace', async () => {
    const privateTarget = await runSearch(shown, { query: 'garbanzos', linksTo: [ONLY_HIDDEN_TITLE] });
    const missing = await runSearch(shown, { query: 'garbanzos', linksTo: ['No existe en ningún sitio'] });
    expect(privateTarget).toEqual({ results: [], nextCursor: null });
    expect(missing).toEqual(privateTarget);
  });

  it('una homónima oculta no añade enlaces por id ni la autorreferencia', async () => {
    const { results } = await runSearch(shown, { query: 'garbanzos', linksTo: [SHARED_TITLE], limit: 50 });
    expect(results.map((result) => result.id)).toEqual([pair.ids.enlaza]);
    // El motor, solo, sí los daría: lo que justifica resolver los destinos aquí.
    const raw = await withEngine(pair.withPrivate, async (engine) =>
      engine.search('garbanzos', null, 50, { linksTo: [SHARED_TITLE] }, null).items.map((row) => row.id)
    );
    expect(raw).toContain(pair.ids.enlazaOculta);
    expect(raw).toContain(pair.ids.destino);
  });
});

describe('notas bloqueadas', () => {
  const NO_TAGS: PrivacyConfig = { privateFolders: [['diario']], privateTags: [] };

  it('con etiquetas privadas configuradas están ocultas; sin ellas salen como en hebra_list_notes, sin propiedades', async () => {
    const h = await auditHarness(async (engine) => {
      const note = await createNote(engine, null, '---\nanterior: cebo_bloqueo\n---\n# Antes\n');
      await saveBody(engine, note.id, lockedBody('Bloqueada visible', []));
      return note.id;
    }, NO_TAGS);
    try {
      const listed = await h.call('hebra_list_notes', { limit: 100 });
      const queried = await h.call('hebra_query_properties', { limit: 100 });
      const inList = listed.json.notes.map((note: { id: string }) => note.id);
      const inQuery = queried.json.notes.map((note: { id: string }) => note.id);
      expect(inList).toContain(h.extra);
      expect(inQuery).toContain(h.extra);
      // Al bloquearla, sus propiedades se fueron con el cuerpo: ni filas ni valores.
      const keys = await h.call('hebra_list_properties');
      expect(keys.raw).not.toContain('anterior');
      expect((await h.call('hebra_list_properties', { key: 'anterior' })).json.values).toEqual([]);
      const exists = await h.call('hebra_query_properties', { filters: [{ key: 'anterior', op: 'exists' }] });
      expect(exists.json.notes).toEqual([]);
    } finally {
      await h.close();
    }

    const hidden = await auditHarness(async (engine) => (await createNote(engine, null, lockedBody('Bloqueada oculta', []))).id);
    try {
      const queried = await hidden.call('hebra_query_properties', { limit: 100 });
      expect(queried.raw).not.toContain(hidden.extra);
      expect(queried.raw).not.toContain('Bloqueada oculta');
    } finally {
      await hidden.close();
    }
  });

  it('una nota con una fila de `note_props` anterior al bloqueo no la enseña', async () => {
    const h = await auditHarness(async (engine, _library, db) => {
      const note = await createNote(engine, null, lockedBody('Bloqueada con resto', []));
      db.prepare('INSERT INTO note_props(note_id, key, value) VALUES (?, ?, ?)').run(note.id, 'resto', 'cebo_resto');
      return note.id;
    }, NO_TAGS);
    try {
      expect((await h.call('hebra_list_properties')).raw).not.toContain('resto');
      expect((await h.call('hebra_list_properties', { key: 'resto' })).json.values).toEqual([]);
      const shown = await h.call('hebra_query_properties', { properties: ['resto'], limit: 100 });
      expect(shown.raw).not.toContain('cebo_resto');
    } finally {
      await h.close();
    }
  });
});

describe('una nota que pasa a oculta durante la llamada', () => {
  const KEY = 'clave_recien_privada';
  const VALUE = 'valor_recien_privado';

  function publicNote(): string {
    return `---\n${KEY}: ${VALUE}\n---\n# Pública\n[[Destino carrera]] carrera\n`;
  }
  function privateNote(): string {
    return `---\n${KEY}: ${VALUE}\n---\n# Pública\n#secreto\n`;
  }

  it('hebra_list_properties repite la llamada y no la cuenta', async () => {
    const h = await auditHarness(async (engine) => (await createNote(engine, null, publicNote())).id);
    try {
      const read = h.port.propRows.bind(h.port);
      const spy = vi.spyOn(h.port, 'propRows').mockImplementationOnce(async (keys) => {
        await h.mutate(async (engine) => saveBody(engine, h.extra, privateNote()));
        return read(keys);
      });
      const raced = await h.call('hebra_list_properties');
      spy.mockRestore();
      expect(raced.raw).not.toContain(KEY);
      expect((await h.call('hebra_list_properties', { key: KEY })).json.values).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('hebra_query_properties no la devuelve', async () => {
    const h = await auditHarness(async (engine) => (await createNote(engine, null, publicNote())).id);
    try {
      const read = h.port.propsScan.bind(h.port);
      const spy = vi.spyOn(h.port, 'propsScan').mockImplementationOnce(async (filters, keys) => {
        const scan = await read(filters, keys);
        await h.mutate(async (engine) => saveBody(engine, h.extra, privateNote()));
        return scan;
      });
      const raced = await h.call('hebra_query_properties', { filters: [{ key: KEY, op: 'exists' }] });
      spy.mockRestore();
      expect(raced.json).toEqual({ notes: [], nextCursor: null });
    } finally {
      await h.close();
    }
  });

  it('hebra_search con `linksTo`: un destino que pasa a oculto da la lista vacía', async () => {
    const h = await auditHarness(async (engine) => {
      await createNote(engine, null, publicNote());
      return (await createNote(engine, null, '# Destino carrera\ncuerpo\n')).id;
    });
    try {
      const read = h.port.notesByFoldedTitle.bind(h.port);
      const spy = vi.spyOn(h.port, 'notesByFoldedTitle').mockImplementationOnce(async (title) => {
        const ids = await read(title);
        await h.mutate(async (engine) => saveBody(engine, h.extra, '# Destino carrera\n#secreto\n'));
        return ids;
      });
      const raced = await h.call('hebra_search', { query: 'carrera', linksTo: ['Destino carrera'] });
      spy.mockRestore();
      expect(raced.json).toEqual({ results: [], nextCursor: null });
    } finally {
      await h.close();
    }
  });
});

describe('por el camino entero del servidor', () => {
  it('las tres aceptan `space` y sus cursores rechazan los de otra herramienta', async () => {
    const h = await auditHarness(async (engine) => {
      await createNote(engine, null, '---\nuno: a\n---\n# Una\n');
      await createNote(engine, null, '---\nuno: b\n---\n# Dos\n');
    });
    try {
      const listed = await h.call('hebra_list_properties', { key: 'uno', space: 'personal' });
      expect(listed.json.values).toEqual([{ value: 'a', count: 1 }, { value: 'b', count: 1 }]);
      const queried = await h.call('hebra_query_properties', {
        filters: [{ key: 'uno', op: 'exists' }],
        limit: 1,
        space: 'personal'
      });
      expect(queried.json.notes).toHaveLength(1);
      const other = await h.call('hebra_list_properties', { cursor: queried.json.nextCursor });
      expect(other.isError).toBe(true);
      expect(other.json).toMatchObject({ error: 'invalid_input' });
      const searched = await h.call('hebra_search', { query: 'una', titleOnly: true, space: 'personal' });
      expect(searched.json.results).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('una etiqueta privada no filtra por propiedad: la nota se oculta y basta', async () => {
    // D3 solo configura carpetas y etiquetas: una propiedad con el NOMBRE de una etiqueta
    // privada en una nota visible no es privada, y sale como el resto de su frontmatter.
    const h = await auditHarness(async (engine) => (await createNote(engine, null, '---\ncategoria: secreto\n---\n# Visible\n')).id);
    try {
      const listed = await h.call('hebra_list_properties', { key: 'categoria' });
      expect(listed.json.values).toEqual([{ value: 'secreto', count: 1 }]);
      const notes = await h.call('hebra_list_notes', { limit: 100 });
      expect(notes.json.notes.map((note: { id: string }) => note.id)).toContain(h.extra);
    } finally {
      await h.close();
    }
  });

  it('`tags:` del frontmatter con una etiqueta privada oculta la nota, y sus propiedades con ella', async () => {
    const h = await auditHarness(async (engine) => (await createNote(engine, null, '---\ntags: secreto\nsolo_aqui: cebo_tags\n---\n# Oculta por tags\n')).id);
    try {
      expect((await h.call('hebra_list_properties')).raw).not.toContain('solo_aqui');
      expect((await h.call('hebra_list_properties', { key: 'solo_aqui' })).json.values).toEqual([]);
      const queried = await h.call('hebra_query_properties', { filters: [{ key: 'solo_aqui', op: 'exists' }] });
      expect(queried.json).toEqual({ notes: [], nextCursor: null });
    } finally {
      await h.close();
    }
  });
});
