/**
 * C-37: el canal del escritor de `hebra_import_office`. Un lector reenvía el Office por
 * `writer.sock` (hasta 5 MiB), un escritor anterior responde `writer_outdated`, la compuerta
 * de capacidad llega a `runOfficeConversion` y un fallo real del conversor (la clase
 * `ConversionError` de Hebra) llega al cliente con su código. El soporte común vive en
 * `forward-harness.ts`; el escritor y el lector son instancias reales sobre el relé en memoria.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { CapacityGate } from '../../src/accounts/capacity';
import { realClock } from '../../src/accounts/lifecycle';
import {
  requestWriter,
  WRITER_SOCKET_FILE,
  WriterRemoteError
} from '../../src/ipc/writer-socket';
import { buildRoutedWriteContext, RoutedStatusSource, writerSocketHandlers } from '../../src/server/forward';
import { localWriteContext, officeConversionRunner, type OfficeWiring } from '../../src/server/serve';
import { OFFICE_CONVERSION_RESERVE_BYTES } from '../../src/server/tools/office-limits';
import { mapWriteError } from '../../src/server/tools/write-errors';
import { ATTACHMENT_MAX_BYTES } from '../../src/store/attachment-content';
import { createOfficeRunner } from '../../src/store/office-runner';
import type { OfficeImportInput } from '../../src/store/office-writes';
import { LibraryInstance } from '../../src/sync/library-instance';
import type { ConversionPreview, ConversionResult } from '../../vendor/hebra/src/lib/office-import/types';
import { IDENTITY, InMemoryLibraryRelay, VAULT_KEY } from '../sync/devices';
import {
  instances,
  livePid,
  OPEN,
  servers,
  tempDataDir,
  useForwardHarness
} from './forward-harness';

useForwardHarness();

const MIB = 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Un Office de prueba de `size` bytes (no hace falta que sea un ZIP: el convertidor es un doble). */
function officeBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
  return bytes;
}

function importInput(bytes: Uint8Array, extra: Partial<OfficeImportInput> = {}): OfficeImportInput {
  return {
    bytes,
    fileName: 'Libro.xlsx',
    format: 'xlsx',
    mode: 'convert-and-keep',
    preview: false,
    folderId: 'root',
    operationId: 'op-office-1',
    privacy: OPEN,
    ...extra
  };
}

/** Lo que ve el ejecutor doble de `runOfficeConversion`. */
interface Seen {
  kind: string;
  size: number;
  key: string;
  gate: unknown;
}

/** Un ejecutor doble: apunta qué recibe y devuelve una conversión sencilla. */
function fakeRun(seen: Seen[]): NonNullable<OfficeWiring['run']> {
  return (async (kind: 'analyze' | 'convert', input: { bytes: Uint8Array }, context: { gate: unknown; key: string }) => {
    seen.push({ kind, size: input.bytes.length, key: context.key, gate: context.gate });
    if (kind === 'analyze') {
      return { format: 'xlsx', convertible: true, losses: [] } satisfies ConversionPreview;
    }
    return {
      output: { kind: 'note', title: 'Hoja convertida', markdown: '# Hoja convertida\n\nTotal 42', assets: [] },
      losses: [{ kind: 'format:font', count: 2, label: 'Fuentes' }]
    } satisfies ConversionResult;
  }) as NonNullable<OfficeWiring['run']>;
}

