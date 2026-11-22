/**
 * H-177: la op `documentOps` de punta a punta y las herramientas de hojas en un lector. El
 * escritor y el lector son instancias reales sobre el relé en memoria (`forward-harness.ts`), y el
 * lector registra las herramientas como un `serve` que no tiene el bloqueo.
 *
 * Lo que se mira:
 * - Crear y editar desde un lector pasan por `writer.sock`: lo escribe el escritor y el
 *   `documentOps` local del lector no se llama nunca.
 * - Leer y pintar no piden turno de escritura ni tocan el socket, y la lectura aparta su memoria
 *   en la compuerta del contexto (`ServerContext.documentCapacity`).
 * - Un `opsVersion` distinto, o un escritor que no conoce la op, dan `writer_outdated` sin escribir.
 * - Un comando de hojas que no pasa el esquema de la herramienta llega por el socket y el escritor
 *   lo rechaza con `batch_invalid` sin tocar el documento: el escritor no se fía del lector.
 * - La forma y los topes de la op (parte 1 de H-177): `invalid_request` sin escribir, y los bytes
 *   de una creación de más de 5 MiB, `file_too_large`.
 *
 * La lectura corre aquí en el proceso del test: el hilo de documentos (`dist/document-worker.mjs`)
 * solo existe empaquetado, así que `runDocumentJob('read')` se sustituye por el mismo trabajo
 * (`runReadSheetJob`) y apunta con qué compuerta y cuenta se pidió.
 *
 * Roturas vistas en rojo al hacer el paquete (y repuestas): que el lector use su `documentOps`
 * local en vez del socket (rojo "pasa por el socket"), que la lectura pida un lote al escritor
 * (rojo "no piden turno"), quitar la comprobación de `opsVersion` del socket (rojo
 * "writer_outdated"), quitar la revalidación de `parseSheetCommands` en el escritor (rojo
 * "batch_invalid") y quitar el tope de `EDIT_OPS_MAX` del socket (rojo "topes").
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CapacityGate } from '../../src/accounts/capacity';
import { realClock } from '../../src/accounts/lifecycle';
import {
  requestWriter,
  WRITER_SOCKET_FILE,
  WriterRemoteError,
  type WriterSocketHandlers
} from '../../src/ipc/writer-socket';
import type { ServerContext } from '../../src/server/context';
import { buildRoutedWriteContext, RoutedStatusSource, writerSocketHandlers } from '../../src/server/forward';
import { localWriteContext } from '../../src/server/serve';
import { mapWriteError } from '../../src/server/tools/write-errors';
import { ATTACHMENT_MAX_BYTES } from '../../src/store/attachment-content';
import type { DocumentOpsRequest } from '../../src/store/document-service';
import { EDIT_OPS_MAX, EDIT_OPS_MAX_BYTES } from '../../src/store/document-limits';
import { DOCUMENT_OPS_VERSION } from '../../src/store/document-types';
import { LibraryInstance } from '../../src/sync/library-instance';
import { IDENTITY, InMemoryLibraryRelay, VAULT_KEY } from '../sync/devices';
import { call, connect, instances, livePid, OPEN, servers, tempDataDir, useForwardHarness } from './forward-harness';

/** Los trabajos de lectura que pidió la herramienta, con su compuerta y su cuenta. */
const jobs = vi.hoisted(() => [] as Array<{ kind: string; key: string; gate: unknown }>);

vi.mock('../../src/store/document-jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/document-jobs')>();
  return {
    ...actual,
    runDocumentJob: async (kind: string, input: unknown, context: { key: string; gate: unknown }) => {
      jobs.push({ kind, key: context.key, gate: context.gate });
      if (kind !== 'read') throw new Error(`trabajo inesperado: ${kind}`);
      const { runReadSheetJob } = await import('../../src/server/tools/read-sheet-job');
      return runReadSheetJob(structuredClone(input) as never);
    }
  };
});

useForwardHarness();

const gate = () =>
  new CapacityGate({
    readMemory: () => ({ usedBytes: 0, limitBytes: 512 * 1024 * 1024 }),
    highWater: { ratio: 0.8 },
    waitMs: 5_000,
    clock: realClock,
    reclaim: async () => undefined
  });

/** Los handlers del escritor, apuntando qué op llega por el socket. */
function recording(handlers: WriterSocketHandlers, seen: string[]): WriterSocketHandlers {
  const wrapped: Record<string, unknown> = {};
  for (const [op, run] of Object.entries(handlers)) {
    wrapped[op] =
      typeof run === 'function'
        ? (...args: unknown[]) => {
            seen.push(op);
            return (run as (...rest: unknown[]) => unknown).apply(handlers, args);
          }
        : run;
  }
  return wrapped as unknown as WriterSocketHandlers;
}

