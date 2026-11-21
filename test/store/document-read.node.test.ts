import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { LibrarySyncEngine, SqliteLibraryEngine } from '../../src/hebra';
import { InMemoryLibraryRelay, LocalLibraryPort } from '../hebra-testing';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { sessionPortOf, setDocumentExporter } from '../../src/store/document-channel';
import {
  DocumentExportUnavailableError,
  DocumentReadError,
  documentBytesForCopy,
  openDocumentRead
} from '../../src/store/document-read';
import { SyncRunner } from '../../src/sync/runner';
import { IDENTITY, VAULT_KEY } from '../sync/devices';
import {
  createFakeAdapter,
  fakeBase,
  type FakeModel,
  type FakeOp
} from '../../vendor/hebra/src/lib/documents/testing/fake-format';
import {
  createDocumentSyncWiring,
  type DocumentSyncPort,
  type DocumentSyncWiring
} from '../../vendor/hebra/src/lib/documents/sync/wiring';
import { createDocSession } from '../../vendor/hebra/src/lib/documents/session';

/**
 * B-D16 (R8 por MCP): un lector ve la ultima edicion sin escribir, y duplicar pide
 * `ensureCheckpoint`. Motor real de Hebra, rele en memoria y formato doble.
 *
 * Pruebas negativas hechas a mano al escribirlo (se rompe, el test cae, se restaura):
 * - `documentBytesForCopy` lee `files.sha256` en vez de pedir `ensureCheckpoint`: cae el test de
 *   la copia (los bytes no llevan la edicion);
 * - `openDocumentRead` llama a `ensureCheckpoint` antes de proyectar: cae el test de no escribir
 *   (cambian `files`, `blobs` y el `/h`).
 */

const adapter = createFakeAdapter('ods');
const bytesOf = (text: string) => new TextEncoder().encode(text);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setDocumentExporter(null);
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setCell(doc: Y.Doc, key: string, value: string, origin?: string): Uint8Array {
  const before = Y.encodeStateVector(doc);
  doc.transact(() => doc.getMap<string>('fake').set(key, value), origin);
  return Y.encodeStateAsUpdateV2(doc, before);
}

async function stateOf(port: Pick<DocumentSyncPort, 'docRead'>, fileId: string) {
  const stored = await port.docRead(fileId);
  const doc = new Y.Doc();
  for (const piece of [...stored.segments, ...stored.pending]) Y.applyUpdateV2(doc, piece);
  return { doc, head: stored.head! };
}

interface Person {
  port: LocalLibraryPort;
  sync: LibrarySyncEngine;
  wiring: DocumentSyncWiring;
}

/** La persona: la app de Hebra con su canal de documentos. */
async function person(relay: InMemoryLibraryRelay): Promise<Person> {
  const { conn } = openNodeSqliteConn(':memory:');
  const engine = await SqliteLibraryEngine.open(conn, 'Mac');
  const port = new LocalLibraryPort(engine);
  let sync!: LibrarySyncEngine;
  const wiring = createDocumentSyncWiring({ libraryId: 'personal' }, port as unknown as DocumentSyncPort, {
    exportDocument: async (fileId) => ({ bytes: bytesOf(`export:${fileId}`), referencedBlobs: [] }),
    requestRound: () => sync.runRound(),
    externalMarks: async () => [],
    clearExternalMark: async () => undefined,
    readBlob: (sha) => sync.readBlob(sha)
  });
  sync = await LibrarySyncEngine.create({
    port,
    transport: relay,
    blobTransport: relay,
    identity: IDENTITY,
    vaultKey: VAULT_KEY,
    keyEpoch: 1,
    leaseOwnerId: `persona-${crypto.randomUUID()}`,
    reservedRecords: wiring.reservedRecords,
    filesRetention: wiring.retention,
    onAfterApplyPage: wiring.onAfterApplyPage
  });
  await wiring.start();
  return { port, sync, wiring };
}

