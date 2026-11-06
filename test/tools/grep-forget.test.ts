/**
 * `hebra_grep` suelta del filtro lo ya decidido (M1 de la revisión de seguridad del plan de
 * memoria, 6 nov 2026; `PendingNotes` y el bucle de lotes de `src/server/tools/grep.ts`): las de
 * un tramo que no se miran, al juzgarlo, y las de un lote, al recorrerlo, menos la última
 * recorrida y la de la última coincidencia, que un corte posterior aún declara a la puerta final.
 *
 * Lo que se comprueba, sobre `test/fixtures/forget-library.ts` (públicas, privadas por carpeta y
 * por etiqueta, bloqueadas, papelera y lápidas, más notas que dos tramos):
 * 1. Equivalencia: cada página, por `expectLazyEquivalent`, idéntica a la de `'all'` (donde
 *    `forget` no hace nada: el índice está entero), cursores incluidos, y sin preguntar por una
 *    nota no cargada (una soltada que se vuelve a mirar sube ese contador).
 * 2. Los dos cortes que declaran una nota de un lote ANTERIOR: el de la de más con la última
 *    coincidencia en el lote de antes, y el de tiempo entre dos lotes (detrás de la última
 *    recorrida). El de tiempo se provoca sin reloj real: el reloj salta al soltar un lote.
 * 3. Memoria: con un patrón raro (recorre todos los tramos), lo cargado a la vez en el índice no
 *    pasa del tramo más grande más un lote, y queda por debajo de las notas de la biblioteca.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrivacyFilter } from '../../src/privacy/filter';
import { LibraryIndex, type LibraryIndexSource } from '../../src/privacy/library-index';
import { expectLazyEquivalent } from '../fixtures/privacy-load';
import { liveNoteRows } from '../fixtures/grep-rows';
import { forgetLibraryHarness, LOTE_VISIBLE, RARE, type ForgetLibrary } from '../fixtures/forget-library';
import { decodeCursor, type AuditHarness } from '../privacy/audit-harness';

/** `GREP_BATCH_NOTES` de `src/server/tools/grep.ts` (no se exporta). */
const BATCH = 64;

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

/** Todas las páginas, cada una comparada con `'all'`: los ids que salen y cuántas páginas. */
async function walk(args: Record<string, unknown>): Promise<{ ids: string[]; pages: number; matches: number }> {
  const ids: string[] = [];
  let matches = 0;
  let cursor: string | undefined;
  for (let pages = 1; ; pages += 1) {
    const call = await expectLazyEquivalent(h.serverContext, 'hebra_grep', cursor ? { ...args, cursor } : args);
    expect(call.isError, JSON.stringify(call.result)).toBe(false);
    for (const match of call.json.matches as Array<{ id: string }>) {
      matches += 1;
      if (!ids.includes(match.id)) ids.push(match.id);
    }
    if (call.json.nextCursor === null) return { ids, pages, matches };
    cursor = call.json.nextCursor as string;
    expect(pages, 'demasiadas páginas').toBeLessThan(300);
  }
}

const sorted = (ids: Iterable<string>): string[] => [...ids].sort();