/**
 * Escritor y lector sobre la misma carpeta, vinculados al relé en memoria como `pair()`; el lector
 * con su cliente MCP y su `documentOps` espiado. Con sync, el escritor monta el cableado de
 * documentos: tras cada lote hay punto de control y limpieza de blobs (`checkpointThenClean`),
 * que antes de H-BLOQUEO-SYNC se esperaba a sí misma y dejaba la edición sin volver.
 */
async function documentPair() {
  const dataDir = tempDataDir();
  const socketOps: string[] = [];
  const sync = {
    transport: new InMemoryLibraryRelay(),
    blobTransport: null,
    identity: IDENTITY,
    vaultKey: VAULT_KEY,
    intervalMs: null
  };
  const writer = await LibraryInstance.open({
    dataDir,
    sync,
    checkIntervalMs: null,
    lock: { releaseOnExit: false },
    writerSocket: (opened) => recording(writerSocketHandlers(localWriteContext(opened), opened), socketOps)
  });
  instances.push(writer);
  await writer.whenReady(5_000);
  expect(writer.syncRunner).not.toBeNull();
  const reader = await LibraryInstance.open({
    dataDir,
    sync,
    checkIntervalMs: null,
    lock: { releaseOnExit: false, pid: livePid() }
  });
  instances.push(reader);
  expect(reader.role).toBe('other_instance');
  const local = localWriteContext(reader);
  const localDocumentOps = vi.spyOn(local, 'documentOps' as never);
  const write = buildRoutedWriteContext(reader, local);
  const capacity = { gate: gate(), key: 'lector' };
  const readerCtx: ServerContext = {
    port: reader.port,
    privacyConfig: { privateFolders: [], privateTags: [] },
    status: new RoutedStatusSource(reader, true),
    documentCapacity: capacity,
    write
  };
  const client = await connect(readerCtx);
  return { dataDir, writer, reader, write, client, socketOps, localDocumentOps, capacity };
}

/** Crea `Cuentas.ods` desde el lector, con `Total | 42` en A1:B1. */
async function createBook(client: Awaited<ReturnType<typeof documentPair>>['client']) {
  const created = await call(client, 'hebra_create_sheet', {
    name: 'Cuentas.ods',
    ops: [{ type: 'setCells', sheet: 'Hoja 1', start: 'A1', rows: [['Total', 42]] }],
    operationId: randomUUID()
  });
  expect(created.isError, JSON.stringify(created.value)).toBe(false);
  return created.value as { id: string; revision: string; layoutRevision: string; outcome: string };
}

/** Un lote de hojas tal como viaja por el socket (`SheetBatchOp`). */
function batchParams(id: string, commands: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opsVersion: DOCUMENT_OPS_VERSION,
    format: 'ods',
    privacy: OPEN,
    action: 'edit',
    input: { id, operationId: randomUUID(), ops: [{ type: 'sheet.batch', seed: 'semilla', commands }], ...extra }
  };
}

describe('hojas desde un lector: crear y editar van por el socket (H-177)', () => {
  it('crear y editar pasan por writer.sock, los escribe el escritor y no se llama al documentOps local', async () => {
    const { writer, client, socketOps, localDocumentOps } = await documentPair();

    const created = await createBook(client);
    expect(created.outcome).toBe('saved');
    expect(await writer.port.documentSource().port.fileRead(created.id)).not.toBeNull();

    const edited = await call(client, 'hebra_edit_sheet', {
      id: created.id,
      ops: [{ type: 'setCells', sheet: 'Hoja 1', start: 'B1', rows: [[43]], expect: { B1: 42 } }],
      expectedLayout: created.layoutRevision,
      operationId: randomUUID()
    });
    expect(edited.isError, JSON.stringify(edited.value)).toBe(false);
    expect(edited.value).toMatchObject({ id: created.id, outcome: 'saved' });
    expect(edited.value.revision).not.toBe(created.revision);

    expect(socketOps.filter((op) => op === 'documentOps')).toHaveLength(2);
    expect(localDocumentOps).not.toHaveBeenCalled();
  });

  it('leer y pintar no piden turno de escritura ni tocan el socket; la lectura aparta en la compuerta del contexto', async () => {
    const { writer, reader, client, socketOps, localDocumentOps, capacity } = await documentPair();
    const created = await createBook(client);
    const turnsBefore = socketOps.length;
    const writerTurns = vi.spyOn(writer, 'writeExclusive');
    const readerTurns = vi.spyOn(reader, 'writeExclusive');
    jobs.length = 0;

    const read = await call(client, 'hebra_read_sheet', { id: created.id, sheet: 'Hoja 1', range: 'A1:B1' });
    expect(read.isError, JSON.stringify(read.value)).toBe(false);
    expect(read.value).toMatchObject({ id: created.id, revision: created.revision, untrustedContent: true });
    expect(JSON.stringify(read.value)).toContain('"Total",42');
    // El render corre aunque aquí no tenga sus fuentes empaquetadas: lo que importa es que no escriba.
    await call(client, 'hebra_render_sheet', { id: created.id, sheet: 'Hoja 1', range: 'A1:B1' });

    expect(jobs).toEqual([{ kind: 'read', key: 'lector', gate: capacity.gate }]);
    expect(writerTurns).not.toHaveBeenCalled();
    expect(readerTurns).not.toHaveBeenCalled();
    expect(socketOps.slice(turnsBefore)).toEqual([]);
    expect(localDocumentOps).not.toHaveBeenCalled();
  });
});