async function personEdits(who: Person, fileId: string, key: string, value: string) {
  const { doc, head } = await stateOf(who.port, fileId);
  await who.wiring.sessionStore.docAppend(fileId, head.generation, setCell(doc, key, value));
}

/** La persona crea `cuentas.ods` con A1 = base. Devuelve el id y el hash del fichero guardado. */
async function createDocument(who: Person): Promise<{ id: string; savedSha: string }> {
  const base = await who.port.blobPut(fakeBase({ A1: 'base' }));
  const file = await who.port.fileCreate(null, 'cuentas.ods', base.sha256);
  await who.port.docSetHead(file.id, who.wiring.newHead('ods', base.sha256), [base.sha256]);
  who.wiring.channel.track(file.id);
  await personEdits(who, file.id, 'A1', 'base');
  return { id: file.id, savedSha: base.sha256 };
}

/** El MCP tal cual corre, sobre ficheros: asi se puede mirar su base desde fuera. */
async function mcp(relay: InMemoryLibraryRelay) {
  const dir = await mkdtemp(join(tmpdir(), 'hebra-mcp-read-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const port = await openNodeLibraryPort({
    sqlitePath: join(dir, 'library.sqlite'),
    dataDir: dir,
    deviceLabel: 'Claude'
  });
  const runner = await SyncRunner.create({
    port: port.syncStorePort(),
    transport: relay,
    blobTransport: relay,
    identity: IDENTITY,
    vaultKey: VAULT_KEY,
    intervalMs: null
  });
  cleanups.push(async () => {
    await runner.stop().catch(() => undefined);
    await port.closeWhenIdle().catch(() => undefined);
  });
  /** Todas las tablas de la base, fila a fila: lo que cambia si algo se escribe. */
  const snapshot = (): string => {
    const db = new DatabaseSync(join(dir, 'library.sqlite'), { readOnly: true });
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
      ).map((row) => row.name);
      const dump: Record<string, unknown[]> = {};
      for (const name of tables) {
        dump[name] = db.prepare(`SELECT * FROM "${name}"`).all().map((row) =>
          JSON.parse(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
        );
      }
      return JSON.stringify(dump);
    } finally {
      db.close();
    }
  };
  const source = { port: port.documentSource().port, readBlob: (sha: string) => runner.readBlobBytes(sha) };
  return { port, runner, snapshot, source, channel: port.documentSource() };
}

async function rounds(who: Person, agent: Awaited<ReturnType<typeof mcp>>, count = 3) {
  for (let turn = 0; turn < count; turn += 1) {
    expect((await who.sync.runRound()).result).toBe('ok');
    expect((await agent.runner.requestRound())?.result).toBe('ok');
  }
}

/** Una persona y un MCP con el documento ya sincronizado. */
async function setup() {
  const relay = new InMemoryLibraryRelay();
  const who = await person(relay);
  const agent = await mcp(relay);
  const file = await createDocument(who);
  await rounds(who, agent);
  return { who, agent, ...file };
}

