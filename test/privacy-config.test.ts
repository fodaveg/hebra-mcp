import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPrivacyConfig } from '../src/privacy/config';
import { resolveDataDir } from '../src/privacy/data-dir';
import { writePrivacyConfigFile } from './fixtures/test-context';

describe('loadPrivacyConfig', () => {
  let dataDir: string | undefined;
  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it('sin config.json: nada privado', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-privacy-'));
    const config = await loadPrivacyConfig(dataDir);
    expect(config).toEqual({ privateFolders: [], privateTags: [] });
  });

  it('lee y normaliza carpetas y etiquetas de config.json', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-privacy-'));
    await writePrivacyConfigFile(dataDir, {
      privateFolders: [['Diario'], ['Salud', 'Médico']],
      privateTags: ['Diario', 'privado']
    });
    const config = await loadPrivacyConfig(dataDir);
    expect(config.privateFolders).toEqual([['diario'], ['salud', 'médico']]);
    expect(config.privateTags.sort()).toEqual(['diario', 'privado'].sort());
  });
});

describe('resolveDataDir', () => {
  it('HEBRA_MCP_DATA_DIR manda sobre cualquier plataforma', () => {
    const dir = resolveDataDir({ HEBRA_MCP_DATA_DIR: '/tmp/algo' } as NodeJS.ProcessEnv);
    expect(dir).toBe('/tmp/algo');
  });
});
