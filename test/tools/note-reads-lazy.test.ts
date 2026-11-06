/**
 * Pieza A5 del plan de memoria (6 nov 2026): las lecturas de una nota y sus relaciones
 * (`hebra_note_outline`, `hebra_links`, `hebra_note_authors`) y `hebra_create_note`,
 * registradas con `privacyLoad: 'lazy'`. Cada una carga en el filtro de privados solo lo que
 * juzga, no la biblioteca entera.
 *
 * Las lecturas pasan por `expectLazyEquivalent` (`test/fixtures/privacy-load.ts`): sin
 * preguntas por notas no cargadas y con la respuesta idéntica a la de `'all'`; y además se
 * comprueba QUÉ responden. `hebra_create_note` es una escritura (correrla dos veces sobre la
 * misma biblioteca crearía dos notas distintas), así que su equivalencia se hace sobre DOS
 * copias de la misma biblioteca: una con `'all'` y otra con la carga declarada.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { PrivacyConfig } from '../../src/privacy';
import type { DirectoryView } from '../../src/server/context';
import { callToolWithLoad, expectLazyEquivalent, type LoadedToolCall } from '../fixtures/privacy-load';
import {
  AUDIT_CONFIG,
  auditHarness,
  createNote,
  lockedBody,
  NOT_FOUND,
  saveBody,
  type AuditHarness
} from '../privacy/audit-harness';

/** Título de una visible con dos homónimas ocultas (por carpeta y por etiqueta). */
const ONE_VISIBLE = 'Homónima perezosa A5';
/** Título que solo llevan notas ocultas. */
const ONLY_HIDDEN = 'Homónima solo oculta A5';
const LOCKED_TITLE = 'Nota bloqueada A5';
/** La nota de los enlaces: sale y entra de visibles y de ocultas. */
const LINKS_TITLE = 'Nota con enlaces A5';
/** Una nota con más encabezados que una página de `limit: 3`. */
const OUTLINE_TITLE = 'Nota con apartados A5';
/** Backlinks visibles y ocultos de la nota de los enlaces. */
const VISIBLE_BACKLINKS = 5;

const ANA = 'b'.repeat(32);
const BEA = 'c'.repeat(32);
const SPACE = '9'.repeat(32);
const DIRECTORY: DirectoryView = {
  selfAccountId: BEA,
  directory: {
    organizations: [
      {
        orgId: '1'.repeat(32),
        name: 'Org',
        members: [
          { accountId: ANA, role: 'member', name: 'Ana' },
          { accountId: BEA, role: 'admin', name: 'Bea' }
        ],
        spaces: [{ spaceId: SPACE, name: null, granted: true }]
      }
    ],
    spaces: []
  }
};

interface Extra {
  visibleHomonymId: string;
  hiddenDuplicateId: string;
  lockedId: string;
  linksId: string;
  outlineId: string;
  visibleBacklinkIds: string[];
  hiddenBacklinkIds: string[];
}

/**
 * La biblioteca de prueba más: homónimas visibles y ocultas, una oculta con el título repetido
 * de la biblioteca (`duplicateTitle`), una nota bloqueada en la raíz, una nota con enlaces por
 * id y por título hacia visibles, ocultas, bloqueadas y de la papelera (y enlazada desde
 * visibles y ocultas), una con muchos apartados, y autores en la nota pública y en las ocultas.
 */
