import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { LibrarySyncEngine, SqliteLibraryEngine } from '../../src/hebra';
import { InMemoryLibraryRelay, LocalLibraryPort } from '../hebra-testing';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import {
  attachSession,
  sessionPortOf,
  type DocumentChannelSource
} from '../../src/store/document-channel';
import type { DocSessionLike } from '../../src/store/document-types';
import { SyncRunner } from '../../src/sync/runner';
import { createSyncGates, type SyncGates } from '../../src/sync/gates';
import { IDENTITY, VAULT_KEY } from './devices';
import { createDocSession } from '../../vendor/hebra/src/lib/documents/session';
import type { DocSession } from '../../vendor/hebra/src/lib/documents/contract';
import {
  createFakeAdapter,
  fakeBase,
  type FakeModel,
  type FakeOp
} from '../../vendor/hebra/src/lib/documents/testing/fake-format';
import {
  createDocumentSyncWiring,
  documentSyncStateKey,
  type DocumentSyncPort,
  type DocumentSyncWiring
} from '../../vendor/hebra/src/lib/documents/sync/wiring';

/**
 * B-D15: el canal de documentos dentro del MCP, con el motor real de Hebra, el relé en memoria
 * y el formato doble. Una persona (la app, montada con el cableado de Hebra tal cual) y el MCP
 * (`NodeLibraryPort` + `SyncRunner`) editan el mismo documento a la vez.
 *
 * Pruebas negativas hechas a mano al escribirlo (se rompe, el test cae, se restaura):
 * - quitar `wiring.start()` de `SyncRunner.startDocuments`: cae el test del reinicio;
 * - hacer que `sessionPortOf` devuelva `source.port` en vez de `wiring.sessionStore`: cae el
 *   test de la primera ronda (el puerto plano no avisa al canal tras el append).
 */

const adapter = createFakeAdapter('ods');
const bytesOf = (text: string) => new TextEncoder().encode(text);
const newRelay = () => new InMemoryLibraryRelay();

// Los tipos reales cumplen `DocSessionLike`: si la sesión de Hebra cambia de forma, esto no compila.
const realSession = null as unknown as DocSession<FakeModel, FakeOp>;
const sessionLike: DocSessionLike<FakeModel, FakeOp> = realSession;
void sessionLike;

/** El `Y.Doc` de un documento tal como lo deja el almacén de un puerto, con su cabecera. */
async function stateOf(port: Pick<DocumentSyncPort, 'docRead'>, fileId: string) {
  const stored = await port.docRead(fileId);
  const doc = new Y.Doc();
  for (const piece of [...stored.segments, ...stored.pending]) Y.applyUpdateV2(doc, piece);
  return { doc, head: stored.head!, pending: stored.pending.length };
}

/** Cambia una celda del formato doble y devuelve el update V2 que eso produce. */
function setCell(doc: Y.Doc, key: string, value: string, origin?: string): Uint8Array {
  const before = Y.encodeStateVector(doc);
  doc.transact(() => doc.getMap<string>('fake').set(key, value), origin);
  return Y.encodeStateAsUpdateV2(doc, before);
}

async function cellsOf(port: Pick<DocumentSyncPort, 'docRead'>, fileId: string) {
  return (await stateOf(port, fileId)).doc.getMap<string>('fake').toJSON();
}

interface Person {
  port: LocalLibraryPort;
  sync: LibrarySyncEngine;
  wiring: DocumentSyncWiring;
  conflicts: string[];
}

const ACCOUNT = 'c4'.repeat(32);
/** Un espacio compartido: su id es el libraryId del canal. */
interface SpaceOptions {
  spaceId: string;
}
interface McpOptions {
  space?: SpaceOptions;
  gates?: SyncGates;
}

