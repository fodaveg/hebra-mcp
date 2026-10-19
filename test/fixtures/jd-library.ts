/**
 * Arnés de los tests de Johnny.Decimal (`hebra_jd_new_id` y `hebra_jd_audit`, D18, 19 oct
 * 2026): la biblioteca de prueba (`./test-library.ts`, con `Diario` privada y `secreto`
 * etiqueta privada) más un sistema JD pequeño, creado con el motor de Hebra como lo haría la
 * app, y un cliente MCP sobre ella. Sin sync: `sync: "not_linked"`.
 *
 * ```
 * 00-09 Sistema/00 Sistema/00.00 JDex      notas «21 Productos», «21.11 Uno», «21.12 Dos»
 * 00-09 Sistema/00 Sistema/00.03 Plantillas nota «JDex - id»
 * 20-29 Trabajo/21 Productos/21.11 Uno, 21.12 Dos
 * 20-29 Trabajo/22 Vacía
 * ```
 *
 * `extraPrivateFolders` añade rutas privadas a la configuración por defecto; `prepare` corre
 * ANTES de la primera llamada (una ruta privada que aún no existe dejaría la configuración
 * sin resolver).
 */
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SqliteLibraryEngine } from '../../src/hebra';
import type { PrivacyConfig } from '../../src/privacy';
import { registerTools } from '../../src/server/register-tools';
import { FsBlobStore } from '../../src/store/blob-store-fs';
import type { NodeLibraryPort } from '../../src/store/node-port';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { buildTestContext, type TestContext } from './test-context';
import { createNote } from './test-library';

/** La plantilla propia de 00.03: lleva una marca para saber que se usó. */
export const JD_TEMPLATE_BODY = '---\njd: "{{id}}"\ntipo: id\n---\n# {{id}} {{title}}\n\nPlantilla propia de {{categoryTitle}}.\n';

export interface JdIds {
  jdex: string;
  templates: string;
  category21: string;
  category22: string;
  id2111: string;
  id2112: string;
  templateNote: string;
}

export interface JdHarness {
  test: TestContext;
  ids: JdIds;
  port: NodeLibraryPort;
  call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; value: Record<string, unknown> }>;
  withEngine<T>(run: (engine: SqliteLibraryEngine) => Promise<T>): Promise<T>;
  /** Carpetas vivas: id, padre y nombre. */
  rawFolders(): Array<{ id: string; parentId: string | null; name: string }>;
  /** Notas vivas fuera de la papelera: id, carpeta, título y cuerpo. */
  rawNotes(): Array<{ id: string; folderId: string; title: string; body: string }>;
  exec(sql: string, ...params: Array<string | number>): void;
  close(): Promise<void>;
}

export const JD_DEFAULT_CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };

export async function startJd(
  options: {
    extraPrivateFolders?: string[][];
    /** Lo que se añade al final de la plantilla «JDex - id» (una etiqueta privada la oculta). */
    templateSuffix?: string;
    prepare?(engine: SqliteLibraryEngine, ids: JdIds): Promise<void>;
  } = {}
): Promise<JdHarness> {
  const config: PrivacyConfig = {
    privateFolders: [...JD_DEFAULT_CONFIG.privateFolders, ...(options.extraPrivateFolders ?? [])],
    privateTags: [...JD_DEFAULT_CONFIG.privateTags]
  };
  const test = await buildTestContext(config);

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

  const ids = await withEngine(async (engine): Promise<JdIds> => {
    const area0 = await engine.folderCreate(null, '00-09 Sistema');
    const cat00 = await engine.folderCreate(area0.id, '00 Sistema');
    const jdex = await engine.folderCreate(cat00.id, '00.00 JDex');
    const templates = await engine.folderCreate(cat00.id, '00.03 Plantillas');
    const area2 = await engine.folderCreate(null, '20-29 Trabajo');
    const category21 = await engine.folderCreate(area2.id, '21 Productos');
    const category22 = await engine.folderCreate(area2.id, '22 Vacía');
    const id2111 = await engine.folderCreate(category21.id, '21.11 Uno');
    const id2112 = await engine.folderCreate(category21.id, '21.12 Dos');
    await createNote(engine, jdex.id, '---\njd: "00.00"\ntipo: id\n---\n# 00.00 JDex\n');
    await createNote(engine, jdex.id, '---\njd: "00.03"\ntipo: id\n---\n# 00.03 Plantillas\n');
    await createNote(engine, jdex.id, '---\njd: "21"\ntipo: categoria\n---\n# 21 Productos\n');
    await createNote(engine, jdex.id, '---\njd: "21.11"\ntipo: id\n---\n# 21.11 Uno\n');
    await createNote(engine, jdex.id, '---\njd: "21.12"\ntipo: id\n---\n# 21.12 Dos\n');
    // El título de la plantilla viaja en su frontmatter (en Obsidian es el nombre del fichero).
    const templateNote = await createNote(
      engine,
      templates.id,
      `---\ntitle: "JDex - id"\n${JD_TEMPLATE_BODY.replace(/^---\n/u, '')}${options.templateSuffix ?? ''}`
    );
    return {
      jdex: jdex.id,
      templates: templates.id,
      category21: category21.id,
      category22: category22.id,
      id2111: id2111.id,
      id2112: id2112.id,
      templateNote: templateNote.id
    };
  });
  if (options.prepare) await withEngine((engine) => options.prepare!(engine, ids));

  const server = new McpServer({ name: 'hebra-mcp-jd-test', version: '0.0.0' });
  registerTools(server, test.serverContext);
  const client = new Client({ name: 'hebra-mcp-jd-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const read = <T>(run: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(test.sqlitePath, { readOnly: true });
    try {
      return run(db);
    } finally {
      db.close();
    }
  };

  return {
    test,
    ids,
    port: test.ctx.port as NodeLibraryPort,
    async call(name, args) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const block = result.content[0] as { type: string; text: string };
      return { isError: result.isError === true, value: JSON.parse(block.text) as Record<string, unknown> };
    },
    withEngine,
    rawFolders() {
      return read((db) =>
        (db.prepare('SELECT id, parent_id, name FROM folders WHERE deleted = 0 ORDER BY id').all() as Array<
          Record<string, unknown>
        >).map((row) => ({
          id: String(row.id),
          parentId: row.parent_id === null ? null : String(row.parent_id),
          name: String(row.name)
        }))
      );
    },
    rawNotes() {
      return read((db) =>
        (db
          .prepare('SELECT id, folder_id, title, body FROM notes WHERE deleted = 0 AND trashed_at IS NULL ORDER BY id')
          .all() as Array<Record<string, unknown>>).map((row) => ({
          id: String(row.id),
          folderId: String(row.folder_id),
          title: String(row.title ?? ''),
          body: String(row.body ?? '')
        }))
      );
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
