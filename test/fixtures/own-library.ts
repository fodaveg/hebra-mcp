/**
 * Una biblioteca propia de un test, montada con el motor de Hebra ANTES de abrir el puerto
 * (hebra-mcp no archiva carpetas ni oculta notas del listado general, ni borra carpetas),
 * y un `ServerContext` sobre ella. Sirve cuando el fixture compartido (`test-library.ts`) no
 * tiene el estado que se prueba: carpetas en la papelera, notas archivadas, autores…
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SqliteLibraryEngine } from '../../src/hebra';
import type { PrivacyConfig } from '../../src/privacy/config';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { FsBlobStore } from '../../src/store/blob-store-fs';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { resolveToolContext, type ServerContext, type ToolContext } from '../../src/server/context';

/** Privados de las bibliotecas propias: la carpeta `Diario` (y lo de dentro) y `#secreto`. */
export const OWN_PRIVACY: PrivacyConfig = {
  privateFolders: [['diario']],
  privateTags: ['secreto']
};

export async function withOwnLibrary<T>(
  build: (engine: SqliteLibraryEngine, db: DatabaseSync) => Promise<T>,
  run: (
    fresh: () => Promise<ToolContext>,
    built: T,
    server: ServerContext
  ) => Promise<void>,
  privacyConfig: PrivacyConfig = OWN_PRIVACY
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-own-'));
  const sqlitePath = join(dataDir, 'library.sqlite');
  let built: T;
  const { db, conn } = openNodeSqliteConn(sqlitePath);
  try {
    built = await build(
      await SqliteLibraryEngine.open(conn, 'test-fixture', { blobs: new FsBlobStore(dataDir) }),
      db
    );
  } finally {
    db.close();
  }
  const port = await openNodeLibraryPort({ sqlitePath, dataDir });
  try {
    const server: ServerContext = { port, privacyConfig, status: new UnlinkedStatusSource() };
    await run(() => resolveToolContext(server), built, server);
  } finally {
    port.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
