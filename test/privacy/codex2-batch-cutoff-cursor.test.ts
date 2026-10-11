import { expect, it, vi } from 'vitest';
import { auditHarness, createNote, saveBody, decodeCursor, NOT_FOUND } from './audit-harness';

it('simulate no revela en continueAfter la nota que se ocultó entre lotes', async () => {
  const h = await auditHarness(async (engine) => {
    const folder = await engine.folderCreate(null, 'Codex2Simulate');
    const ids: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      ids.push((await createNote(engine, folder.id, `# Lote ${index}\nTOKEN_SIMULATE_CUTOFF\n`)).id);
    }
    return ids.sort();
  });
  const hiddenId = h.extra[64]!;
  const read = h.port.grepBodies.bind(h.port);
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  let intercepted = false;
  const spy = vi.spyOn(h.port, 'grepBodies').mockImplementation(async (...args) => {
    const result = await read(...args);
    if (!intercepted) {
      intercepted = true;
      await h.mutate((engine) => saveBody(engine, hiddenId, '# Privada\nTOKEN_SIMULATE_CUTOFF\n#secreto\n'));
      const now = Date.now();
      let calls = 0;
      // Una llamada fija deadline y 63 miran el plazo entre las 64 notas leídas.
      // La siguiente vence antes de que se lea el segundo lote.
      clock = vi.spyOn(Date, 'now').mockImplementation(() => ++calls <= 64 ? now : now + 10_000);
    }
    return result;
  });
  try {
    const result = await h.call('hebra_replace_in_notes', {
      mode: 'simulate', pattern: 'TOKEN_SIMULATE_CUTOFF', replacement: 'RESULTADO', folder: 'Codex2Simulate', limit: 100
    });
    clock?.mockRestore();
    expect(result.isError).toBe(false);
    expect((await h.call('hebra_read_note', { id: hiddenId })).json).toEqual(NOT_FOUND);
    expect(result.json.cutoff).toBe('time');
    expect(decodeCursor(result.json.continueAfter), 'continueAfter revela el id oculto del lote todavía no leído').not.toContain(hiddenId);
  } finally {
    clock?.mockRestore();
    spy.mockRestore();
    await h.close();
  }
});
