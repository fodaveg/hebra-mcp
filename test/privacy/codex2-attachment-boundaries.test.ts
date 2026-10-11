import { expect, it, vi } from 'vitest';
import { auditHarness, lockedBody, NOT_FOUND, saveBody } from './audit-harness';
import { ATTACHMENT_TEXT } from '../fixtures/test-library';

it.each(['hebra_read_attachment', 'hebra_list_attachments'])('%s no da note_locked si la nota acaba de bloquearse y ocultarse', async (tool) => {
  const h = await auditHarness(async () => ({}));
  const original = h.port.noteRead.bind(h.port);
  const spy = vi.spyOn(h.port, 'noteRead').mockImplementationOnce(async (id) => {
    await h.mutate((engine) => saveBody(engine, id, lockedBody('CEBO_BLOQUEADA', [])));
    return original(id);
  });
  try {
    const response = await h.call(tool, { id: h.library.attachmentsNoteId, attachmentId: h.library.attachments.text });
    spy.mockRestore();
    expect((await h.call('hebra_read_note', { id: h.library.attachmentsNoteId })).json).toEqual(NOT_FOUND);
    expect(response.json, 'El error note_locked confirma la existencia de una bloqueada oculta antes de pasar por recheck')
      .toEqual(NOT_FOUND);
  } finally { spy.mockRestore(); await h.close(); }
});

it('read_attachment no da tamaño si la nota pasa a privada durante noteAttachments', async () => {
  const h = await auditHarness(async () => ({}));
  const original = h.port.noteAttachments.bind(h.port);
  const spy = vi.spyOn(h.port, 'noteAttachments').mockImplementationOnce(async (id) => {
    const rows = await original(id);
    await h.mutate(async (engine) => {
      const note = (await engine.noteRead(id))!;
      await saveBody(engine, id, `${note.body}\n#secreto\n`);
    });
    return rows;
  });
  try {
    const response = await h.call('hebra_read_attachment', { id: h.library.attachmentsNoteId, attachmentId: h.library.attachments.big });
    spy.mockRestore();
    expect((await h.call('hebra_read_note', { id: h.library.attachmentsNoteId })).json).toEqual(NOT_FOUND);
    expect(response.json, 'attachment_too_large con byteLength revela el tamaño de un adjunto cuya nota ya es privada')
      .toEqual(NOT_FOUND);
  } finally { spy.mockRestore(); await h.close(); }
});

it('read_attachment no entrega bytes si la propietaria se oculta durante el segundo hiddenContent', async () => {
  const h = await auditHarness(async () => ({}));
  const original = h.port.notesLinkingBlobs.bind(h.port);
  let checks = 0;
  const spy = vi.spyOn(h.port, 'notesLinkingBlobs').mockImplementation(async (...args) => {
    if (++checks === 2) {
      await h.mutate(async (engine) => {
        const note = (await engine.noteRead(h.library.attachmentsNoteId))!;
        await saveBody(engine, note.id, `${note.body}\n#secreto\n`);
      });
    }
    return original(...args);
  });
  try {
    const response = await h.call('hebra_read_attachment', { id: h.library.attachmentsNoteId, attachmentId: h.library.attachments.text });
    spy.mockRestore();
    expect(checks).toBe(2);
    expect((await h.call('hebra_read_note', { id: h.library.attachmentsNoteId })).json).toEqual(NOT_FOUND);
    expect(response.raw, 'La segunda consulta de referencias usa el filtro anterior a la etiqueta privada y entrega los bytes ocultos')
      .not.toContain(ATTACHMENT_TEXT);
  } finally { spy.mockRestore(); await h.close(); }
});
