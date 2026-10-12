/**
 * Arnés de los tests de crear, renombrar, mover y duplicar ficheros sueltos (D17, 12 oct
 * 2026): un cliente MCP sobre la biblioteca de prueba (`./test-library.ts`, con `Diario` y
 * `Diario/2026` privadas y `secreto` etiqueta privada), las filas de `files` leídas por otra
 * conexión de solo lectura y el motor de Hebra por otra conexión, para lo que hace la app (u
 * otro dispositivo) sobre la misma biblioteca. Sin sync: `sync: "not_linked"`.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SqliteLibraryEngine } from '../../src/hebra';
import type { PrivacyConfig } from '../../src/privacy';
import { registerTools } from '../../src/server/register-tools';
import { FsBlobStore } from '../../src/store/blob-store-fs';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { buildTestContext, type TestContext } from './test-context';
import type { TestLibraryOptions } from './test-library';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Una fila de `files` tal como está en disco. */
export interface RawFile {
  id: string;
  name: string;
  folderId: string;
  sha256: string;
  localSeq: number;
  trashed: boolean;
  deleted: boolean;
}

export interface LooseFilesHarness {
  test: TestContext;
  /** La llamada por el cliente MCP, con el primer bloque de texto como JSON. */
  call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; value: Record<string, unknown> }>;
  /** La llamada tal cual (para `hebra_read_file`, que trae dos bloques). */
  callRaw(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** Todas las filas de `files`, ordenadas por id. */
  rawFiles(): RawFile[];
  /** El motor de Hebra por otra conexión: lo que haría la app. */
  withEngine<T>(run: (engine: SqliteLibraryEngine) => Promise<T>): Promise<T>;
  /** Un fichero suelto creado con el motor, como lo crea Hebra. */
  engineFile(folderId: string | null, name: string, bytes: Uint8Array | string, mime?: string | null): Promise<string>;
  /** SQL directo sobre la biblioteca (para dejar unos bytes como no presentes). */
  exec(sql: string, ...params: Array<string | number>): void;
  close(): Promise<void>;
}

export async function startLooseFiles(
  privacyConfig?: PrivacyConfig,
  libraryOptions?: TestLibraryOptions
): Promise<LooseFilesHarness> {
  const test = await buildTestContext(privacyConfig, libraryOptions);
  const server = new McpServer({ name: 'hebra-mcp-loose-files-test', version: '0.0.0' });
  registerTools(server, test.serverContext);
  const client = new Client({ name: 'hebra-mcp-loose-files-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const callRaw = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;

  const withEngine = async <T>(run: (engine: SqliteLibraryEngine) => Promise<T>): Promise<T> => {
    const { db, conn } = openNodeSqliteConn(test.sqlitePath);
    try {
      const engine = await SqliteLibraryEngine.open(conn, 'otro-dispositivo', {
        journalMode: 'WAL',
        blobs: new FsBlobStore(test.dataDir)
      });
      return await run(engine);
    } finally {
      db.close();
    }
  };

  return {
    test,
    callRaw,
    async call(name, args) {
      const result = await callRaw(name, args);
      const block = result.content[0] as { type: string; text: string };
      return { isError: result.isError === true, value: JSON.parse(block.text) as Record<string, unknown> };
    },
    rawFiles() {
      const db = new DatabaseSync(test.sqlitePath, { readOnly: true });
      try {
        const rows = db
          .prepare(
            'SELECT id, name, folder_id, sha256, local_seq, trashed_at, deleted FROM files ORDER BY id'
          )
          .all() as Array<Record<string, unknown>>;
        return rows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          folderId: String(row.folder_id),
          sha256: String(row.sha256),
          localSeq: Number(row.local_seq),
          trashed: row.trashed_at !== null,
          deleted: Number(row.deleted) !== 0
        }));
      } finally {
        db.close();
      }
    },
    withEngine,
    engineFile(folderId, name, bytes, mime = null) {
      return withEngine(async (engine) => {
        const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
        const blob = await engine.blobPut(data, { mime });
        return (await engine.fileCreate(folderId, name, blob.sha256)).id;
      });
    },
    exec(sql, ...params) {
      const db = new DatabaseSync(test.sqlitePath);
      try {
        db.prepare(sql).run(...params);
      } finally {
        db.close();
      }
    },
    async close() {
      await client.close();
      await server.close();
      await test.close();
    }
  };
}
