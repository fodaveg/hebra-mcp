/**
 * Pieza A7 del plan de memoria (6 nov 2026): `hebra_list_tags`, `hebra_list_folders`,
 * `hebra_list_properties` y `hebra_query_properties` ya no recorren `PrivacyFilter.visibleNotes()`
 * (la biblioteca entera cargada y copiada en cada llamada): agrupan en SQL con las reglas del filtro
 * dentro de la consulta (`notesScope`, `src/store/visible-sql.ts`) y se registran con
 * `privacyLoad: 'lazy'`. `listNotes` del puerto del motor JD (`src/store/jd-port.ts`) lee solo las
 * notas de la carpeta.
 *
 * Tres comprobaciones, sobre la biblioteca de prueba más notas con etiquetas y propiedades en cada
 * caso de §6.3 (pública, privada por carpeta y por subcarpeta, por etiqueta y por etiqueta anidada,
 * bloqueada con un resto de propiedades, en la papelera, bajo una carpeta borrada pública y bajo
 * una privada), con tres configuraciones (etiquetas privadas, sin ellas y una etiqueta anidada):
 * 1. `expectLazyEquivalent`: registrada `'lazy'`, sin preguntas por notas no cargadas y la misma
 *    respuesta que con `'all'`, página a página.
 * 2. El ORÁCULO: la respuesta es la que daba el código de antes, calculada aquí con el filtro de la
 *    biblioteca entera (`visibleNotes()`, que solo queda para esto). Con `'all'` y `'lazy'` las dos
 *    van ya por SQL, así que la 1 sola no probaría que las reglas sean las del filtro.
 * 3. Lo que carga una llamada perezosa: ni `notesVisibilityIndex` (la biblioteca entera) ni, en
 *    `notesVisibilityIndexFor` o en la visibilidad que juzga la puerta final, más notas que las de
 *    la página. Con `'all'`, el mismo espía sí ve la carga entera (control de que el espía mira).
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrivacyConfig } from '../../src/privacy';
import type { PrivacyFilter } from '../../src/privacy/filter';
import { resolveToolContext } from '../../src/server/context';
import { JdLibraryPort } from '../../src/store/jd-port';
import { legacyFolderTombstone } from '../fixtures/test-library';
import { callToolWithLoad, expectLazyEquivalent } from '../fixtures/privacy-load';
import { AUDIT_CONFIG, auditHarness, createNote, lockedBody, saveBody, type AuditHarness } from '../privacy/audit-harness';

interface Extra {
  publicA: string;
  publicB: string;
  folderPrivate: string;
  subfolderPrivate: string;
  tagPrivate: string;
  nestedTagPrivate: string;
  locked: string;
  trashed: string;
  underDeletedPublic: string;
  underDeletedPrivate: string;
}

/** Cuerpo con frontmatter, título y etiquetas. */
function body(title: string, props: Record<string, string>, tags: readonly string[]): string {
  const front = Object.entries(props).map(([key, value]) => `${key}: ${value}`);
  return `---\n${front.join('\n')}\n---\n# ${title}\n${tags.map((tag) => `#${tag}`).join(' ')}\ncuerpo\n`;
}