describe('hebra_grep suelta lo decidido y responde igual (M1)', () => {
  it('recorridos con y sin prefiltro, por carpeta, etiqueta y expresión: igual que con todo cargado', { timeout: 120_000 }, async () => {
    const visible = [...h.extra.loteVisible, ...h.extra.underDeletedPublic];
    const everything = await walk({ pattern: 'remolacha', limit: 100 });
    expect(sorted(everything.ids)).toEqual(sorted(visible));
    expect(everything.pages).toBeGreaterThan(2);
    // Páginas pequeñas: muchos cursores, cada uno en una nota de un lote ya soltado o no.
    expect(sorted((await walk({ pattern: 'remolacha', limit: 7 })).ids)).toEqual(sorted(visible));
    expect(sorted((await walk({ pattern: 'remolacha', folder: 'Lote', limit: 90 })).ids)).toEqual(
      sorted(h.extra.loteVisible)
    );
    expect(sorted((await walk({ pattern: 'remolacha', tag: 'huerta', limit: 90 })).ids)).toEqual(sorted(visible));
    expect(sorted((await walk({ pattern: 'remolacha \\d+', regex: true, limit: 100 })).ids)).toEqual(sorted(visible));
    // `Q7`: dos letras, sin prefiltro; lo llevan las de rango par de `Lote` (y ocultas).
    const even = h.extra.loteVisible.filter((_, rank) => rank % 2 === 0);
    expect(sorted((await walk({ pattern: 'Q7', limit: 50 })).ids)).toEqual(sorted(even));
  });

  it('el corte por la de más con la última coincidencia en el lote anterior', { timeout: 60_000 }, async () => {
    // Primer lote: rangos 0-63 de `Lote`, 32 coincidencias (pares) y la última recorrida, la 63
    // (impar, sin coincidencia). La de más es la 64, ya en el segundo lote: el cursor nombra la
    // 62, de un lote ya soltado salvo ella.
    const call = await expectLazyEquivalent(h.serverContext, 'hebra_grep', { pattern: 'Q7', folder: 'Lote', limit: 32 });
    expect(call.json.matches).toHaveLength(32);
    expect(call.json.cutoff).toBeNull();
    const last = h.extra.loteVisible[62]!;
    expect(call.json.matches.at(-1).id).toBe(last);
    expect(JSON.parse(decodeCursor(call.json.nextCursor)!)[0]).toBe(last);
    // Y el resto, desde ese cursor.
    expect((await walk({ pattern: 'Q7', folder: 'Lote', limit: 32 })).matches).toBe(LOTE_VISIBLE / 2);
  });

  it('el corte por tiempo ENTRE dos lotes sigue detrás de la última recorrida', { timeout: 60_000 }, async () => {
    // El reloj salta 10 s cada vez que se suelta algo: lo que se suelta al juzgar un tramo no
    // cuenta (ese tiempo se le devuelve al plazo), y lo que se suelta al acabar el primer lote
    // agota el plazo justo antes del segundo. En `'all'` `forget` también se llama (sin efecto),
    // así que las dos cargas cortan en el mismo sitio.
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    const forget = PrivacyFilter.prototype.forget;
    vi.spyOn(PrivacyFilter.prototype, 'forget').mockImplementation(function (this: PrivacyFilter, ids) {
      offset += 10_000;
      return forget.call(this, ids);
    });
    const call = await expectLazyEquivalent(h.serverContext, 'hebra_grep', { pattern: 'Q7', folder: 'Lote', limit: 100 });
    expect(call.json.cutoff).toBe('time');
    expect(call.json.matches).toHaveLength(BATCH / 2);
    // Detrás de la 63, la última recorrida, que no tiene coincidencias.
    expect(JSON.parse(decodeCursor(call.json.nextCursor)!)).toEqual([h.extra.loteVisible[BATCH - 1], 0]);
  });

  it('un patrón raro recorre la biblioteca, pero el índice no pasa de un tramo y un lote', { timeout: 60_000 }, async () => {
    const slices: number[] = [];
    let peak = 0;
    const ensure = LibraryIndex.prototype.ensure;
    vi.spyOn(LibraryIndex.prototype, 'ensure').mockImplementation(async function (
      this: LibraryIndex,
      source: LibraryIndexSource,
      ids: readonly string[]
    ) {
      const loaded = await ensure.call(this, source, ids);
      // Solo el índice perezoso: en `'all'` está entero desde el principio.
      if (!this.isFull()) {
        slices.push(ids.length);
        peak = Math.max(peak, this.retained);
      }
      return loaded;
    });
    const { ids } = await walk({ pattern: RARE });
    expect(ids).toEqual([h.extra.rareVisible]);
    const live = (await liveNoteRows(h.port)).filter((row) => !row.locked).length;
    // Se juzgaron todas las vivas sin bloquear (en tramos), una vez.
    expect(slices.reduce((sum, size) => sum + size, 0)).toBe(live);
    expect(slices.length).toBeGreaterThanOrEqual(3);
    const largest = Math.max(...slices);
    expect(peak, `pico ${peak}, tramo mayor ${largest}, vivas ${live}`).toBeLessThanOrEqual(largest + BATCH + 2);
    expect(peak).toBeLessThan(live);
  });
});
