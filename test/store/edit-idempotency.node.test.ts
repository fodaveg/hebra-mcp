/**
 * Idempotencia durable de `hebra_edit_note` y reinicios (D2 ampliada, 28 sep 2026;
 * `src/store/operations.ts`). Todo sobre una SQLite en disco que se cierra y se vuelve a
 * abrir, como un proceso que muere y arranca:
 * - Se guardó y la ronda falló (sin red): tras reiniciar, el reintento con el mismo
 *   `operationId` NO vuelve a escribir (`replayed`) y la nota sube en la ronda de ahora.
 * - El proceso murió ANTES de guardar (registro `started`, nota intacta): el reintento
 *   la guarda, una vez.
 * - El proceso murió DESPUÉS de guardar y antes de cerrar el registro: el reintento ve
 *   por el SHA-256 que ya se guardó y no repite.
 * Lo mismo para `hebra_append_to_note` con `operationId` (10 oct 2026), que comparte el
 * registro.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryTransport } from '../../src/hebra';
import { localWriteContext } from '../../src/server/serve';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import { encodeRevision } from '../../src/store/revision';
import { NoteWriter, type EditNoteInput, type NoteWriteTarget } from '../../src/store/writes';
import { LibraryInstance } from '../../src/sync/library-instance';
import { IDENTITY, InMemoryLibraryRelay, VAULT_KEY, appDevice } from '../sync/devices';
import { NO_PRIVATE } from '../fixtures/no-private';

const dirs: string[] = [];
const instances: LibraryInstance[] = [];
const ports: NodeLibraryPort[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
  for (const port of ports.splice(0)) port.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-edit-idem-'));
  dirs.push(dir);
  return dir;
}

/** Un relé que no responde: toda ronda falla como sin red. */
const OFFLINE: LibraryTransport = {
  getChanges: () => Promise.reject(new TypeError('fetch failed')),
  postRecords: () => Promise.reject(new TypeError('fetch failed'))
};

async function revisionOf(port: NodeLibraryPort, id: string): Promise<string> {
  const note = (await port.noteRead(id))!;
  const { libraryId } = await port.libraryOpen();
  return encodeRevision({ libraryId, noteId: id, localSeq: note.localSeq, bodySha256: note.bodySha256 });
}

