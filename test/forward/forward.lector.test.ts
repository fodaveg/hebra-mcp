/**
 * Lector: qué hace cuando el escritor no responde. El soporte común vive en
 * `forward-harness.ts`.
 */
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WRITER_SOCKET_FILE,
  WriterRemoteError,
  WriterSocketServer,
  WriterUnavailableError,
  requestWriter,
} from "../../src/ipc/writer-socket";
import {
  buildRoutedWriteContext,
  RoutedStatusSource,
  writerSocketHandlers,
  type ForwardingInstance,
} from "../../src/server/forward";
import {
  buildWriteContext,
  type WriteContext,
} from "../../src/server/write-context";
import { isBusyOtherInstance, writeRejected } from "../../src/store/errors";
import { mapWriteError } from "../../src/server/tools/write-errors";
import { RELINKED_NOTES_MAX } from "../../src/store/file-content";
import {
  OPEN,
  servers,
  stderrText,
  tempDataDir,
  useForwardHarness,
} from "./forward-harness";

useForwardHarness();

describe('lector: qué hace cuando el escritor no responde', () => {
  function fakeInstance(path: string, afterCheck: 'this' | 'other_instance') {
    let role: 'this' | 'other_instance' = 'other_instance';
    const instance: ForwardingInstance = {
      get role() {
        return role;
      },
      writerSocketPath: path,
      checkWriter: vi.fn(async () => {
        role = afterCheck;
      }),
      status: async () => ({
        lastSyncAt: null,
        lastSyncOutcome: null,
        pendingUpload: 0,
        errorsByCode: {},
        revoked: false,
        writer: role
      })
    };
    return instance;
  }

  /** `WriteContext` local de mentira que cuenta cuántas notas «creó». */
  function localSpy(
    overrides: Partial<Parameters<typeof buildWriteContext>[0]> = {}
  ): WriteContext & { readonly created: number } {
    const counter = { created: 0 };
    const write = buildWriteContext({
      createNote: async () => {
        counter.created += 1;
        return { id: 'local', title: 'local', folderId: 'root' };
      },
      appendToNote: async (input) => ({ id: input.id, outcome: 'saved' as const }),
      editNote: async (input) => ({
        result: { id: input.id, outcome: 'saved' as const, revision: 'r1.x' },
        wrote: true
      }),
      recordEditConflict: async () => undefined,
      organize: async (input) => ({
        result: { id: input.id, folderId: 'root', favorite: false, archived: false, trashed: false },
        wrote: true
      }),
      restoreVersion: async (input) => ({
        result: { id: input.id, outcome: 'saved' as const, revision: 'r1.x' },
        wrote: true
      }),
      fetchAttachment: async () => false,
      createFolder: async (input) => ({ result: { id: input.parentId, changed: true }, wrote: true }),
      renameFolder: async (input) => ({ result: { id: input.id, changed: true }, wrote: true }),
      addAttachment: async (input) => ({
        result: {
          note: { id: input.id, outcome: 'saved' as const, revision: 'r1.x' },
          attachmentId: 'a'.repeat(64),
          markdown: ''
        },
        wrote: true
      }),
      organizeFile: async (input) => ({
        result: { id: input.id, folderId: 'root', trashed: input.action === 'trashFile' },
        wrote: true
      }),
      noteRead: async () => null,
      folderDirty: async () => null,
      blobUploaded: async () => null,
      looseFileDirty: async () => null,
      onConflictCopy: () => () => undefined,
      isLinked: () => false,
      requestRound: async () => null,
      ...overrides
    });
    // `defineProperty`, no `Object.assign`: este copiaría el valor del getter una vez.
    return Object.defineProperty(write, 'created', { get: () => counter.created }) as WriteContext & {
      readonly created: number;
    };
  }

  it('escritor vivo pero mudo (timeout) y bloqueo ajeno: busy_other_instance', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const silent = createServer((socket) => socket.resume());
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(path, resolve));
    const instance = fakeInstance(path, 'other_instance');
    const local = localSpy();
    const write = buildRoutedWriteContext(instance, local, { timeoutMs: { createNote: 200 } });
    const error = await write.createNote({ body: '# x', privacy: OPEN }).catch((caught: unknown) => caught);
    expect(isBusyOtherInstance(error)).toBe(true);
    expect(instance.checkWriter).toHaveBeenCalledOnce();
    expect(local.created).toBe(0);
    expect(stderrText()).toContain('"outcome":"busy","reason":"timeout"');
  });

  it('conexión cortada tras enviar: toma el relevo pero NO repite la escritura', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const dying = createServer((socket) => socket.once('data', () => socket.destroy()));
    servers.push(dying);
    await new Promise<void>((resolve) => dying.listen(path, resolve));
    const instance = fakeInstance(path, 'this');
    const local = localSpy();
    const write = buildRoutedWriteContext(instance, local);
    const error = await write.createNote({ body: '# x', privacy: OPEN }).catch((caught: unknown) => caught);
    expect(isBusyOtherInstance(error)).toBe(true);
    expect(instance.role).toBe('this');
    expect(local.created).toBe(0);
    // La siguiente ya es local.
    expect(await write.createNote({ body: '# x', privacy: OPEN })).toMatchObject({ id: 'local' });
    expect(local.created).toBe(1);
  });

  it('escritor recién muerto aún sin recoger (zombi): segundo intento de relevo a los 100 ms (B2)', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    // Fichero sin nadie escuchando, como el socket de un escritor muerto por SIGKILL.
    writeFileSync(path, '');
    let checks = 0;
    let role: 'this' | 'other_instance' = 'other_instance';
    const instance: ForwardingInstance = {
      get role() {
        return role;
      },
      writerSocketPath: path,
      // El primero aún lo ve vivo (zombi); el segundo, ya recogido, toma el bloqueo.
      checkWriter: vi.fn(async () => {
        checks += 1;
        if (checks === 2) role = 'this';
      }),
      status: async () => ({
        lastSyncAt: null,
        lastSyncOutcome: null,
        pendingUpload: 0,
        errorsByCode: {},
        revoked: false,
        writer: role
      })
    };
    const local = localSpy();
    const write = buildRoutedWriteContext(instance, local);
    const started = Date.now();
    expect(await write.createNote({ body: '# x', privacy: OPEN })).toMatchObject({ id: 'local' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(instance.checkWriter).toHaveBeenCalledTimes(2);
    expect(local.created).toBe(1);
    expect(stderrText()).toContain('"outcome":"takeover","reason":"refused"');
  });

  it('escritor de una versión anterior que ignora el operationId de un append: lo registra y devuelve su respuesta', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const received: Array<Record<string, unknown>> = [];
    // Un escritor anterior: guarda y responde sin `operationId` (no lo conoce).
    const server = await WriterSocketServer.listen({
      path,
      handlers: {
        ...writerSocketHandlers(localSpy(), fakeInstance(path, 'this')),
        appendToNote: async (input) => {
          received.push({ ...input });
          return { id: input.id, outcome: 'saved', revision: 'r1.x', totalChars: 9 };
        }
      }
    });
    servers.push(server);
    const write = buildRoutedWriteContext(fakeInstance(path, 'other_instance'), localSpy());
    const text = 'CEBO-escritor-viejo-4e1a';
    const result = await write.appendToNote({ id: 'n1', text, operationId: 'op-viejo', privacy: OPEN });
    // El texto se guardó: la respuesta es la del escritor, sin error y sin `replayed`.
    expect(result).toEqual({ id: 'n1', outcome: 'saved', revision: 'r1.x', totalChars: 9 });
    expect(received).toHaveLength(1);
    expect(stderrText()).toContain('"event":"forward.operation_id_ignored","op":"appendToNote"');
    expect(stderrText()).not.toContain(text);
    expect(stderrText()).not.toContain('"n1"');

    // Sin `operationId` no hay nada que avisar.
    await write.appendToNote({ id: 'n1', text, privacy: OPEN });
    expect(stderrText().split('forward.operation_id_ignored').length - 1).toBe(1);
  });

  it('el escritor actual devuelve el operationId del append', async () => {
    const handlers = writerSocketHandlers(localSpy(), fakeInstance('', 'this'));
    expect(
      await handlers.appendToNote({ id: 'n1', text: 'x', operationId: 'op-eco', privacy: OPEN })
    ).toMatchObject({ id: 'n1', outcome: 'saved', operationId: 'op-eco' });
    expect(await handlers.appendToNote({ id: 'n1', text: 'x', privacy: OPEN })).not.toHaveProperty(
      'operationId'
    );
  });

  it('escritor de una versión anterior que no conoce la op de adjunto con apartado: error claro, sin escribir ni tomar el relevo', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const ops: string[] = [];
    // Un escritor anterior: su `parseEnvelope` rechaza la op desconocida ANTES de escribir.
    const old = createServer((socket) => {
      socket.once('data', (chunk) => {
        ops.push((JSON.parse(String(chunk)) as { op: string }).op);
        socket.end(`${JSON.stringify({ id: null, ok: false, error: 'invalid_request' })}\n`);
      });
    });
    servers.push(old);
    await new Promise<void>((resolve) => old.listen(path, resolve));
    let written = 0;
    const local = localSpy({
      addAttachment: async (input) => {
        written += 1;
        return {
          result: {
            note: { id: input.id, outcome: 'saved' as const, revision: 'r1.x' },
            attachmentId: 'a'.repeat(64),
            markdown: ''
          },
          wrote: true
        };
      }
    });
    const instance = fakeInstance(path, 'other_instance');
    const write = buildRoutedWriteContext(instance, local);
    const input = {
      id: 'n1',
      name: 'x.txt',
      bytes: new TextEncoder().encode('hola'),
      mimeType: 'text/plain',
      operationId: 'op-viejo-att',
      privacy: OPEN
    };
    const error = await write
      .addAttachment({ ...input, heading: 'Uno', headingOccurrence: 2 })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'writer_outdated' });
    expect(ops).toEqual(['addAttachmentInSection']);
    expect(written).toBe(0);
    expect(instance.checkWriter).not.toHaveBeenCalled();
    expect(stderrText()).not.toContain('"n1"');
  });

  it('D23: un escritor anterior no renombra sin arreglar las notas ni ignora expectedRevision: writer_outdated, sin escribir', async () => {
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
    let written = 0;
    const count = async (): Promise<never> => {
      written += 1;
      throw new Error('no debería escribir aquí');
    };
    const instance = fakeInstance(path, 'other_instance');
    const write = buildRoutedWriteContext(instance, localSpy({ looseFileWrite: count, noteState: count }));
    const outdated = { code: 'writer_outdated' };
    await expect(
      write.looseFileWrite!({ action: 'renameFile', id: 'f1', name: 'x.base', operationId: 'op-old', privacy: OPEN })
    ).rejects.toMatchObject(outdated);
    await expect(
      write.noteState!({ action: 'moveNote', id: 'n1', folderId: 'root', expectedRevision: 'r1.x', privacy: OPEN })
    ).rejects.toMatchObject(outdated);
    await expect(
      write.noteState!({ action: 'setHidden', id: 'n1', hidden: true, privacy: OPEN })
    ).rejects.toMatchObject(outdated);
    expect(ops).toEqual(['renameFileRelinking', 'noteState', 'noteState']);
    expect(written).toBe(0);
    expect(instance.checkWriter).not.toHaveBeenCalled();
  });

  it('D23: las ops del socket validan su entrada, exigen privacidad y dan lo mismo por el lector', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const privacy = OPEN;
    const saved = {
      folderId: 'root',
      favorite: false,
      archived: false,
      trashed: false,
      hidden: true,
      isConflictCopy: false,
      changed: true
    };
    const seen: unknown[] = [];
    let relinkedFromWriter: unknown = ['n1', 'n2'];
    const server = await WriterSocketServer.listen({
      path,
      handlers: {
        ...writerSocketHandlers(localSpy(), fakeInstance(path, 'this')),
        noteState: async (input) => {
          seen.push(input);
          return { id: input.id, ...saved, sync: 'not_linked' };
        },
        looseFileWrite: async (input) => {
          if (input.action === 'renameFile' && input.name === 'muchas.base') throw writeRejected('too_many_linked_notes');
          seen.push(input.action);
          return {
            id: 'action' in input && input.action === 'renameFile' ? input.id : 'x',
            name: 'x.base',
            folderId: 'root',
            sha256: 'a'.repeat(64),
            byteLength: null,
            mimeType: null,
            outcome: 'saved',
            relinkedNotes: relinkedFromWriter as string[],
            sync: 'not_linked'
          };
        }
      }
    });
    servers.push(server);
    const invalid = { code: 'invalid_request' };
    for (const params of [
      // Sin privacidad, sin revisión, una de más, o una acción que no existe.
      { action: 'setHidden', id: 'n1', hidden: true },
      { action: 'setHidden', id: 'n1', hidden: 'si', privacy },
      { action: 'moveNote', id: 'n1', folderId: 'root', privacy },
      { action: 'trashNote', id: 'n1', privacy },
      { action: 'restoreNote', id: 'n1', expectedRevision: 'x'.repeat(2_000), privacy },
      { action: 'purgeNote', id: 'n1', privacy },
      { action: 'setFavorite', id: 'n1', favorite: true, privacy },
      { action: 'clearConflict', privacy }
    ]) {
      await expect(requestWriter(path, 'noteState', params, 2_000), JSON.stringify(params)).rejects.toMatchObject(invalid);
    }
    // `renameFileRelinking` solo renombra: ni crear, ni mover, ni duplicar por ella.
    await expect(
      requestWriter(path, 'renameFileRelinking', { action: 'moveFile', id: 'f1', folderId: 'root', operationId: 'op', privacy }, 2_000)
    ).rejects.toMatchObject(invalid);
    // `organize` sigue sin saber de ellas: un `expectedRevision` allí se ignoraba, por eso no van.
    await expect(
      requestWriter(path, 'organize', { action: 'setHidden', id: 'n1', hidden: true, privacy }, 2_000)
    ).rejects.toMatchObject(invalid);
    expect(seen).toEqual([]);

    const never = async (): Promise<never> => {
      throw new Error('el lector no escribe aquí: lo hace el escritor');
    };
    const write = buildRoutedWriteContext(
      fakeInstance(path, 'other_instance'),
      localSpy({ looseFileWrite: never, noteState: never })
    );
    expect(
      await write.noteState!({ action: 'moveNote', id: 'n1', folderId: 'root', expectedRevision: 'r1.x', privacy })
    ).toMatchObject({ id: 'n1', hidden: true, changed: true });
    expect(seen[0]).toMatchObject({ action: 'moveNote', expectedRevision: 'r1.x', privacy });
    const renamed = await write.looseFileWrite!({ action: 'renameFile', id: 'f1', name: 'x.base', operationId: 'op-r', privacy });
    expect(renamed).toMatchObject({ id: 'f1', relinkedNotes: ['n1', 'n2'] });
    expect(stderrText()).toContain('"op":"renameFileRelinking","outcome":"forwarded"');
    // El rechazo por el tope cruza el socket con su código, sin parecer un escritor anterior.
    const tooMany = await write
      .looseFileWrite!({ action: 'renameFile', id: 'f1', name: 'muchas.base', operationId: 'op-tope', privacy })
      .catch((error: unknown) => error);
    expect(mapWriteError(tooMany).code).toBe('too_many_linked_notes');
    // Los ids del escritor se validan y se acotan: otra forma o de más, `writer_protocol`.
    for (const bad of ['n1', [1], [''], ['x'.repeat(201)], Array.from({ length: RELINKED_NOTES_MAX + 1 }, () => 'n')]) {
      relinkedFromWriter = bad;
      const rejected = await write
        .looseFileWrite!({ action: 'renameFile', id: 'f1', name: 'x.base', operationId: 'op-mala', privacy })
        .catch((error: unknown) => error);
      expect(rejected, JSON.stringify(bad).slice(0, 40)).toMatchObject({ message: 'writer_protocol' });
    }
  });

  it('adjunto sin heading sigue por addAttachment; con heading, por addAttachmentInSection', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const seen: Array<{ heading?: string; headingOccurrence?: number }> = [];
    const server = await WriterSocketServer.listen({
      path,
      handlers: {
        ...writerSocketHandlers(localSpy(), fakeInstance(path, 'this')),
        addAttachment: async (input) => {
          seen.push({ heading: input.heading, headingOccurrence: input.headingOccurrence });
          return {
            id: input.id,
            outcome: 'saved',
            revision: 'r1.x',
            attachmentId: 'a'.repeat(64),
            markdown: '![[sha256:a|x]]',
            ...(input.heading !== undefined
              ? { placed: { line: 3, heading: input.heading } }
              : {}),
            sync: 'not_linked'
          };
        }
      }
    });
    servers.push(server);
    const write = buildRoutedWriteContext(fakeInstance(path, 'other_instance'), localSpy());
    const input = {
      id: 'n1',
      name: 'x.txt',
      bytes: new TextEncoder().encode('hola'),
      mimeType: 'text/plain',
      operationId: 'op-att-ruta',
      privacy: OPEN
    };
    expect(await write.addAttachment(input)).not.toHaveProperty('placed');
    expect(await write.addAttachment({ ...input, heading: 'Uno', headingOccurrence: 2 })).toMatchObject({
      placed: { line: 3, heading: 'Uno' }
    });
    expect(seen).toEqual([
      { heading: undefined, headingOccurrence: undefined },
      { heading: 'Uno', headingOccurrence: 2 }
    ]);
  });

  it('placed solo sale en un guardado nuevo: ni con replayed ni con copia de conflicto', async () => {
    const placed = { line: 3, heading: 'Uno' };
    const input = {
      id: 'n1',
      name: 'x.txt',
      bytes: new TextEncoder().encode('hola'),
      mimeType: 'text/plain',
      operationId: 'op-placed',
      heading: 'Uno',
      privacy: OPEN
    };
    const stub = (note: Record<string, unknown>) =>
      localSpy({
        addAttachment: async () => ({
          result: { note: { id: 'n1', ...note } as never, attachmentId: 'a'.repeat(64), markdown: '', placed },
          wrote: false
        })
      });
    expect(await stub({ outcome: 'saved', revision: 'r1.x' }).addAttachment(input)).toMatchObject({ placed });
    expect(
      await stub({ outcome: 'saved', revision: 'r1.x', replayed: true }).addAttachment(input)
    ).not.toHaveProperty('placed');
    expect(
      await stub({ outcome: 'conflict_copy', copyId: 'c1' }).addAttachment(input)
    ).not.toHaveProperty('placed');
  });

  it('sin escritor: toma el relevo y escribe en local', async () => {
    const dataDir = tempDataDir();
    const instance = fakeInstance(join(dataDir, WRITER_SOCKET_FILE), 'this');
    const local = localSpy();
    const write = buildRoutedWriteContext(instance, local);
    expect(await write.createNote({ body: '# x', privacy: OPEN })).toMatchObject({ id: 'local' });
    expect(local.created).toBe(1);
    expect(stderrText()).toContain('"outcome":"takeover","reason":"no_socket"');
  });

  it('hebra_status sin escritor que responda: intenta el relevo y da el estado local', async () => {
    const dataDir = tempDataDir();
    const instance = fakeInstance(join(dataDir, WRITER_SOCKET_FILE), 'other_instance');
    const status = await new RoutedStatusSource(instance, false).getStatus();
    expect(status).toMatchObject({ linked: false, writer: 'other_instance', lastSyncAt: null });
    expect(instance.checkWriter).toHaveBeenCalledOnce();
  });

  it('un error del escritor que no es de disponibilidad no provoca relevo', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const server = await WriterSocketServer.listen({
      path,
      handlers: {
        createNote: async () => {
          throw new Error('fallo con texto que no debe viajar');
        },
        appendToNote: async () => {
          throw new Error('x');
        },
        editNote: async () => {
          throw new Error('x');
        },
        organize: async () => {
          throw new Error('x');
        },
        restoreVersion: async () => {
          throw new Error('x');
        },
        fetchAttachment: async () => {
          throw new Error('x');
        },
        createFolder: async () => {
          throw new Error('x');
        },
        renameFolder: async () => {
          throw new Error('x');
        },
        addAttachment: async () => {
          throw new Error('x');
        },
        organizeFile: async () => {
          throw new Error('x');
        },
        status: async () => {
          throw new Error('x');
        }
      }
    });
    servers.push(server);
    const instance = fakeInstance(path, 'this');
    const write = buildRoutedWriteContext(instance, localSpy());
    const error = await write
      .createNote({ body: '# x', privacy: OPEN })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WriterRemoteError);
    expect((error as WriterRemoteError).code).toBe('internal');
    expect(instance.checkWriter).not.toHaveBeenCalled();
    expect(stderrText()).not.toContain('fallo con texto');
    expect(error).not.toBeInstanceOf(WriterUnavailableError);
  });
});
