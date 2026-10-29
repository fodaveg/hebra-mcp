/** H-L7: el consumidor MCP conserva el formato y rechaza escrituras antes de SQLite. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import { NoteWriter } from '../../src/store/writes';
import type { SyncStorePort } from '../../src/store/sync-port';
import { SyncRunner } from '../../src/sync/runner';
import { decodeRecordEnvelope, encodeRecordEnvelope, deriveRecordKey } from '../../vendor/hebra/src/lib/library/envelope';
import { NO_PRIVATE } from '../fixtures/no-private';
import { IDENTITY, InMemoryLibraryRelay, VAULT_KEY } from './devices';

const ports: NodeLibraryPort[] = [];
const runners: SyncRunner[] = [];
const directories: string[] = [];
const ACCOUNT = 'c4'.repeat(32);

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Marca una base aislada como la apertura de un espacio de la app. No toca datos reales. */
async function openSpace(shared = true, bound = true) {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-space-format-'));
  directories.push(directory);
  const sqlitePath = join(directory, 'library.sqlite');
  const port = await openNodeLibraryPort({ sqlitePath });
  ports.push(port);
  if (shared) {
    const db = new DatabaseSync(sqlitePath);
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(
      'space_id', '955480b0-c2c3-471f-aa5d-3f37ed46fe68'
    );
    db.close();
  }
  if (bound) await port.syncStorePort().libraryConnect({
    binding: { ...IDENTITY, libraryInstance: 'space-format-test' }, relayHasRecords: true
  });
  return { port, sqlitePath, writer: new NoteWriter(port) };
}

function incoming(minClient: number, rev: number): Parameters<SyncStorePort['syncApplyPage']>[0] {
  return [{
    id: 'shared-note', rev, minClient, deleted: false, plaintextHash: `fixture-${rev}`,
    fields: {
      kind: 'note', folderId: 'root', body: '# Compartida', favorite: false,
      createdAt: 1, updatedAt: rev, trashedAt: null, conflictOf: null,
      conflictAt: null, conflictDevice: null
    }
  }];
}

describe('formato de espacio en el consumidor MCP', () => {
  it('revalida dentro de FIFO si llega un minClient nuevo antes de guardar', async () => {
    const { port, writer } = await openSpace();
    const sync = port.syncStorePort();
    await sync.syncApplyPage(incoming(2, 1));
    expect(await sync.syncMinClient!()).toBe(2);
    // Las dos peticiones entran sin esperar una a otra: la página ocupa el primer turno.
    const page = sync.syncApplyPage(incoming(3, 2));
    const edit = writer.organize({ action: 'setFavorite', id: 'shared-note', favorite: true, privacy: NO_PRIVATE });
    await expect(edit).rejects.toMatchObject({ code: 'client_outdated' });
    await page;
    expect((await port.noteRead('shared-note'))?.favorite).toBe(false);
    expect(await sync.syncDirtyBatch(50)).toEqual([]);
    await expect(port.noteCreate()).rejects.toMatchObject({ code: 'client_outdated' });
  });

  it('conserva el rechazo al reabrir, sin depender del estado en memoria del runner', async () => {
    const { port, sqlitePath } = await openSpace();
    await port.syncStorePort().syncApplyPage(incoming(3, 1));
    await port.closeWhenIdle();
    ports.splice(ports.indexOf(port), 1);
    const reopened = await openNodeLibraryPort({ sqlitePath });
    ports.push(reopened);
    await expect(new NoteWriter(reopened).createNote({ body: '# Nueva', privacy: NO_PRIVATE }))
      .rejects.toMatchObject({ code: 'client_outdated' });
    expect((await reopened.libraryOpen()).notesCount).toBe(1);
  });

  it('un espacio sin vínculo rechaza; el personal sigue permitiendo crear', async () => {
    const shared = await openSpace(true, false);
    await expect(shared.writer.createNote({ body: '# No debe existir', privacy: NO_PRIVATE }))
      .rejects.toMatchObject({ code: 'space_not_ready' });
    expect((await shared.port.libraryOpen()).notesCount).toBe(0);
    const personal = await openSpace(false, false);
    const created = await personal.writer.createNote({ body: '# Personal', privacy: NO_PRIVATE });
    expect((await personal.port.noteRead(created.id))?.body).toBe('# Personal');
  });

  it('el runner emite authorId y minClient del formato vigente, y no sube ante uno futuro', async () => {
    const relay = new InMemoryLibraryRelay();
    const port = await openNodeLibraryPort({ sqlitePath: ':memory:' });
    ports.push(port);
    const runner = await SyncRunner.create({
      port: port.syncStorePort(), transport: relay, identity: IDENTITY, vaultKey: VAULT_KEY,
      intervalMs: null, spaceEnvelope: { authorId: ACCOUNT }
    });
    runners.push(runner);
    const created = await new NoteWriter(port).createNote({ body: '# Del agente', privacy: NO_PRIVATE });
    expect((await runner.requestRound())?.result).toBe('ok');
    const page = await relay.getChanges(IDENTITY.syncVaultId, 0);
    const record = page.records.find((row) => row.id === created.id)!;
    const recordKey = await deriveRecordKey({ vaultKey: VAULT_KEY, syncVaultId: IDENTITY.syncVaultId, keyEpoch: 1 });
    const decoded = await decodeRecordEnvelope({
      recordKey, syncVaultId: IDENTITY.syncVaultId, recordId: created.id, envelope: record.envelope!
    });
    expect(decoded).toMatchObject({ authorId: ACCOUNT, minClient: 2 });
    const dirty = await new NoteWriter(port).createNote({ body: '# Pendiente', privacy: NO_PRIVATE });
    const future = await encodeRecordEnvelope({
      recordKey, syncVaultId: IDENTITY.syncVaultId, recordId: created.id,
      fields: decoded.fields, authorship: { authorId: ACCOUNT, minClient: 3 }
    });
    const pushed = await relay.postRecords(IDENTITY.syncVaultId, [{
      id: created.id, baseRev: record.rev, deleted: false, envelope: future.envelope, objectIds: []
    }]);
    expect(pushed.records[0]?.status).toBe('ok');
    expect((await runner.requestRound())?.result).toBe('ok');
    expect(runner.clientOutdated()).toEqual({ requiredFormat: 3, clientFormat: 2 });
    expect((await relay.getChanges(IDENTITY.syncVaultId, 0)).records.some((row) => row.id === dirty.id)).toBe(false);
  });
});