/** Escritor y lector sobre la misma carpeta de datos; el escritor con el cableado de Office dado. */
async function officePair(office: OfficeWiring) {
  const dataDir = tempDataDir();
  const relay = new InMemoryLibraryRelay();
  const sync = { transport: relay, blobTransport: null, identity: IDENTITY, vaultKey: VAULT_KEY, intervalMs: null };
  const writer = await LibraryInstance.open({
    dataDir,
    sync,
    checkIntervalMs: null,
    lock: { releaseOnExit: false },
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
  // El lector no debe convertir nunca: si el ejecutor del lector corre, el reenvío no ocurrió.
  const readerOffice: OfficeWiring = {
    capacity: { gate: gateWith(), key: 'lector' },
    run: (async () => {
      throw new Error('el lector no convierte');
    }) as unknown as NonNullable<OfficeWiring['run']>
  };
  const write = buildRoutedWriteContext(reader, localWriteContext(reader, undefined, { office: readerOffice }));
  return { writer, reader, write, status: new RoutedStatusSource(reader, true), dataDir };
}

const gateWith = (usedMib = 0) =>
  new CapacityGate({
    readMemory: () => ({ usedBytes: usedMib * MIB, limitBytes: 512 * MIB }),
    highWater: { ratio: 0.8 },
    waitMs: 5_000,
    clock: realClock,
    reclaim: async () => undefined
  });

describe('un lector reenvía un Office al escritor (C-37)', () => {
  it('reenvía 5 MiB: el escritor convierte con la compuerta real y escribe el original y la nota', async () => {
    const seen: Seen[] = [];
    const gate = gateWith();
    const { write, writer } = await officePair({ capacity: { gate, key: 'cuenta-1' }, run: fakeRun(seen) });
    const bytes = officeBytes(ATTACHMENT_MAX_BYTES);

    const result = await write.importOffice!(importInput(bytes));

    expect(result.outcome).toBe('converted');
    expect(result.note?.title).toBe('Hoja convertida');
    expect(result.original?.sha256).toBe(sha(bytes));
    expect(result.losses).toEqual([{ kind: 'format:font', count: 2, label: 'Fuentes' }]);
    expect(['uploaded', 'pending']).toContain(result.sync);
    // El escritor lo recibió entero: la conversión corrió con los 5 MiB.
    expect(seen.map((entry) => [entry.kind, entry.size, entry.key])).toEqual([['convert', ATTACHMENT_MAX_BYTES, 'cuenta-1']]);
    // La nota está en la biblioteca del escritor.
    expect(await writer.port.noteRead(result.note!.id)).not.toBeNull();
  });

  it('el análisis (preview) viaja sin estado de sync y sin escribir', async () => {
    const seen: Seen[] = [];
    const { write, writer } = await officePair({ capacity: { gate: gateWith(), key: 'k' }, run: fakeRun(seen) });
    const before = (await writer.port.libraryOpen()).notesCount;
    const result = await write.importOffice!(importInput(officeBytes(2_000), { preview: true, operationId: undefined }));
    expect(result).toEqual({ outcome: 'preview', convertible: true, losses: [] });
    expect(seen.map((entry) => entry.kind)).toEqual(['analyze']);
    expect((await writer.port.libraryOpen()).notesCount).toBe(before);
  });

  it('un reintento con el mismo operationId no duplica (replayed)', async () => {
    const { write, writer } = await officePair({ capacity: { gate: gateWith(), key: 'k' }, run: fakeRun([]) });
    const bytes = officeBytes(3_000);
    const first = await write.importOffice!(importInput(bytes));
    const notes = (await writer.port.libraryOpen()).notesCount;
    const second = await write.importOffice!(importInput(bytes));
    expect(second.replayed).toBe(true);
    expect(second.note?.id).toBe(first.note?.id);
    expect((await writer.port.libraryOpen()).notesCount).toBe(notes);
  });

  it('más de 5 MiB desde un lector es file_too_large y no toca el socket', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const ops: string[] = [];
    const listener = createServer((socket) => {
      socket.once('data', (chunk) => {
        ops.push((JSON.parse(String(chunk)) as { op: string }).op);
        socket.end();
      });
    });
    servers.push(listener);
    await new Promise<void>((resolve) => listener.listen(path, resolve));
    const { write } = await officePair({ capacity: { gate: gateWith(), key: 'k' }, run: fakeRun([]) });
    const outsider = {
      role: 'other_instance' as const,
      writerSocketPath: path,
      checkWriter: async () => undefined,
      status: async () => {
        throw new Error('no se usa');
      }
    };
    const routed = buildRoutedWriteContext(outsider, write);
    const error = await routed.importOffice!(importInput(officeBytes(ATTACHMENT_MAX_BYTES + 1))).catch((caught: unknown) => caught);
    expect(mapWriteError(error).code).toBe('file_too_large');
    expect(ops).toEqual([]);
  });

  it('un escritor anterior (no conoce la op) responde writer_outdated y no escribe', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const ops: string[] = [];
    const old = createServer((socket) => {
      socket.once('data', (chunk) => {
        ops.push((JSON.parse(String(chunk)) as { op: string }).op);
        socket.end(`${JSON.stringify({ id: null, ok: false, error: 'invalid_request' })}\n`);
      });
    });
    servers.push(old);
    await new Promise<void>((resolve) => old.listen(path, resolve));
    const seen: Seen[] = [];
    const { write, writer } = await officePair({ capacity: { gate: gateWith(), key: 'k' }, run: fakeRun(seen) });
    const instance = {
      role: 'other_instance' as const,
      writerSocketPath: path,
      checkWriter: async () => undefined,
      status: async () => {
        throw new Error('no se usa');
      }
    };
    const routed = buildRoutedWriteContext(instance, write);
    const before = (await writer.port.libraryOpen()).notesCount;
    const error = await routed.importOffice!(importInput(officeBytes(1_000))).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'writer_outdated' });
    expect(ops).toEqual(['importOffice']);
    expect(seen).toEqual([]);
    expect((await writer.port.libraryOpen()).notesCount).toBe(before);
  });

  it('el escritor rechaza una petición mal formada con invalid_request, sin convertir', async () => {
    const seen: Seen[] = [];
    const { dataDir } = await officePair({ capacity: { gate: gateWith(), key: 'k' }, run: fakeRun(seen) });
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const good = {
      fileName: 'a.xlsx',
      format: 'xlsx',
      mode: 'convert-and-keep',
      preview: false,
      folderId: 'root',
      operationId: 'op-x',
      dataBase64: Buffer.from('PK').toString('base64'),
      privacy: OPEN
    };
    for (const bad of [
      { ...good, format: 'exe' },
      { ...good, mode: 'otro' },
      { ...good, preview: 'no' },
      { ...good, operationId: undefined },
      { ...good, dataBase64: '***' },
      { ...good, privacy: undefined }
    ]) {
      const error = await requestWriter(path, 'importOffice', bad, 5_000).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WriterRemoteError);
      expect(error).toMatchObject({ code: 'invalid_request' });
    }
    expect(seen).toEqual([]);
  });
});

