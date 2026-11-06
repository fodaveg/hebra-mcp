/**
 * La simulación de `hebra_replace_in_notes` SIN `ids` ya no carga la biblioteca entera en el
 * filtro (M1 de la revisión de seguridad del plan de memoria, 6 nov 2026): juzga las candidatas
 * por lotes (`SIMULATE_JUDGE_NOTES`), cada uno cargado con `ensure` y soltado al decidirlo.
 *
 * Sobre `test/fixtures/forget-library.ts` (públicas, privadas por carpeta y por etiqueta,
 * bloqueadas, papelera y lápidas):
 * 1. con lotes de 7 (muchos lotes) y con un lote que cabe en cada tramo (desde M2 la simulación
 *    juzga por tramos de como mucho `SIMULATE_WINDOW_MAX`), los planes, las páginas, los cortes (`continueAfter`) y los recuentos
 *    son IDÉNTICOS, en la biblioteca entera, por carpeta (con y sin subcarpetas) y por etiqueta;
 * 2. lo que entra en los planes es exactamente lo visible del ámbito según el filtro de la
 *    biblioteca entera (`fromSnapshot`);
 * 3. la simulación no lee nunca la visibilidad de todas las notas y lo cargado a la vez en el
 *    índice no pasa del lote.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrivacyFilter } from '../../src/privacy/filter';
import { LibraryIndex, type LibraryIndexSource } from '../../src/privacy/library-index';
import {
  ReplaceBatch,
  type ReplacePlanView,
  type ReplaceResult,
  type ReplaceScope
} from '../../src/store/replace-batch';
import { forgetLibraryHarness, RARE, type ForgetLibrary } from '../fixtures/forget-library';
import { liveNoteRows } from '../fixtures/grep-rows';
import { AUDIT_CONFIG, type AuditHarness } from '../privacy/audit-harness';

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

interface Walked {
  seen: unknown[];
  /** Las notas de todos los planes. */
  planned: string[];
}

/** Simula todo el ámbito por planes de `maxNotes` (siguiendo `continueAfter`) y pide sus
 *  páginas de `limit`; sin aplicar nada. */
async function walk(batch: ReplaceBatch, pattern: string, regex: boolean, scope: ReplaceScope): Promise<Walked> {
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
        maxNotes: 40,
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

const batchWith = (judgeNotes: number): ReplaceBatch =>
  new ReplaceBatch(h.port, h.port, { judgeNotes, simulateBudgetMs: 60_000 });

const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

describe('simulación sin ids, por lotes de privacidad (M1)', () => {
  it('lotes pequeños y un lote entero dan los mismos planes, páginas, cortes y recuentos', { timeout: 120_000 }, async () => {
    const full = PrivacyFilter.fromSnapshot(await h.port.foldersList(), await h.port.notesVisibilityIndex(), AUDIT_CONFIG);
    const visible = [...h.extra.loteVisible, ...h.extra.underDeletedPublic];
    // El escenario es el que dice ser, según el filtro de la biblioteca entera.
    for (const id of visible) expect(full.isHiddenNote(id)).toBe(false);
    for (const id of [...h.extra.hidden, ...h.extra.trashed]) expect(full.isHiddenNote(id)).toBe(true);

    const even = h.extra.loteVisible.filter((_, rank) => rank % 2 === 0);
    const cases: Array<{ pattern: string; regex: boolean; scope: ReplaceScope; expected: string[] }> = [
      { pattern: 'remolacha', regex: false, scope: {}, expected: visible },
      { pattern: 'remolacha \\d+', regex: true, scope: {}, expected: visible },
      { pattern: 'Q7', regex: false, scope: {}, expected: even },
      { pattern: 'remolacha', regex: false, scope: { folder: 'Lote' }, expected: h.extra.loteVisible },
      { pattern: 'remolacha', regex: false, scope: { folder: 'Lote', subfolders: true }, expected: h.extra.loteVisible },
      { pattern: 'remolacha', regex: false, scope: { tag: 'huerta' }, expected: visible },
      { pattern: 'remolacha', regex: false, scope: { tag: 'secreto' }, expected: [] },
      { pattern: 'remolacha', regex: false, scope: { folder: 'Diario' }, expected: [] }
    ];
    for (const { pattern, regex, scope, expected } of cases) {
      const label = JSON.stringify({ pattern, scope });
      const small = await walk(batchWith(7), pattern, regex, scope);
      const whole = await walk(batchWith(1_000_000), pattern, regex, scope);
      expect(small.seen, label).toEqual(whole.seen);
      expect(sorted(small.planned), label).toEqual(sorted(expected));
      if (expected.length > 40) expect(small.seen.length, label).toBeGreaterThan(2);
    }
  });

  it('con ids, como antes: solo esas, sin lotes', async () => {
    const ids = [h.extra.loteVisible[0]!, h.extra.hidden[0]!, h.extra.trashed[0]!, h.extra.underDeletedPublic[0]!];
    const small = await walk(batchWith(1), 'remolacha', false, { ids });
    expect(sorted(small.planned)).toEqual(sorted([h.extra.loteVisible[0]!, h.extra.underDeletedPublic[0]!]));
  });

  it('no lee la biblioteca entera y lo cargado a la vez no pasa del lote', { timeout: 60_000 }, async () => {
    const all = vi.spyOn(h.port, 'notesVisibilityIndex');
    let peak = 0;
    let judged = 0;
    let largest = 0;
    const ensure = LibraryIndex.prototype.ensure;
    vi.spyOn(LibraryIndex.prototype, 'ensure').mockImplementation(async function (
      this: LibraryIndex,
      source: LibraryIndexSource,
      ids: readonly string[]
    ) {
      const loaded = await ensure.call(this, source, ids);
      judged += ids.length;
      largest = Math.max(largest, ids.length);
      peak = Math.max(peak, this.retained);
      return loaded;
    });
    // Una simulación sola (sin `preview`, cuyo filtro carga las notas del plan): todos los
    // `ensure` son de su filtro.
    const plan = (
      await batchWith(7).run({
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
    // El patrón raro: una sola nota en el plan, y el juicio de privacidad pasó por todas las
    // candidatas, una vez cada una y de 7 en 7 como mucho (desde M2, por tramos que se leen y
    // se juzgan según avanza la simulación).
    expect(plan.planNotes).toBe(1);
    expect(all).not.toHaveBeenCalled();
    const candidates = (await liveNoteRows(h.port)).filter((row) => !row.locked).length;
    expect(judged).toBe(candidates);
    expect(largest).toBeLessThanOrEqual(7);
    expect(peak).toBeLessThanOrEqual(7);
  });
});