/** La persona: la app de Hebra con su canal de documentos. */
async function person(relay: InMemoryLibraryRelay, space?: SpaceOptions): Promise<Person> {
  const { conn } = openNodeSqliteConn(':memory:');
  const engine = await SqliteLibraryEngine.open(conn, 'Mac');
  const port = new LocalLibraryPort(engine);
  const conflicts: string[] = [];
  let sync!: LibrarySyncEngine;
  const wiring = createDocumentSyncWiring({ libraryId: space?.spaceId ?? 'personal' }, port as unknown as DocumentSyncPort, {
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
    ...(space ? { spaceEnvelope: { authorId: ACCOUNT } } : {}),
    leaseOwnerId: `persona-${crypto.randomUUID()}`,
    reservedRecords: wiring.reservedRecords,
    filesRetention: wiring.retention,
    onAfterApplyPage: wiring.onAfterApplyPage,
    onEvent: (event) => {
      if (event.event === 'sync.conflict_copy') conflicts.push(event.recordId);
    }
  });
  await wiring.start();
  return { port, sync, wiring, conflicts };
}

/** La persona crea `cuentas.ods` con la celda A1 ya escrita. */
async function createDocument(who: Person): Promise<string> {
  const base = await who.port.blobPut(fakeBase({ A1: 'base' }));
  const file = await who.port.fileCreate(null, 'cuentas.ods', base.sha256);
  await who.port.docSetHead(file.id, who.wiring.newHead('ods', base.sha256), [base.sha256]);
  who.wiring.channel.track(file.id);
  await personEdits(who, file.id, 'A1', 'base');
  return file.id;
}

/** Edita como la persona: por el almacén de sesiones del cableado de la app. */
async function personEdits(who: Person, fileId: string, key: string, value: string) {
  const { doc, head } = await stateOf(who.port, fileId);
  await who.wiring.sessionStore.docAppend(fileId, head.generation, setCell(doc, key, value));
}

