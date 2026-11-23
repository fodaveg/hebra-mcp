/**
 * H-MCP-ERROR-LECTOR (22 nov 2026): los rechazos de un lote de hojas llegan al LLM con su código
 * y sus campos, desde un lector y desde el escritor.
 *
 * Lo que fallaba: `hebra_edit_sheet` respondía `{"error":"not_found"}` a cualquier lote que el
 * escritor rechazaba en el cálculo (`batch_invalid` sin `expectedLayout`, `precondition_failed`
 * con una disposición vieja…), aunque el escritor contestara bien por `writer.sock`. El reenvío no
 * perdía nada: lo cambiaba la puerta final. La fase 1 del lote (`runDocumentOps`) apunta el
 * `operationId` en `hebra_mcp_operations` antes de calcular, así que la propia llamada cambia la
 * época de privacidad (`data_version` en el lector, `total_changes()` en el escritor); la política
 * `WRITE` de la herramienta trataba ese error como ligado a un objeto que no se puede confirmar y
 * lo cambiaba por `not_found`. Pasaba igual por el escritor (lo mide el primer test).
 * `hebra_create_sheet` lo sufría con una escritura ajena a mitad de llamada.
 *
 * Lo que no cambia: si el documento deja de verse (aquí, se mueve a una carpeta privada mientras
 * el escritor responde), el rechazo sigue saliendo como `not_found`.
 *
 * Roturas vistas en rojo (y repuestas): quitar la política de documentos de `hebra_edit_sheet` y
 * `hebra_create_sheet` en `register-tools.ts` (rojo en los dos de editar y en el de crear: `not_found`) y aceptar
 * el error sin mirar lo declarado (rojo en el de la carpeta privada).
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CapacityGate } from '../../src/accounts/capacity';
import { realClock } from '../../src/accounts/lifecycle';
import { requestWriter, WRITER_SOCKET_FILE } from '../../src/ipc/writer-socket';
import type { PrivacyConfig } from '../../src/privacy/config';
import type { ServerContext } from '../../src/server/context';
import { buildRoutedWriteContext, RoutedStatusSource, writerSocketHandlers } from '../../src/server/forward';
import { localWriteContext } from '../../src/server/serve';
import { DOCUMENT_OPS_VERSION } from '../../src/store/document-types';
import { LibraryInstance } from '../../src/sync/library-instance';
import { IDENTITY, InMemoryLibraryRelay, VAULT_KEY } from '../sync/devices';
import { call, connect, instances, livePid, OPEN, tempDataDir, useForwardHarness } from './forward-harness';

useForwardHarness();

const gate = () =>
  new CapacityGate({
    readMemory: () => ({ usedBytes: 0, limitBytes: 512 * 1024 * 1024 }),
    highWater: { ratio: 0.8 },
    waitMs: 5_000,
    clock: realClock,
    reclaim: async () => undefined
  });

/**
 * Escritor y lector sobre la misma carpeta, cada uno con su cliente MCP: el del lector reenvía
 * crear y editar por `writer.sock`; el del escritor los corre en su proceso. `readerPort` deja
 * cambiar el puerto del lector (para simular una escritura ajena durante la llamada).
 */
async function documentPair(
  options: { readerPrivacy?: PrivacyConfig; readerPort?: (port: LibraryInstance['port']) => LibraryInstance['port'] } = {}
) {
  const dataDir = tempDataDir();
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
    writerSocket: (opened) => writerSocketHandlers(localWriteContext(opened), opened)
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
  expect(reader.role).toBe('other_instance');
  const write = buildRoutedWriteContext(reader, localWriteContext(reader));
  const readerClient = await connect({
    port: options.readerPort ? options.readerPort(reader.port) : reader.port,
    privacyConfig: options.readerPrivacy ?? OPEN,
    status: new RoutedStatusSource(reader, true),
    documentCapacity: { gate: gate(), key: 'lector' },
    write
  } satisfies ServerContext);
  const writerClient = await connect({
    port: writer.port,
    privacyConfig: OPEN,
    status: new RoutedStatusSource(writer, true),
    documentCapacity: { gate: gate(), key: 'escritor' },
    write: localWriteContext(writer)
  } satisfies ServerContext);
  return { dataDir, write, readerClient, writerClient };
}

type Client = Awaited<ReturnType<typeof documentPair>>['readerClient'];

/** Crea `Cuentas.ods` con `Total | 42` en A1:B1. */
async function createBook(client: Client) {
  // La raíz no admite hojas (H-MCP-SIN-RAIZ): van a una carpeta, que se crea si falta.
  const folder = await call(client, 'hebra_create_folder', { name: 'Hojas' });
  expect(folder.isError, JSON.stringify(folder.value)).toBe(false);
  const created = await call(client, 'hebra_create_sheet', {
    name: 'Cuentas.ods',
    folder: 'Hojas',
    ops: [{ type: 'setCells', sheet: 'Hoja 1', start: 'A1', rows: [['Total', 42]] }],
    operationId: randomUUID()
  });
  expect(created.isError, JSON.stringify(created.value)).toBe(false);
  return created.value as { id: string; revision: string; layoutRevision: string };
}