async function lazyHarness(config: PrivacyConfig): Promise<AuditHarness<Extra>> {
  return auditHarness<Extra>(async (engine, library, db) => {
    const visible = await createNote(engine, null, `# ${ONE_VISIBLE}\nLa que se ve.\n## Dentro\n`);
    await createNote(engine, library.folders.diario2026, `# ${ONE_VISIBLE}\nOculta por carpeta.\n`);
    await createNote(engine, null, `# ${ONE_VISIBLE}\n#secreto\nOculta por etiqueta.\n`);
    await createNote(engine, library.folders.diario2026, `# ${ONLY_HIDDEN}\nOculta por carpeta.\n`);
    await createNote(engine, null, `# ${ONLY_HIDDEN}\n#secreto/personal\nOculta por etiqueta.\n`);
    const hiddenDuplicate = await createNote(
      engine,
      library.folders.diario2026,
      `# ${library.duplicateTitle}\nCandidata oculta.\n`
    );
    const locked = await createNote(engine, null, `# ${LOCKED_TITLE}\nAntes de bloquearla.\n`);
    await saveBody(engine, locked.id, lockedBody(LOCKED_TITLE, []));

    const links = await createNote(
      engine,
      null,
      [
        `# ${LINKS_TITLE}`,
        `Por id, visible: [[id:${library.publicNoteId}]]`,
        `Por id, oculta por carpeta: [[id:${library.privateFolderNoteId}]]`,
        `Por id, oculta por etiqueta: [[id:${library.privateTagNoteId}]]`,
        `Por id, bloqueada: [[id:${locked.id}]]`,
        `Por id, en la papelera: [[id:${library.trashedNoteId}]]`,
        `Por id, inexistente: [[id:no-existe-0000]]`,
        `Por título, una visible y homónimas ocultas: [[${ONE_VISIBLE}]]`,
        `Por título, solo ocultas: [[${ONLY_HIDDEN}]]`,
        `Por título, dos visibles y una oculta: [[${library.duplicateTitle}]]`,
        `Por título, bloqueada: [[${LOCKED_TITLE}]]`,
        `Por título, oculta de la biblioteca: [[Nota oculta de carpeta]]`,
        ''
      ].join('\n')
    );
    const visibleBacklinkIds: string[] = [];
    for (let i = 1; i <= VISIBLE_BACKLINKS; i += 1) {
      const note = await createNote(engine, library.folders.lumbre, `# Enlaza visible ${i}\n[[${LINKS_TITLE}]]\n`);
      visibleBacklinkIds.push(note.id);
    }
    const hiddenBacklinkIds = [
      (await createNote(engine, library.folders.diario2026, `# Enlaza oculta carpeta\n[[${LINKS_TITLE}]]\n`)).id,
      (await createNote(engine, null, `# Enlaza oculta etiqueta\n#secreto\n[[id:${links.id}]]\n`)).id
    ];
    // Una de la papelera que enlazaba: nunca sale.
    const trashedBacklink = await createNote(engine, null, `# Enlaza tirada\n[[${LINKS_TITLE}]]\n`);
    await engine.noteTrash(trashedBacklink.id);

    const outline = await createNote(
      engine,
      library.folders.lumbre,
      [`# ${OUTLINE_TITLE}`, '## Uno', 'a', '## Dos', 'b', '### Dos punto uno', '## Uno', 'c', '## Tres', '#### Hondo', ''].join(
        '\n'
      )
    );

    // Autores (los escribe el sync de un espacio compartido): en la pública y en las ocultas.
    const setAuthors = (id: string, author: string, relay: string, kind: string | null) =>
      db
        .prepare('UPDATE notes SET author_id = ?, relay_author_id = ?, relay_actor_kind = ? WHERE id = ?')
        .run(author, relay, kind, id);
    setAuthors(library.publicNoteId, ANA, BEA, 'agent');
    for (const id of [library.privateFolderNoteId, library.privateTagNoteId, locked.id, library.trashedNoteId]) {
      setAuthors(id, ANA, ANA, 'app');
    }

    return {
      visibleHomonymId: visible.id,
      hiddenDuplicateId: hiddenDuplicate.id,
      lockedId: locked.id,
      linksId: links.id,
      outlineId: outline.id,
      visibleBacklinkIds,
      hiddenBacklinkIds
    };
  }, config);
}

/** Config sin etiquetas privadas: una nota bloqueada se ve (A1). */
const NO_TAGS_CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: [] };

