/**
 * `hebra_grep` perezosa (A4 del plan de memoria, 6 nov 2026): registrada con
 * `privacyLoad: 'lazy'`, juzga las notas por tramos en orden de id (`PendingNotes` de
 * `src/server/tools/grep.ts`), cada tramo cargado con `ensure` antes de mirarlo, y solo hasta
 * donde llega la página. Cada página pasa por `expectLazyEquivalent`
 * (`test/fixtures/privacy-load.ts`): sin preguntas por notas no cargadas y con la respuesta
 * (cursor incluido) idéntica a la de `'all'`; y además se comprueba QUÉ responde.
 *
 * Los cortes por tiempo no se comparan aquí: dependen del reloj, y la equivalencia de dos
 * llamadas con un reloj real no es determinista. Que juzgar un tramo no cuente para el plazo
 * lo dice el código (`deadline += …`), y los tests de corte con reloj falso de siempre
 * (`test/privacy/codex-replace-grep-cursor.test.ts`, `test/tools/grep.test.ts`) siguen igual.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectLazyEquivalent } from '../fixtures/privacy-load';
import { lazyListsHarness, WORD, type LazyLists } from '../fixtures/lazy-lists-library';
import { AUDIT_CONFIG, auditHarness, createNote, lockedBody, saveBody, type AuditHarness } from '../privacy/audit-harness';

/** Recorre todas las páginas, cada una comparada con `'all'`; devuelve los ids (sin repetir,
 *  en el orden en que salen) y cuántas páginas. */
async function walk(
  h: AuditHarness<unknown>,
  args: Record<string, unknown>
): Promise<{ ids: string[]; matches: number; pages: number }> {
  const ids: string[] = [];
  let matches = 0;
  let cursor: string | undefined;
  for (let pages = 1; ; pages += 1) {
    const call = await expectLazyEquivalent(h.serverContext, 'hebra_grep', cursor ? { ...args, cursor } : args);
    expect(call.isError, JSON.stringify(call.json)).toBe(false);
    expect(call.json.cutoff).toBeNull();
    for (const match of call.json.matches as Array<{ id: string }>) {
      matches += 1;
      if (!ids.includes(match.id)) ids.push(match.id);
    }
    if (call.json.nextCursor === null) return { ids, matches, pages };
    cursor = call.json.nextCursor as string;
    expect(pages, 'demasiadas páginas').toBeLessThan(200);
  }
}

