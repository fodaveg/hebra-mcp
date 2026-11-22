/**
 * Hojas con el escritor VINCULADO al sync (relé en memoria): lo que sin sync no se ve, porque sin
 * cableado de documentos no hay punto de control ni limpieza de blobs tras el lote.
 *
 * H-BLOQUEO-SYNC: con sync, `hebra_edit_sheet` no volvía nunca. Tras el lote,
 * `checkpointThenClean` abría un turno de escritura y, dentro, la limpieza leía por la cola del
 * puerto que ese turno ya ocupaba. Sin sync la misma edición tarda unos milisegundos; con el fallo,
 * el turno no salía en 68 s. Aquí se pide que vuelva antes de `EDIT_DEADLINE_MS`.
 *
 * Prueba negativa hecha al escribirlo: con `document-blob-cleanup.ts` de antes del arreglo, la
 * edición no vuelve en el plazo (rojo «colgado»).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { writerSocketHandlers } from '../../src/server/forward';
import { localWriteContext } from '../../src/server/serve';
import { buildSheetFile } from '../../src/server/tools/create-sheet';
import type { WriteContext } from '../../src/server/write-context';
import { DOCUMENT_OPS_VERSION } from '../../src/store/document-types';
import { LibraryInstance } from '../../src/sync/library-instance';
import { IDENTITY, InMemoryLibraryRelay, VAULT_KEY } from '../sync/devices';
import { instances, OPEN, tempDataDir, useForwardHarness } from './forward-harness';

useForwardHarness();

/** Sin sync tarda unos milisegundos; el fallo era no volver nunca. */
const EDIT_DEADLINE_MS = 5_000;

/** Un escritor vinculado al relé en memoria, con su contexto de escritura local. */
async function linkedWriter(): Promise<{ writer: LibraryInstance; write: WriteContext }> {
  const relay = new InMemoryLibraryRelay();
  const writer = await LibraryInstance.open({
    dataDir: tempDataDir(),
    sync: { transport: relay, blobTransport: null, identity: IDENTITY, vaultKey: VAULT_KEY, intervalMs: null },
    checkIntervalMs: null,
    lock: { releaseOnExit: false },
    writerSocket: (opened) => writerSocketHandlers(localWriteContext(opened), opened)
  });
  instances.push(writer);
  await writer.whenReady(5_000);
  expect(writer.syncRunner).not.toBeNull();
  return { writer, write: localWriteContext(writer) };
}

/** Crea `C.ods` con `Total | 42` en A1:B1 y devuelve su id. */
async function createBook(write: WriteContext): Promise<string> {
  const built = await buildSheetFile(
    [{ type: 'setCells', sheet: 'Hoja 1', start: 'A1', rows: [['Total', 42]] }],
    AbortSignal.timeout(10_000)
  );
  if ('code' in built) throw new Error(`no se pudo crear el libro: ${built.code}`);
  const created = await write.documentOps!({
    opsVersion: DOCUMENT_OPS_VERSION,
    format: 'ods',
    privacy: OPEN,
    action: 'create',
    operationId: randomUUID(),
    folderId: 'root',
    name: 'C.ods',
    bytes: built.bytes
  });
  expect(created).toMatchObject({ ok: true, created: { outcome: 'saved' } });
  return (created as { created: { id: string } }).created.id;
}

/** Un lote de hojas sobre `id`: `B1 = value`, con la guarda de lo que había. */
function editCell(write: WriteContext, id: string, previous: number, value: number) {
  return write.documentOps!({
    opsVersion: DOCUMENT_OPS_VERSION,
    format: 'ods',
    privacy: OPEN,
    action: 'edit',
    input: {
      id,
      operationId: randomUUID(),
      ops: [
        {
          type: 'sheet.batch',
          seed: randomUUID(),
          commands: [{ type: 'setCells', sheet: 'Hoja 1', start: 'B1', rows: [[value]], expect: { B1: previous } }]
        }
      ] as never
    }
  });
}

/** `promise`, o `'colgado'` si no se resuelve en `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'colgado'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<'colgado'>((resolve) => (timer = setTimeout(() => resolve('colgado'), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

describe('hojas con el escritor vinculado al sync (H-BLOQUEO-SYNC)', () => {
  it('editar una hoja vuelve en el plazo: la limpieza de blobs no se espera a sí misma', async () => {
    const { write } = await linkedWriter();
    const id = await createBook(write);
    const edited = await within(editCell(write, id, 42, 43), EDIT_DEADLINE_MS);
    expect(edited).not.toBe('colgado');
    expect(edited).toMatchObject({ ok: true, out: { id, outcome: 'saved' } });
  });
});
