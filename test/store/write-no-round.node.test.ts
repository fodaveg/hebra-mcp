/**
 * Una escritura que no escribió nada no pide ronda de sync ni la espera (R2 del audit del
 * 1 oct 2026): edición sin cambios, reintento con el mismo `operationId` y organización
 * que ya estaba en el estado pedido. El campo `sync` sigue siendo cierto: `not_linked`
 * sin sync, `uploaded` con la fila limpia y `pending` con la fila sucia. Una escritura
 * real sigue pidiendo la ronda. Lo mismo un fichero suelto (D10, 9 oct 2026): mandarlo a
 * la papelera cuando ya está en ella, o sacarlo cuando ya está vivo.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteLibraryEngine, type LibraryTransport } from '../../src/hebra';
import { localWriteContext } from '../../src/server/serve';
import type { WriteContext } from '../../src/server/write-context';
import { FsBlobStore } from '../../src/store/blob-store-fs';
import { encodeRevision } from '../../src/store/revision';
import type { NodeLibraryPort } from '../../src/store/node-port';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import type { EditNoteInput, OrganizeFileActionName, OrganizeInput } from '../../src/store/writes';
import { LIBRARY_SQLITE_FILE, LibraryInstance } from '../../src/sync/library-instance';
import { IDENTITY, InMemoryLibraryRelay, VAULT_KEY } from '../sync/devices';
import { NO_PRIVATE } from '../fixtures/no-private';

const dirs: string[] = [];
const instances: LibraryInstance[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const OFFLINE: LibraryTransport = {
  getChanges: () => Promise.reject(new TypeError('fetch failed')),
  postRecords: () => Promise.reject(new TypeError('fetch failed'))
};

async function open(
  transport: LibraryTransport | null,
  dataDir = mkdtempSync(join(tmpdir(), 'hebra-mcp-no-round-'))
): Promise<LibraryInstance> {
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  const instance = await LibraryInstance.open({
    dataDir,
    sync: transport
      ? {
          transport,
          // Con un fichero suelto, la ronda sube también sus bytes.
          blobTransport: transport instanceof InMemoryLibraryRelay ? transport : null,
          identity: IDENTITY,
          vaultKey: VAULT_KEY,
          intervalMs: null
        }
      : null,
    checkIntervalMs: null,
    lock: { releaseOnExit: false }
  });
  instances.push(instance);
  return instance;
}

async function revisionOf(instance: LibraryInstance, id: string): Promise<string> {
  const port = instance.port as NodeLibraryPort;
  const note = (await port.noteRead(id))!;
  const { libraryId } = await port.libraryOpen();
  return encodeRevision({ libraryId, noteId: id, localSeq: note.localSeq, bodySha256: note.bodySha256 });
}

interface Setup {
  instance: LibraryInstance;
  write: WriteContext;
  id: string;
  rounds: () => number;
}

/** Una nota ya creada; el contador de rondas empieza en cero DESPUÉS de crearla. */
async function setup(transport: LibraryTransport | null): Promise<Setup> {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const instance = await open(transport);
  const write = localWriteContext(instance);
  const created = await write.createNote({ body: '# Plan\n\nuno dos tres', privacy: NO_PRIVATE });
  const runner = instance.syncRunner;
  if (runner) await runner.requestRound();
  const spy = runner ? vi.spyOn(runner, 'requestRound') : null;
  return { instance, write, id: created.id, rounds: () => spy?.mock.calls.length ?? 0 };
}

/**
 * Un fichero suelto ya creado. Lo crea «Hebra» (su motor, sobre el mismo directorio de
 * datos) ANTES de que arranque la instancia: hebra-mcp no tiene vía para crear ficheros.
 * El contador de rondas empieza en cero después de la primera ronda.
 */
async function setupFile(
  transport: LibraryTransport | null
): Promise<Setup & { localSeq(): number }> {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const dataDir = mkdtempSync(join(tmpdir(), 'hebra-mcp-no-round-file-'));
  dirs.push(dataDir);
  const sqlitePath = join(dataDir, LIBRARY_SQLITE_FILE);
  const { db, conn } = openNodeSqliteConn(sqlitePath);
  let id: string;
  try {
    const engine = await SqliteLibraryEngine.open(conn, 'Mac', { blobs: new FsBlobStore(dataDir) });
    const blob = await engine.blobPut(new TextEncoder().encode('bytes del plano'), {
      mime: 'application/pdf'
    });
    id = (await engine.fileCreate(null, 'plano.pdf', blob.sha256)).id;
  } finally {
    db.close();
  }
  const instance = await open(transport, dataDir);
  const write = localWriteContext(instance);
  const runner = instance.syncRunner;
  if (runner) await runner.requestRound();
  const spy = runner ? vi.spyOn(runner, 'requestRound') : null;
  /** `local_seq` de la fila, por otra conexión de solo lectura: ninguna vía lo enseña. */
  const localSeq = (): number => {
    const reader = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      const row = reader.prepare('SELECT local_seq FROM files WHERE id = ?').get(id) as
        | { local_seq: number | bigint }
        | undefined;
      return Number(row?.local_seq);
    } finally {
      reader.close();
    }
  };
  return { instance, write, id, rounds: () => spy?.mock.calls.length ?? 0, localSeq };
}

const FILE_ACTIONS: readonly OrganizeFileActionName[] = ['trashFile', 'restoreFile'];

