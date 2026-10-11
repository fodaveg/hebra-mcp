import { expect, it, vi } from 'vitest';
import { auditHarness, createNote, saveBody, decodeCursor, NOT_FOUND } from './audit-harness';

it('grep no publica en cursor la nota que pasó a oculta al vencer el plazo entre lotes', async () => {
  const h = await auditHarness(async (engine) => {
    const folder = await engine.folderCreate(null, 'CodexGrep');
    const ids: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      ids.push((await createNote(engine, folder.id, `# Nota ${index}\nCODIGO_GREPCURSOR\n`)).id);
    }
    return { ids: ids.sort() };
  });
  const hiddenId = h.extra.ids[64]!;
  const realRead = h.port.grepBodies.bind(h.port);
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  let intercepted = false;
  const spy = vi.spyOn(h.port, 'grepBodies').mockImplementation(async (...args) => {
    const result = await realRead(...args);
    if (!intercepted) {
      intercepted = true;
      await h.mutate((engine) => saveBody(engine, hiddenId, '# Oculta\nCODIGO_GREPCURSOR\n#secreto\n'));
      const now = Date.now();
      let calls = 0;
      // 63 consultas entre las 64 notas del primer lote; el plazo vence justo antes
      // del segundo. No se espera tiempo real ni se cambia el resultado del almacén.
      clock = vi.spyOn(Date, 'now').mockImplementation(() => ++calls <= 63 ? now : now + 10_000);
    }
    return result;
  });
  try {
    const result = await h.call('hebra_grep', { pattern: 'CODIGO_GREPCURSOR', folder: 'CodexGrep', limit: 100 });
    clock?.mockRestore();
    expect(result.isError).toBe(false);
    expect((await h.call('hebra_read_note', { id: hiddenId })).json).toEqual(NOT_FOUND);
    expect(decodeCursor(result.json.nextCursor), 'El cursor del grep revela el id de la nota oculta del siguiente lote').not.toContain(hiddenId);
  } finally {
    clock?.mockRestore();
    spy.mockRestore();
    await h.close();
  }
});
