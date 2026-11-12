/**
 * HS-5 (§28.3 y §28.12 de Hebra): lo que el motor de sync de Hebra hace por hebra-mcp en una
 * base de ESPACIO. Una edición del agente con `noteSave` y `baseBody` (`NoteWriter.editNote`)
 * sube con `history: true` y su `clientID` de Yjs se declara al relé (`POST /history/clients`)
 * por el mismo transporte, y con la misma credencial, que la escritura del registro. Y como el
 * runner del MCP va con `actorKind: 'agent'` (`src/spaces/manager.ts`), nunca manda
 * `historyPurge`: el relé se lo rechazaría (§28.12).
 *
 * El relé es el de memoria de Hebra (`InMemoryLibraryRelay`), envuelto para apuntar lo que
 * sube y contestar las declaraciones (el de memoria no tiene historial).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import type { LibraryHistoryClientsInput, LibraryPushRecordInput, LibraryTransport } from '../../src/hebra';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import { encodeRevision } from '../../src/store/revision';
import { NoteWriter } from '../../src/store/writes';
import { SyncRunner } from '../../src/sync/runner';
import { decodeRecordEnvelope, deriveRecordKey, encodeRecordEnvelope } from '../../vendor/hebra/src/lib/library/envelope';
import { NO_PRIVATE } from '../fixtures/no-private';
import { lockedBody } from '../privacy/audit-harness';
import { IDENTITY, InMemoryLibraryRelay, VAULT_KEY } from './devices';

const ACCOUNT = 'c4'.repeat(32);
const ports: NodeLibraryPort[] = [];
const runners: SyncRunner[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** El relé de memoria con lo que sube apuntado, `history: true` en `/changes` si se pide y
 *  `POST /history/clients` respondido con 204. */
function recordingRelay(options: { historyOnChanges?: boolean } = {}) {
  const relay = new InMemoryLibraryRelay();
  const pushed: LibraryPushRecordInput[] = [];
  const declared: LibraryHistoryClientsInput[] = [];
  const transport: LibraryTransport = {
    getChanges: async (vault, since, limit) => {
      const page = await relay.getChanges(vault, since, limit);
      if (!options.historyOnChanges) return page;
      return { ...page, records: page.records.map((record) => ({ ...record, history: true })) };
    },
    postRecords: async (vault, records) => {
      pushed.push(...records);
      return relay.postRecords(vault, records);
    },
    postHistoryClients: async (_vault, input) => {
      declared.push({ recordId: input.recordId, clients: [...input.clients] });
    }
  };
  return { relay, transport, pushed, declared };
}

/** Una base de espacio de verdad (`spaceAccess`) con el runner del MCP como lo monta
 *  `SpacesManager`: `spaceEnvelope` con la cuenta y `actorKind: 'agent'`. */
async function agentSpace(transport: LibraryTransport) {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-space-history-'));
  directories.push(directory);
  const spaceAccess = {
    spaceId: '955480b0-c2c3-471f-aa5d-3f37ed46fe68', scope: 'fixture', authorize: async () => {}, assertActive: () => {}
  };
  const port = await openNodeLibraryPort({ sqlitePath: join(directory, 'library.sqlite'), spaceAccess });
  ports.push(port);
  const runner = await SyncRunner.create({
    port: port.syncStorePort(), transport, identity: IDENTITY, vaultKey: VAULT_KEY, intervalMs: null,
    spaceEnvelope: { authorId: ACCOUNT, actorKind: 'agent' }
  });
  runners.push(runner);
  return { port, runner, writer: new NoteWriter(port) };
}

async function revisionOf(port: NodeLibraryPort, id: string): Promise<string> {
  const note = (await port.noteRead(id))!;
  return encodeRevision({ libraryId: await port.libraryId(), noteId: id, localSeq: note.localSeq, bodySha256: note.bodySha256 });
}

