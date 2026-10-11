import { expect, it, vi } from 'vitest';
import { auditHarness, createNote, NOT_FOUND, saveBody } from './audit-harness';

it('preview descarta nextCursor si la única nota restante se oculta antes de la puerta final', async () => {
  const h = await auditHarness(async (engine) => {
    const ids = [
      (await createNote(engine, null, '# Primera\nCODIGO_COLA\n')).id,
      (await createNote(engine, null, '# Segunda\nCODIGO_COLA\n')).id
    ];
    return ids.sort();
  });
  let changed = false;
  const recheck = h.port.privacyRecheck.bind(h.port);
  try {
    const simulated = await h.call('hebra_replace_in_notes', {
      mode: 'simulate', pattern: 'CODIGO_COLA', replacement: 'CAMBIADO', ids: h.extra, limit: 1
    });
    expect(simulated.isError).toBe(false);
    expect(simulated.json.planNotes).toBe(2);

    const planId = simulated.json.planId as string;
    const firstPage = `rp1.${Buffer.from(JSON.stringify([planId, 0])).toString('base64url')}`;
    const spy = vi.spyOn(h.port, 'privacyRecheck').mockImplementation(async (...args) => {
      if (!changed) {
        changed = true;
        await h.mutate((engine) => saveBody(engine, h.extra[1]!, '# Privada\nCODIGO_COLA\n#secreto\n'));
      }
      return recheck(...args);
    });
    try {
      const page = await h.call('hebra_replace_in_notes', {
        mode: 'preview', planId, cursor: firstPage, limit: 1
      });
      spy.mockRestore();
      expect(changed).toBe(true);
      expect((await h.call('hebra_read_note', { id: h.extra[1] })).json).toEqual(NOT_FOUND);
      expect(page.isError).toBe(false);
      expect(page.json.notes.map((note: { id: string }) => note.id)).toEqual([h.extra[0]]);
      expect(page.json.nextCursor, 'El cursor anuncia una nota que ya es privada').toBeNull();
    } finally {
      spy.mockRestore();
    }
  } finally {
    await h.close();
  }
});