/** Los ids que tiene que juzgar cualquier lectura: ocultas de todas las clases. */
function hiddenIds(h: AuditHarness<Extra>): string[] {
  return [
    h.library.privateFolderNoteId,
    h.library.privateTagNoteId,
    h.library.trashedNoteId,
    h.library.trashedPrivateTagNoteId,
    h.extra.lockedId,
    'no-existe-0000'
  ];
}

describe('hebra_note_outline con privacyLoad lazy: igual que con la biblioteca entera', () => {
  let h: AuditHarness<Extra> | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });
  const outline = (args: Record<string, unknown>) =>
    expectLazyEquivalent(h!.serverContext, 'hebra_note_outline', args);

  it('nota pública por id, paginada página a página', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    const headings: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const call: LoadedToolCall = await outline({
        id: h.extra.outlineId,
        limit: 3,
        ...(cursor === null ? {} : { cursor })
      });
      expect(call.isError).toBe(false);
      headings.push(...(call.json.sections as Array<{ heading: string }>).map((section) => section.heading));
      cursor = call.json.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(headings).toEqual([OUTLINE_TITLE, 'Uno', 'Dos', 'Dos punto uno', 'Uno', 'Tres', 'Hondo']);
  });

  it('privada por carpeta, por etiqueta, bloqueada (con etiquetas privadas), en la papelera e inexistente: not_found', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    for (const id of hiddenIds(h)) {
      expect((await outline({ id })).json, id).toEqual(NOT_FOUND);
    }
  });

  it('bloqueada sin etiquetas privadas: note_locked, también igual', async () => {
    h = await lazyHarness(NO_TAGS_CONFIG);
    expect((await outline({ id: h.extra.lockedId })).json).toEqual({ error: 'note_locked' });
  });

  it('por título: la única visible entre homónimas ocultas', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    const call = await outline({ title: ONE_VISIBLE });
    expect(call.isError).toBe(false);
    expect(call.json.id).toBe(h.extra.visibleHomonymId);
  });

  it('por título: dos visibles y una oculta es ambiguous_title, solo con las visibles; solo ocultas, not_found', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    const call = await outline({ title: h.library.duplicateTitle });
    expect(call.json.error).toBe('ambiguous_title');
    const ids = (call.json.candidates as Array<{ id: string }>).map((candidate) => candidate.id).sort();
    expect(ids).toEqual([h.library.duplicateNoteAId, h.library.duplicateNoteBId].sort());
    expect(ids).not.toContain(h.extra.hiddenDuplicateId);
    expect((await outline({ title: ONLY_HIDDEN })).json).toEqual(NOT_FOUND);
  });
});