async function scenario(config: PrivacyConfig): Promise<AuditHarness<Extra>> {
  return auditHarness<Extra>(async (engine, library, db) => {
    const make = async (folder: string | null, title: string, props: Record<string, string>, tags: string[]) =>
      (await createNote(engine, folder, body(title, props, tags))).id;
    const publicA = await make(library.folders.proyectos, 'A7 pública A', { estado: 'activo', prioridad: '2' }, [
      'proyectos/lumbre',
      'a7-compartida'
    ]);
    const publicB = await make(null, 'A7 pública B', { estado: 'hecho', prioridad: '10' }, ['a7-compartida']);
    const folderPrivate = await make(library.folders.diario, 'A7 carpeta', { estado: 'a7-privado', 'a7-clave-carpeta': 'x' }, [
      'a7-compartida',
      'a7-solo-carpeta'
    ]);
    const subfolderPrivate = await make(library.folders.diario2026, 'A7 subcarpeta', { estado: 'a7-privado', 'a7-clave-sub': 'y' }, [
      'a7-solo-subcarpeta'
    ]);
    const tagPrivate = await make(null, 'A7 etiqueta', { estado: 'a7-etiqueta', 'a7-clave-etiqueta': 'z', prioridad: 'no-numero' }, [
      'secreto',
      'a7-compartida'
    ]);
    const nestedTagPrivate = await make(null, 'A7 anidada', { estado: 'a7-anidada', 'a7-clave-anidada': 'w' }, [
      'secreto/hondo',
      'a7-solo-anidada'
    ]);
    const locked = await make(null, 'A7 bloqueada', { estado: 'a7-bloqueada' }, ['a7-solo-bloqueada']);
    await saveBody(engine, locked, lockedBody('A7 bloqueada', []));
    // Un resto de antes de bloquearla: una bloqueada no tiene propiedades aunque quede la fila.
    db.prepare('INSERT OR IGNORE INTO note_props (note_id, key, value) VALUES (?, ?, ?)').run(locked, 'a7-clave-bloqueada', 'resto');
    const trashed = await make(null, 'A7 papelera', { estado: 'a7-papelera', 'a7-clave-papelera': 't' }, ['a7-solo-papelera']);
    await engine.noteTrash(trashed);
    const publicSub = await engine.folderCreate(library.folders.proyectos, 'A7 sub pública');
    const underDeletedPublic = await make(publicSub.id, 'A7 lápida pública', { estado: 'activo', 'a7-clave-lapida': 'u' }, [
      'a7-solo-lapida-publica'
    ]);
    await legacyFolderTombstone(engine, publicSub.id);
    const privateSub = await engine.folderCreate(library.folders.diario, 'A7 sub privada');
    const underDeletedPrivate = await make(privateSub.id, 'A7 lápida privada', { estado: 'a7-lapida-privada', 'a7-clave-lapida-privada': 's' }, [
      'a7-solo-lapida-privada'
    ]);
    await legacyFolderTombstone(engine, privateSub.id);
    return {
      publicA,
      publicB,
      folderPrivate,
      subfolderPrivate,
      tagPrivate,
      nestedTagPrivate,
      locked,
      trashed,
      underDeletedPublic,
      underDeletedPrivate
    };
  }, config);
}

const CONFIGS: Array<[string, PrivacyConfig]> = [
  ['carpeta y etiqueta privadas', AUDIT_CONFIG],
  ['sin etiquetas privadas (la bloqueada se ve)', { privateFolders: [['diario']], privateTags: [] }],
  ['etiqueta privada anidada (proyectos/lumbre)', { privateFolders: [['diario']], privateTags: ['proyectos/lumbre'] }]
];

/** El filtro de la biblioteca entera, como lo usaba el código de antes de A7. */
async function fullFilter(h: AuditHarness<Extra>): Promise<PrivacyFilter> {
  return (await resolveToolContext(h.serverContext)).privacy;
}

/** Las filas de `note_props`, leídas aparte (el oráculo no pasa por el puerto). */
function propRows(h: AuditHarness<Extra>): Array<{ note_id: string; key: string; value: string }> {
  const db = new DatabaseSync(h.sqlitePath, { readOnly: true });
  try {
    return db.prepare('SELECT note_id, key, value FROM note_props').all() as Array<{ note_id: string; key: string; value: string }>;
  } finally {
    db.close();
  }
}

/** Todas las páginas de una herramienta, cada una con `expectLazyEquivalent`; los elementos de
 *  `field`, juntos. */
async function walkLazy(h: AuditHarness<Extra>, name: string, args: Record<string, unknown>, field: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const call = await expectLazyEquivalent(h.serverContext, name, cursor === undefined ? args : { ...args, cursor });
    expect(call.isError, JSON.stringify(call.json)).toBe(false);
    items.push(...(call.json[field] as unknown[]));
    cursor = call.json.nextCursor ?? undefined;
    pages += 1;
    expect(pages).toBeLessThan(200);
  } while (cursor);
  return items;
}

