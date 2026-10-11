import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PrivacyConfigSource } from '../../src/privacy/config-source';
import { auditHarness, NOT_FOUND } from './audit-harness';

// Cambia el fichero REAL durante una lectura REAL. No modifica filas, respuestas ni sellos.
it.each([
  ['entera', 'hebra_read_note', {}],
  ['apartado', 'hebra_read_note', { heading: 'Nota oculta de carpeta' }],
  ['líneas', 'hebra_read_note', { lines: { from: 1, to: 2 } }],
  ['esquema', 'hebra_note_outline', {}]
])('config.json que pasa a privado durante lectura %s se aplica antes de responder', async (_mode, tool, extra) => {
  const h = await auditHarness(async () => ({}));
  const path = join(h.dataDir, 'config.json');
  writeFileSync(path, JSON.stringify({ privateFolders: [], privateTags: [] }));
  h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
  const original = h.port.noteRead.bind(h.port);
  const spy = vi.spyOn(h.port, 'noteRead').mockImplementationOnce(async (id) => {
    const row = await original(id);
    writeFileSync(path, JSON.stringify({ privateFolders: ['Diario'], privateTags: ['secreto'] }));
    return row;
  });
  try {
    const response = await h.call(tool, { id: h.library.privateFolderNoteId, ...extra });
    spy.mockRestore();
    expect((await h.call('hebra_read_note', { id: h.library.privateFolderNoteId })).json).toEqual(NOT_FOUND);
    expect(response.json, 'La recomprobación usa config antigua: devuelve cuerpo/título/apartados privados sin cambio de local_seq')
      .toEqual(NOT_FOUND);
  } finally { spy.mockRestore(); await h.close(); }
});

it('config.json ilegible durante lectura bloquea la respuesta que está en vuelo', async () => {
  const h = await auditHarness(async () => ({}));
  const path = join(h.dataDir, 'config.json');
  writeFileSync(path, JSON.stringify({ privateFolders: [], privateTags: [] }));
  h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
  const original = h.port.noteRead.bind(h.port);
  const spy = vi.spyOn(h.port, 'noteRead').mockImplementationOnce(async (id) => {
    const row = await original(id);
    writeFileSync(path, '{');
    return row;
  });
  try {
    const response = await h.call('hebra_read_note', { id: h.library.privateFolderNoteId });
    spy.mockRestore();
    expect((await h.call('hebra_status')).json).toEqual({ error: 'privacy_config_unresolved' });
    expect(response.json, 'Sale contenido mientras config.json ya es ilegible: el cierre ante la duda solo cubre llamadas siguientes')
      .toEqual({ error: 'privacy_config_unresolved' });
  } finally { spy.mockRestore(); await h.close(); }
});
