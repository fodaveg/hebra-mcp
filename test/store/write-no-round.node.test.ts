/**
 * Una escritura que no escribió nada no pide ronda de sync ni la espera (R2 del audit del
 * 1 oct 2026): edición sin cambios, reintento con el mismo `operationId` y organización
 * que ya estaba en el estado pedido. El campo `sync` sigue siendo cierto: `not_linked`
 * sin sync, `uploaded` con la fila limpia y `pending` con la fila sucia. Una escritura
 * real sigue pidiendo la ronda.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryTransport } from '../../src/hebra';
import { localWriteContext } from '../../src/server/serve';
import type { WriteContext } from '../../src/server/write-context';
import { encodeRevision } from '../../src/store/revision';
import type { NodeLibraryPort } from '../../src/store/node-port';
import type { EditNoteInput, OrganizeInput } from '../../src/store/writes';
import { LibraryInstance } from '../../src/sync/library-instance';
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

async function open(transport: LibraryTransport | null): Promise<LibraryInstance> {
  const dataDir = mkdtempSync(join(tmpdir(), 'hebra-mcp-no-round-'));
  dirs.push(dataDir);
  const instance = await LibraryInstance.open({
    dataDir,
    sync: transport
      ? { transport, identity: IDENTITY, vaultKey: VAULT_KEY, intervalMs: null }
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
});

describe('con escritura real', () => {
  it('organizar cambiando el estado pide la ronda y la espera', async () => {
    const { write, id, rounds } = await setup(new InMemoryLibraryRelay());
    const result = await write.organize({ action: 'setFavorite', id, favorite: true, privacy: NO_PRIVATE });
    expect(result).toMatchObject({ favorite: true, sync: 'uploaded' });
    expect(rounds()).toBeGreaterThan(0);
  });
});