describe('lectura del estado actual de un documento en el MCP (B-D16)', () => {
  it('un lector ve la ultima edicion de la persona sin escribir nada', async () => {
    const { who, agent, id, savedSha } = await setup();
    // La edicion llega por el canal, pero no esta en ningun fichero guardado.
    await personEdits(who, id, 'B2', 'persona');
    await rounds(who, agent);
    // Calentamiento: la base del documento baja del rele la primera vez (cache de un blob).
    await (await openDocumentRead<FakeModel, FakeOp>(agent.source, id, adapter)).close();
    const before = agent.snapshot();
    const savedBefore = (await agent.source.port.fileRead(id))!.sha256;
    expect(savedBefore).toBe(savedSha);

    const read = await openDocumentRead<FakeModel, FakeOp>(agent.source, id, adapter);
    expect(read.model.entries).toEqual({ A1: 'base', B2: 'persona' });
    expect(read.generation).toBe(read.head.generation);
    // El mismo estado da la misma revision que la sesion de escritura.
    const { doc, head } = await stateOf(agent.source.port, id);
    const writer = createDocSession<FakeModel, FakeOp>({
      fileId: id,
      doc,
      generation: head.generation,
      adapter,
      port: sessionPortOf(agent.channel),
      base: fakeBase({ A1: 'base' })
    });
    expect(read.revision).toBe(writer.revision());
    expect(read.layoutRevision).toBe(writer.layoutRevision());
    await read.close();

    // Nada escrito: ni `files`, ni blobs, ni el `/h`, ni la cola de sync.
    expect(agent.snapshot()).toBe(before);
    expect((await agent.source.port.fileRead(id))!.sha256).toBe(savedSha);
  });

  it('ve una edicion del LLM aun pendiente en el almacen, y la revision cambia con ella', async () => {
    const { agent, id } = await setup();
    const first = await openDocumentRead<FakeModel, FakeOp>(agent.source, id, adapter);
    const firstRevision = first.revision;
    await first.close();

    const { doc, head } = await stateOf(agent.source.port, id);
    await sessionPortOf(agent.channel).docAppendWith(
      id,
      head.generation,
      setCell(doc, 'C3', 'llm', 'agent'),
      () => undefined
    );
    const before = agent.snapshot();

    const read = await openDocumentRead<FakeModel, FakeOp>(agent.source, id, adapter);
    expect(read.model.entries).toEqual({ A1: 'base', C3: 'llm' });
    expect(read.pending).toBeGreaterThan(0);
    expect(read.revision).not.toBe(firstRevision);
    await read.close();
    expect(agent.snapshot()).toBe(before);
  });

  it('un documento sin cabecera da doc_head_missing y sin escribir', async () => {
    const { agent } = await setup();
    const before = agent.snapshot();
    const failure = await openDocumentRead<FakeModel, FakeOp>(agent.source, 'no-existe', adapter).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(DocumentReadError);
    expect((failure as DocumentReadError).code).toBe('doc_head_missing');
    expect(agent.snapshot()).toBe(before);
  });

  it('duplicar pide el punto de control: los bytes llevan la ultima edicion (R8)', async () => {
    const { who, agent, id, savedSha } = await setup();
    setDocumentExporter(async ({ store }, fileId) => {
      const { doc } = await stateOf(store, fileId);
      return { bytes: fakeBase(doc.getMap<string>('fake').toJSON()), referencedBlobs: [] };
    });
    await personEdits(who, id, 'B2', 'persona');
    await rounds(who, agent);
    // El fichero guardado sigue siendo el antiguo: sin punto de control, la copia saldria vieja.
    expect((await agent.source.port.fileRead(id))!.sha256).toBe(savedSha);
    // El blob guardado esta en local: una copia sin punto de control saldria con esos bytes viejos.
    expect(await agent.runner.readBlobBytes(savedSha)).not.toBeNull();

    const copy = await documentBytesForCopy(agent.channel, id);
    expect(copy.sha256).not.toBe(savedSha);
    expect(JSON.parse(new TextDecoder().decode(copy.bytes))).toEqual({ A1: 'base', B2: 'persona' });
    expect((await agent.source.port.fileRead(id))!.sha256).toBe(copy.sha256);
  });

  it('sin exportador registrado, duplicar falla con un error tipado y no escribe nada', async () => {
    const { who, agent, id } = await setup();
    await personEdits(who, id, 'B2', 'persona');
    await rounds(who, agent);
    const before = agent.snapshot();

    const failure = await documentBytesForCopy(agent.channel, id).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DocumentExportUnavailableError);
    expect((failure as DocumentReadError).code).toBe('document_export_unavailable');
    expect(agent.snapshot()).toBe(before);
  });

  it('sin canal montado, duplicar da document_channel_unwired', async () => {
    const { agent, id } = await setup();
    const failure = await documentBytesForCopy({ port: agent.source.port, wiring: null }, id).catch(
      (error: unknown) => error
    );
    expect((failure as DocumentReadError).code).toBe('document_channel_unwired');
  });
});
