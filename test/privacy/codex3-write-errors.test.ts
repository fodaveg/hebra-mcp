import { expect, it, vi } from 'vitest';
import { auditHarness, createNote, NOT_FOUND, saveBody } from './audit-harness';

// Se intercalan cambios reales entre el error del escritor y la puerta final.
it('R3: append no devuelve ambiguous_heading de una nota ocultada después del error', async () => {
  const h = await auditHarness(async (engine) => (await createNote(engine, null,
    '# Pública\n## Duplicado\nuno\n## Duplicado\ndos\n')).id);
  const append = h.serverContext.write!.appendToNote.bind(h.serverContext.write);
  let rejected = false;
  const spy = vi.spyOn(h.serverContext.write!, 'appendToNote').mockImplementationOnce(async (input) => {
    try { return await append(input); }
    catch (error) {
      rejected = true;
      await h.mutate((engine) => saveBody(engine, h.extra,
        '# Pública\n## Duplicado\nuno\n## Duplicado\ndos\n#secreto\n'));
      throw error;
    }
  });
  try {
    const result = await h.call('hebra_append_to_note', { id: h.extra, text: 'nuevo', heading: 'Duplicado' });
    expect(rejected, 'El error procede del escritor real').toBe(true);
    expect((await h.call('hebra_read_note', { id: h.extra })).json).toEqual(NOT_FOUND);
    expect(result.json, 'ambiguous_heading y sus candidates revelan apartados de una nota ya oculta').toEqual(NOT_FOUND);
  } finally { spy.mockRestore(); await h.close(); }
});

it('R3: edit no devuelve no_match de una nota ocultada después del error', async () => {
  const h = await auditHarness(async (engine) => (await createNote(engine, null, '# Pública\ntexto\n')).id);
  try {
    const read = await h.call('hebra_read_note', { id: h.extra });
    const edit = h.serverContext.write!.editNote.bind(h.serverContext.write);
    const spy = vi.spyOn(h.serverContext.write!, 'editNote').mockImplementationOnce(async (input) => {
      try { return await edit(input); }
      catch (error) {
        await h.mutate((engine) => saveBody(engine, h.extra, '# Pública\ntexto\n#secreto\n'));
        throw error;
      }
    });
    try {
      const result = await h.call('hebra_edit_note', { id: h.extra,
        edits: [{ find: 'NO_EXISTE_EN_EL_CUERPO', replace: 'nuevo' }],
        expectedRevision: read.json.revision, operationId: 'codex3-edit-error' });
      expect((await h.call('hebra_read_note', { id: h.extra })).json).toEqual(NOT_FOUND);
      expect(result.json, 'no_match revela que la nota oculta existe y se leyó su cuerpo').toEqual(NOT_FOUND);
    } finally { spy.mockRestore(); }
  } finally { await h.close(); }
});

it('R3: operation_id_reused no revela una operación cuya nota se oculta antes de la puerta', async () => {
  const h = await auditHarness(async (engine) => ({
    old: (await createNote(engine, null, '# Anterior\ntexto\n')).id,
    target: (await createNote(engine, null, '# Destino\ntexto\n')).id
  }));
  try {
    const operationId = 'codex3-history-error';
    expect((await h.call('hebra_append_to_note', { id: h.extra.old, text: 'antes', operationId })).isError).toBe(false);
    const append = h.serverContext.write!.appendToNote.bind(h.serverContext.write);
    const spy = vi.spyOn(h.serverContext.write!, 'appendToNote').mockImplementationOnce(async (input) => {
      try { return await append(input); }
      catch (error) {
        await h.mutate((engine) => saveBody(engine, h.extra.old, '# Anterior\ntexto\n#secreto\n'));
        throw error;
      }
    });
    try {
      const result = await h.call('hebra_append_to_note', { id: h.extra.target, text: 'ahora', operationId });
      expect((await h.call('hebra_read_note', { id: h.extra.old })).json).toEqual(NOT_FOUND);
      expect(result.json, 'operation_id_reused revela historial de una nota que ya no existe para el cliente')
        .not.toEqual({ error: 'operation_id_reused' });
    } finally { spy.mockRestore(); }
  } finally { await h.close(); }
});