describe('la compuerta de capacidad llega a runOfficeConversion (C-37)', () => {
  it('officeConversionRunner pasa la compuerta y la cuenta tal cual, y el hilo aparta la reserva medida más el fichero', async () => {
    const real = gateWith();
    const reservations: Array<{ bytes: number | undefined; key: string | undefined }> = [];
    const spy = {
      admit: (signal?: AbortSignal, bytes?: number, key?: string) => {
        reservations.push({ bytes, key });
        return real.admit(signal, bytes, key);
      }
    };
    const runner = createOfficeRunner({
      createWorker: () =>
        new Worker(
          `require('node:worker_threads').parentPort.postMessage({ ok: true, result: { format: 'xlsx', convertible: true, losses: [] } });`,
          { eval: true, stdout: true, stderr: true }
        )
    });
    const converter = officeConversionRunner({ gate: spy, key: 'cuenta-7' }, (kind, input, context) =>
      (runner.run as (...args: unknown[]) => Promise<never>)(kind, input, context)
    );
    const bytes = officeBytes(4_096);
    await converter.analyze({ bytes, fileName: 'a.xlsx', format: 'xlsx' });
    expect(reservations).toEqual([{ bytes: OFFICE_CONVERSION_RESERVE_BYTES + bytes.length, key: 'cuenta-7' }]);
    // La reserva se soltó al terminar.
    expect(real.reservedBytes).toBe(0);
  });

  it('un fallo real del conversor (ConversionError de Hebra) llega al cliente con su código, por el socket', async () => {
    const gate = gateWith();
    const runner = createOfficeRunner({
      createWorker: () =>
        new Worker(
          `require('node:worker_threads').parentPort.postMessage({ ok: false, code: 'encrypted', userMessage: 'El archivo tiene contraseña.' });`,
          { eval: true, stdout: true, stderr: true }
        )
    });
    const run = ((kind: 'analyze' | 'convert', input: never, context: never) =>
      (runner.run as (...args: unknown[]) => Promise<never>)(
        kind,
        input,
        context
      )) as unknown as NonNullable<OfficeWiring['run']>;
    const { write } = await officePair({ capacity: { gate, key: 'k' }, run });
    const bytes = officeBytes(1_500);

    const preview = await write.importOffice!(importInput(bytes, { preview: true, operationId: undefined }));
    expect(preview).toMatchObject({ outcome: 'preview', convertible: false, reason: 'encrypted' });

    const kept = await write.importOffice!(importInput(bytes));
    expect(kept).toMatchObject({ outcome: 'kept_original', convertible: false, reason: 'encrypted' });
    expect(kept.original?.sha256).toBe(sha(bytes));
    expect(gate.reservedBytes).toBe(0);
  });
});