/** Los `clientID` del `ydoc` del último sobre que subió `id`. */
async function pushedClients(pushed: LibraryPushRecordInput[], id: string): Promise<number[]> {
  const last = pushed.filter((record) => record.id === id).at(-1)!;
  const recordKey = await deriveRecordKey({ vaultKey: VAULT_KEY, syncVaultId: IDENTITY.syncVaultId, keyEpoch: 1 });
  const decoded = await decodeRecordEnvelope({
    recordKey, syncVaultId: IDENTITY.syncVaultId, recordId: id, envelope: last.envelope!
  });
  const fields = decoded.fields as { ydoc?: string };
  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, Buffer.from(fields.ydoc!, 'base64'));
  const clients = [...Y.decodeStateVector(Y.encodeStateVector(doc)).keys()];
  doc.destroy();
  return clients;
}

describe('historial compartido desde el MCP (HS-5)', () => {
  it('una edición del agente con baseBody sube con history y declara su clientID', async () => {
    const { transport, pushed, declared } = recordingRelay();
    const { port, runner, writer } = await agentSpace(transport);
    // La primera ronda vincula la base al espacio; antes, escribir es `space_not_ready`.
    expect((await runner.requestRound())?.result).toBe('ok');
    const created = await writer.createNote({ body: '# Plan\n\nPrimera línea.\n', privacy: NO_PRIVATE });
    expect((await runner.requestRound())?.result).toBe('ok');

    const edited = await writer.editNote({
      id: created.id,
      edits: [{ find: 'Primera línea.', replace: 'Primera línea, revisada por el agente.' }],
      expectedRevision: await revisionOf(port, created.id),
      operationId: `op-hs5-${process.pid}`,
      privacy: NO_PRIVATE
    });
    expect(edited.outcome).toBe('saved');
    expect((await runner.requestRound())?.result).toBe('ok');

    const editPush = pushed.filter((record) => record.id === created.id).at(-1)!;
    expect(editPush.history).toBe(true);
    // Lo que declara es suyo: `clientID` que están en el `ydoc` que subió, de esta nota.
    const mine = declared.filter((batch) => batch.recordId === created.id).flatMap((batch) => batch.clients);
    expect(mine.length).toBeGreaterThan(0);
    const inDoc = await pushedClients(pushed, created.id);
    for (const client of mine) expect(inDoc).toContain(client);
    // Nada de esto lleva `historyPurge`.
    expect(pushed.some((record) => record.historyPurge === true)).toBe(false);
  });

  it('al bajar una nota bloqueada con historial, el agente no manda historyPurge', async () => {
    const { relay, transport, pushed } = recordingRelay({ historyOnChanges: true });
    // Otro miembro deja en el relé una nota bloqueada cuyo historial sigue guardado.
    const recordKey = await deriveRecordKey({ vaultKey: VAULT_KEY, syncVaultId: IDENTITY.syncVaultId, keyEpoch: 1 });
    const { envelope } = await encodeRecordEnvelope({
      recordKey, syncVaultId: IDENTITY.syncVaultId, recordId: 'locked-note',
      fields: {
        kind: 'note', folderId: 'root', body: lockedBody('Bloqueada', []), createdAt: 1, updatedAt: 2,
        favorite: false, trashedAt: null, conflictOf: null, conflictAt: null, conflictDevice: null
      },
      authorship: { authorId: 'a1'.repeat(32), minClient: 2 }
    });
    const seeded = await relay.postRecords(IDENTITY.syncVaultId, [
      { id: 'locked-note', baseRev: null, deleted: false, envelope, objectIds: [] }
    ]);
    expect(seeded.records[0]?.status).toBe('ok');

    const { port, runner } = await agentSpace(transport);
    expect((await runner.requestRound())?.result).toBe('ok');
    expect((await runner.requestRound())?.result).toBe('ok');
    expect((await port.noteRead('locked-note'))?.body.startsWith('hebra-locked:')).toBe(true);
    expect(pushed.some((record) => record.historyPurge === true)).toBe(false);
    expect(pushed.some((record) => record.id === 'locked-note')).toBe(false);
  });
});
