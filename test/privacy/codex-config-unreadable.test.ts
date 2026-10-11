import { chmodSync, lstatSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PrivacyConfigSource } from '../../src/privacy/config-source';
import { auditHarness, NOT_FOUND } from './audit-harness';

it('un config.json que pierde permiso de lectura bloquea también las herramientas sin contenido', async () => {
  const h = await auditHarness(async () => ({}));
  const path = join(h.dataDir, 'config.json');
  try {
    writeFileSync(path, JSON.stringify({ privateFolders: ['Diario'], privateTags: ['secreto'] }));
    h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
    expect((await h.call('hebra_read_note', { id: h.library.privateFolderNoteId })).json).toEqual(NOT_FOUND);
    chmodSync(path, 0o000);
    // Premisa real: el archivo existe, pero ESTE proceso no puede leerlo.
    expect(() => readFileSync(path, 'utf8')).toThrow(/EACCES/);
    const response = await h.call('hebra_status');
    expect(response.json, 'config.json ilegible: el servidor sigue sirviendo con la configuración cacheada')
      .toEqual({ error: 'privacy_config_unresolved' });
  } finally {
    chmodSync(path, 0o600);
    await h.close();
  }
});

it('un config.json existente cuyo enlace pierde su destino no destapa las notas privadas', async () => {
  const h = await auditHarness(async () => ({}));
  const path = join(h.dataDir, 'config.json');
  try {
    writeFileSync(path, JSON.stringify({ privateFolders: ['Diario'], privateTags: ['secreto'] }));
    h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
    expect((await h.call('hebra_read_note', { id: h.library.privateFolderNoteId })).json).toEqual(NOT_FOUND);
    unlinkSync(path);
    symlinkSync(join(h.dataDir, 'config-destino-perdido.json'), path);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/);
    const response = await h.call('hebra_read_note', { id: h.library.privateFolderNoteId });
    expect(response.json, `config.json existe pero no se lee; sale cuerpo privado: ${response.raw}`)
      .toEqual({ error: 'privacy_config_unresolved' });
  } finally { await h.close(); }
});
