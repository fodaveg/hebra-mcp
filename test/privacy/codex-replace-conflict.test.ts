import { expect, it } from 'vitest';
import { auditHarness, createNote, saveBody, NOT_FOUND } from './audit-harness';

for (const mode of ['apply', 'undo'] as const) {
  it(`replace_in_notes ${mode} no revela copyId de una copia de conflicto que ahora es privada`, async () => {
    const h = await auditHarness(async (engine) => ({
      id: (await createNote(engine, null, '# Reemplazo\nTOKEN_ANTES\n')).id
    }));
    try {
      const simulated = await h.call('hebra_replace_in_notes', {
        mode: 'simulate', pattern: 'TOKEN_ANTES', replacement: 'TOKEN_DESPUES', ids: [h.extra.id]
      });
      expect(simulated.isError).toBe(false);
      const planId = simulated.json.planId;
      await h.mutate((engine) => saveBody(engine, h.extra.id, '# Reemplazo\nEdición concurrente\n'));
      const applied = await h.call('hebra_replace_in_notes', { mode: 'apply', planId, operationId: 'codex-conflict' });
      expect(applied.isError).toBe(false);
      const copyId = applied.json.notes[0].copyId;
      expect(typeof copyId).toBe('string');
      await h.mutate(async (engine) => {
        const copy = (await engine.noteRead(copyId))!;
        await saveBody(engine, copyId, `${copy.body}\n#secreto\n`);
      });
      expect((await h.call('hebra_read_note', { id: copyId })).json).toEqual(NOT_FOUND);
      const result = await h.call('hebra_replace_in_notes', {
        mode, planId, ...(mode === 'apply' ? { operationId: 'codex-conflict' } : {})
      });
      expect(result.raw, 'El informe revela el id de una copia de conflicto oculta').not.toContain(copyId);
    } finally { await h.close(); }
  });
}