describe('reinicio tras guardar: «no guardado» frente a «guardado pendiente de sync»', () => {
  it('guardado con la ronda caída: el reintento tras reiniciar no repite y la nota sube', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const dataDir = tempDataDir();
    const relay = new InMemoryLibraryRelay();
    const lock = { releaseOnExit: false };

    // Primer «proceso»: sin red.
    const offline = await LibraryInstance.open({
      dataDir,
      sync: { transport: OFFLINE, identity: IDENTITY, vaultKey: VAULT_KEY, intervalMs: null },
      checkIntervalMs: null,
      lock
    });
    instances.push(offline);
    const created = await offline.createNote({ body: '# Plan\n\nuno dos tres', privacy: NO_PRIVATE });
    const input: EditNoteInput = {
      privacy: NO_PRIVATE,
      id: created.id,
      edits: [{ find: 'dos', replace: 'DOS' }],
      expectedRevision: await revisionOf(offline.port as NodeLibraryPort, created.id),
      operationId: 'op-reinicio-1'
    };
    const first = await localWriteContext(offline).editNote(input);
    expect(first).toMatchObject({ outcome: 'saved', sync: 'error' });
    expect(typeof first.syncError).toBe('string');
    expect((await offline.status()).pendingUpload).toBeGreaterThan(0);
    await offline.close();
    instances.splice(instances.indexOf(offline), 1);

    // Segundo «proceso», ya con red: el agente reintenta porque perdió la respuesta.
    const online = await LibraryInstance.open({
      dataDir,
      sync: { transport: relay, identity: IDENTITY, vaultKey: VAULT_KEY, intervalMs: null },
      checkIntervalMs: null,
      lock
    });
    instances.push(online);
    const again = await localWriteContext(online).editNote(input);
    // El reintento no escribe, así que no pide ronda (R2): la fila sigue sucia y es `pending`
    // hasta la siguiente ronda (la periódica, o esta explícita).
    expect(again).toMatchObject({ outcome: 'saved', replayed: true, sync: 'pending' });
    await online.syncRunner!.requestRound();
    expect(again.outcome === 'saved' && first.outcome === 'saved' && again.revision).toBe(
      first.outcome === 'saved' ? first.revision : null
    );
    expect((await online.port.noteRead(created.id))?.body).toBe('# Plan\n\nuno DOS tres');

    const app = await appDevice(relay);
    await app.sync.runRound();
    expect((await app.port.noteRead(created.id))?.body).toBe('# Plan\n\nuno DOS tres');
  });

  it('murió antes de guardar: el reintento guarda, una sola vez', async () => {
    const dataDir = tempDataDir();
    const sqlitePath = join(dataDir, 'library.sqlite');
    const port = await openNodeLibraryPort({ sqlitePath, dataDir });
    ports.push(port);
    const created = await new NoteWriter(port).createNote({ body: '# Nota\n\nhola', privacy: NO_PRIVATE });
    const input: EditNoteInput = {
      privacy: NO_PRIVATE,
      id: created.id,
      edits: [{ find: 'hola', replace: 'hola y adiós' }],
      expectedRevision: await revisionOf(port, created.id),
      operationId: 'op-antes'
    };
    // `noteSave` «mata el proceso» justo después de `begin`.
    const crashing: NoteWriteTarget = {
      writeExclusive: (operation) =>
        port.writeExclusive((store) =>
          operation({
            ...store,
            noteSave: () => Promise.reject(new Error('proceso muerto'))
          })
        )
    };
    await expect(new NoteWriter(crashing).editNote(input)).rejects.toThrow('proceso muerto');
    expect((await port.noteRead(created.id))?.body).toBe('# Nota\n\nhola');
    port.close();

    const reopened = await openNodeLibraryPort({ sqlitePath, dataDir });
    ports.push(reopened);
    const result = await new NoteWriter(reopened).editNote(input);
    expect(result).toMatchObject({ outcome: 'saved' });
    expect(result.replayed).toBeUndefined();
    expect((await reopened.noteRead(created.id))?.body).toBe('# Nota\n\nhola y adiós');
  });

  it('murió después de guardar y antes de cerrar el registro: el reintento no repite', async () => {
    const dataDir = tempDataDir();
    const sqlitePath = join(dataDir, 'library.sqlite');
    const port = await openNodeLibraryPort({ sqlitePath, dataDir });
    ports.push(port);
    const created = await new NoteWriter(port).createNote({ body: '# Nota\n\nhola', privacy: NO_PRIVATE });
    const input: EditNoteInput = {
      privacy: NO_PRIVATE,
      id: created.id,
      edits: [{ find: 'hola', replace: 'hola y adiós' }],
      expectedRevision: await revisionOf(port, created.id),
      operationId: 'op-despues'
    };
    const crashing: NoteWriteTarget = {
      writeExclusive: (operation) =>
        port.writeExclusive((store) =>
          operation({
            ...store,
            operations: {
              ...store.operations,
              finish: () => {
                throw new Error('proceso muerto');
              }
            }
          })
        )
    };
    await expect(new NoteWriter(crashing).editNote(input)).rejects.toThrow('proceso muerto');
    expect((await port.noteRead(created.id))?.body).toBe('# Nota\n\nhola y adiós');
    port.close();

    const reopened = await openNodeLibraryPort({ sqlitePath, dataDir });
    ports.push(reopened);
    const result = await new NoteWriter(reopened).editNote(input);
    expect(result).toMatchObject({ outcome: 'saved', replayed: true });
    expect((await reopened.noteRead(created.id))?.body).toBe('# Nota\n\nhola y adiós');
    // Y la revisión que devuelve es la de lo guardado: vale para la siguiente edición.
    expect(result.outcome === 'saved' && result.revision).toBe(await revisionOf(reopened, created.id));
  });

  it('append con operationId que murió antes de guardar: el reintento añade, una sola vez', async () => {
    const dataDir = tempDataDir();
    const sqlitePath = join(dataDir, 'library.sqlite');
    const port = await openNodeLibraryPort({ sqlitePath, dataDir });
    ports.push(port);
    const created = await new NoteWriter(port).createNote({ body: '# Nota\n\nhola', privacy: NO_PRIVATE });
    const input = { id: created.id, text: 'añadido', operationId: 'op-append-antes', privacy: NO_PRIVATE };
    const crashing: NoteWriteTarget = {
      writeExclusive: (operation) =>
        port.writeExclusive((store) =>
          operation({ ...store, noteSave: () => Promise.reject(new Error('proceso muerto')) })
        )
    };
    await expect(new NoteWriter(crashing).appendToNote(input)).rejects.toThrow('proceso muerto');
    port.close();

    const reopened = await openNodeLibraryPort({ sqlitePath, dataDir });
    ports.push(reopened);
    const result = await new NoteWriter(reopened).appendToNote(input);
    expect(result).toMatchObject({ outcome: 'saved', appended: { tail: 'añadido' } });
    expect(result.replayed).toBeUndefined();
    expect((await reopened.noteRead(created.id))?.body).toBe('# Nota\n\nhola\n\nañadido');
  });

  it('append con operationId que murió tras guardar y antes de cerrar el registro: no repite, sin `appended`', async () => {
    const dataDir = tempDataDir();
    const sqlitePath = join(dataDir, 'library.sqlite');
    const port = await openNodeLibraryPort({ sqlitePath, dataDir });
    ports.push(port);
    const created = await new NoteWriter(port).createNote({ body: '# Nota\n\nhola', privacy: NO_PRIVATE });
    const input = { id: created.id, text: 'añadido', operationId: 'op-append-despues', privacy: NO_PRIVATE };
    const crashing: NoteWriteTarget = {
      writeExclusive: (operation) =>
        port.writeExclusive((store) =>
          operation({
            ...store,
            operations: {
              ...store.operations,
              finish: () => {
                throw new Error('proceso muerto');
              }
            }
          })
        )
    };
    await expect(new NoteWriter(crashing).appendToNote(input)).rejects.toThrow('proceso muerto');
    expect((await port.noteRead(created.id))?.body).toBe('# Nota\n\nhola\n\nañadido');
    port.close();

    const reopened = await openNodeLibraryPort({ sqlitePath, dataDir });
    ports.push(reopened);
    const writer = new NoteWriter(reopened);
    const body = '# Nota\n\nhola\n\nañadido';
    const result = await writer.appendToNote(input);
    // No consta dónde quedó el texto: `revision` y `totalChars` del cuerpo actual, sin
    // `appended` (SPEC.md §5, `hebra_append_to_note`).
    expect(result).toEqual({
      id: created.id,
      outcome: 'saved',
      revision: await revisionOf(reopened, created.id),
      totalChars: body.length,
      replayed: true
    });
    expect((await reopened.noteRead(created.id))?.body).toBe(body);
    // El registro quedó cerrado: el siguiente reintento sale igual, del registro.
    expect(await writer.appendToNote(input)).toEqual(result);
  });

  it('append con operationId cuya ronda produjo una copia de conflicto: el reintento la devuelve', async () => {
    const dataDir = tempDataDir();
    const port = await openNodeLibraryPort({ sqlitePath: join(dataDir, 'library.sqlite'), dataDir });
    ports.push(port);
    const writer = new NoteWriter(port);
    const created = await writer.createNote({ body: '# Nota\n\nhola', privacy: NO_PRIVATE });
    const input = { id: created.id, text: 'añadido', operationId: 'op-append-copia', privacy: NO_PRIVATE };
    await writer.appendToNote(input);
    await writer.recordEditConflict('op-append-copia', created.id, 'copia-1');
    expect(await writer.appendToNote(input)).toEqual({
      id: created.id,
      outcome: 'conflict_copy',
      copyId: 'copia-1',
      replayed: true
    });
    expect((await port.noteRead(created.id))?.body).toBe('# Nota\n\nhola\n\nañadido');
  });

  it('un registro caducado se purga: el reintento es una petición nueva y choca con su revisión', async () => {
    const dataDir = tempDataDir();
    const port = await openNodeLibraryPort({ sqlitePath: join(dataDir, 'library.sqlite'), dataDir });
    ports.push(port);
    const writer = new NoteWriter(port);
    const created = await writer.createNote({ body: '# Nota\n\nhola', privacy: NO_PRIVATE });
    const input: EditNoteInput = {
      privacy: NO_PRIVATE,
      id: created.id,
      edits: [{ find: 'hola', replace: 'hola otra vez' }],
      expectedRevision: await revisionOf(port, created.id),
      operationId: 'op-caduca'
    };
    await writer.editNote(input);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 60 * 60 * 1000);
    await expect(writer.editNote(input)).rejects.toMatchObject({ code: 'revision_conflict' });
    expect((await port.noteRead(created.id))?.body).toBe('# Nota\n\nhola otra vez');
  });
});
