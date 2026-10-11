import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PrivacyConfigSource } from '../../src/privacy/config-source';
import { auditHarness, createNote, saveBody } from './audit-harness';

it('list_tags no publica una etiqueta recién privada que se quitó de la nota antes de la puerta', async () => {
  const tag = 'codex3_temporal';
  const h = await auditHarness(async (engine) => {
    const note = await createNote(engine, null, `# Pública con etiqueta\n#${tag}\n`);
    return { noteId: note.id };
  });
  const path = join(h.dataDir, 'config.json');
  writeFileSync(path, JSON.stringify({ privateFolders: ['Diario'], privateTags: ['secreto'] }));
  h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
  const original = h.port.tagsList.bind(h.port);
  const spy = vi.spyOn(h.port, 'tagsList').mockImplementationOnce(async () => {
    const rows = await original();
    await h.mutate((engine) => saveBody(engine, h.extra.noteId, '# Pública sin etiqueta\nContenido.\n'));
    writeFileSync(path, JSON.stringify({ privateFolders: ['Diario'], privateTags: ['secreto', tag] }));
    return rows;
  });
  try {
    const raced = await h.call('hebra_list_tags', { limit: 100 });
    spy.mockRestore();
    expect((await h.call('hebra_list_tags', { limit: 100 })).raw).not.toContain(tag);
    expect(raced.raw, 'La puerta comprueba visibilidad actual pero conserva el recuento y la etiqueta del snapshot viejo')
      .not.toContain(tag);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});
