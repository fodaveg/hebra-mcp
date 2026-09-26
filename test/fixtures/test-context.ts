/**
 * `ToolContext`/`ServerContext` de prueba sobre la biblioteca de `test-library.ts`:
 * abre el mismo fichero SQLite con `openNodeLibraryPort` (la vía normal de producción,
 * `src/store`, sin tocarlo) y arma el filtro de privados con `Diario` (carpeta) y
 * `secreto` (etiqueta) como privados.
 *
 * `ctx` (`ToolContext`, `privacy` YA construida) es lo que usan los tests de cada
 * herramienta por separado (`test/tools/*.test.ts`): no cambia el almacén a mitad de
 * prueba, así que una `privacy` fija ahí es correcta y más simple. `serverContext`
 * (`ServerContext`, con `privacyConfig` en vez de `privacy` ya resuelta) es lo que
 * necesita `registerTools`, que reconstruye el filtro EN CADA llamada
 * (`src/server/context.ts`): úsalo cuando el test cambie el almacén entre llamadas
 * (sync, escrituras) y quiera comprobar que la herramienta ve el cambio sin reiniciar.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store';
import { PrivacyFilter, type PrivacyConfig } from '../../src/privacy';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import type { ServerContext, ToolContext } from '../../src/server/context';
import { buildTestLibrary, type TestLibrary } from './test-library';

const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  privateFolders: [['diario']],
  privateTags: ['secreto']
};

export interface TestContext {
  ctx: ToolContext;
  serverContext: ServerContext;
  library: TestLibrary;
  dataDir: string;
  close(): Promise<void>;
}

export async function buildTestContext(
  privacyConfig: PrivacyConfig = DEFAULT_PRIVACY_CONFIG
): Promise<TestContext> {
  const dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-test-'));
  const sqlitePath = join(dataDir, 'library.sqlite');
  const library = await buildTestLibrary(sqlitePath);

  const port: NodeLibraryPort = await openNodeLibraryPort({ sqlitePath, dataDir });
  const status = new UnlinkedStatusSource();
  const privacy = await PrivacyFilter.build(port, privacyConfig);

  return {
    ctx: { port, privacy, status },
    serverContext: { port, privacyConfig, status },
    library,
    dataDir,
    async close() {
      port.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

/** Config con una carpeta privada que NO existe: para `privacy_config_unresolved`. */
export const UNRESOLVED_PRIVACY_CONFIG: PrivacyConfig = {
  privateFolders: [['no-existe']],
  privateTags: []
};

export async function writePrivacyConfigFile(dataDir: string, config: PrivacyConfig): Promise<void> {
  await writeFile(
    join(dataDir, 'config.json'),
    JSON.stringify({
      privateFolders: config.privateFolders.map((segments) => segments.join('/')),
      privateTags: config.privateTags
    })
  );
}
