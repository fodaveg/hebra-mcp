/**
 * C-37b: el canal de `hebra_import_office` por `sourceFileId`. Un lector manda solo el id y el
 * escritor lee los bytes de su disco (hasta 25 MiB, no los 5 MiB del base64); un id de otra
 * biblioteca, de la papelera o oculto por privacidad da lo mismo que uno inexistente; un
 * escritor anterior responde `writer_outdated`; la subida queda anotada en `uploadLedger`; y
 * `capacity_wait_timeout` vuelve al cliente sin escribir nada y se puede reintentar. El escritor
 * y el lector son instancias reales sobre el relé en memoria.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextUnavailableError } from '../../src/accounts/capacity';
import { WRITER_SOCKET_FILE } from '../../src/ipc/writer-socket';
import { buildRoutedWriteContext, writerSocketHandlers } from '../../src/server/forward';
import { localWriteContext, type OfficeWiring } from '../../src/server/serve';
import { OFFICE_FILE_ID_MAX_BYTES } from '../../src/server/tools/office-limits';
import { mapWriteError } from '../../src/server/tools/write-errors';
import { ATTACHMENT_MAX_BYTES } from '../../src/store/attachment-content';
import type { OfficeImportInput } from '../../src/store/office-writes';
import { LibraryInstance, type UploadLedger } from '../../src/sync/library-instance';
import type { ConversionPreview, ConversionResult } from '../../vendor/hebra/src/lib/office-import/types';
import { IDENTITY, InMemoryLibraryRelay, VAULT_KEY } from '../sync/devices';
import { instances, livePid, OPEN, servers, tempDataDir, useForwardHarness } from './forward-harness';

useForwardHarness();

const MIB = 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const PRIVATE_FOLDER = { privateFolders: [['diario']], privateTags: [] };

function officeBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
  return bytes;
}

/** Un ejecutor doble: apunta lo que recibe y devuelve una conversión sencilla. */
function fakeRun(seen: Array<{ kind: string; size: number; key: string }>): NonNullable<OfficeWiring['run']> {
  return (async (kind: 'analyze' | 'convert', input: { bytes: Uint8Array }, context: { key: string }) => {
    seen.push({ kind, size: input.bytes.length, key: context.key });
    if (kind === 'analyze') return { format: 'xlsx', convertible: true, losses: [] } satisfies ConversionPreview;
    return {
      output: { kind: 'note', title: 'Hoja convertida', markdown: '# Hoja convertida\n\nTotal 42', assets: [] },
      losses: []
    } satisfies ConversionResult;
  }) as NonNullable<OfficeWiring['run']>;
}

/** Un registro de subidas pendientes que apunta lo que se anota. */
function recordingLedger() {
  const recorded: Array<string | null> = [];
  const ledger: UploadLedger = {
    opened: () => undefined,
    closed: () => undefined,
    record: async (space) => {
      recorded.push(space);
    }
  };
  return { ledger, recorded };
}

async function officePair(office: OfficeWiring, ledger?: UploadLedger) {
  const dataDir = tempDataDir();
  const relay = new InMemoryLibraryRelay();
  const sync = { transport: relay, blobTransport: null, identity: IDENTITY, vaultKey: VAULT_KEY, intervalMs: null };
  const writer = await LibraryInstance.open({
    dataDir,
    sync,
    checkIntervalMs: null,
    lock: { releaseOnExit: false },
    ...(ledger ? { uploadLedger: ledger } : {}),
    writerSocket: (opened) => writerSocketHandlers(localWriteContext(opened, undefined, { office }), opened)
  });
  instances.push(writer);
  await writer.whenReady(5_000);
  const reader = await LibraryInstance.open({
    dataDir,
    sync,
    checkIntervalMs: null,
    lock: { releaseOnExit: false, pid: livePid() }
  });
  instances.push(reader);
  const readerOffice: OfficeWiring = {
    run: (async () => {
      throw new Error('el lector no convierte');
    }) as unknown as NonNullable<OfficeWiring['run']>
  };
  const write = buildRoutedWriteContext(reader, localWriteContext(reader, undefined, { office: readerOffice }));
  return { writer, reader, write, dataDir };
}

