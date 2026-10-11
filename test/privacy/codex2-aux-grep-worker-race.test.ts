import { describe, expect, it, vi } from 'vitest';
import { RegexScanWorker } from '../../src/store/regex-worker';
import { auditHarness, createNote, decodeCursor, saveBody, NOT_FOUND } from './audit-harness';

const BAIT = 'CEBO_CODEX2_GREP_WORKER';

describe('ronda 2: grep después de leer un lote y mientras trabaja el hilo', () => {
  it('no devuelve coincidencias ni cursor de una nota ocultada antes de escanear el lote ya leído', async () => {
    const body = `# Nota visible\n${BAIT} uno\n${BAIT} dos\n`;
    const h = await auditHarness(async (engine) => ({
      id: (await createNote(engine, null, body)).id
    }));
    const scan = RegexScanWorker.prototype.scan;
    const spy = vi.spyOn(RegexScanWorker.prototype, 'scan').mockImplementationOnce(async function (...args) {
      // El cuerpo se leyó en el turno del puerto. El hilo usa esos bytes mientras
      // otra ronda puede cambiar la privacidad; el spy solo fija esa intercalación.
      await h.mutate(async (engine) => saveBody(engine, h.extra.id, `${body}\n#secreto\n`));
      return scan.apply(this, args);
    });
    try {
      const raced = await h.call('hebra_grep', { pattern: `^${BAIT}`, regex: true, limit: 1 });
      spy.mockRestore();
      expect((await h.call('hebra_read_note', { id: h.extra.id })).json).toEqual(NOT_FOUND);
      const stable = await h.call('hebra_grep', { pattern: `^${BAIT}`, regex: true, limit: 1 });
      expect(stable.json.matches).toEqual([]);
      expect(
        { matches: raced.json.matches, cursor: decodeCursor(raced.json.nextCursor) },
        'El filtro del lote no se vuelve a comprobar tras el trabajo asíncrono: salen texto e id ya privados'
      ).toEqual({ matches: [], cursor: null });
    } finally {
      spy.mockRestore();
      await h.close();
    }
  });
});