let open: AuditHarness<Extra> | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe.each(CONFIGS)('A7 con %s', (_label, config) => {
  it('hebra_list_tags: perezosa, la del oráculo y paginada igual', async () => {
    const h = (open = await scenario(config));
    const filter = await fullFilter(h);
    const counts = new Map<string, number>();
    for (const { tags } of filter.visibleNotes().values()) for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const expected = (await h.port.tagsList()).tags
      .filter((entry) => (counts.get(entry.tag) ?? 0) > 0)
      .map((entry) => ({ tag: entry.tag, count: counts.get(entry.tag)! }));

    const whole = await expectLazyEquivalent(h.serverContext, 'hebra_list_tags', {});
    expect(whole.json.tags).toEqual(expected);
    expect(await walkLazy(h, 'hebra_list_tags', { limit: 2 }, 'tags')).toEqual(expected);

    const shown = new Set((whole.json.tags as Array<{ tag: string }>).map((entry) => entry.tag));
    for (const tag of ['a7-solo-carpeta', 'a7-solo-subcarpeta', 'a7-solo-papelera', 'a7-solo-lapida-privada']) {
      expect(shown.has(tag), tag).toBe(false);
    }
    expect(shown.has('a7-solo-lapida-publica')).toBe(true);
    const hasTags = config.privateTags.length > 0;
    expect(shown.has('a7-solo-bloqueada')).toBe(false); // una bloqueada no deriva etiquetas
    expect(shown.has('a7-solo-anidada')).toBe(!config.privateTags.includes('secreto'));
    expect(shown.has('secreto')).toBe(!config.privateTags.includes('secreto'));
    if (config.privateTags.includes('proyectos/lumbre')) {
      expect(shown.has('proyectos/lumbre')).toBe(false);
      expect(shown.has('proyectos')).toBe(false);
    }
    expect(hasTags || shown.has('secreto/hondo')).toBe(true);
  });

  it('hebra_list_folders: perezosa, la del oráculo y paginada igual', async () => {
    const h = (open = await scenario(config));
    const filter = await fullFilter(h);
    const counts = new Map<string, number>();
    for (const { folderId } of filter.visibleNotes().values()) counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
    const expected = (await h.port.foldersList()).folders
      .filter((folder) => !filter.isFolderHidden(folder.id))
      .map((folder) => ({ id: folder.id, path: filter.folderPath(folder.id), count: counts.get(folder.id) ?? 0 }));

    const whole = await expectLazyEquivalent(h.serverContext, 'hebra_list_folders', {});
    expect(whole.json.folders).toEqual(expected);
    expect(await walkLazy(h, 'hebra_list_folders', { limit: 2 }, 'folders')).toEqual(expected);
    const ids = new Set((whole.json.folders as Array<{ id: string }>).map((folder) => folder.id));
    expect(ids.has(h.library.folders.diario)).toBe(false);
    expect(ids.has(h.library.folders.diario2026)).toBe(false);
  });

  it('hebra_list_properties: claves y valores perezosos, los del oráculo y paginados igual', async () => {
    const h = (open = await scenario(config));
    const filter = await fullFilter(h);
    const visible = filter.visibleNotes();
    const counted = propRows(h).filter((row) => visible.has(row.note_id) && !filter.isLockedNote(row.note_id));
    const keyNotes = new Map<string, Set<string>>();
    for (const row of counted) keyNotes.set(row.key, (keyNotes.get(row.key) ?? new Set()).add(row.note_id));
    const binary = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));
    const expectedKeys = [...keyNotes.keys()].sort(binary).map((key) => ({ key, count: keyNotes.get(key)!.size }));

    expect(await walkLazy(h, 'hebra_list_properties', {}, 'keys')).toEqual(expectedKeys);
    expect(await walkLazy(h, 'hebra_list_properties', { limit: 1 }, 'keys')).toEqual(expectedKeys);
    const keys = new Set(expectedKeys.map((entry) => entry.key));
    expect(keys.has('a7-clave-bloqueada')).toBe(false);
    expect(keys.has('a7-clave-lapida')).toBe(true);
    for (const key of ['a7-clave-carpeta', 'a7-clave-sub', 'a7-clave-papelera', 'a7-clave-lapida-privada']) {
      expect(keys.has(key), key).toBe(false);
    }
    expect(keys.has('a7-clave-etiqueta')).toBe(!config.privateTags.includes('secreto'));

    const values = new Map<string, number>();
    for (const row of counted) if (row.key === 'estado' && row.value !== '') values.set(row.value, (values.get(row.value) ?? 0) + 1);
    const expectedValues = [...values.keys()].sort(binary).map((value) => ({ value, count: values.get(value)! }));
    expect(await walkLazy(h, 'hebra_list_properties', { key: 'estado' }, 'values')).toEqual(expectedValues);
    expect(await walkLazy(h, 'hebra_list_properties', { key: 'Estado', limit: 2 }, 'values')).toEqual(expectedValues);
  });

  it('hebra_query_properties: perezosa, las notas del oráculo y paginada igual', async () => {
    const h = (open = await scenario(config));
    const filter = await fullFilter(h);
    const visible = filter.visibleNotes();
    const withEstado = new Set(
      propRows(h)
        .filter((row) => row.key === 'estado' && visible.has(row.note_id) && !filter.isLockedNote(row.note_id))
        .map((row) => row.note_id)
    );
    const args = { filters: [{ key: 'estado', op: 'exists' }], sort: { key: 'prioridad', direction: 'descending' } };
    const whole = (await walkLazy(h, 'hebra_query_properties', args, 'notes')) as Array<{ id: string; folderPath: string }>;
    expect(new Set(whole.map((note) => note.id))).toEqual(withEstado);
    expect(await walkLazy(h, 'hebra_query_properties', { ...args, limit: 1 }, 'notes')).toEqual(whole);
    for (const note of whole) expect(note.folderPath).toBe(filter.folderPath(visible.get(note.id)!.folderId));
    // La lápida pública sale en la raíz; lo privado y la papelera, nunca.
    expect(whole.find((note) => note.id === h.extra.underDeletedPublic)?.folderPath).toBe('');
    for (const id of [h.extra.folderPrivate, h.extra.subfolderPrivate, h.extra.trashed, h.extra.underDeletedPrivate]) {
      expect(whole.some((note) => note.id === id), id).toBe(false);
    }
    // Sin filtros: también la bloqueada visible (sin propiedades), y por carpeta con subcarpetas.
    const all = (await walkLazy(h, 'hebra_query_properties', { limit: 3 }, 'notes')) as Array<{ id: string }>;
    expect(new Set(all.map((note) => note.id))).toEqual(new Set(visible.keys()));
    const proyectos = (await walkLazy(h, 'hebra_query_properties', { folder: 'Proyectos', subfolders: true }, 'notes')) as Array<{
      id: string;
    }>;
    expect(proyectos.map((note) => note.id).sort()).toEqual(
      [...visible].filter(([, meta]) => filter.folderSubtree(h.library.folders.proyectos).includes(meta.folderId)).map(([id]) => id).sort()
    );
  });

  it('listNotes del motor JD: las visibles de cada carpeta, con su título, como antes', async () => {
    const h = (open = await scenario(config));
    const filter = await fullFilter(h);
    const reads: string[] = [];
    const jd = new JdLibraryPort(
      {
        folders: () => h.port.foldersList(),
        notes: () => h.port.notesVisibilityIndex(),
        noteRead: (id) => {
          reads.push(id);
          return h.port.noteRead(id);
        },
        folderNotes: (folderId) => h.port.titlesInFolder(folderId),
        filter: () => filter
      },
      null
    );
    const visible = filter.visibleNotes();
    for (const folderId of ['root', ...Object.values(h.library.folders)]) {
      const expectedIds = [...visible].filter(([, meta]) => meta.folderId === folderId).map(([id]) => id).sort();
      const expected = filter.isFolderHidden(folderId)
        ? []
        : await Promise.all(expectedIds.map(async (id) => ({ id, title: (await h.port.noteRead(id))!.title })));
      reads.length = 0;
      expect(await jd.listNotes(folderId), folderId).toEqual(expected);
      expect(reads, 'listNotes ya no lee la fila entera de cada nota').toEqual([]);
    }
    expect((await jd.listNotes('root')).some((note) => note.id === h.extra.underDeletedPublic)).toBe(true);
    expect((await jd.listNotes('root')).some((note) => note.id === h.extra.underDeletedPrivate)).toBe(false);
  });
});