/** Un fichero ya subido a la biblioteca del escritor, en una carpeta nueva (o la raíz). */
async function addFile(writer: LibraryInstance, name: string, bytes: Uint8Array, folder?: string) {
  return writer.writeExclusive(async (store) => {
    const folderId = folder === undefined ? 'root' : (await store.folderCreate('root', folder)).id;
    await store.blobPut(bytes, { mime: 'application/octet-stream', expectedSha256: sha(bytes) });
    return store.fileCreate(folderId, name, sha(bytes));
  });
}

/** La entrada de un lector con `sourceFileId`: lleva los bytes, el reenvío los quita. */
function byId(id: string, extra: Partial<OfficeImportInput> = {}): OfficeImportInput {
  return {
    bytes: new Uint8Array([1]),
    fileName: 'Libro.xlsx',
    format: 'xlsx',
    mode: 'convert-and-keep',
    preview: false,
    folderId: 'root',
    sourceFileId: id,
    operationId: 'op-src-1',
    privacy: OPEN,
    ...extra
  };
}

describe('un lector importa por sourceFileId sin pasar los bytes por el socket (C-37b)', () => {
  it.each([
    ['5 MiB y un byte', ATTACHMENT_MAX_BYTES + 1],
    ['12 MiB', 12 * MIB],
    ['25 MiB exactos', OFFICE_FILE_ID_MAX_BYTES]
  ])('%s: el escritor lee el fichero de su disco y convierte', async (_name, size) => {
    const seen: Array<{ kind: string; size: number; key: string }> = [];
    const { writer, write } = await officePair({ run: fakeRun(seen) });
    const bytes = officeBytes(size);
    const source = await addFile(writer, 'Libro.xlsx', bytes);

    const result = await write.importOffice!(byId(source.id));

    expect(result.outcome).toBe('converted');
    expect(result.original).toMatchObject({ id: source.id, sha256: sha(bytes) });
    expect(seen.map((entry) => [entry.kind, entry.size])).toEqual([['convert', size]]);
  });

  it('más de 25 MiB es file_too_large y no convierte ni escribe', async () => {
    const seen: Array<{ kind: string; size: number; key: string }> = [];
    const { writer, write } = await officePair({ run: fakeRun(seen) });
    const source = await addFile(writer, 'Enorme.xlsx', officeBytes(OFFICE_FILE_ID_MAX_BYTES + 1));
    const before = (await writer.port.libraryOpen()).notesCount;

    const error = await write.importOffice!(byId(source.id, { fileName: 'Enorme.xlsx' })).catch((caught: unknown) => caught);

    expect(mapWriteError(error).code).toBe('file_too_large');
    expect(seen).toEqual([]);
    expect((await writer.port.libraryOpen()).notesCount).toBe(before);
  });

  it('un id de otra biblioteca, de la papelera o oculto por privacidad da lo mismo que uno inexistente', async () => {
    const seen: Array<{ kind: string; size: number; key: string }> = [];
    const { writer, write } = await officePair({ run: fakeRun(seen) });
    const other = await officePair({ run: fakeRun([]) });
    const foreign = await addFile(other.writer, 'Ajeno.xlsx', officeBytes(2_000));
    const hidden = await addFile(writer, 'Privado.xlsx', officeBytes(2_001), 'Diario');
    const trashed = await addFile(writer, 'Borrado.xlsx', officeBytes(2_002));
    await writer.writeExclusive(async (store) => {
      await store.fileTrash(trashed.id);
    });
    const missing = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    const codes: string[] = [];
    for (const [id, privacy] of [
      [missing, PRIVATE_FOLDER],
      [foreign.id, PRIVATE_FOLDER],
      [hidden.id, PRIVATE_FOLDER],
      [trashed.id, PRIVATE_FOLDER]
    ] as const) {
      const error = await write.importOffice!(byId(id, { privacy, operationId: `op-${id.slice(0, 8)}` })).catch(
        (caught: unknown) => caught
      );
      codes.push(mapWriteError(error).code);
    }
    expect(codes).toEqual(['not_found', 'not_found', 'not_found', 'not_found']);
    // Con la configuración abierta, el mismo oculto sí se ve: el rechazo era la privacidad.
    const visible = await write.importOffice!(byId(hidden.id, { operationId: 'op-visible' }));
    expect(visible.outcome).toBe('converted');
    expect(seen.length).toBe(1);
  });

  it('un escritor anterior responde writer_outdated, sin escribir y sin mandar los bytes', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const received: Array<Record<string, unknown>> = [];
    const old = createServer((socket) => {
      socket.once('data', (chunk) => {
        received.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        socket.end(`${JSON.stringify({ id: null, ok: false, error: 'invalid_request' })}\n`);
      });
    });
    servers.push(old);
    await new Promise<void>((resolve) => old.listen(path, resolve));
    const { writer, write } = await officePair({ run: fakeRun([]) });
    const source = await addFile(writer, 'Libro.xlsx', officeBytes(6 * MIB));
    const routed = buildRoutedWriteContext(
      {
        role: 'other_instance' as const,
        writerSocketPath: path,
        checkWriter: async () => undefined,
        status: async () => {
          throw new Error('no se usa');
        }
      },
      write
    );
    const before = (await writer.port.libraryOpen()).notesCount;

    const error = await routed.importOffice!(byId(source.id)).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'writer_outdated' });
    expect(received).toHaveLength(1);
    expect(received[0]?.op).toBe('importOffice');
    expect(JSON.stringify(received[0])).not.toContain('dataBase64');
    expect((await writer.port.libraryOpen()).notesCount).toBe(before);
  });
});

