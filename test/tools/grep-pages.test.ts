/**
 * `hebra_grep` y la simulación de `hebra_replace_in_notes` leen las notas vivas por páginas
 * (M2 del plan de memoria, 6 nov 2026; `NoteRowsById`, `grepNotesPage`), en vez de pedir las filas
 * de la biblioteca entera de una vez (`grepNotes`, unos 4,8 MiB a 30 000 notas).
 *
 * Sobre `test/fixtures/forget-library.ts` (públicas, privadas por carpeta y por etiqueta,
 * bloqueadas, papelera y lápidas) y con páginas de 3 filas (más de cien páginas por recorrido):
 * 1. Equivalencia: cada página de `hebra_grep` (coincidencias, cursores, cortes) y cada plan de la
 *    simulación (páginas, `continueAfter`, recuentos) son IDÉNTICOS a los de leer la biblioteca en
 *    una sola página, que es lo que se hacía antes; en `hebra_grep`, también a los de cargar la
 *    biblioteca entera en el filtro (`loadAll`).
 * 2. Filas: ninguna lectura devuelve más de una página, un recorrido lee muchas, y los informes
 *    de un plan leen las filas de sus notas por id, sin recorrer la biblioteca.
 * 3. El plazo: leer una página nueva a mitad del recorrido no cuenta para el plazo (como no
 *    contaba leerlas todas antes de empezar), así que lo que tarden las filas de las notas
 *    ocultas no corta la respuesta. El reloj salta 10 s en cada página leída.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveToolContext } from '../../src/server/context';
import { runGrep, type GrepInput, type GrepOutput } from '../../src/server/tools/grep';
import {
  ReplaceBatch,
  type ReplacePlanView,
  type ReplaceResult,
  type ReplaceScope
} from '../../src/store/replace-batch';
import { forgetLibraryHarness, RARE, type ForgetLibrary } from '../fixtures/forget-library';
import { liveNoteRows } from '../fixtures/grep-rows';
import { AUDIT_CONFIG, type AuditHarness } from '../privacy/audit-harness';

/** Una sola página: la biblioteca entera de una vez, como antes de M2. */
const WHOLE = 1_000_000;
/** Páginas pequeñas: un recorrido atraviesa más de cien. */
const SMALL = 3;

let h: AuditHarness<ForgetLibrary>;

