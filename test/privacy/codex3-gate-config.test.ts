import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PrivacyConfigSource } from '../../src/privacy/config-source';
import { auditHarness, NOT_FOUND } from './audit-harness';

it('R3: status bloquea una configuración que deja de resolver durante la llamada sin usos', async () => {
  const h = await auditHarness(async () => ({}));
  const path = join(h.dataDir, 'config.json');
  writeFileSync(path, JSON.stringify({ privateFolders: [], privateTags: [] }));
  h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
  const status = h.serverContext.status.getStatus.bind(h.serverContext.status);
  const spy = vi.spyOn(h.serverContext.status, 'getStatus').mockImplementationOnce(async () => {
    const result = await status();
    writeFileSync(path, JSON.stringify({ privateFolders: ['NoExisteCodex3'], privateTags: [] }));
    return result;
  });
  try {
    const result = await h.call('hebra_status');
    expect((await h.call('hebra_status')).json).toEqual({ error: 'privacy_config_unresolved' });
    expect(result.json, 'La puerta sin usos sirve status aunque la configuración actual no resuelve')
      .toEqual({ error: 'privacy_config_unresolved' });
  } finally { spy.mockRestore(); await h.close(); }
});

it('R3: la configuración se aplica también si cambia antes de la transacción de la puerta', async () => {
  const h = await auditHarness(async () => ({}));
  const path = join(h.dataDir, 'config.json');
  writeFileSync(path, JSON.stringify({ privateFolders: [], privateTags: [] }));
  h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
  const recheck = h.port.privacyRecheck.bind(h.port);
  const spy = vi.spyOn(h.port, 'privacyRecheck').mockImplementationOnce(async (request) => {
    // gateConfig ya devolvió. El turno SQLite aún no ha comenzado: es una frontera
    // asíncrona real, no una modificación posterior a la salida MCP.
    writeFileSync(path, JSON.stringify({ privateFolders: ['Diario'], privateTags: ['secreto'] }));
    return recheck(request);
  });
  try {
    const result = await h.call('hebra_read_note', { id: h.library.privateFolderNoteId });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect((await h.call('hebra_read_note', { id: h.library.privateFolderNoteId })).json).toEqual(NOT_FOUND);
    expect(result.json, 'Salen cuerpo y título privados: la transacción de la puerta usa una configuración anterior')
      .toEqual(NOT_FOUND);
  } finally { spy.mockRestore(); await h.close(); }
});