describe('la subida de una importación queda anotada (C-37b)', () => {
  it('importOfficeLocal avisa a uploadLedger; sin escribir (preview) no anota', async () => {
    const { ledger, recorded } = recordingLedger();
    const { writer, write } = await officePair({ run: fakeRun([]) }, ledger);
    const source = await addFile(writer, 'Libro.xlsx', officeBytes(3_000));
    await write.importOffice!(byId(source.id, { preview: true, operationId: undefined }));
    expect(recorded).toEqual([]);

    await write.importOffice!(byId(source.id));
    expect(recorded).toEqual([null]);
  });
});

describe('capacity_wait_timeout vuelve al cliente sin escribir (C-37b)', () => {
  it('no es un fallo interno: nada escrito, ni el original, y el reintento con el mismo operationId convierte', async () => {
    let busy = true;
    const seen: Array<{ kind: string; size: number; key: string }> = [];
    const inner = fakeRun(seen);
    const run = ((kind: 'analyze' | 'convert', input: { bytes: Uint8Array }, context: { key: string }) => {
      if (busy) return Promise.reject(new ContextUnavailableError('capacity_wait_timeout', 3));
      return (inner as unknown as (...args: unknown[]) => Promise<unknown>)(kind, input, context);
    }) as unknown as NonNullable<OfficeWiring['run']>;
    const { writer, write } = await officePair({ run });
    const bytes = officeBytes(4_000);
    const notes = (await writer.port.libraryOpen()).notesCount;
    const filesBefore = await writer.writeExclusive(async (store) => store.filesIndex().files.length);

    const error = await write
      .importOffice!({ ...byId('x'), sourceFileId: undefined, bytes, operationId: 'op-cap' })
      .catch((caught: unknown) => caught);
    expect(mapWriteError(error).code).toBe('capacity_wait_timeout');
    expect((await writer.port.libraryOpen()).notesCount).toBe(notes);
    expect(await writer.writeExclusive(async (store) => store.filesIndex().files.length)).toBe(filesBefore);

    // Un análisis también devuelve el motivo, no un "no convertible".
    const preview = await write
      .importOffice!({ ...byId('x'), sourceFileId: undefined, bytes, preview: true, operationId: undefined })
      .catch((caught: unknown) => caught);
    expect(mapWriteError(preview).code).toBe('capacity_wait_timeout');

    busy = false;
    const retried = await write.importOffice!({ ...byId('x'), sourceFileId: undefined, bytes, operationId: 'op-cap' });
    expect(retried.outcome).toBe('converted');
    expect(retried.replayed).toBeUndefined();
    expect(retried.original?.sha256).toBe(sha(bytes));
  });
});
