import { expect, it, vi } from 'vitest';
import { auditHarness, saveBody, NOT_FOUND } from './audit-harness';
import { ATTACHMENT_TEXT } from '../fixtures/test-library';

it('read_attachment no entrega bytes si la nota pasa a privada durante blobRead', async () => {
  const h = await auditHarness(async () => ({}));
  const read = h.port.blobRead.bind(h.port);
  const spy = vi.spyOn(h.port, 'blobRead').mockImplementation(async (sha) => {
    const bytes = await read(sha);
    if (sha === h.library.attachments.text) {
      await h.mutate(async (engine) => {
        const note = (await engine.noteRead(h.library.attachmentsNoteId))!;
        await saveBody(engine, note.id, `${note.body}\n#secreto\n`);
      });
    }
    return bytes;
  });
  try {
    const response = await h.call('hebra_read_attachment', {
      id: h.library.attachmentsNoteId,
      attachmentId: h.library.attachments.text
    });
    expect((await h.call('hebra_read_note', { id: h.library.attachmentsNoteId })).json).toEqual(NOT_FOUND);
    expect(response.raw, 'Se entregan bytes del adjunto después de confirmarse privada la nota').not.toContain(ATTACHMENT_TEXT);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});
