import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PrivacyConfigSource } from '../../src/privacy/config-source';
import { auditHarness, NOT_FOUND } from './audit-harness';

it('create_folder no informa de una ruta que pasó a privada aunque su carpeta siga visible en otra ruta', async () => {
  const h = await auditHarness(async () => ({}), { privateFolders: [], privateTags: [] });
  const configPath = join(h.dataDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ privateFolders: [], privateTags: [] }));
  h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
  let createdId: string | undefined;
  const create = h.serverContext.write!.createFolder.bind(h.serverContext.write);
  const writerSpy = vi.spyOn(h.serverContext.write!, 'createFolder').mockImplementation(async (input) => {
    const result = await create(input);
    createdId = result.id;
    return result;
  });
  const recheck = h.port.privacyRecheck.bind(h.port);
  let changed = false;
  const gateSpy = vi.spyOn(h.port, 'privacyRecheck').mockImplementation(async (request) => {
    if (!changed && createdId) {
      changed = true;
      await h.mutate(async (engine, library) => {
        await engine.folderMove(createdId!, library.folders.proyectos);
        await engine.folderCreate(null, 'Codex6Reservada');
      });
      writeFileSync(configPath, JSON.stringify({ privateFolders: ['Codex6Reservada'], privateTags: [] }));
    }
    return recheck(request);
  });
  try {
    const result = await h.call('hebra_create_folder', { name: 'Codex6Reservada' });
    expect(changed).toBe(true);
    expect(result.json, 'la ruta original ahora nombra una carpeta privada distinta').toEqual(NOT_FOUND);
  } finally {
    gateSpy.mockRestore();
    writerSpy.mockRestore();
    await h.close();
  }
});
