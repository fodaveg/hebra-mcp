/**
 * Carpetas a la papelera y de vuelta (D29, 28 nov 2026) por `writer.sock`: la op `organizeFolder`
 * valida su entrada, exige la privacidad del lector, da lo mismo por el lector que en el escritor,
 * y un escritor anterior que no la conoce no escribe (`writer_outdated`). El soporte común vive en
 * `forward-harness.ts`.
 */
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WRITER_SOCKET_FILE, WriterSocketServer, requestWriter } from '../../src/ipc/writer-socket';
import { buildRoutedWriteContext, writerSocketHandlers, type ForwardingInstance } from '../../src/server/forward';
import { buildWriteContext, type WriteContext } from '../../src/server/write-context';
import type { FolderTrashInput } from '../../src/store/folder-trash';
import { OPEN, servers, tempDataDir, useForwardHarness } from './forward-harness';

useForwardHarness();

function fakeInstance(path: string, role: 'this' | 'other_instance'): ForwardingInstance {
  return {
    role,
    writerSocketPath: path,
    checkWriter: vi.fn(async () => undefined),
    status: async () => ({
      lastSyncAt: null,
      lastSyncOutcome: null,
      pendingUpload: 0,
      errorsByCode: {},
      revoked: false,
      writer: role
    })
  };
}

/** Un `WriteContext` local que no escribe nada salvo lo que se le pase. */
function local(overrides: Partial<Parameters<typeof buildWriteContext>[0]> = {}): WriteContext {
  const never = async (): Promise<never> => {
    throw new Error('no debería llegar aquí');
  };
  return buildWriteContext({
    createNote: never,
    appendToNote: never,
    editNote: never,
    recordEditConflict: async () => undefined,
    organize: never,
    restoreVersion: never,
    fetchAttachment: async () => false,
    createFolder: never,
    renameFolder: never,
    addAttachment: never,
    organizeFile: never,
    noteRead: async () => null,
    folderDirty: async () => false,
    blobUploaded: async () => null,
    looseFileDirty: async () => null,
    onConflictCopy: () => () => undefined,
    isLinked: () => false,
    requestRound: async () => null,
    ...overrides
  });
}

describe('organizeFolder por writer.sock (D29)', () => {
  it('un escritor anterior no la conoce: writer_outdated, sin escribir ni tomar el relevo', async () => {
    const path = join(tempDataDir(), WRITER_SOCKET_FILE);
    const ops: string[] = [];
    const old = createServer((socket) => {
      socket.once('data', (chunk) => {
        ops.push((JSON.parse(String(chunk)) as { op: string }).op);
        socket.end(`${JSON.stringify({ id: null, ok: false, error: 'invalid_request' })}\n`);
      });
    });
    servers.push(old);
    await new Promise<void>((resolve) => old.listen(path, resolve));
    let written = 0;
    const instance = fakeInstance(path, 'other_instance');
    const write = buildRoutedWriteContext(
      instance,
      local({
        organizeFolder: async () => {
          written += 1;
          throw new Error('el lector no escribe aquí');
        }
      })
    );
    for (const action of ['trashFolder', 'restoreFolder'] as const) {
      await expect(write.organizeFolder!({ action, id: 'c1', privacy: OPEN })).rejects.toMatchObject({
        code: 'writer_outdated'
      });
    }
    expect(ops).toEqual(['organizeFolder', 'organizeFolder']);
    expect(written).toBe(0);
    expect(instance.checkWriter).not.toHaveBeenCalled();
  });

  it('valida la entrada y exige la privacidad; por el lector da lo mismo que en el escritor', async () => {
    const path = join(tempDataDir(), WRITER_SOCKET_FILE);
    const seen: FolderTrashInput[] = [];
    const server = await WriterSocketServer.listen({
      path,
      handlers: {
        ...writerSocketHandlers(local(), fakeInstance(path, 'this')),
        organizeFolder: async (input) => {
          seen.push(input);
          return { id: input.id, changed: input.action === 'trashFolder', sync: 'not_linked' };
        }
      }
    });
    servers.push(server);
    const invalid = { code: 'invalid_request' };
    for (const params of [
      // Sin privacidad, sin id, o una acción que no existe (purgar no está).
      { action: 'trashFolder', id: 'c1' },
      { action: 'trashFolder', privacy: OPEN },
      { action: 'purgeFolder', id: 'c1', privacy: OPEN },
      { action: 'moveFolder', id: 'c1', privacy: OPEN },
      { id: 'c1', privacy: OPEN }
    ]) {
      await expect(requestWriter(path, 'organizeFolder', params, 2_000), JSON.stringify(params)).rejects.toMatchObject(
        invalid
      );
    }
    expect(seen).toEqual([]);

    // El lector la reenvía solo si su contexto local la tiene (como el escritor que tomaría el
    // relevo); aquí no se llega a escribir en local.
    const write = buildRoutedWriteContext(
      fakeInstance(path, 'other_instance'),
      local({
        organizeFolder: async () => {
          throw new Error('el lector no escribe aquí');
        }
      })
    );
    const privacy = { privateFolders: [['diario']], privateTags: ['secreto'] };
    expect(await write.organizeFolder!({ action: 'trashFolder', id: 'c1', privacy })).toEqual({
      id: 'c1',
      changed: true,
      sync: 'not_linked'
    });
    expect(await write.organizeFolder!({ action: 'restoreFolder', id: 'c2', privacy })).toEqual({
      id: 'c2',
      changed: false,
      sync: 'not_linked'
    });
    // La privacidad que aplica el escritor es la de ESTE lector.
    expect(seen).toEqual([
      { action: 'trashFolder', id: 'c1', privacy },
      { action: 'restoreFolder', id: 'c2', privacy }
    ]);
  });
});