function sorted(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

describe('hebra_grep con privacyLoad lazy: igual que con la biblioteca entera', () => {
  let h: AuditHarness<LazyLists> | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('un literal con prefiltro, en páginas pequeñas con ocultas entre medias', async () => {
    h = await lazyListsHarness();
    const { ids, pages } = await walk(h, { pattern: WORD, limit: 3 });
    expect(sorted(ids)).toEqual(sorted([...h.extra.visibleIds, h.extra.destinoVisibleId]));
    expect(pages).toBeGreaterThan(3);
  });

  it('un literal corto (sin prefiltro), con contexto, por carpeta y subcarpetas', async () => {
    h = await lazyListsHarness();
    const { ids } = await walk(h, { pattern: 'za', folder: 'Huerto', subfolders: true, contextLines: 1, limit: 5 });
    expect(sorted(ids)).toEqual(sorted(h.extra.visibleIds));
  });

  it('por carpeta sin subcarpetas', async () => {
    h = await lazyListsHarness();
    const { ids } = await walk(h, { pattern: WORD, folder: 'Huerto', limit: 4 });
    expect(sorted(ids)).toEqual(sorted(h.extra.visibleHuertoIds));
  });

  it('por etiqueta (`hasTag`)', async () => {
    h = await lazyListsHarness();
    const { ids } = await walk(h, { pattern: WORD, tag: 'verdura', limit: 2 });
    expect(sorted(ids)).toEqual(sorted(h.extra.visibleTaggedIds));
  });

  it('una expresión regular', async () => {
    h = await lazyListsHarness();
    const { ids } = await walk(h, { pattern: `${WORD} \\d+`, regex: true, limit: 2 });
    expect(sorted(ids)).toEqual(sorted(h.extra.visibleHuertoIds));
  });

  it('etiqueta o carpeta privadas, inexistentes, y sin coincidencias: vacía', async () => {
    h = await lazyListsHarness();
    for (const args of [
      { pattern: WORD, tag: 'secreto' },
      { pattern: WORD, folder: 'Diario' },
      { pattern: WORD, tag: 'no-existe' },
      { pattern: WORD, folder: 'No existe' },
      { pattern: 'palabraquenoesta' },
      { pattern: 'tirada' }
    ]) {
      const call = await expectLazyEquivalent(h.serverContext, 'hebra_grep', args);
      expect(call.json, JSON.stringify(args)).toEqual({ matches: [], nextCursor: null, cutoff: null });
    }
  });

  it('bloqueadas sin etiquetas privadas: no se miran (van cifradas), igual en las dos cargas', async () => {
    h = await lazyListsHarness({ privateFolders: [['diario']], privateTags: [] });
    const { ids } = await walk(h, { pattern: WORD, folder: 'Huerto', limit: 4 });
    for (const id of ids) expect(h.extra.visibleHuertoIds.has(id) || h.extra.hiddenIds.has(id)).toBe(true);
    expect(ids.length).toBeGreaterThan(h.extra.visibleHuertoIds.size);
  });
});

/** 900 notas en `Montón`: una de cada seis visible (150); las otras, por etiqueta privada,
 *  bloqueadas o en la carpeta privada. Todas con `remolacha`; `aguja_rara` solo en dos (una
 *  visible y una oculta). Más que los dos primeros tramos (128 y 256) y que dos lotes. */
const PILE_NOTES = 900;

interface Pile {
  visible: string[];
  hidden: string[];
  rareVisible: string;
}

async function pileHarness(): Promise<AuditHarness<Pile>> {
  return auditHarness<Pile>(async (engine, library) => {
    const pile = await engine.folderCreate(null, 'Montón');
    const out: Pile = { visible: [], hidden: [], rareVisible: '' };
    for (let index = 0; index < PILE_NOTES; index += 1) {
      // 0: visible; 1-3: `#secreto`; 4: en la carpeta privada; 5: bloqueada.
      const kind = index % 6;
      const rare = index === 600 || index === 601;
      const folderId = kind === 4 ? library.folders.diario2026 : pile.id;
      const secret = kind >= 1 && kind <= 3;
      const body = `# Montón ${index}\n#huerta${secret ? '\n#secreto' : ''}\nremolacha ${index}\n${rare ? 'aguja_rara\n' : ''}`;
      const note = await createNote(engine, folderId, body);
      if (kind === 5) await saveBody(engine, note.id, lockedBody(`Montón ${index}`, []));
      if (kind === 0) {
        out.visible.push(note.id);
        if (rare) out.rareVisible = note.id;
      } else {
        out.hidden.push(note.id);
      }
    }
    return out;
  }, AUDIT_CONFIG);
}

describe('hebra_grep perezosa con más notas que un tramo', () => {
  // Una sola biblioteca para los dos (son lecturas): hacerla cuesta unos segundos.
  let h: AuditHarness<Pile>;

  beforeAll(async () => {
    h = await pileHarness();
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('una página que necesita varios lotes y tramos, y la siguiente desde su cursor', { timeout: 60_000 }, async () => {
    // La primera página sola: 101 notas visibles (dos lotes y la de más) no caben en lo que se
    // juzga antes de empezar (los dos primeros tramos, 384 filas, unas 70 visibles), así que
    // hay que juzgar otro tramo a mitad del recorrido.
    const forIds = vi.spyOn(h.port, 'notesVisibilityIndexFor');
    const first = await expectLazyEquivalent(h.serverContext, 'hebra_grep', { pattern: 'remolacha', limit: 100 });
    const ensureReads = forIds.mock.calls.length;
    forIds.mockRestore();
    expect(first.json.matches).toHaveLength(100);
    expect(ensureReads, 'no hizo falta un tramo a mitad del recorrido').toBeGreaterThanOrEqual(3);
    const { ids, pages } = await walk(h, { pattern: 'remolacha', limit: 100 });
    expect(sorted(ids)).toEqual(sorted(h.extra.visible));
    expect(pages).toBe(2);
    // Por etiqueta y por carpeta, el mismo recorrido.
    expect(sorted((await walk(h, { pattern: 'remolacha', tag: 'huerta', limit: 70 })).ids)).toEqual(sorted(h.extra.visible));
    expect(sorted((await walk(h, { pattern: 'remolacha', folder: 'Montón', limit: 70 })).ids)).toEqual(
      sorted(h.extra.visible)
    );
  });

  it('un patrón raro recorre todos los tramos con el prefiltro: solo la visible', { timeout: 60_000 }, async () => {
    const candidates = vi.spyOn(h.port, 'grepCandidates');
    try {
      const { ids } = await walk(h, { pattern: 'aguja_rara' });
      expect(ids).toEqual([h.extra.rareVisible]);
      // Los tramos doblan (128, 256, 512, 1024): cuatro llamadas al prefiltro por carga, no una
      // por lote; `expectLazyEquivalent` llama dos veces.
      expect(candidates.mock.calls.length).toBeLessThanOrEqual(2 * 4);
    } finally {
      candidates.mockRestore();
    }
  });
});
