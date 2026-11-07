/**
 * `safeTextSearch` con un término negativo por subcadena recorre varias páginas del motor hasta llenar
 * el límite. Entre una y otra cede el event loop (`serve-http` es un solo proceso para todas las
 * cuentas) y el resultado no cambia. Sin medir milisegundos: se cuentan las vueltas del event loop.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SqliteLibraryEngine } from '../../src/hebra';
import { auditHarness, createNote } from '../privacy/audit-harness';

async function library() {
  return auditHarness(async (engine) => {
    for (const n of ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis']) {
      await createNote(engine, null, `# Garbanzos ${n}\ngarbanzos ${n}\n`);
    }
  });
}

describe('safeTextSearch cede el hilo entre páginas del motor', () => {
  it('una vuelta del event loop entre dos consultas al motor', async () => {
    const h = await library();
    try {
      const engine = (h.port as unknown as { engine: SqliteLibraryEngine }).engine;
      const original = engine.search.bind(engine);
      let ticks = 0;
      let timer: NodeJS.Immediate;
      const tick = (): void => {
        ticks += 1;
        timer = setImmediate(tick);
      };
      timer = setImmediate(tick);
      const seen: number[] = [];
      const spy = vi.spyOn(engine, 'search').mockImplementation((...args) => {
        seen.push(ticks);
        return original(...args);
      });
      try {
        // Todas contienen «anzos»: se excluyen todas y se recorre el motor entero, de una en una.
        const page = await h.port.search('garbanzos -anzos', null, 1, null, null);
        expect(page.items).toEqual([]);
        expect(seen.length).toBeGreaterThanOrEqual(6);
        for (let i = 1; i < seen.length; i += 1) expect(seen[i]!, `consulta ${i}`).toBeGreaterThan(seen[i - 1]!);
      } finally {
        spy.mockRestore();
        clearImmediate(timer);
      }
    } finally {
      await h.close();
    }
  });

  it('el resultado y el cursor no dependen del tamaño de página', async () => {
    const h = await library();
    try {
      const all = await h.port.search('garbanzos -tres', null, 50, null, null);
      expect(all.items.length).toBe(5);
      expect(all.items.every((item) => !item.title.includes('tres'))).toBe(true);
      const walked: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await h.port.search('garbanzos -tres', cursor, 1, null, null);
        walked.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(walked).toEqual(all.items.map((item) => item.id));
    } finally {
      await h.close();
    }
  });
});
