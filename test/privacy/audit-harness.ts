/**
 * Arnés de las sondas del audit de privacidad adversarial del 10 oct 2026 (nota
 * «2026-10-10 - Audit de privacidad adversarial de hebra-mcp» de Hebra, 21.13/40),
 * convertidas en tests del repo. Las sondas las escribió Claude (no son código de Hebra) y
 * aquí se adaptan: mismo escenario, con aserciones en vez de un informe.
 *
 * Cada escenario parte de la biblioteca de prueba de siempre (`buildTestLibrary`) y añade
 * lo suyo con el MOTOR de Hebra (`SqliteLibraryEngine`) en una conexión aparte, como lo
 * dejaría la app de otro dispositivo después del sync. Después abre el puerto de producción
 * (`openNodeLibraryPort`) y conecta un cliente MCP en memoria a `registerTools`, el mismo
 * camino que stdio. `mutate` vuelve a abrir el motor en otra conexión con el puerto ya
 * abierto: un cambio que llega «por sync» entre dos llamadas de herramienta.
 *
 * Nunca toca la biblioteca real: todo vive en un directorio temporal que `close` borra.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { deriveNote, SqliteLibraryEngine, type NoteRow } from '../../src/hebra';
import { FsBlobStore } from '../../src/store/blob-store-fs';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store';
import type { PrivacyConfig } from '../../src/privacy';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import type { ServerContext } from '../../src/server/context';
import { registerTools } from '../../src/server/register-tools';
import { buildTestLibrary, type TestLibrary } from '../fixtures/test-library';
import { testWriteContext } from '../fixtures/test-context';

/** La configuración de las sondas: `Diario` (carpeta) y `secreto` (etiqueta). */
export const AUDIT_CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };

export interface ToolCall {
  isError: boolean;
  /** El primer bloque de texto, como JSON (`null` si no lo es). */
  json: any;
  /** Todos los bloques de texto, juntos. */
  raw: string;
}

/** Un escenario sobre el motor de Hebra, en una conexión aparte. */
export type Scenario<T> = (engine: SqliteLibraryEngine, library: TestLibrary, db: DatabaseSync) => Promise<T>;

export async function saveBody(engine: SqliteLibraryEngine, id: string, body: string): Promise<void> {
  const row = (await engine.noteRead(id))!;
  await engine.noteSave({
    ...deriveNote(body),
    id,
    body,
    expectedLocalSeq: row.localSeq,
    baseBodySha256: row.bodySha256
  });
}

export async function createNote(
  engine: SqliteLibraryEngine,
  folderId: string | null,
  body: string
): Promise<NoteRow> {
  const created = await engine.noteCreate(folderId);
  await saveBody(engine, created.id, body);
  return (await engine.noteRead(created.id))!;
}

/** Envoltorio `hebra-locked:v1:` con la forma que acepta el motor, con la pista de la
 *  contraseña en la cabecera en claro, como la deja Hebra al bloquear. */
export function lockedBody(title: string, blobRefs: readonly string[], hint?: string): string {
  const b64url = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString('base64url');
  const header: Record<string, unknown> = {
    v: 1,
    kid: 'ab'.repeat(16),
    kdf: { alg: 'pbkdf2-sha256', iter: 600_000, salt: b64url(new Uint8Array(16).fill(1)) },
    wrappedKey: b64url(new Uint8Array(60).fill(2)),
    title,
    blobRefs
  };
  if (hint !== undefined) header.hint = hint;
  return `hebra-locked:v1:${b64url(JSON.stringify(header))}.${b64url(new Uint8Array(48).fill(3))}`;
}

/** Abre el motor de Hebra en otra conexión sobre `sqlitePath`, ejecuta `run` y la cierra. */
export async function withEngine<T>(
  sqlitePath: string,
  run: (engine: SqliteLibraryEngine, db: DatabaseSync) => Promise<T>
): Promise<T> {
  const { db, conn } = openNodeSqliteConn(sqlitePath);
  try {
    // En WAL, como el puerto: cambiar el modo del diario con otra conexión abierta da
    // `database is locked`.
    const engine = await SqliteLibraryEngine.open(conn, 'audit-scenario', {
      journalMode: 'WAL',
      blobs: new FsBlobStore(dirname(sqlitePath))
    });
    return await run(engine, db);
  } finally {
    db.close();
  }
}

export interface AuditHarness<T> {
  library: TestLibrary;
  extra: T;
  dataDir: string;
  sqlitePath: string;
  port: NodeLibraryPort;
  serverContext: ServerContext;
  call(name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  /** Un cambio del motor con el puerto ya abierto (lo que traería una ronda de sync). */
  mutate<R>(run: (engine: SqliteLibraryEngine, library: TestLibrary, db: DatabaseSync) => Promise<R>): Promise<R>;
  /** Cierra el puerto y abre otro sobre el mismo fichero: un reinicio del proceso. */
  restart(): Promise<void>;
  /** Lo que salió por stderr (los logs de §6.4). */
  stderr(): string;
  close(): Promise<void>;
}

export interface AuditHarnessOptions {
  /** Contexto de servidor alternativo (p. ej. con `loadPrivacyConfig`), sobre el puerto. */
  serverContext?: (port: NodeLibraryPort, dataDir: string) => ServerContext;
}

async function connect(ctx: ServerContext): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer({ name: 'hebra-mcp-audit', version: '0.0.0' });
  registerTools(server, ctx);
  const client = new Client({ name: 'hebra-mcp-audit-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

export async function auditHarness<T>(
  scenario: Scenario<T>,
  config: PrivacyConfig = AUDIT_CONFIG,
  options: AuditHarnessOptions = {}
): Promise<AuditHarness<T>> {
  const dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-audit-'));
  const sqlitePath = join(dataDir, 'library.sqlite');
  const library = await buildTestLibrary(sqlitePath);
  const extra = await withEngine(sqlitePath, (engine, db) => scenario(engine, library, db));

  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const contextFor = (port: NodeLibraryPort): ServerContext =>
    options.serverContext?.(port, dataDir) ?? {
      port,
      privacyConfig: config,
      status: new UnlinkedStatusSource(),
      write: testWriteContext(port)
    };
  let port = await openNodeLibraryPort({ sqlitePath, dataDir });
  let serverContext = contextFor(port);
  let { client, server } = await connect(serverContext);

  const harness: AuditHarness<T> = {
    library,
    extra,
    dataDir,
    sqlitePath,
    get port() {
      return port;
    },
    get serverContext() {
      return serverContext;
    },
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const texts = result.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text);
      let json: any = null;
      try {
        json = JSON.parse(texts[0] ?? '');
      } catch {
        json = null;
      }
      return { isError: result.isError === true, json, raw: texts.join('\n') };
    },
    mutate: (run) => withEngine(sqlitePath, (engine, db) => run(engine, library, db)),
    async restart() {
      await client.close();
      await server.close();
      port.close();
      port = await openNodeLibraryPort({ sqlitePath, dataDir });
      serverContext = contextFor(port);
      ({ client, server } = await connect(serverContext));
    },
    stderr: () => stderrSpy.mock.calls.map((call) => String(call[0])).join(''),
    async close() {
      stderrSpy.mockRestore();
      await client.close();
      await server.close();
      port.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
  return harness;
}

/** Decodifica un cursor envuelto `xx.<base64url>`. */
export function decodeCursor(cursor: string | null): string | null {
  if (cursor === null) return null;
  const dot = cursor.indexOf('.');
  return Buffer.from(cursor.slice(dot + 1), 'base64url').toString('utf8');
}

export const NOT_FOUND = { error: 'not_found' };
