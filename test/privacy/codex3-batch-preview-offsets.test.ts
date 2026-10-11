import { expect, it } from 'vitest';
import { auditHarness, createNote, saveBody } from './audit-harness';

async function planWithFourNotes() {
  const h = await auditHarness(async (engine) => {
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push((await createNote(engine, null, `# Página ${index}\nCODIGO_OFFSET\n`)).id);
    }
    return ids.sort();
  });
  try {
    const simulation = await h.call('hebra_replace_in_notes', {
      mode: 'simulate', pattern: 'CODIGO_OFFSET', replacement: 'OTRO', ids: h.extra, limit: 1
    });
    expect(simulation.isError).toBe(false);
    expect(simulation.json.planNotes).toBe(4);
    return { h, planId: simulation.json.planId as string, firstCursor: simulation.json.nextCursor as string };
  } catch (error) {
    await h.close();
    throw error;
  }
}

// Ajustado en la 2.ª vuelta de d64e187e (revisión independiente, punto 4): el cursor de preview
// pasó de contar visibles devueltas a llevar la clave de la última devuelta. Con eso ya no se
// salta ni se repite una nota cuando otra cambia de visibilidad entre páginas, que era el
// coste que estos dos controles fijaban; ahora fijan lo contrario.
it('preview sigue detrás de la última devuelta aunque esa se vuelva privada (no se salta la siguiente)', async () => {
  const { h, planId, firstCursor } = await planWithFourNotes();
  try {
    await h.mutate((engine) => saveBody(engine, h.extra[0]!, '# Privada\nCODIGO_OFFSET\n#secreto\n'));
    const page = await h.call('hebra_replace_in_notes', {
      mode: 'preview', planId, cursor: firstCursor, limit: 1
    });
    expect(page.isError).toBe(false);
    expect(page.json.notes.map((note: { id: string }) => note.id),
      'Al desaparecer una nota ya devuelta, la página siguiente empieza en la que la seguía').toEqual([h.extra[1]]);
  } finally {
    await h.close();
  }
});

it('preview no repite una nota visible si reaparece otra antes de ella entre páginas', async () => {
  const { h, planId } = await planWithFourNotes();
  try {
    await h.mutate((engine) => saveBody(engine, h.extra[0]!, '# Privada\nCODIGO_OFFSET\n#secreto\n'));
    const cursorAtStart = `rp1.${Buffer.from(JSON.stringify([planId, 0])).toString('base64url')}`;
    const first = await h.call('hebra_replace_in_notes', {
      mode: 'preview', planId, cursor: cursorAtStart, limit: 1
    });
    expect(first.isError).toBe(false);
    expect(first.json.notes.map((note: { id: string }) => note.id)).toEqual([h.extra[1]]);
    await h.mutate((engine) => saveBody(engine, h.extra[0]!, '# Visible de nuevo\nCODIGO_OFFSET\n'));
    const second = await h.call('hebra_replace_in_notes', {
      mode: 'preview', planId, cursor: first.json.nextCursor, limit: 1
    });
    expect(second.isError).toBe(false);
    expect(second.json.notes.map((note: { id: string }) => note.id),
      'Al reaparecer una nota anterior, la página siguiente sigue detrás de la ya devuelta').toEqual([h.extra[2]]);
  } finally {
    await h.close();
  }
});
