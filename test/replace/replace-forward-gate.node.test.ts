/**
 * `hebra_replace_in_notes` desde un LECTOR a través de la PUERTA FINAL de privacidad
 * (SPEC.md §6.3 y §8, D14). `replace-forward.node.test.ts` llama a la herramienta sin pasar
 * por la puerta y no veía este fallo: el escritor guardaba el plan en `library.sqlite`, eso
 * subía `data_version` de la biblioteca (parte de la época de la puerta) y el lector
 * descartaba la respuesta de `simulate` y la rehacía hasta devolver un plan vacío
 * (`planNotes: 0`). Los planes viven ahora en `replace-plans.sqlite` (`src/store/replace-plans.ts`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivacyConfig } from '../../src/privacy/config';
import { buildRoutedWriteContext, writerSocketHandlers } from '../../src/server/forward';
import { registerTools } from '../../src/server/register-tools';
import { localWriteContext } from '../../src/server/serve';
import { LIBRARY_SQLITE_FILE, LibraryInstance } from '../../src/sync/library-instance';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import {
  migrateReplacePlansFromLibrary,
  openReplacePlansDatabase,
  readReplacePlanTargets,
  REPLACE_PLANS_SQLITE_FILE
} from '../../src/store/replace-plans';
import { createNote, openWriter, removeTempDirs, tempDir } from './helpers';

const children: ChildProcess[] = [];
const instances: LibraryInstance[] = [];
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const instance of instances.splice(0)) await instance.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  vi.restoreAllMocks();
  removeTempDirs();
});

function livePid(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child.pid!;
}

async function callTool(client: Client, args: Record<string, unknown>): Promise<{ isError: boolean; json: any }> {
  const result = (await client.callTool({ name: 'hebra_replace_in_notes', arguments: args })) as CallToolResult;
  const text = result.content.find((block): block is { type: 'text'; text: string } => block.type === 'text')?.text;
  return { isError: result.isError === true, json: JSON.parse(text ?? 'null') };
}

describe('hebra_replace_in_notes desde un lector, por la puerta final', () => {
  it('simular devuelve el plan con sus notas (no uno vacío), y aplicar y deshacer pasan', async () => {
    const dataDir = tempDir();
    const writer = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false },
      writerSocket: (opened) => writerSocketHandlers(localWriteContext(opened), opened)
    });
    instances.push(writer);
    await createNote(writer, '# Pública\n\nfoo\n');
    await createNote(writer, '# Otra\n\nfoo\n');

    const reader = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false, pid: livePid() }
    });
    instances.push(reader);
    expect(reader.role).toBe('other_instance');

    const privacy: PrivacyConfig = { privateFolders: [], privateTags: ['secreto'] };
    const server = new McpServer({ name: 'hebra-mcp-gate', version: '0.0.0' });
    registerTools(server, {
      port: reader.port,
      privacyConfig: privacy,
      status: new UnlinkedStatusSource(),
      write: buildRoutedWriteContext(reader, localWriteContext(reader))
    });
    const client = new Client({ name: 'hebra-mcp-gate-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(async () => {
      await client.close();
      await server.close();
    });

    const simulated = await callTool(client, { mode: 'simulate', pattern: 'foo', replacement: 'bar' });
    expect(simulated.isError, JSON.stringify(simulated.json)).toBe(false);
    expect(simulated.json.planNotes).toBe(2);
    expect(simulated.json.notes).toHaveLength(2);
    expect(typeof simulated.json.planId).toBe('string');

    const applied = await callTool(client, { mode: 'apply', planId: simulated.json.planId, operationId: 'op-gate' });
    expect(applied.isError, JSON.stringify(applied.json)).toBe(false);
    expect(applied.json.complete).toBe(true);

    const undone = await callTool(client, { mode: 'undo', planId: simulated.json.planId });
    expect(undone.isError, JSON.stringify(undone.json)).toBe(false);
    expect(undone.json.notes.map((note: { outcome: string }) => note.outcome)).toEqual(['restored', 'restored']);

    // Los planes están en su fichero, no en la biblioteca.
    expect(existsSync(join(dataDir, REPLACE_PLANS_SQLITE_FILE))).toBe(true);
    const library = new DatabaseSync(join(dataDir, LIBRARY_SQLITE_FILE), { readOnly: true });
    try {
      expect(
        library.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'hebra_mcp_replace_plan%'").all()
      ).toEqual([]);
    } finally {
      library.close();
    }
  }, 60_000);
});

describe('planes de replace en replace-plans.sqlite', () => {
  it('un lector lee el plan que nombra un operation_id_reused sin abrir la biblioteca', async () => {
    const dataDir = tempDir();
    const opened = await openWriter(dataDir);
    const writer = opened.instance;
    instances.push(writer);
    await createNote(writer, '# Uno\n\nfoo\n');
    const plan = (await opened.call({ mode: 'simulate', pattern: 'foo', replacement: 'bar' })) as { planId: string };
    const libraryId = await writer.port.libraryId();
    const found = readReplacePlanTargets(join(dataDir, LIBRARY_SQLITE_FILE), [plan.planId, 'otro'], libraryId);
    expect([...found.keys()]).toEqual([plan.planId]);
    expect(found.get(plan.planId)!.noteIds).toHaveLength(1);
    expect(readReplacePlanTargets(join(dataDir, LIBRARY_SQLITE_FILE), [plan.planId], 'otra-biblioteca').size).toBe(0);
    expect(readReplacePlanTargets(join(tempDir(), LIBRARY_SQLITE_FILE), [plan.planId], libraryId).size).toBe(0);
  });

  it('las tablas de una versión anterior en library.sqlite pasan al fichero nuevo, con su vuelta atrás', () => {
    const dir = tempDir();
    const libraryPath = join(dir, LIBRARY_SQLITE_FILE);
    const library = new DatabaseSync(libraryPath);
    // La forma de la primera versión: sin las columnas añadidas después.
    library.exec(`CREATE TABLE hebra_mcp_replace_plans (
      plan_id TEXT PRIMARY KEY, library_id TEXT NOT NULL, privacy_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL,
      apply_operation_id TEXT, applied_at INTEGER, state TEXT NOT NULL, matches INTEGER NOT NULL);
    CREATE TABLE hebra_mcp_replace_plan_notes (
      plan_id TEXT NOT NULL, position INTEGER NOT NULL, note_id TEXT NOT NULL, base_sha256 TEXT NOT NULL,
      result_sha256 TEXT NOT NULL, result_body TEXT NOT NULL, matches INTEGER NOT NULL, preview TEXT NOT NULL,
      base_body TEXT, outcome TEXT, copy_id TEXT, proof TEXT, undo_outcome TEXT, undo_copy TEXT, undo_proof TEXT,
      PRIMARY KEY (plan_id, position));
    INSERT INTO hebra_mcp_replace_plans VALUES ('p1', 'lib', 'fp', 1000, 'op', 2000, 'applied', 1);
    INSERT INTO hebra_mcp_replace_plan_notes (plan_id, position, note_id, base_sha256, result_sha256, result_body, matches, preview, base_body, outcome)
      VALUES ('p1', 0, 'n1', 'a', 'b', 'bar', 1, '[]', 'foo', 'applied')`);
    const plans = openReplacePlansDatabase(libraryPath);
    try {
      expect(migrateReplacePlansFromLibrary(library, plans, libraryPath)).toBe(1);
      expect(
        plans.prepare('SELECT state, applied_at FROM hebra_mcp_replace_plans WHERE plan_id = ?').get('p1')
      ).toMatchObject({ state: 'applied', applied_at: 2000 });
      expect(plans.prepare('SELECT base_body, outcome, copy_owned FROM hebra_mcp_replace_plan_notes').get()).toMatchObject({
        base_body: 'foo',
        outcome: 'applied',
        copy_owned: 0
      });
      expect(library.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'hebra_mcp_replace_plan%'").all()).toEqual([]);
      // Segunda vez: nada que hacer.
      expect(migrateReplacePlansFromLibrary(library, plans, libraryPath)).toBe(0);
    } finally {
      plans.close();
      library.close();
    }
  });
});