const EXPECTING = { type: 'setCells', sheet: 'Hoja 1', start: 'B1', rows: [[43]], expect: { B1: 42 } };

describe('hebra_edit_sheet: el rechazo del escritor sale con su código y sus campos (H-MCP-ERROR-LECTOR)', () => {
  it('un lote con expect y sin expectedLayout: batch_invalid con path, opIndex y motivo, igual por el lector y por el escritor', async () => {
    const { dataDir, readerClient, writerClient } = await documentPair();
    const created = await createBook(readerClient);

    // Lo que contesta el escritor por el socket, sin herramienta de por medio.
    const raw = (await requestWriter(
      join(dataDir, WRITER_SOCKET_FILE),
      'documentOps',
      {
        opsVersion: DOCUMENT_OPS_VERSION,
        format: 'ods',
        privacy: OPEN,
        action: 'edit',
        input: { id: created.id, operationId: randomUUID(), ops: [{ type: 'sheet.batch', seed: 's', commands: [EXPECTING] }] }
      },
      10_000
    )) as { ok: false; error: { code: string; issues: unknown[] } };
    expect(raw).toMatchObject({ ok: false, error: { code: 'batch_invalid' } });
    const expected = { error: 'batch_invalid', issues: raw.error.issues };
    expect(raw.error.issues).toEqual([
      { opIndex: 0, path: 'expectedLayout', reason: expect.stringContaining('expectedLayout') }
    ]);

    for (const [side, client] of [
      ['lector', readerClient],
      ['escritor', writerClient]
    ] as const) {
      const edited = await call(client, 'hebra_edit_sheet', { id: created.id, ops: [EXPECTING], operationId: randomUUID() });
      expect(edited.isError, side).toBe(true);
      expect(edited.value, side).toEqual(expected);
    }
  });

  it('una disposición vieja: precondition_failed con opIndex y target, igual por el lector y por el escritor', async () => {
    const { readerClient, writerClient } = await documentPair();
    const created = await createBook(readerClient);
    for (const [side, client] of [
      ['lector', readerClient],
      ['escritor', writerClient]
    ] as const) {
      const edited = await call(client, 'hebra_edit_sheet', {
        id: created.id,
        ops: [EXPECTING],
        expectedLayout: 'una-disposicion-vieja',
        operationId: randomUUID()
      });
      expect(edited.isError, side).toBe(true);
      expect(edited.value, side).toEqual({ error: 'precondition_failed', opIndex: 0, target: 'expectedLayout' });
    }
  });

  it('si el documento pasa a una carpeta privada mientras el escritor responde, el rechazo sigue siendo not_found', async () => {
    const { readerClient, writerClient, write } = await documentPair({
      readerPrivacy: { privateFolders: [['privada']], privateTags: [] }
    });
    // La carpeta privada tiene que existir para que la configuración del lector resuelva.
    const folder = await call(writerClient, 'hebra_create_folder', { name: 'privada' });
    expect(folder.isError, JSON.stringify(folder.value)).toBe(false);
    const created = await createBook(writerClient);
    const original = write.documentOps!.bind(write);
    let rejected: unknown;
    const spy = vi.spyOn(write, 'documentOps').mockImplementationOnce(async (request) => {
      const outcome = await original(request);
      rejected = outcome;
      const moved = await call(writerClient, 'hebra_move_file', {
        id: created.id,
        folder: 'privada',
        operationId: randomUUID()
      });
      expect(moved.isError, JSON.stringify(moved.value)).toBe(false);
      return outcome;
    });
    try {
      const edited = await call(readerClient, 'hebra_edit_sheet', { id: created.id, ops: [EXPECTING], operationId: randomUUID() });
      expect(rejected, 'el rechazo viene del escritor real').toMatchObject({ ok: false, error: { code: 'batch_invalid' } });
      expect(edited.value).toEqual({ error: 'not_found' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('hebra_create_sheet: el rechazo del lote sale con su código aunque otro escriba durante la llamada (H-MCP-ERROR-LECTOR)', () => {
  it('un comando sobre una hoja que no existe: batch_invalid con sus campos, no not_found', async () => {
    // La época que toma la llamada al empezar ya no es la de la puerta: lo que deja en el
    // lector una escritura del escritor (una ronda de sync, otra llamada) a mitad de llamada.
    const { readerClient } = await documentPair({
      readerPort: (port) =>
        new Proxy(port, {
          get(target, prop) {
            if (prop === 'privacyEpoch') return async () => 'la-epoca-de-antes-de-otra-escritura';
            const value = Reflect.get(target, prop, target) as unknown;
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          }
        })
    });
    const folder = await call(readerClient, 'hebra_create_folder', { name: 'Hojas' });
    expect(folder.isError, JSON.stringify(folder.value)).toBe(false);
    const created = await call(readerClient, 'hebra_create_sheet', {
      name: 'Otra.ods',
      folder: 'Hojas',
      ops: [{ type: 'setCells', sheet: 'No existe', start: 'A1', rows: [[1]] }],
      operationId: randomUUID()
    });
    expect(created.isError).toBe(true);
    expect(created.value).toMatchObject({
      error: 'batch_invalid',
      issues: [{ opIndex: 0, path: expect.stringMatching(/^ops\.0/), reason: expect.any(String) }]
    });
  });
});
