import { expect, it } from 'vitest';
import { auditHarness, createNote, decodeCursor, saveBody, NOT_FOUND } from './audit-harness';

it('preview no cuenta una nota oculta anterior a la primera nota de la página', async () => {
  const h = await auditHarness(async (engine) => {
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push((await createNote(engine, null, `# Página ${index}\nCODIGO_PREFIX\n`)).id);
    }
    return ids.sort();
  });
  try {
    const simulated = await h.call('hebra_replace_in_notes', {
      mode: 'simulate', pattern: 'CODIGO_PREFIX', replacement: 'OTRO', ids: h.extra, limit: 1
    });
    expect(simulated.isError).toBe(false);
    const planId = simulated.json.planId;
    await h.mutate((engine) => saveBody(engine, h.extra[0]!, '# Privada\nCODIGO_PREFIX\n#secreto\n'));
    expect((await h.call('hebra_read_note', { id: h.extra[0] })).json).toEqual(NOT_FOUND);
    const cursor = `rp1.${Buffer.from(JSON.stringify([planId, 0])).toString('base64url')}`;
    const result = await h.call('hebra_replace_in_notes', { mode: 'preview', planId, cursor, limit: 1 });
    expect(result.isError).toBe(false);
    expect(result.json.notes.map((note: { id: string }) => note.id)).toEqual([h.extra[1]]);
    // Desde la 2.ª vuelta de d64e187e el cursor de preview es la CLAVE de la última devuelta
    // (`[planId, id]`): no cuenta la nota oculta de antes ni ninguna otra.
    const decoded = JSON.parse(decodeCursor(result.json.nextCursor)!);
    expect(decoded[1], 'El cursor no lleva más que la última nota devuelta').toBe(h.extra[1]);
    expect(JSON.stringify(decoded)).not.toContain(h.extra[0]!);
  } finally { await h.close(); }
});