describe('A7: hebra_query_properties ordena solo con valores de visibles sin bloquear', () => {
  it('un resto no numérico de una bloqueada visible no cambia el orden numérico', async () => {
    const h = (open = await auditHarness<Extra>(async (engine, _library, db) => {
      const ten = (await createNote(engine, null, body('A7 orden diez', { 'a7-orden': '10' }, []))).id;
      const two = (await createNote(engine, null, body('A7 orden dos', { 'a7-orden': '2' }, []))).id;
      const locked = (await createNote(engine, null, body('A7 orden bloqueada', { 'a7-orden': '5' }, []))).id;
      await saveBody(engine, locked, lockedBody('A7 orden bloqueada', []));
      db.prepare('INSERT OR IGNORE INTO note_props (note_id, key, value) VALUES (?, ?, ?)').run(locked, 'a7-orden', 'no-numero');
      return { publicA: ten, publicB: two, locked } as unknown as Extra;
    }, { privateFolders: [['diario']], privateTags: [] }));
    const args = { filters: [{ key: 'a7-orden', op: 'exists' }], sort: { key: 'a7-orden', direction: 'descending' } };
    const notes = (await walkLazy(h, 'hebra_query_properties', args, 'notes')) as Array<{ id: string }>;
    // Numérico: 10 antes que 2. Si contara el resto de la bloqueada, el modo sería texto y '2' > '10'.
    expect(notes.map((note) => note.id)).toEqual([h.extra.publicA, h.extra.publicB]);
  });
});

