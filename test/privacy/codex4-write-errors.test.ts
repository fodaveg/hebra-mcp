import { expect, it, vi } from 'vitest';
import { auditHarness, createNote, NOT_FOUND, saveBody } from './audit-harness';

it('una revisión de otra nota distingue solo el destino visible del oculto estable', async () => {
  const h = await auditHarness(async (engine) => ({
    target: (await createNote(engine, null, '# Destino\ntexto\n')).id,
    other: (await createNote(engine, null, '# Otra\ntexto\n')).id
  }));
  try {
    const other = await h.call('hebra_read_note', { id: h.extra.other });
    const input = {
      id: h.extra.target,
      edits: [{ find: 'texto', replace: 'nuevo' }],
      expectedRevision: other.json.revision
    };
    expect((await h.call('hebra_edit_note', { ...input, operationId: 'codex4-visible-wrong-revision' })).json)
      .toEqual({ error: 'invalid_input' });
    await h.mutate((engine) => saveBody(engine, h.extra.target, '# Destino\ntexto\n#secreto\n'));
    expect((await h.call('hebra_edit_note', { ...input, operationId: 'codex4-hidden-wrong-revision' })).json)
      .toEqual(NOT_FOUND);
  } finally {
    await h.close();
  }
});

it('no confirma una nota ya privada con invalid_input de una revisión de otra nota', async () => {
  const h = await auditHarness(async (engine) => ({
    target: (await createNote(engine, null, '# Destino\ntexto\n')).id,
    other: (await createNote(engine, null, '# Otra\ntexto\n')).id
  }));
  const edit = h.serverContext.write!.editNote.bind(h.serverContext.write);
  let writerRejected = false;
  const spy = vi.spyOn(h.serverContext.write!, 'editNote').mockImplementationOnce(async (input) => {
    try {
      return await edit(input);
    } catch (error) {
      writerRejected = true;
      await h.mutate((engine) => saveBody(engine, h.extra.target, '# Destino\ntexto\n#secreto\n'));
      throw error;
    }
  });
  try {
    const other = await h.call('hebra_read_note', { id: h.extra.other });
    const raced = await h.call('hebra_edit_note', {
      id: h.extra.target,
      edits: [{ find: 'texto', replace: 'nuevo' }],
      expectedRevision: other.json.revision,
      operationId: 'codex4-wrong-note-revision'
    });
    expect(writerRejected, 'la revisión llegó al escritor real').toBe(true);
    expect((await h.call('hebra_read_note', { id: h.extra.target })).json).toEqual(NOT_FOUND);
    expect(raced.json, 'invalid_input confirma que la nota existía al leer la revisión').toEqual(NOT_FOUND);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});