const STATES = [
  { name: 'not_linked', transport: () => null, expected: 'not_linked' },
  { name: 'uploaded', transport: () => new InMemoryLibraryRelay(), expected: 'uploaded' },
  { name: 'pending', transport: () => OFFLINE, expected: 'pending' }
] as const;

describe.each(STATES)('sin escritura, estado $name', ({ transport, expected }) => {
  it('una edición sin cambios no pide ronda y dice la verdad', async () => {
    const { instance, write, id, rounds } = await setup(transport());
    const input: EditNoteInput = {
      privacy: NO_PRIVATE,
      id,
      edits: [{ find: 'dos', replace: 'dos' }],
      expectedRevision: await revisionOf(instance, id),
      operationId: 'op-sin-cambios'
    };
    const result = await write.editNote(input);
    expect(result).toMatchObject({ id, outcome: 'saved', sync: expected });
    expect(rounds()).toBe(0);
  });

  it('un reintento con el mismo operationId no pide ronda', async () => {
    const { instance, write, id, rounds } = await setup(transport());
    const input: EditNoteInput = {
      privacy: NO_PRIVATE,
      id,
      edits: [{ find: 'dos', replace: 'DOS' }],
      expectedRevision: await revisionOf(instance, id),
      operationId: 'op-reintento'
    };
    const first = await write.editNote(input);
    // Una escritura real SÍ pide la ronda (dos veces: `onWritten` y la espera).
    if (expected !== 'not_linked') expect(rounds()).toBeGreaterThan(0);
    const before = rounds();
    const again = await write.editNote(input);
    expect(again).toMatchObject({ outcome: 'saved', replayed: true });
    expect(first.outcome).toBe('saved');
    expect(rounds()).toBe(before);
    // El `sync` del reintento sale de la fila: limpia si la ronda de la primera subió.
    expect(again.sync).toBe(expected);
  });

  it('organizar a un estado que ya tiene no pide ronda (los cinco casos)', async () => {
    const { write, id, rounds } = await setup(transport());
    // Dejar la nota en cada estado con una escritura real y repetir la petición.
    const pairs: Array<[OrganizeInput, OrganizeInput]> = [
      [
        { action: 'setFavorite', id, favorite: true, privacy: NO_PRIVATE },
        { action: 'setFavorite', id, favorite: true, privacy: NO_PRIVATE }
      ],
      [
        { action: 'setArchived', id, archived: true, privacy: NO_PRIVATE },
        { action: 'setArchived', id, archived: true, privacy: NO_PRIVATE }
      ],
      [
        { action: 'moveNote', id, folderId: 'root', privacy: NO_PRIVATE },
        { action: 'moveNote', id, folderId: 'root', privacy: NO_PRIVATE }
      ],
      [
        { action: 'trashNote', id, privacy: NO_PRIVATE },
        { action: 'trashNote', id, privacy: NO_PRIVATE }
      ],
      [
        { action: 'restoreNote', id, privacy: NO_PRIVATE },
        { action: 'restoreNote', id, privacy: NO_PRIVATE }
      ]
    ];
    for (const [first, repeat] of pairs) {
      // El primero puede escribir o no (mover a la raíz ya estaba); da igual.
      await write.organize(first);
      const before = rounds();
      const result = await write.organize(repeat);
      expect(rounds(), repeat.action).toBe(before);
      expect(result.sync, repeat.action).toBe(expected);
    }
  });

  it('mandar a la papelera o sacar un fichero suelto que ya está así no pide ronda (D10)', async () => {
    const { write, id, rounds, localSeq } = await setupFile(transport());
    for (const action of FILE_ACTIONS) {
      // La primera escribe de verdad (el fichero estaba en el otro estado).
      const seqBefore = localSeq();
      const first = await write.organizeFile({ action, id, privacy: NO_PRIVATE });
      expect(first, action).toMatchObject({ id, folderId: 'root', trashed: action === 'trashFile' });
      expect(localSeq(), action).toBe(seqBefore + 1);
      const before = rounds();
      const again = await write.organizeFile({ action, id, privacy: NO_PRIVATE });
      expect(rounds(), action).toBe(before);
      expect(again, action).toMatchObject({ id, trashed: action === 'trashFile', sync: expected });
      // Ni ronda ni fila tocada: repetir no sube `local_seq`.
      expect(localSeq(), action).toBe(seqBefore + 1);
    }
  });
});

describe('con escritura real', () => {
  it('mandar a la papelera un fichero suelto vivo pide la ronda y la espera (D10)', async () => {
    const { write, id, rounds } = await setupFile(new InMemoryLibraryRelay());
    const result = await write.organizeFile({ action: 'trashFile', id, privacy: NO_PRIVATE });
    expect(result).toEqual({ id, folderId: 'root', trashed: true, sync: 'uploaded' });
    expect(rounds()).toBeGreaterThan(0);
  });

  it('organizar cambiando el estado pide la ronda y la espera', async () => {
    const { write, id, rounds } = await setup(new InMemoryLibraryRelay());
    const result = await write.organize({ action: 'setFavorite', id, favorite: true, privacy: NO_PRIVATE });
    expect(result).toMatchObject({ favorite: true, sync: 'uploaded' });
    expect(rounds()).toBeGreaterThan(0);
  });
});