describe('documentOps por el socket: versión, escritor anterior y lote revalidado (H-177)', () => {
  it('otro opsVersion es invalid_request en el escritor y writer_outdated en el lector, sin escribir', async () => {
    const { dataDir, writer, write, client, socketOps } = await documentPair();
    const created = await createBook(client);
    const before = await writer.port.documentSource().port.docRead(created.id);
    const request = {
      opsVersion: DOCUMENT_OPS_VERSION + 1,
      format: 'ods',
      privacy: OPEN,
      action: 'edit',
      input: {
        id: created.id,
        operationId: randomUUID(),
        ops: [
          {
            type: 'sheet.batch',
            seed: 's',
            commands: [{ type: 'setCells', sheet: 'Hoja 1', start: 'C1', rows: [[1]], expect: { C1: null } }]
          }
        ]
      }
    } as unknown as DocumentOpsRequest;

    const routed = await write.documentOps!(request).catch((caught: unknown) => caught);
    expect(routed).toMatchObject({ code: 'writer_outdated' });
    const raw = await requestWriter(join(dataDir, WRITER_SOCKET_FILE), 'documentOps', { ...request }, 5_000).catch(
      (caught: unknown) => caught
    );
    expect(raw).toBeInstanceOf(WriterRemoteError);
    expect(raw).toMatchObject({ code: 'invalid_request' });
    // El escritor no llegó a su handler: lo rechazó al leer la petición.
    expect(socketOps.filter((op) => op === 'documentOps')).toHaveLength(1);
    const after = await writer.port.documentSource().port.docRead(created.id);
    expect(after.pending.length + after.segments.length).toBe(before.pending.length + before.segments.length);
  });

  it('un escritor que no conoce la op responde writer_outdated', async () => {
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
    const { write } = await documentPair();
    const outsider = {
      role: 'other_instance' as const,
      writerSocketPath: path,
      checkWriter: async () => undefined,
      status: async () => {
        throw new Error('no se usa');
      }
    };
    const routed = buildRoutedWriteContext(outsider, write);
    const error = await routed
      .documentOps!({
        opsVersion: DOCUMENT_OPS_VERSION,
        format: 'ods',
        privacy: OPEN,
        action: 'undo',
        input: { id: 'f1', operationId: 'op-2', undoOperationId: 'op-1' }
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'writer_outdated' });
    expect(ops).toEqual(['documentOps']);
  });

  it('un comando de hojas que no pasa el esquema llega por el socket y el escritor da batch_invalid sin escribir', async () => {
    const { dataDir, writer, client } = await documentPair();
    const created = await createBook(client);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const before = await writer.port.documentSource().port.docRead(created.id);

    for (const commands of [
      // Una función de red: el esquema de la herramienta la rechaza, el núcleo la escribiría.
      [{ type: 'setCells', sheet: 'Hoja 1', start: 'C1', rows: [['=WEBSERVICE("http://ejemplo.invalid")']], expect: { C1: null } }],
      // Un campo que el esquema estricto no admite.
      [{ type: 'setCells', sheet: 'Hoja 1', start: 'C1', rows: [[1]], expect: { C1: null }, otro: true }],
      // Un comando que no existe.
      [{ type: 'borrarTodo', sheet: 'Hoja 1' }]
    ]) {
      const reply = await requestWriter(path, 'documentOps', batchParams(created.id, commands), 10_000);
      expect(reply, JSON.stringify(commands)).toMatchObject({ ok: false, error: { code: 'batch_invalid' } });
    }
    // Un lote que no es un `sheet.batch` (dos operaciones, o sin semilla), igual.
    const twoBatches = batchParams(created.id, []);
    const input = twoBatches.input as { ops: unknown[] };
    input.ops = [input.ops[0], input.ops[0]];
    expect(await requestWriter(path, 'documentOps', twoBatches, 10_000)).toMatchObject({
      ok: false,
      error: { code: 'batch_invalid' }
    });
    const after = await writer.port.documentSource().port.docRead(created.id);
    expect(after.pending.length + after.segments.length).toBe(before.pending.length + before.segments.length);
    expect(after.head).toEqual(before.head);
  });
});

