import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PrivacyConfigSource } from '../../src/privacy/config-source';
import { auditHarness, lockedBody, NOT_FOUND, saveBody } from './audit-harness';

it('add_attachment no da note_locked si la nota se bloquea y se oculta durante noteRead', async () => {
  const h = await auditHarness(async () => ({}));
  const original = h.port.noteRead.bind(h.port);
  const spy = vi.spyOn(h.port, 'noteRead').mockImplementationOnce(async (id) => {
    await h.mutate((engine) => saveBody(engine, id, lockedBody('CEBO_ADJUNTO_BLOQUEADO', [])));
    return original(id);
  });
  try {
    const raced = await h.call('hebra_add_attachment', {
      id: h.library.attachmentsNoteId,
      name: 'prueba.txt',
      dataBase64: Buffer.from('prueba').toString('base64'),
      mimeType: 'text/plain',
      operationId: 'codex3-aux-locked'
    });
    spy.mockRestore();
    expect((await h.call('hebra_read_note', { id: h.library.attachmentsNoteId })).json).toEqual(NOT_FOUND);
    expect(raced.json, 'note_locked confirma la existencia de una nota que ya está oculta')
      .toEqual(NOT_FOUND);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});

it('rename_folder no revela una hermana que pasa a privada antes de cerrar un error de colisión', async () => {
  const h = await auditHarness(async () => ({}));
  const path = join(h.dataDir, 'config.json');
  writeFileSync(path, JSON.stringify({ privateFolders: [], privateTags: [] }));
  h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
  const source = h.serverContext.privacyConfigSource;
  const original = source.current.bind(source);
  let calls = 0;
  const spy = vi.spyOn(source, 'current').mockImplementation(async () => {
    if (++calls === 2) {
      writeFileSync(path, JSON.stringify({ privateFolders: ['Proyectos'], privateTags: [] }));
    }
    return original();
  });
  try {
    const args = { folderId: h.library.folders.historial, name: 'Proyectos' };
    const raced = await h.call('hebra_rename_folder', args);
    spy.mockRestore();
    expect((await h.call('hebra_rename_folder', args)).json)
      .toEqual({ error: 'folder_unavailable' });
    expect(raced.json, 'folder_name_taken confirma que existe la carpeta recién privada')
      .toEqual({ error: 'folder_unavailable' });
  } finally {
    spy.mockRestore();
    await h.close();
  }
});
