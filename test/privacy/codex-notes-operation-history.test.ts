import { describe, expect, it } from 'vitest';
import { auditHarness, createNote, saveBody } from './audit-harness';

describe('Codex: registro de operaciones de notas ahora ocultas', () => {
  it('reutilizar operationId en una visible no debe revelar una operación de otra nota oculta', async () => {
    const outcomes: Array<{ isError: boolean; error: string | null }> = [];
    for (const withHiddenOperation of [false, true]) {
      const h = await auditHarness(async (engine) => ({
        formerlyVisible: (await createNote(engine, null, '# Nota que será privada\ntexto\n')).id,
        publicTarget: (await createNote(engine, null, '# Nota pública\ntexto\n')).id
      }));
      try {
        if (withHiddenOperation) {
          const first = await h.call('hebra_append_to_note', {
            id: h.extra.formerlyVisible, text: 'añadido anterior', operationId: 'codex-operation-shared'
          });
          expect(first.isError, first.raw).toBe(false);
        }
        await h.mutate(async (engine) => {
          await saveBody(engine, h.extra.formerlyVisible, '# Nota que será privada\n#secreto\nCEBO_HISTORIAL_OCULTO\n');
        });
        expect((await h.call('hebra_read_note', { id: h.extra.formerlyVisible })).json).toEqual({ error: 'not_found' });
        const result = await h.call('hebra_append_to_note', {
          id: h.extra.publicTarget, text: 'añadido público', operationId: 'codex-operation-shared'
        });
        outcomes.push({ isError: result.isError, error: result.json.error ?? null });
      } finally {
        await h.close();
      }
    }
    expect(outcomes[0]).toEqual({ isError: false, error: null });
    expect(outcomes[1], 'operation_id_reused revela que el operationId existe en el historial de una nota oculta').toEqual(outcomes[0]);
  });
});