describe('hebra_links con privacyLoad lazy: igual que con la biblioteca entera', () => {
  let h: AuditHarness<Extra> | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });
  const links = (args: Record<string, unknown>) => expectLazyEquivalent(h!.serverContext, 'hebra_links', args);

  it('salientes por id y por título hacia visibles y ocultas: solo resuelven las visibles', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    const call = await links({ id: h.extra.linksId });
    expect(call.isError).toBe(false);
    const resolved = Object.fromEntries(
      (call.json.outgoing as Array<{ ref: string; resolvedId?: string }>).map((link) => [link.ref, link.resolvedId])
    );
    expect(resolved).toEqual({
      [`id:${h.library.publicNoteId}`]: h.library.publicNoteId,
      [`id:${h.library.privateFolderNoteId}`]: undefined,
      [`id:${h.library.privateTagNoteId}`]: undefined,
      [`id:${h.extra.lockedId}`]: undefined,
      [`id:${h.library.trashedNoteId}`]: undefined,
      'id:no-existe-0000': undefined,
      // Los refs por título salen canónicos (`deriveNote`), en minúsculas.
      [ONE_VISIBLE.toLowerCase()]: h.extra.visibleHomonymId,
      [ONLY_HIDDEN.toLowerCase()]: undefined,
      [h.library.duplicateTitle.toLowerCase()]: undefined,
      [LOCKED_TITLE.toLowerCase()]: undefined,
      'nota oculta de carpeta': undefined
    });
  });

  it('sin etiquetas privadas, la bloqueada resuelve por id', async () => {
    h = await lazyHarness(NO_TAGS_CONFIG);
    const outgoing = (await links({ id: h.extra.linksId })).json.outgoing as Array<{ ref: string; resolvedId?: string }>;
    expect(outgoing.find((link) => link.ref === `id:${h!.extra.lockedId}`)?.resolvedId).toBe(h.extra.lockedId);
  });

  it('backlinks desde visibles y ocultas, paginados (limit 2): solo las visibles, en todas las páginas', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    const outgoing: string[] = [];
    const backlinks: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const call: LoadedToolCall = await links({
        id: h.extra.linksId,
        limit: 2,
        ...(cursor === null ? {} : { cursor })
      });
      expect(call.isError).toBe(false);
      outgoing.push(...(call.json.outgoing as Array<{ ref: string }>).map((link) => link.ref));
      backlinks.push(...(call.json.backlinks as Array<{ id: string }>).map((note) => note.id));
      cursor = call.json.nextCursor;
      pages += 1;
    } while (cursor !== null);
    // 11 salientes de 2 en 2: 6 páginas; los 5 backlinks visibles acaban antes.
    expect(pages).toBe(6);
    expect(outgoing).toHaveLength(11);
    expect(backlinks.sort()).toEqual([...h.extra.visibleBacklinkIds].sort());
    for (const id of h.extra.hiddenBacklinkIds) expect(backlinks).not.toContain(id);
  });

  it('una nota oculta por carpeta, por etiqueta, bloqueada, en la papelera o inexistente: not_found', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    for (const id of hiddenIds(h)) {
      expect((await links({ id })).json, id).toEqual(NOT_FOUND);
    }
  });

  it('la nota pública de la biblioteca: saliente hacia una oculta por título y backlink de una visible', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    const call = await links({ id: h.library.publicNoteId });
    expect(call.isError).toBe(false);
    const backlinkIds = (call.json.backlinks as Array<{ id: string }>).map((note) => note.id);
    expect(backlinkIds).toContain(h.library.linkingNoteId);
    expect(backlinkIds).toContain(h.extra.linksId);
  });
});

describe('hebra_note_authors con privacyLoad lazy: igual que con la biblioteca entera', () => {
  let h: AuditHarness<Extra> | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });
  const authors = (args: Record<string, unknown>, directory = false) =>
    expectLazyEquivalent(
      directory ? { ...h!.serverContext, directory: async () => DIRECTORY } : h!.serverContext,
      'hebra_note_authors',
      args
    );

  it('nota pública, sin directorio y con él', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    const bare = await authors({ id: h.library.publicNoteId });
    expect(bare.isError).toBe(false);
    expect(bare.json).toMatchObject({ declaredAuthorId: ANA, mismatch: true, namesResolved: false });
    expect(bare.json.lastEditor).toMatchObject({ accountId: BEA, name: null, actorKind: 'agent' });

    const named = await authors({ id: h.library.publicNoteId }, true);
    expect(named.json).toMatchObject({ namesResolved: true });
    expect(named.json.lastEditor).toMatchObject({ accountId: BEA, name: 'Bea', isSelf: true });
  });

  it('privada por carpeta, por etiqueta, bloqueada (con etiquetas privadas), en la papelera e inexistente: not_found', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    for (const id of hiddenIds(h)) {
      expect((await authors({ id }, true)).json, id).toEqual(NOT_FOUND);
    }
  });

  it('bloqueada sin etiquetas privadas: sus autores', async () => {
    h = await lazyHarness(NO_TAGS_CONFIG);
    const call = await authors({ id: h.extra.lockedId });
    expect(call.isError).toBe(false);
    expect(call.json.lastEditor).toMatchObject({ accountId: ANA });
  });
});

