import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PrivacyConfigSource } from '../../src/privacy/config-source';
import { auditHarness, NOT_FOUND, saveBody } from './audit-harness';

const baseConfig = { privateFolders: ['Diario'], privateTags: ['secreto'] };
const hiddenProject = { privateFolders: ['Diario', 'Proyectos'], privateTags: ['secreto'] };

it('read_file retira bytes y metadatos si config.json vuelve privada su carpeta durante blobRead', async () => {
  const h = await auditHarness(async () => ({}));
  const path = join(h.dataDir, 'config.json');
  writeFileSync(path, JSON.stringify(baseConfig));
  h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
  const original = h.port.blobRead.bind(h.port);
  const spy = vi.spyOn(h.port, 'blobRead').mockImplementationOnce(async (sha256) => {
    const bytes = await original(sha256);
    writeFileSync(path, JSON.stringify(hiddenProject));
    return bytes;
  });
  try {
    const raced = await h.call('hebra_read_file', { id: h.library.files.plano });
    spy.mockRestore();
    expect((await h.call('hebra_read_file', { id: h.library.files.plano })).json).toEqual(NOT_FOUND);
    expect(raced.json, 'La puerta debe descartar los bytes y el nombre del fichero recién privado')
      .toEqual(NOT_FOUND);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});

it('list_files retira el nombre y la ruta si config.json oculta su carpeta durante filesIndex', async () => {
  const h = await auditHarness(async () => ({}));
  const path = join(h.dataDir, 'config.json');
  writeFileSync(path, JSON.stringify(baseConfig));
  h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
  const original = h.port.filesIndex.bind(h.port);
  const spy = vi.spyOn(h.port, 'filesIndex').mockImplementationOnce(async () => {
    const index = await original();
    writeFileSync(path, JSON.stringify(hiddenProject));
    return index;
  });
  try {
    const raced = await h.call('hebra_list_files', { limit: 100 });
    spy.mockRestore();
    expect((await h.call('hebra_list_files', { limit: 100 })).raw).not.toContain(h.library.files.plano);
    expect(raced.raw, 'La lista no debe conservar la fila de la carpeta recién privada')
      .not.toContain(h.library.files.plano);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});

it('list_attachments no lista alias ni hash cuando su nota adquiere etiqueta privada durante noteAttachments', async () => {
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
    const raced = await h.call('hebra_list_attachments', { id: h.library.attachmentsNoteId });
    spy.mockRestore();
    expect((await h.call('hebra_read_note', { id: h.library.attachmentsNoteId })).json).toEqual(NOT_FOUND);
    expect(raced.json, 'No deben salir alias, tamaños ni hashes de la nota ya privada')
      .toEqual(NOT_FOUND);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});