describe('forma y topes de documentOps en el escritor (H-177, parte 1)', () => {
  it('lo mal formado o pasado de topes es invalid_request, sin llegar al handler', async () => {
    const { dataDir, client, socketOps } = await documentPair();
    const created = await createBook(client);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const command = { type: 'setCells', sheet: 'Hoja 1', start: 'C1', rows: [[1]], expect: { C1: null } };
    const good = batchParams(created.id, [command]);
    const goodInput = good.input as Record<string, unknown>;
    const handled = socketOps.length;
    const create = {
      opsVersion: DOCUMENT_OPS_VERSION,
      format: 'ods',
      privacy: OPEN,
      action: 'create',
      operationId: randomUUID(),
      folderId: 'root',
      name: 'Otra.ods',
      dataBase64: Buffer.from('PK').toString('base64')
    };

    for (const bad of [
      { ...good, opsVersion: undefined },
      { ...good, format: 'docx' },
      { ...good, action: 'borrar' },
      { ...good, privacy: undefined },
      { ...good, input: { ...goodInput, ops: [] } },
      { ...good, input: { ...goodInput, ops: Array.from({ length: EDIT_OPS_MAX + 1 }, () => command) } },
      {
        ...good,
        input: {
          ...goodInput,
          ops: [{ type: 'sheet.batch', seed: 's', commands: [{ ...command, rows: [['x'.repeat(EDIT_OPS_MAX_BYTES * 2)]] }] }]
        }
      },
      { ...good, input: { ...goodInput, dryRun: 'si' } },
      { ...good, input: { ...goodInput, expectedRevision: '' } },
      { ...good, input: { ...goodInput, operationId: '' } },
      { ...good, input: { ...goodInput, id: '' } },
      { ...good, action: 'undo', input: { id: created.id, operationId: 'op-2' } },
      { ...create, name: '' },
      { ...create, folderId: undefined },
      { ...create, dataBase64: '***' }
    ]) {
      const error = await requestWriter(path, 'documentOps', bad, 10_000).catch((caught: unknown) => caught);
      expect(error, JSON.stringify(bad).slice(0, 200)).toBeInstanceOf(WriterRemoteError);
      expect(error).toMatchObject({ code: 'invalid_request' });
    }
    expect(socketOps.slice(handled)).toEqual([]);
  });

  it('los bytes de una creación de más de 5 MiB: file_too_large en el escritor y sin tocar el socket desde el lector', async () => {
    const { dataDir, write, writer } = await documentPair();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const bytes = new Uint8Array(ATTACHMENT_MAX_BYTES + 3);
    const before = (await writer.port.libraryOpen()).notesCount;
    const raw = await requestWriter(
      path,
      'documentOps',
      {
        opsVersion: DOCUMENT_OPS_VERSION,
        format: 'ods',
        privacy: OPEN,
        action: 'create',
        operationId: randomUUID(),
        folderId: 'root',
        name: 'Grande.ods',
        dataBase64: Buffer.from(bytes).toString('base64')
      },
      10_000
    ).catch((caught: unknown) => caught);
    expect(mapWriteError(raw).code).toBe('file_too_large');

    // Desde el lector no llega a enviarse.
    const otherPath = join(tempDataDir(), WRITER_SOCKET_FILE);
    const ops: string[] = [];
    const listener = createServer((socket) => {
      socket.once('data', (chunk) => {
        ops.push((JSON.parse(String(chunk)) as { op: string }).op);
        socket.end();
      });
    });
    servers.push(listener);
    await new Promise<void>((resolve) => listener.listen(otherPath, resolve));
    const outsider = {
      role: 'other_instance' as const,
      writerSocketPath: otherPath,
      checkWriter: async () => undefined,
      status: async () => {
        throw new Error('no se usa');
      }
    };
    const routed = buildRoutedWriteContext(outsider, write);
    const error = await routed
      .documentOps!({
        opsVersion: DOCUMENT_OPS_VERSION,
        format: 'ods',
        privacy: OPEN,
        action: 'create',
        operationId: randomUUID(),
        folderId: 'root',
        name: 'Grande.ods',
        bytes
      })
      .catch((caught: unknown) => caught);
    expect(mapWriteError(error).code).toBe('file_too_large');
    expect(ops).toEqual([]);
    expect((await writer.port.libraryOpen()).notesCount).toBe(before);
  });
});
