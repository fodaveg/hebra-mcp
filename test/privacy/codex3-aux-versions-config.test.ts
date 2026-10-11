import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PrivacyConfigSource } from '../../src/privacy/config-source';
import { auditHarness, NOT_FOUND } from './audit-harness';

const initiallyPublic = { privateFolders: ['Diario'], privateTags: [] };
const newlyPrivate = { privateFolders: ['Diario'], privateTags: ['secreto'] };

it('read_version no entrega el cuerpo histórico cuando su etiqueta pasa a privada durante la lectura', async () => {
  const h = await auditHarness(async () => ({}));
  const path = join(h.dataDir, 'config.json');
  writeFileSync(path, JSON.stringify(initiallyPublic));
  h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
  const original = h.port.noteVersionRead.bind(h.port);
  const spy = vi.spyOn(h.port, 'noteVersionRead').mockImplementationOnce(async (id) => {
    const version = await original(id);
    writeFileSync(path, JSON.stringify(newlyPrivate));
    return version;
  });
  try {
    const args = { id: h.library.formerlyPrivateNoteId, versionId: h.library.formerlyPrivateVersionId };
    const raced = await h.call('hebra_read_version', args);
    spy.mockRestore();
    expect((await h.call('hebra_read_version', args)).json).toEqual(NOT_FOUND);
    expect(raced.json, 'La puerta vuelve a mirar la nota viva, pero no la etiqueta del cuerpo histórico que entrega')
      .toEqual(NOT_FOUND);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});

it('list_versions no anuncia una versión cuya etiqueta pasa a privada durante la lectura', async () => {
  const h = await auditHarness(async () => ({}));
  const path = join(h.dataDir, 'config.json');
  writeFileSync(path, JSON.stringify(initiallyPublic));
  h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
  const original = h.port.noteVersionsLocked.bind(h.port);
  const spy = vi.spyOn(h.port, 'noteVersionsLocked').mockImplementationOnce(async (ids) => {
    const locked = await original(ids);
    writeFileSync(path, JSON.stringify(newlyPrivate));
    return locked;
  });
  try {
    const args = { id: h.library.formerlyPrivateNoteId };
    const raced = await h.call('hebra_list_versions', args);
    spy.mockRestore();
    expect((await h.call('hebra_list_versions', args)).json.versions).toEqual([]);
    expect(raced.json.versions, 'La puerta no reevalúa la privacidad de las versiones ya listadas')
      .toEqual([]);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});