beforeAll(async () => {
  h = await forgetLibraryHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

/** Todas las páginas de `hebra_grep`, cada una con un contexto recién hecho (como cada llamada). */
async function grepWalk(
  input: GrepInput,
  notesPage: number,
  loadAll = false,
  timeBudgetMs = 60_000
): Promise<GrepOutput[]> {
  const pages: GrepOutput[] = [];
  let cursor: string | undefined;
  for (let round = 0; round < 300; round += 1) {
    const ctx = await resolveToolContext(h.serverContext, { loadAll });
    const page = await runGrep(ctx, cursor ? { ...input, cursor } : input, { timeBudgetMs, notesPage });
    pages.push(page);
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
  throw new Error('demasiadas páginas');
}

const matchedIds = (pages: readonly GrepOutput[]): string[] => sorted(pages.flatMap((page) => page.matches.map((match) => match.id)));

/** La salida sin lo aleatorio: el `planId` (también dentro de los cursores) y `expiresAt`. */
function normalized(result: ReplaceResult): unknown {
  const planId = 'planId' in result ? result.planId : null;
  const text = JSON.stringify(result)
    .replace(/"rp1\.([A-Za-z0-9_-]+)"/g, (_, payload: string) =>
      JSON.stringify(`rp1:${Buffer.from(payload, 'base64url').toString('utf8')}`)
    )
    .split(planId ?? '\u0000')
    .join('PLAN')
    .replace(/"expiresAt":"[^"]+"/g, '"expiresAt":"EXP"');
  return JSON.parse(text);
}

/** Simula todo el ámbito por planes de `maxNotes` (siguiendo `continueAfter`) y pide sus páginas. */
async function simulateWalk(
  batch: ReplaceBatch,
  pattern: string,
  regex: boolean,
  scope: ReplaceScope,
  maxNotes = 40
): Promise<{ seen: unknown[]; planned: string[] }> {
  const seen: unknown[] = [];
  const planned: string[] = [];
  let after: string | undefined;
  for (let round = 0; round < 50; round += 1) {
    const plan = (
      await batch.run({
        mode: 'simulate',
        pattern,
        regex,
        caseSensitive: false,
        replacement: 'CAMBIO',
        scope,
        maxNotes,
        limit: 15,
        privacy: AUDIT_CONFIG,
        ...(after ? { after } : {})
      })
    ).result as ReplacePlanView & { gateNotes?: string[] };
    seen.push(normalized(plan));
    planned.push(...(plan.gateNotes ?? []));
    let cursor = plan.nextCursor;
    while (cursor && plan.planId) {
      const page = (await batch.run({ mode: 'preview', planId: plan.planId, cursor, limit: 15, privacy: AUDIT_CONFIG }))
        .result as ReplacePlanView;
      seen.push(normalized(page));
      cursor = page.nextCursor;
    }
    if (!plan.continueAfter) return { seen, planned };
    after = plan.continueAfter;
  }
  throw new Error('demasiadas vueltas');
}

const batchWith = (notesPage: number, judgeNotes: number): ReplaceBatch =>
  new ReplaceBatch(h.port, h.port, { notesPage, judgeNotes, simulateBudgetMs: 60_000 });

/** Las lecturas de filas del puerto: cuántas filas devolvió cada una. */
function spyPages(): number[] {
  const sizes: number[] = [];
  const page = h.port.grepNotesPage.bind(h.port);
  vi.spyOn(h.port, 'grepNotesPage').mockImplementation(async (from, limit) => {
    const rows = await page(from, limit);
    sizes.push(rows.length);
    return rows;
  });
  return sizes;
}

/** El reloj salta 10 s en cada página de filas leída. */
function clockJumpsOnPages(): void {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  const page = h.port.grepNotesPage.bind(h.port);
  vi.spyOn(h.port, 'grepNotesPage').mockImplementation(async (from, limit) => {
    offset += 10_000;
    return page(from, limit);
  });
}

describe('hebra_grep por páginas (M2)', () => {
  it('páginas pequeñas, una sola página y la biblioteca entera en el filtro: las mismas respuestas', { timeout: 120_000 }, async () => {
    const visible = [...h.extra.loteVisible, ...h.extra.underDeletedPublic];
    const even = h.extra.loteVisible.filter((_, rank) => rank % 2 === 0);
    const cases: Array<{ input: GrepInput; expected: string[] }> = [
      { input: { pattern: 'remolacha', limit: 100 }, expected: visible },
      { input: { pattern: 'remolacha', limit: 7 }, expected: visible },
      { input: { pattern: 'remolacha', folder: 'Lote', limit: 90 }, expected: h.extra.loteVisible },
      { input: { pattern: 'remolacha', tag: 'huerta', limit: 90 }, expected: visible },
      { input: { pattern: 'remolacha \\d+', regex: true, limit: 100 }, expected: visible },
      { input: { pattern: 'Q7', limit: 50 }, expected: even },
      { input: { pattern: RARE }, expected: [h.extra.rareVisible] },
      { input: { pattern: 'remolacha', folder: 'Diario' }, expected: [] }
    ];
    for (const { input, expected } of cases) {
      const label = JSON.stringify(input);
      const small = await grepWalk(input, SMALL);
      expect(small, label).toEqual(await grepWalk(input, WHOLE));
      expect(small, label).toEqual(await grepWalk(input, WHOLE, true));
      expect(matchedIds(small), label).toEqual(sorted(expected));
    }
  });

  it('ninguna lectura pasa de una página, y un patrón raro lee muchas', { timeout: 60_000 }, async () => {
    const live = (await liveNoteRows(h.port)).length;
    const sizes = spyPages();
    const pages = await grepWalk({ pattern: RARE }, 50);
    expect(matchedIds(pages)).toEqual([h.extra.rareVisible]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
    // Recorre la biblioteca entera (cada fila una vez), pero página a página.
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(live);
    expect(sizes.length).toBeGreaterThanOrEqual(Math.ceil(live / 50));
  });

  it('leer páginas a mitad del recorrido no cuenta para el plazo', { timeout: 60_000 }, async () => {
    const input: GrepInput = { pattern: 'Q7', limit: 100 };
    const reference = await grepWalk(input, WHOLE);
    expect(reference.map((page) => page.cutoff)).toEqual([null, null]);
    clockJumpsOnPages();
    // Más de cien páginas de 3 filas, 10 s cada una, con el plazo de producción (2 s).
    const paged = await grepWalk(input, SMALL, false, 2_000);
    expect(paged).toEqual(reference);
  });
});

describe('simulación de hebra_replace_in_notes por páginas (M2)', () => {
  it('páginas pequeñas y una sola página: los mismos planes, páginas, cortes y recuentos', { timeout: 120_000 }, async () => {
    const visible = [...h.extra.loteVisible, ...h.extra.underDeletedPublic];
    const even = h.extra.loteVisible.filter((_, rank) => rank % 2 === 0);
    const someIds = [
      h.extra.loteVisible[0]!,
      h.extra.loteVisible[200]!,
      h.extra.hidden[0]!,
      h.extra.trashed[0]!,
      h.extra.underDeletedPublic[3]!,
      h.extra.loteVisible[0]!
    ];
    const cases: Array<{ pattern: string; regex: boolean; scope: ReplaceScope; expected: string[] }> = [
      { pattern: 'remolacha', regex: false, scope: {}, expected: visible },
      { pattern: 'remolacha \\d+', regex: true, scope: {}, expected: visible },
      { pattern: 'Q7', regex: false, scope: {}, expected: even },
      { pattern: RARE, regex: false, scope: {}, expected: [h.extra.rareVisible] },
      { pattern: 'remolacha', regex: false, scope: { folder: 'Lote', subfolders: true }, expected: h.extra.loteVisible },
      { pattern: 'remolacha', regex: false, scope: { tag: 'huerta' }, expected: visible },
      { pattern: 'remolacha', regex: false, scope: { folder: 'Diario' }, expected: [] },
      {
        pattern: 'remolacha',
        regex: false,
        scope: { ids: someIds },
        expected: [h.extra.loteVisible[0]!, h.extra.loteVisible[200]!, h.extra.underDeletedPublic[3]!]
      }
    ];
    for (const { pattern, regex, scope, expected } of cases) {
      const label = JSON.stringify({ pattern, scope });
      const small = await simulateWalk(batchWith(SMALL, 7), pattern, regex, scope);
      const whole = await simulateWalk(batchWith(WHOLE, WHOLE), pattern, regex, scope);
      expect(small.seen, label).toEqual(whole.seen);
      expect(sorted(small.planned), label).toEqual(sorted(expected));
      if (expected.length > 40) expect(small.seen.length, label).toBeGreaterThan(2);
    }
  });

  it('ninguna lectura pasa de una página, y los informes del plan leen solo sus notas', { timeout: 60_000 }, async () => {
    const live = (await liveNoteRows(h.port)).length;
    const sizes = spyPages();
    const plan = (
      await batchWith(50, 7).run({
        mode: 'simulate',
        pattern: RARE,
        regex: false,
        caseSensitive: false,
        replacement: 'CAMBIO',
        scope: {},
        maxNotes: 200,
        limit: 1,
        privacy: AUDIT_CONFIG
      })
    ).result as ReplacePlanView;
    expect(plan.planNotes).toBe(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(live);
    expect(sizes.length).toBeGreaterThanOrEqual(Math.ceil(live / 50));

    // `preview` (`visibleNow`): las filas de las notas del plan, por id; ninguna página.
    sizes.length = 0;
    const forIds = vi.spyOn(h.port, 'grepNotesFor');
    const fromStart = `rp1.${Buffer.from(JSON.stringify([plan.planId, 0]), 'utf8').toString('base64url')}`;
    await batchWith(50, 7).run({ mode: 'preview', planId: plan.planId!, cursor: fromStart, limit: 1, privacy: AUDIT_CONFIG });
    expect(sizes).toEqual([]);
    expect(forIds).toHaveBeenCalledTimes(1);
    expect(forIds.mock.calls[0]![0]).toEqual([h.extra.rareVisible]);
  });

  it('leer páginas a mitad de la simulación no cuenta para el plazo', { timeout: 60_000 }, async () => {
    const run = (notesPage: number, budget: number) =>
      new ReplaceBatch(h.port, h.port, { notesPage, simulateBudgetMs: budget }).run({
        mode: 'simulate',
        pattern: 'Q7',
        regex: false,
        caseSensitive: false,
        replacement: 'CAMBIO',
        scope: {},
        maxNotes: 200,
        limit: 200,
        privacy: AUDIT_CONFIG
      });
    const reference = normalized((await run(WHOLE, 60_000)).result) as ReplacePlanView;
    expect(reference.cutoff).toBeNull();
    clockJumpsOnPages();
    const paged = normalized((await run(SMALL, 2_000)).result);
    expect(paged).toEqual(reference);
  });
});