interface Mcp {
  port: NodeLibraryPort;
  runner: SyncRunner;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hebra-mcp-docs-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** El MCP tal cual corre: `NodeLibraryPort` y `SyncRunner`. Con `dir`, sobre ficheros (reinicio). */
async function mcp(relay: InMemoryLibraryRelay, dir?: string, extra: McpOptions = {}): Promise<Mcp> {
  const spaceAccess = extra.space
    ? { spaceId: extra.space.spaceId, scope: 'fixture', authorize: async () => {}, assertActive: () => {} }
    : undefined;
  const port = await openNodeLibraryPort({
    ...(dir
      ? { sqlitePath: join(dir, 'library.sqlite'), dataDir: dir, deviceLabel: 'Claude' }
      : { sqlitePath: ':memory:', deviceLabel: 'Claude' }),
    ...(spaceAccess ? { spaceAccess } : {})
  });
  const runner = await SyncRunner.create({
    port: port.syncStorePort(),
    transport: relay,
    blobTransport: relay,
    identity: IDENTITY,
    vaultKey: VAULT_KEY,
    intervalMs: null,
    ...(extra.space ? { spaceEnvelope: { authorId: ACCOUNT } } : {}),
    ...(extra.gates ? { gates: extra.gates } : {})
  });
  cleanups.push(async () => {
    await runner.stop().catch(() => undefined);
    await port.closeWhenIdle().catch(() => undefined);
  });
  return { port, runner };
}

async function closeMcp(agent: Mcp) {
  await agent.runner.stop();
  await agent.port.closeWhenIdle();
}

async function rounds(who: Person, agent: Mcp, count = 3) {
  for (let turn = 0; turn < count; turn += 1) {
    expect((await who.sync.runRound()).result).toBe('ok');
    expect((await agent.runner.requestRound())?.result).toBe('ok');
  }
}

/** Una sesión abierta del MCP sobre un documento, que escribe por el puerto de sesiones del canal. */
async function openAgentDoc(source: DocumentChannelSource, fileId: string) {
  const { doc, head } = await stateOf(source.port, fileId);
  const port = sessionPortOf(source);
  let closed = false;
  return {
    doc,
    session: { fileId, doc, close: async () => void (closed = true) },
    closed: () => closed,
    /** Una edición del LLM: update V2 por `docAppendWith`, ya aplicada al `Y.Doc` abierto. */
    edit: (key: string, value: string) =>
      port.docAppendWith(fileId, head.generation, setCell(doc, key, value, 'agent'), () => undefined)
  };
}

describe('canal de documentos del MCP (B-D15)', () => {
  it('cada runner monta su canal con el puerto de su contexto', async () => {
    const agent = await mcp(newRelay());
    expect(agent.runner.documents).not.toBeNull();
    expect(agent.port.documentSource().wiring).toBe(agent.runner.documents);
    expect(agent.port.documentSource().libraryId).toBe('personal');
    // El puerto del almacén lleva lo atómico y los libros duraderos (sin ellos el cableado lanza).
    const port = agent.port.documentSource().port;
    for (const name of ['docAppendWith', 'docPurgeLoad', 'docPurgeSave', 'docRetentionLoad'] as const) {
      expect(typeof port[name], name).toBe('function');
    }
    // D2: el MCP no purga ni por el puerto de documentos.
    await expect(port.filePurge('x')).rejects.toThrow('document-purge-not-allowed');
  });

  it('la persona y el LLM editan a la vez y los dos cambios llegan a los dos lados, sin copia', async () => {
    const relay = newRelay();
    const who = await person(relay);
    const agent = await mcp(relay);
    const fileId = await createDocument(who);
    await rounds(who, agent);
    const source = agent.port.documentSource();
    expect(await cellsOf(source.port, fileId)).toEqual({ A1: 'base' });

    // Una sesión abierta del MCP: su `Y.Doc` y su puerto de escritura, el del canal.
    const open = await openAgentDoc(source, fileId);
    const release = attachSession(source, open.session);
    expect(source.sessions.openDocuments()).toEqual([fileId]);

    // A la vez, sin ronda entre medias: la persona escribe B2 y el LLM, C3.
    await personEdits(who, fileId, 'B2', 'persona');
    await open.edit('C3', 'llm');
    await rounds(who, agent);

    const both = { A1: 'base', B2: 'persona', C3: 'llm' };
    expect(await cellsOf(who.port, fileId)).toEqual(both);
    expect(await cellsOf(source.port, fileId)).toEqual(both);
    // La sesión abierta del LLM recibió lo de la persona sin reabrirla.
    expect(open.doc.getMap('fake').toJSON()).toEqual(both);
    // Y sin copia de conflicto ni cambio de generación en ninguno de los dos lados.
    expect(who.conflicts).toEqual([]);
    expect(open.closed()).toBe(false);
    release();
    expect(source.sessions.openDocuments()).toEqual([]);
  });

  it('una edición del LLM sube en la primera ronda: el puerto de sesiones avisa al canal tras cada append', async () => {
    const relay = newRelay();
    const who = await person(relay);
    const agent = await mcp(relay);
    const fileId = await createDocument(who);
    await rounds(who, agent);
    const open = await openAgentDoc(agent.port.documentSource(), fileId);

    await open.edit('C3', 'llm');
    expect((await agent.runner.requestRound())?.result).toBe('ok');
    expect((await who.sync.runRound()).result).toBe('ok');
    expect(await cellsOf(who.port, fileId)).toEqual({ A1: 'base', C3: 'llm' });
  });

  it('docAppendWith guarda el update y lo que escribe inTx en el mismo turno, o ninguno', async () => {
    const relay = newRelay();
    const who = await person(relay);
    const agent = await mcp(relay);
    const fileId = await createDocument(who);
    await rounds(who, agent);
    const source = agent.port.documentSource();
    const port = sessionPortOf(source);
    const { head, pending, doc } = await stateOf(source.port, fileId);
    const update = setCell(doc, 'Z9', 'x');
    let ran = 0;

    await expect(
      port.docAppendWith(fileId, head.generation, update, () => {
        ran += 1;
        throw new Error('el registro de operaciones falló');
      })
    ).rejects.toThrow('el registro de operaciones falló');
    expect(ran).toBe(1);
    expect((await stateOf(source.port, fileId)).pending).toBe(pending);

    await port.docAppendWith(fileId, head.generation, update, () => void (ran += 1));
    expect(ran).toBe(2);
    expect((await stateOf(source.port, fileId)).pending).toBe(pending + 1);
  });

  it('un cambio de generación cierra las sesiones abiertas de ese documento', async () => {
    const source = (await mcp(newRelay())).port.documentSource();
    let closed = 0;
    source.sessions.add('f1', { close: async () => void (closed += 1) });
    source.sessions.add('f2', { close: async () => void (closed += 100) });
    await source.sessions.closeFor('f1');
    expect(closed).toBe(1);
    expect(source.sessions.openDocuments()).toEqual(['f2']);
  });

  it.fails('la sesión real de Hebra cumple DocSessionLike y escribe updates V2 como espera el almacén', async () => {
    // HALLAZGO (vendor/hebra/src/lib/documents/session.ts, líneas 193, 196 y 237): `createDocSession`
    // saca el update de `copy.on('update')` y lo aplica con `Y.applyUpdate`, es decir, V1. El
    // almacén, el canal y `generation-flow.ts` leen todo como V2 (`Y.applyUpdateV2`): un update V1
    // lanza «Unexpected end of array». Mientras no se arregle en Hebra, este test falla a propósito
    // (`it.fails`); al arreglarlo pasará a rojo y hay que quitar el `.fails`.
    const relay = newRelay();
    const who = await person(relay);
    const agent = await mcp(relay);
    const fileId = await createDocument(who);
    await rounds(who, agent);
    const source = agent.port.documentSource();
    const { doc, head } = await stateOf(source.port, fileId);
    const session = createDocSession<FakeModel, FakeOp>({
      fileId,
      doc,
      generation: head.generation,
      adapter,
      port: sessionPortOf(source),
      base: fakeBase({ A1: 'base' })
    });
    const like: DocSessionLike<FakeModel, FakeOp> = session;
    await like.apply([{ kind: 'set', key: 'C3', value: 'llm' }], 'agent', { seed: 's1' });
    await rounds(who, agent);
    expect(await cellsOf(who.port, fileId)).toEqual({ A1: 'base', C3: 'llm' });
  });

  it('un documento editado antes de reiniciar sube tras el arranque (start registra los documentos)', async () => {
    const relay = newRelay();
    const dir = await tempDir();
    const who = await person(relay);
    const first = await mcp(relay, dir);
    const fileId = await createDocument(who);
    await rounds(who, first);

    // El LLM escribe y el proceso se cierra sin ronda: la edición solo está en la base local.
    const source = first.port.documentSource();
    const { doc, head } = await stateOf(source.port, fileId);
    await sessionPortOf(source).docAppend(fileId, head.generation, setCell(doc, 'D4', 'antes de cerrar'));
    await closeMcp(first);

    const second = await mcp(relay, dir);
    await rounds(who, second);
    expect(await cellsOf(who.port, fileId)).toEqual({ A1: 'base', D4: 'antes de cerrar' });
  });

  it('el vínculo del canal se guarda en la base del contexto y sobrevive al reinicio', async () => {
    const dir = await tempDir();
    const first = await mcp(newRelay(), dir);
    expect((await first.runner.requestRound())?.result).toBe('ok');
    const key = documentSyncStateKey('personal');
    const saved = first.port.documentSource().storage.getItem(key);
    expect(saved).toContain('binding');
    await closeMcp(first);

    // Otro puerto sobre el mismo fichero: la caché está vacía, el valor viene de `meta`.
    const reopened = await openNodeLibraryPort({ sqlitePath: join(dir, 'library.sqlite'), dataDir: dir });
    cleanups.push(async () => void (await reopened.closeWhenIdle().catch(() => undefined)));
    expect(reopened.documentSource().storage.getItem(key)).toBe(saved);
  });

  it('en un espacio compartido la edición sube, llega a otro dispositivo del espacio y no se cruza con la biblioteca personal', async () => {
    const spaceId = '955480b0-c2c3-471f-aa5d-3f37ed46fe68';
    const space = { spaceId };
    const spaceRelay = newRelay();
    const personalRelay = newRelay();
    const spacePerson = await person(spaceRelay, space);
    const personalPerson = await person(personalRelay);
    const spaceAgent = await mcp(spaceRelay, undefined, { space });
    const personalAgent = await mcp(personalRelay);
    expect(spaceAgent.port.documentSource().libraryId).toBe(spaceId);
    expect(personalAgent.port.documentSource().libraryId).toBe('personal');

    const spaceFile = await createDocument(spacePerson);
    const personalFile = await createDocument(personalPerson);
    await rounds(spacePerson, spaceAgent);
    await rounds(personalPerson, personalAgent);
    const spaceSource = spaceAgent.port.documentSource();
    const personalSource = personalAgent.port.documentSource();
    expect(await cellsOf(spaceSource.port, spaceFile)).toEqual({ A1: 'base' });

    // El LLM edita en el espacio: sube y llega al otro dispositivo del espacio.
    const open = await openAgentDoc(spaceSource, spaceFile);
    await open.edit('C3', 'llm-espacio');
    await rounds(spacePerson, spaceAgent);
    expect(await cellsOf(spacePerson.port, spaceFile)).toEqual({ A1: 'base', C3: 'llm-espacio' });

    // Ninguna edición ni documento cruza de un contexto al otro.
    const personalOpen = await openAgentDoc(personalSource, personalFile);
    await personalOpen.edit('Z9', 'llm-personal');
    await rounds(personalPerson, personalAgent);
    await rounds(spacePerson, spaceAgent);
    expect(await cellsOf(personalPerson.port, personalFile)).toEqual({ A1: 'base', Z9: 'llm-personal' });
    expect(await cellsOf(spacePerson.port, spaceFile)).toEqual({ A1: 'base', C3: 'llm-espacio' });
    expect((await spaceSource.port.docRead(personalFile)).head).toBeNull();
    expect((await personalSource.port.docRead(spaceFile)).head).toBeNull();
    expect(await spaceSource.port.fileRead(personalFile)).toBeNull();
    expect(await personalSource.port.fileRead(spaceFile)).toBeNull();
    // El vínculo del canal se guarda con la clave de SU contexto.
    expect(spaceSource.storage.getItem(documentSyncStateKey(spaceId))).toContain('binding');
    expect(spaceSource.storage.getItem(documentSyncStateKey('personal'))).toBeNull();
  });

  it('readBlob del canal pasa por la compuerta de descargas: con la plaza ocupada espera, y la suelta al acabar', async () => {
    const relay = newRelay();
    const gates = createSyncGates(2, 1);
    const who = await person(relay);
    const agent = await mcp(relay, undefined, { gates });
    const fileId = await createDocument(who);
    await rounds(who, agent);
    const source = agent.port.documentSource();
    // Un documento con ediciones pendientes no es "pristine": restaurar su base pide los bytes
    // por el gancho `readBlob` del cableado.
    const open = await openAgentDoc(source, fileId);
    await open.edit('C3', 'llm');
    const head = (await source.port.docRead(fileId)).head!;

    // La única plaza de descargas del proceso está cogida.
    const held = (await gates.downloads.acquire(undefined, 'otra-cuenta'))!;
    const restoring = source.wiring!.restore(fileId, head.baseSha256).catch(() => undefined);
    // La descarga del cableado hace cola en la compuerta en vez de ir directa al motor.
    await vi.waitFor(() => expect(gates.downloads.queued).toBe(1));
    held();
    await restoring;
    expect(gates.downloads.queued).toBe(0);
    expect(gates.downloads.inUse).toBe(0);
  });

  it('un lector no monta canal de documentos y no escribe', async () => {
    const dir = await tempDir();
    const location = { sqlitePath: join(dir, 'library.sqlite'), dataDir: dir };
    const writer = await openNodeLibraryPort(location);
    cleanups.push(async () => void (await writer.closeWhenIdle().catch(() => undefined)));
    const reader = await openNodeLibraryPort({ ...location, mode: 'readOnly' });
    cleanups.push(async () => void (await reader.closeWhenIdle().catch(() => undefined)));
    const runner = await SyncRunner.create({
      port: reader.syncStorePort(),
      transport: newRelay(),
      identity: IDENTITY,
      vaultKey: VAULT_KEY,
      intervalMs: null
    });
    expect(runner.documents).toBeNull();
    await expect(
      reader.documentSource().port.docAppend('x', 'g', new Uint8Array([1]))
    ).rejects.toThrow('busy_other_instance');
  });
});
