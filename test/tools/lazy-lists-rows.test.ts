/**
 * Cuánto lee el filtro de privados en `hebra_search`, `hebra_grep` y `hebra_list_notes` con
 * `privacyLoad: 'lazy'` (A4 del plan de memoria, 6 nov 2026), sobre una biblioteca de 5 000
 * notas: del orden de las notas de la página, no de la biblioteca. Se cuentan filas pedidas a
 * `notesVisibilityIndexFor` (lo que carga `ensure`) y llamadas a `notesVisibilityIndex` (la
 * biblioteca entera, lo que hacía `ensureAll` en cada llamada): contadores, no milisegundos.
 *
 * La biblioteca se hace UNA vez para el fichero (con el motor, unos segundos): una de cada
 * cinco notas oculta por etiqueta, una de cada once en la carpeta privada.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { callToolWithLoad } from '../fixtures/privacy-load';
import { auditHarness, createNote, type AuditHarness } from '../privacy/audit-harness';

const NOTES = 5_000;

interface Big {
  visible: number;
}

let h: AuditHarness<Big>;

beforeAll(async () => {
  h = await auditHarness<Big>(async (engine, library) => {
    const folder = await engine.folderCreate(null, 'Grande');
    let visible = 0;
    for (let index = 0; index < NOTES; index += 1) {
      const inPrivate = index % 11 === 0;
      const tagged = index % 5 === 0;
      const body = `# Grande ${index}\n#lote${tagged ? '\n#secreto' : ''}\nchirivía ${index}\n`;
      await createNote(engine, inPrivate ? library.folders.diario2026 : folder.id, body);
      if (!inPrivate && !tagged) visible += 1;
    }
    return { visible };
  });
}, 300_000);

afterAll(async () => {
  await h?.close();
});

/** Filas pedidas a `notesVisibilityIndexFor`, llamadas a él y a `notesVisibilityIndex` durante
 *  UNA llamada de `name` con su carga declarada. */
async function measure(name: string, args: Record<string, unknown>, load: 'declared' | 'all' = 'declared') {
  const forIds = vi.spyOn(h.port, 'notesVisibilityIndexFor');
  const all = vi.spyOn(h.port, 'notesVisibilityIndex');
  try {
    const call = await callToolWithLoad(h.serverContext, name, args, load);
    expect(call.isError, JSON.stringify(call.json)).toBe(false);
    const fullRows = await Promise.all(all.mock.results.map((result) => result.value as Promise<unknown[]>));
    return {
      call,
      requestedRows: forIds.mock.calls.reduce((sum, [ids]) => sum + ids.length, 0),
      forIdsCalls: forIds.mock.calls.length,
      fullCalls: all.mock.calls.length,
      fullRows: fullRows.reduce((sum, rows) => sum + rows.length, 0)
    };
  } finally {
    forIds.mockRestore();
    all.mockRestore();
  }
}

describe(`filas de visibilidad leídas por llamada, con ${NOTES} notas`, () => {
  it('con la carga entera: la biblioteca entera en cada llamada (la referencia)', async () => {
    const m = await measure('hebra_list_notes', { folder: 'Grande' }, 'all');
    expect(m.fullCalls).toBe(1);
    expect(m.fullRows).toBeGreaterThan(NOTES);
    console.info(`[A4] hebra_list_notes 'all': notesVisibilityIndex ${m.fullCalls} llamada, ${m.fullRows} filas`);
  });

  it.each([
    ['hebra_list_notes', { folder: 'Grande' }, 50, 120],
    ['hebra_list_notes', { tag: 'lote', limit: 100 }, 100, 250],
    ['hebra_search', { query: 'chirivía' }, 20, 60],
    ['hebra_search', { query: 'chirivía', folder: 'Grande', limit: 50 }, 50, 120],
    ['hebra_grep', { pattern: 'chirivía' }, 20, 128],
    ['hebra_grep', { pattern: 'chirivía', tag: 'lote', limit: 100 }, 100, 384]
  ] as const)('%s %j: del orden de la página', async (name, args, pageSize, maxRows) => {
    const m = await measure(name, args);
    const list = (m.call.json.notes ?? m.call.json.results ?? m.call.json.matches) as unknown[];
    expect(list).toHaveLength(pageSize);
    expect(m.call.json.nextCursor).not.toBeNull();
    expect(m.call.unloadedLookups).toBe(0);
    expect(m.fullCalls, 'leyó la biblioteca entera').toBe(0);
    expect(m.requestedRows).toBeLessThanOrEqual(maxRows);
    console.info(
      `[A4] ${name} ${JSON.stringify(args)}: página ${pageSize}, notesVisibilityIndexFor ` +
        `${m.forIdsCalls} llamadas, ${m.requestedRows} filas pedidas (de ${NOTES})`
    );
  });
});