describe('A7: lo que carga una llamada perezosa', () => {
  const CALLS: Array<[string, Record<string, unknown>, number]> = [
    ['hebra_list_tags', { limit: 2 }, 0],
    ['hebra_list_folders', { limit: 2 }, 0],
    ['hebra_list_properties', { limit: 2 }, 0],
    ['hebra_list_properties', { key: 'estado', limit: 2 }, 0],
    ['hebra_query_properties', { filters: [{ key: 'estado', op: 'exists' }], limit: 2 }, 2]
  ];

  it.each(CALLS)('%s %j: ni la biblioteca entera ni más notas que las de la página', async (name, args, pageNotes) => {
    const h = (open = await scenario(AUDIT_CONFIG));
    const whole = vi.spyOn(h.port, 'notesVisibilityIndex');
    const forIds = vi.spyOn(h.port, 'notesVisibilityIndexFor');
    const recheck = vi.spyOn(h.port, 'privacyRecheck');
    const loaded = () => forIds.mock.calls.reduce((sum, [ids]) => sum + ids.length, 0);
    const judged = () => recheck.mock.calls.reduce((sum, [request]) => sum + request.visibility.length, 0);

    // Control: con 'all', el espía sí ve la carga de la biblioteca entera.
    await callToolWithLoad(h.serverContext, name, args, 'all');
    expect(whole).toHaveBeenCalled();
    whole.mockClear();
    forIds.mockClear();
    recheck.mockClear();

    const call = await callToolWithLoad(h.serverContext, name, args);
    expect(call.isError).toBe(false);
    expect(call.declared).toBe('lazy');
    expect(whole).not.toHaveBeenCalled();
    expect(loaded()).toBeLessThanOrEqual(pageNotes);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(judged()).toBeLessThanOrEqual(pageNotes);
  });
});
