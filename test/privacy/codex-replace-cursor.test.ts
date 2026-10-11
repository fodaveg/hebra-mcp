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
    expect(decoded[1], 'El cursor deja un hueco por una nota oculta: tras 1 visible anuncia posición 2').toBe(1);
  } finally { await h.close(); }
});