describe('hebra_create_note con privacyLoad lazy: igual que con la biblioteca entera, sobre dos copias', () => {
  let all: AuditHarness<Extra> | undefined;
  let lazy: AuditHarness<Extra> | undefined;
  afterEach(async () => {
    await all?.close();
    await lazy?.close();
    all = undefined;
    lazy = undefined;
  });

  /** El id de la nota nueva es aleatorio: fuera, para comparar el resto. */
  const withoutId = (call: LoadedToolCall): unknown => {
    if (call.isError || call.json === null || typeof call.json.id !== 'string') return call.result;
    const { id: _id, ...rest } = call.json;
    return { ...call.result, content: [{ type: 'text', json: rest }, ...call.result.content.slice(1)] };
  };

  /** La misma creación con `'all'` en una copia y con la carga declarada en la otra. */
  async function create(args: Record<string, unknown>): Promise<{ all: LoadedToolCall; lazy: LoadedToolCall }> {
    const fromAll = await callToolWithLoad(all!.serverContext, 'hebra_create_note', args, 'all');
    const fromLazy = await callToolWithLoad(lazy!.serverContext, 'hebra_create_note', args);
    expect(fromLazy.declared, "hebra_create_note no está registrada con privacyLoad: 'lazy'").toBe('lazy');
    expect(fromLazy.unloadedLookups, 'hebra_create_note preguntó por notas que no cargó').toBe(0);
    expect(withoutId(fromLazy), "hebra_create_note responde distinto con 'lazy' que con 'all'").toEqual(
      withoutId(fromAll)
    );
    return { all: fromAll, lazy: fromLazy };
  }

  it('crea en la raíz y en una carpeta pública, y la nota queda igual en las dos copias', async () => {
    all = await lazyHarness(AUDIT_CONFIG);
    lazy = await lazyHarness(AUDIT_CONFIG);
    for (const args of [
      { body: '# Nueva en la raíz\nTexto.\n' },
      { body: `# Nueva con enlaces\n[[${ONLY_HIDDEN}]] y [[id:${lazy.library.privateFolderNoteId}]]\n`, folder: 'Proyectos/Lumbre' }
    ]) {
      const calls = await create(args);
      expect(calls.lazy.isError).toBe(false);
      const fromAll = await all.port.noteRead(calls.all.json.id);
      const fromLazy = await lazy.port.noteRead(calls.lazy.json.id);
      expect(fromLazy?.body).toBe(args.body);
      expect(fromLazy?.title).toBe(fromAll?.title);
      expect(fromLazy?.folderId).toBe(fromAll?.folderId);
    }
  });

  it('carpeta privada (y subcarpeta), inexistente, etiqueta privada en el cuerpo: not_found, sin crear nada', async () => {
    all = await lazyHarness(AUDIT_CONFIG);
    lazy = await lazyHarness(AUDIT_CONFIG);
    const count = async (h: AuditHarness<Extra>) => (await h.port.notesPage(null, 500, { kind: 'all' })).items.length;
    const before = await count(lazy);
    for (const args of [
      { body: '# En privada', folder: 'Diario' },
      { body: '# En subcarpeta privada', folder: 'Diario/2026' },
      { body: '# En ninguna', folder: 'no-existe' },
      { body: '# Con etiqueta\n#secreto/personal\n' }
    ]) {
      const calls = await create(args);
      expect(calls.lazy.json, JSON.stringify(args)).toEqual(NOT_FOUND);
    }
    expect(await count(lazy)).toBe(before);
  });

  it('cuerpo de más: invalid_input, también igual', async () => {
    all = await lazyHarness(AUDIT_CONFIG);
    lazy = await lazyHarness(AUDIT_CONFIG);
    const calls = await create({ body: 'x'.repeat(100_001) });
    expect(calls.lazy.json).toEqual({ error: 'invalid_input' });
  });
});
