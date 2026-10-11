import { expect, it } from 'vitest';
import { auditHarness, createNote, saveBody, NOT_FOUND } from './audit-harness';

it('preview no cuenta notas ahora ocultas en la posición del siguiente cursor', async () => {
  const h = await auditHarness(async (engine) => {
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push((await createNote(engine, null, `# Plan ${index}\nCODIGO_CURSOR\n`)).id);
    }
    return { ids: ids.sort() };
  });
  try {
    const simulation = await h.call('hebra_replace_in_notes', {
      mode: 'simulate', pattern: 'CODIGO_CURSOR', replacement: 'OTRO', ids: h.extra.ids, limit: 1
    });
    expect(simulation.isError).toBe(false);
    const planId = simulation.json.planId;
    const hiddenId = h.extra.ids[1]!;
    await h.mutate((engine) => saveBody(engine, hiddenId, '# Ahora privado\nCODIGO_CURSOR\n#secreto\n'));
    expect((await h.call('hebra_read_note', { id: hiddenId })).json).toEqual(NOT_FOUND);
    const cursor = `rp1.${Buffer.from(JSON.stringify([planId, 0])).toString('base64url')}`;
    const result = await h.call('hebra_replace_in_notes', { mode: 'preview', planId, cursor, limit: 1 });
    expect(result.isError).toBe(false);
    expect(result.json.notes).toHaveLength(1);
    const decoded = JSON.parse(Buffer.from(result.json.nextCursor.split('.')[1], 'base64url').toString());
    // Desde la 2.ª vuelta de d64e187e el cursor de preview es la CLAVE de la última devuelta
    // (`[planId, id]`), no una posición: no cuenta nada, y el hueco no se puede producir.
    expect(decoded[1], 'El cursor no lleva más que la última nota devuelta').toBe(result.json.notes[0].id);
    expect(JSON.stringify(decoded)).not.toContain(hiddenId);
  } finally { await h.close(); }
});
