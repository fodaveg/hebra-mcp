/**
 * Dispositivos de prueba contra el relé en memoria de Hebra (`InMemoryLibraryRelay` de
 * `node-testing.ts`, el mismo que usa `sync-engine.test.ts`):
 * - `mcpDevice`: hebra-mcp tal cual corre, `NodeLibraryPort` + `SyncRunner` + `NoteWriter`.
 * - `appDevice`: «otra app de Hebra», montada como la monta el propio Hebra en sus tests
 *   (`SqliteLibraryEngine` + `LocalLibraryPort` + `LibrarySyncEngine`), sobre
 *   `node:sqlite`. Así lo que converge lo decide el código de Hebra, no el de hebra-mcp.
 */
import {
  deriveNote,
  LibrarySyncEngine,
  SqliteLibraryEngine,
  type LibrarySyncEvent,
  type SyncEngineIdentity
} from '../../src/hebra';
import { InMemoryLibraryRelay, LocalLibraryPort } from '../hebra-testing';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { NoteWriter } from '../../src/store/writes';
import { SyncRunner, type SyncLogEventName, type SyncLogFields } from '../../src/sync/runner';

export const VAULT_KEY = crypto.getRandomValues(new Uint8Array(32));
export const IDENTITY: SyncEngineIdentity = {
  relayOrigin: 'https://relay.test',
  syncVaultId: 'bb'.repeat(16)
};

export interface McpDevice {
  port: NodeLibraryPort;
  runner: SyncRunner;
  writer: NoteWriter;
  logged: Array<{ event: SyncLogEventName; fields: SyncLogFields }>;
}

export async function mcpDevice(relay: InMemoryLibraryRelay): Promise<McpDevice> {
  const port = await openNodeLibraryPort({ sqlitePath: ':memory:', deviceLabel: 'Claude' });
  const logged: McpDevice['logged'] = [];
  const runner = await SyncRunner.create({
    port: port.syncStorePort(),
    transport: relay,
    identity: IDENTITY,
    vaultKey: VAULT_KEY,
    intervalMs: null,
    emit: (event, fields) => logged.push({ event, fields })
  });
  const writer = new NoteWriter(port, { onWritten: () => void runner.requestRound() });
  return { port, runner, writer, logged };
}

export interface AppDevice {
  engine: SqliteLibraryEngine;
  port: LocalLibraryPort;
  sync: LibrarySyncEngine;
  events: LibrarySyncEvent[];
}

export async function appDevice(relay: InMemoryLibraryRelay, label = 'Mac'): Promise<AppDevice> {
  const { conn } = openNodeSqliteConn(':memory:');
  const engine = await SqliteLibraryEngine.open(conn, label);
  const port = new LocalLibraryPort(engine);
  const events: LibrarySyncEvent[] = [];
  const sync = await LibrarySyncEngine.create({
    port,
    transport: relay,
    identity: IDENTITY,
    vaultKey: VAULT_KEY,
    keyEpoch: 1,
    onEvent: (event) => events.push(event)
  });
  return { engine, port, sync, events };
}

/** Guarda en la app como su editor: derivados de `derive.ts` y la base que vio. */
export async function appSave(app: AppDevice, id: string, body: string): Promise<void> {
  const row = await app.port.noteRead(id);
  if (!row) throw new Error(`nota ${id} no existe en la app`);
  const derived = deriveNote(body);
  await app.port.noteSave({
    id,
    body,
    title: derived.title,
    titleNorm: derived.titleNorm,
    excerpt: derived.excerpt,
    tags: derived.tags,
    links: derived.links,
    blobRefs: derived.blobRefs,
    props: derived.props,
    expectedLocalSeq: row.localSeq,
    baseBodySha256: row.bodySha256
  });
}

export async function appCreate(app: AppDevice, body: string): Promise<string> {
  const note = await app.port.noteCreate(null);
  await appSave(app, note.id, body);
  return note.id;
}

/** Cuerpos de todas las notas vivas (incluidas copias de conflicto) de un puerto. */
export async function allBodies(port: {
  notesPage: NodeLibraryPort['notesPage'];
  noteRead: NodeLibraryPort['noteRead'];
}): Promise<Array<{ id: string; body: string; conflictOf: string | null }>> {
  const page = await port.notesPage(null, 200, { kind: 'all' });
  const out: Array<{ id: string; body: string; conflictOf: string | null }> = [];
  for (const item of page.items) {
    const row = await port.noteRead(item.id);
    if (row) out.push({ id: row.id, body: row.body, conflictOf: row.conflictOf });
  }
  return out;
}

export { InMemoryLibraryRelay };
