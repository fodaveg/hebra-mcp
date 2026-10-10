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
 *
 * `write` (L3b) va DIRECTO sin sync: un `NoteWriter` sobre el mismo `port`, con
 * `onConflictCopy` sin efecto y `requestRound` resuelta ya, como corresponde a una
 * instancia sin emparejar (L2) o a un test que no necesita el motor de sync real (para
 * eso, `test/sync/devices.ts` y `test/write-tools-sync.test.ts`).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store';
import { NoteWriter } from '../../src/store/writes';
import { ReplaceBatch } from '../../src/store/replace-batch';
import { fetchFileBytes, replaceFileText } from '../../src/store/file-writes';
import { PrivacyFilter, type PrivacyConfig } from '../../src/privacy';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import type { ServerContext, ToolContext } from '../../src/server/context';
import { buildWriteContext, type WriteContext } from '../../src/server/write-context';
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
  sqlitePath: string;
  close(): Promise<void>;
}

/** `WriteContext` sin sync, sobre `port`: sin ronda que pedir (`sync: "not_linked"`). */
function testWriteContext(port: NodeLibraryPort): WriteContext {
  const writer = new NoteWriter(port);
  // `hebra_replace_in_notes` (D14): el lote sobre el mismo puerto, que lee y escribe.
  const replace = new ReplaceBatch(port, port);
  return buildWriteContext({
    replaceInNotes: (request) => replace.run(request),
    createNote: (input) => writer.createNote(input),
    appendToNote: (input) => writer.appendToNote(input),
    editNote: (input) => writer.editNoteLocal(input),
    recordEditConflict: (operationId, id, copyId) =>
      writer.recordEditConflict(operationId, id, copyId),
    organize: (input) => writer.organizeLocal(input),
    restoreVersion: (input) => writer.restoreVersionLocal(input),
    // Sin sync: solo dice si los bytes ya estaban aquí (no hay relé del que bajarlos).
    fetchAttachment: (input) => writer.fetchAttachment(input, null),
    createFolder: (input) => writer.createFolderLocal(input),
    renameFolder: (input) => writer.renameFolderLocal(input),
    addAttachment: (input) => writer.addAttachmentLocal(input),
    organizeFile: (input) => writer.organizeFileLocal(input),
    // Ficheros sueltos (D15): sin sync, sin relé del que bajar bytes.
    fetchFile: (input) => fetchFileBytes(port, input, null),
    replaceFileText: (input) => replaceFileText(port, input, null, () => {}),
    noteRead: (id) => port.noteRead(id),
    folderDirty: (id) => port.folderDirty(id),
    blobUploaded: (sha256) => port.blobUploaded(sha256),
    looseFileDirty: (id) => port.looseFileDirty(id),
    onConflictCopy: () => () => {},
    isLinked: () => false,
    requestRound: () => Promise.resolve(null)
  });
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
  const write = testWriteContext(port);

  return {
    ctx: { port, privacy, privacyConfig, status, write },
    serverContext: { port, privacyConfig, status, write },
    library,
    dataDir,
    sqlitePath,
    async close() {
      port.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

/**
 * Un `WriteContext` de OTRA instancia sobre el MISMO fichero, en solo lectura (SPEC.md
 * §8): toda escritura por él rechaza con `busy_other_instance`, igual que un segundo
 * proceso de hebra-mcp que no tiene el bloqueo. Para los tests de `busy_other_instance`
 * de `hebra_create_note`/`hebra_append_to_note`.
 */
export async function openBusyWriteContext(
  test: Pick<TestContext, 'sqlitePath' | 'dataDir'>
): Promise<{ write: WriteContext; close(): void }> {
  const reader = await openNodeLibraryPort({
    sqlitePath: test.sqlitePath,
    dataDir: test.dataDir,
    mode: 'readOnly'
  });
  return { write: testWriteContext(reader), close: () => reader.close() };
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
