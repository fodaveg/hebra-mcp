/**
 * Protocolo de `writer.sock` por su cuenta: 0600, límite de tamaño, líneas inválidas y
 * socket ajeno al cerrar. El soporte común vive en `forward-harness.ts`.
 */
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  WRITER_SOCKET_FILE,
  WriterRemoteError,
  WriterSocketServer,
  requestWriter,
  type WriterSocketHandlers,
} from "../../src/ipc/writer-socket";
import { CREATE_BODY_MAX_LENGTH } from "../../src/store/writes";
import { FILE_TEXT_REPLACE_MAX_BYTES } from "../../src/store/file-content";
import { EDITS_TOTAL_MAX_LENGTH } from "../../src/store/edits";
import {
  OPEN,
  servers,
  tempDataDir,
  useForwardHarness,
} from "./forward-harness";

useForwardHarness();

describe('protocolo de writer.sock', () => {
  const handlers: WriterSocketHandlers = {
    createNote: async (input) => ({ id: 'n1', title: 't', folderId: input.folderId ?? 'root' }),
    appendToNote: async (input) => ({ id: input.id, outcome: 'saved' }),
    editNote: async (input) => ({
      id: input.id,
      outcome: 'saved',
      revision: 'r1.x',
      sync: 'not_linked'
    }),
    organize: async (input) => ({
      id: input.id,
      folderId: 'root',
      favorite: false,
      archived: false,
      trashed: input.action === 'trashNote',
      sync: 'not_linked'
    }),
    restoreVersion: async (input) => ({
      id: input.id,
      outcome: 'saved',
      revision: `r1.v${input.versionId}`,
      sync: 'not_linked'
    }),
    fetchAttachment: async (input) => ({ available: input.sha256.startsWith('a') }),
    createFolder: async (input) => ({ id: `f-${input.parentId}`, changed: true, sync: 'not_linked' }),
    renameFolder: async (input) => ({ id: input.id, changed: true, sync: 'not_linked' }),
    addAttachment: async (input) => ({
      id: input.id,
      outcome: 'saved',
      revision: 'r1.x',
      attachmentId: 'a'.repeat(64),
      markdown: `![[sha256:${'a'.repeat(64)}|${input.name}]]`,
      sync: 'not_linked'
    }),
    organizeFile: async (input) => ({
      id: input.id,
      folderId: 'root',
      trashed: input.action === 'trashFile',
      sync: 'not_linked'
    }),
    fetchFile: async (input) => ({ available: input.id === 'f1' }),
    replaceFileText: async (input) => ({
      id: input.id,
      outcome: 'saved',
      sha256: 'b'.repeat(64),
      byteLength: input.text?.length ?? 0,
      mimeType: 'text/yaml',
      previousSha256: input.expectedSha256,
      sync: 'not_linked'
    }),
    status: async () => ({
      lastSyncAt: null,
      lastSyncOutcome: null,
      pendingUpload: 0,
      errorsByCode: {},
      revoked: false
    })
  };

  async function listen(dataDir: string, maxMessageBytes?: number): Promise<WriterSocketServer> {
    const server = await WriterSocketServer.listen({
      path: join(dataDir, WRITER_SOCKET_FILE),
      handlers,
      maxMessageBytes
    });
    servers.push(server);
    return server;
  }

  /** Manda `payload` crudo y devuelve lo que responda el escritor hasta cerrar. */
  function raw(path: string, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let out = '';
      const socket = createConnection(path, () => socket.write(payload));
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (out += chunk));
      socket.on('error', () => undefined);
      socket.once('close', () => resolve(out));
      setTimeout(() => reject(new Error('sin cierre')), 5_000).unref();
    });
  }

  it('borra un writer.sock huérfano al escuchar y queda en 0600', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    writeFileSync(path, 'huérfano');
    await listen(dataDir);
    expect(statSync(path).isSocket()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(
      await requestWriter(path, 'createNote', { body: '# x', folderId: null, privacy: OPEN }, 2_000)
    ).toEqual({
      id: 'n1',
      title: 't',
      folderId: 'root'
    });
  });

  it('una línea mayor que el límite se rechaza sin leerla entera y se cierra la conexión', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir, 1_024);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const response = await raw(path, 'x'.repeat(4_096));
    expect(JSON.parse(response)).toEqual({ id: null, ok: false, error: 'message_too_large' });
    // El cliente lo recibe como respuesta del escritor, no como escritor caído.
    await expect(
      requestWriter(path, 'createNote', { body: 'y'.repeat(2_048), folderId: null }, 2_000)
    ).rejects.toBeInstanceOf(WriterRemoteError);
  });

  it('appendToNote lleva operationId opcional hasta el escritor; uno inválido es invalid_request', async () => {
    const seen: Array<string | undefined> = [];
    const path = join(tempDataDir(), WRITER_SOCKET_FILE);
    const server = await WriterSocketServer.listen({
      path,
      handlers: {
        ...handlers,
        appendToNote: async (input) => {
          seen.push(input.operationId);
          return { id: input.id, outcome: 'saved', replayed: true };
        }
      }
    });
    servers.push(server);
    expect(
      await requestWriter(path, 'appendToNote', { id: 'n1', text: 'x', operationId: 'op-1', privacy: OPEN }, 2_000)
    ).toEqual({ id: 'n1', outcome: 'saved', replayed: true });
    await requestWriter(path, 'appendToNote', { id: 'n1', text: 'x', privacy: OPEN }, 2_000);
    expect(seen).toEqual(['op-1', undefined]);
    for (const operationId of ['', 'o'.repeat(201), 7]) {
      await expect(
        requestWriter(path, 'appendToNote', { id: 'n1', text: 'x', operationId, privacy: OPEN }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(seen).toHaveLength(2);
  });

  describe('conexiones ociosas (B4)', () => {
    /** Escucha con un plazo de ociosidad corto y un `appendToNote` que tarda `slowMs`. */
    async function listenIdle(idleTimeoutMs: number, slowMs = 0) {
      const path = join(tempDataDir(), WRITER_SOCKET_FILE);
      const server = await WriterSocketServer.listen({
        path,
        idleTimeoutMs,
        handlers: {
          ...handlers,
          appendToNote: async (input) => {
            await new Promise((resolve) => setTimeout(resolve, slowMs));
            return { id: input.id, outcome: 'saved' };
          }
        }
      });
      servers.push(server);
      return path;
    }

    /** Conecta, manda `payload` (o nada) y resuelve cuando el escritor cierra. */
    function closedByWriter(path: string, payload: string | null): Promise<{ data: string; ms: number }> {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        let data = '';
        const socket = createConnection(path, () => {
          if (payload !== null) socket.write(payload);
        });
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => (data += chunk));
        socket.on('error', () => undefined);
        socket.once('close', () => resolve({ data, ms: Date.now() - started }));
        setTimeout(() => {
          socket.destroy();
          reject(new Error('el escritor no cerró la conexión ociosa'));
        }, 5_000).unref();
      });
    }

    it('una conexión que no manda nada se cierra pasado el plazo', async () => {
      const path = await listenIdle(150);
      const { data } = await closedByWriter(path, null);
      expect(data).toBe('');
    });

    it('una línea a medias (sin salto de línea) se cierra pasado el plazo, sin responder', async () => {
      const path = await listenIdle(150);
      const { data } = await closedByWriter(path, '{"id":1,"op":"status","params":{}');
      expect(data).toBe('');
    });

    it('una petición en curso más larga que el plazo no se corta', async () => {
      const path = await listenIdle(100, 400);
      expect(
        await requestWriter(path, 'appendToNote', { id: 'n1', text: 'x', privacy: OPEN }, 5_000)
      ).toEqual({ id: 'n1', outcome: 'saved' });
    });
  });

  it('el límite por defecto admite el cuerpo máximo de §5 en el peor escape JSON', () => {
    const worst = JSON.stringify({
      id: 1,
      op: 'createNote',
      params: { body: '\u0001'.repeat(CREATE_BODY_MAX_LENGTH), folderId: null }
    });
    expect(Buffer.byteLength(worst)).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  it('el límite por defecto admite el texto máximo de replaceFileText en el peor escape JSON (D15)', () => {
    const worst = JSON.stringify({
      id: 1,
      op: 'replaceFileText',
      params: {
        id: 'f'.repeat(200),
        expectedSha256: 'a'.repeat(64),
        text: '\u0001'.repeat(FILE_TEXT_REPLACE_MAX_BYTES),
        operationId: 'o'.repeat(200),
        privacy: OPEN
      }
    });
    expect(Buffer.byteLength(worst)).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  it('fetchFile y replaceFileText por el socket (D15): privacidad obligatoria y entrada revalidada', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    expect(await requestWriter(path, 'fetchFile', { id: 'f1', privacy: OPEN }, 2_000)).toEqual({
      available: true
    });
    for (const params of [{ id: 'f1' }, { id: '', privacy: OPEN }, { id: 7, privacy: OPEN }]) {
      await expect(requestWriter(path, 'fetchFile', params, 2_000)).rejects.toMatchObject({
        code: 'invalid_request'
      });
    }
    const valid = {
      id: 'f1',
      expectedSha256: 'a'.repeat(64),
      text: 'views: []\n',
      operationId: 'op-1',
      privacy: OPEN
    };
    expect(await requestWriter(path, 'replaceFileText', valid, 2_000)).toMatchObject({
      id: 'f1',
      outcome: 'saved'
    });
    const { text: _text, ...withoutText } = valid;
    expect(
      await requestWriter(path, 'replaceFileText', { ...withoutText, undoOperationId: 'op-0' }, 2_000)
    ).toMatchObject({ id: 'f1' });
    for (const params of [
      { ...valid, privacy: undefined },
      { ...valid, expectedSha256: 'A'.repeat(64) },
      { ...valid, expectedSha256: 'a'.repeat(63) },
      { ...valid, operationId: '' },
      { ...valid, undoOperationId: 'op-0' },
      withoutText,
      { ...valid, text: 'x'.repeat(FILE_TEXT_REPLACE_MAX_BYTES + 1) },
      { ...valid, id: '' }
    ]) {
      await expect(requestWriter(path, 'replaceFileText', params, 2_000)).rejects.toMatchObject({
        code: 'invalid_request'
      });
    }
  });

  it('el escritor vuelve a comprobar los límites de §5 y rechaza JSON inválido', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    await expect(
      requestWriter(path, 'createNote', { body: 'x'.repeat(CREATE_BODY_MAX_LENGTH + 1) }, 2_000)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      requestWriter(path, 'appendToNote', { id: 'n1', text: 'x'.repeat(20_001), privacy: OPEN }, 2_000)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    // Sin la privacidad del lector, ninguna escritura: el escritor no supone la suya.
    await expect(
      requestWriter(path, 'createNote', { body: '# x', folderId: null }, 2_000)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      requestWriter(path, 'appendToNote', { id: 'n1', text: 'x' }, 2_000)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      requestWriter(path, 'organize', { action: 'setFavorite', id: 'n1', favorite: true }, 2_000)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    // Ni acciones de carpetas dentro de `organize`: crear y renombrar son ops propias desde
    // D9 (3 oct 2026), y mover o borrar carpetas no lo es ninguna.
    for (const action of ['createFolder', 'renameFolder', 'moveFolder', 'trashFolder']) {
      await expect(
        requestWriter(
          path,
          'organize',
          { action, id: 'f1', parentId: 'root', name: 'x', privacy: OPEN },
          2_000
        )
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(JSON.parse(await raw(path, 'no es json\n'))).toEqual({
      id: null,
      ok: false,
      error: 'invalid_request'
    });
  });

  it('editNote: el escritor exige la privacidad del lector y revalida los límites', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const valid = {
      id: 'n1',
      edits: [{ find: 'a', replace: 'b' }],
      expectedRevision: 'r1.x',
      operationId: 'op',
      privacy: { privateFolders: [['diario']], privateTags: ['secreto'] }
    };
    expect(await requestWriter(path, 'editNote', valid, 2_000)).toMatchObject({ outcome: 'saved' });
    for (const params of [
      { ...valid, privacy: null },
      { ...valid, privacy: { privateFolders: ['diario'], privateTags: [] } },
      { ...valid, edits: [] },
      { ...valid, edits: [{ find: '', replace: 'x' }] },
      { ...valid, edits: [{ find: 'a', replace: 'x'.repeat(EDITS_TOTAL_MAX_LENGTH) }] },
      { ...valid, operationId: '' }
    ]) {
      await expect(requestWriter(path, 'editNote', params, 2_000)).rejects.toMatchObject({
        code: 'invalid_request'
      });
    }
  });

  it('papelera y restoreVersion por el socket: privacidad obligatoria, entrada revalidada y sin purga', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const privacy = { privateFolders: [['diario']], privateTags: ['secreto'] };
    for (const action of ['trashNote', 'restoreNote']) {
      expect(await requestWriter(path, 'organize', { action, id: 'n1', privacy }, 2_000)).toMatchObject({
        id: 'n1',
        trashed: action === 'trashNote'
      });
      await expect(
        requestWriter(path, 'organize', { action, id: 'n1' }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    // Ninguna acción de purga ni de vaciar la papelera existe en el protocolo.
    for (const action of ['purgeNote', 'notePurge', 'emptyTrash', 'trashEmpty']) {
      await expect(
        requestWriter(path, 'organize', { action, id: 'n1', privacy }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }

    const valid = { id: 'n1', versionId: 7, expectedRevision: 'r1.x', operationId: 'op', privacy };
    expect(await requestWriter(path, 'restoreVersion', valid, 2_000)).toMatchObject({
      outcome: 'saved',
      revision: 'r1.v7'
    });
    for (const params of [
      { ...valid, privacy: undefined },
      { ...valid, versionId: 0 },
      { ...valid, versionId: 1.5 },
      { ...valid, versionId: '7' },
      { ...valid, operationId: '' },
      { ...valid, expectedRevision: 'x'.repeat(2_000) }
    ]) {
      await expect(requestWriter(path, 'restoreVersion', params, 2_000)).rejects.toMatchObject({
        code: 'invalid_request'
      });
    }
  });

  it('organizeFile por el socket (D10): solo mandar y sacar, privacidad obligatoria y sin purga', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const privacy = { privateFolders: [['diario']], privateTags: ['secreto'] };
    for (const action of ['trashFile', 'restoreFile']) {
      expect(
        await requestWriter(path, 'organizeFile', { action, id: 'f1', privacy }, 2_000)
      ).toEqual({ id: 'f1', folderId: 'root', trashed: action === 'trashFile', sync: 'not_linked' });
      // Sin la privacidad del lector, nada: el escritor no supone la suya.
      await expect(
        requestWriter(path, 'organizeFile', { action, id: 'f1' }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(
        requestWriter(path, 'organizeFile', { action, id: '', privacy }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(
        requestWriter(path, 'organizeFile', { action, id: 7, privacy }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
      // Y no son acciones de `organize`, que solo admite las de nota.
      await expect(
        requestWriter(path, 'organize', { action, id: 'f1', privacy }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    // Ninguna otra acción de ficheros existe en el protocolo: ni purgar o vaciar la
    // papelera, ni crear, renombrar, mover o reemplazar, ni las de nota por esta op.
    for (const action of [
      'purgeFile',
      'filePurge',
      'emptyTrash',
      'trashEmpty',
      'deleteFile',
      'createFile',
      'fileCreate',
      'renameFile',
      'fileRename',
      'moveFile',
      'fileMove',
      'replaceFile',
      'fileReplace',
      'readFile',
      'trashNote',
      'restoreNote'
    ]) {
      await expect(
        requestWriter(path, 'organizeFile', { action, id: 'f1', name: 'x', folderId: 'root', privacy }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    // Ni como operación propia del socket.
    for (const op of ['purgeFile', 'filePurge', 'trashFile', 'restoreFile', 'createFile', 'moveFile']) {
      expect(
        JSON.parse(await raw(path, `${JSON.stringify({ id: 1, op, params: { id: 'f1', privacy } })}\n`))
      ).toEqual({ id: null, ok: false, error: 'invalid_request' });
    }
  });

  it('fetchAttachment por el socket: privacidad obligatoria, hash validado y respuesta sin bytes', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const valid = { noteId: 'n1', sha256: 'a'.repeat(64), privacy: OPEN };
    expect(await requestWriter(path, 'fetchAttachment', valid, 2_000)).toEqual({ available: true });
    for (const params of [
      { ...valid, privacy: undefined },
      { ...valid, sha256: 'A'.repeat(64) },
      { ...valid, sha256: '../../etc/passwd' },
      { ...valid, sha256: 'a'.repeat(63) },
      { ...valid, noteId: '' }
    ]) {
      await expect(requestWriter(path, 'fetchAttachment', params, 2_000)).rejects.toMatchObject({
        code: 'invalid_request'
      });
    }
  });

  it('carpetas y addAttachment por el socket (D9): privacidad obligatoria, entrada revalidada', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    expect(
      await requestWriter(path, 'createFolder', { parentId: 'root', name: 'x', privacy: OPEN }, 2_000)
    ).toMatchObject({ id: 'f-root', changed: true });
    expect(await requestWriter(path, 'renameFolder', { id: 'f1', name: 'x', privacy: OPEN }, 2_000)).toMatchObject({
      id: 'f1',
      changed: true
    });
    for (const [op, params] of [
      ['createFolder', { parentId: 'root', name: 'x' }],
      ['createFolder', { parentId: '', name: 'x', privacy: OPEN }],
      ['createFolder', { parentId: 'root', name: 'x'.repeat(1_025), privacy: OPEN }],
      ['renameFolder', { id: 'f1', name: 'x' }],
      ['renameFolder', { id: 'f1', name: 7, privacy: OPEN }]
    ] as const) {
      await expect(requestWriter(path, op, params, 2_000)).rejects.toMatchObject({ code: 'invalid_request' });
    }

    const valid = {
      id: 'n1',
      name: 'a.txt',
      dataBase64: Buffer.from('hola').toString('base64'),
      mimeType: 'text/plain',
      operationId: 'op-1',
      privacy: OPEN
    };
    expect(await requestWriter(path, 'addAttachment', valid, 2_000)).toMatchObject({
      id: 'n1',
      outcome: 'saved'
    });
    for (const params of [
      { ...valid, privacy: undefined },
      { ...valid, dataBase64: 'no es base64!' },
      { ...valid, dataBase64: '' },
      { ...valid, operationId: '' },
      { ...valid, mimeType: 7 },
      { ...valid, id: '' }
    ]) {
      await expect(requestWriter(path, 'addAttachment', params, 2_000)).rejects.toMatchObject({
        code: 'invalid_request'
      });
    }
    // Un adjunto de 5 MiB cabe en una línea; uno de 5 MiB + 1 cabe en la línea pero el
    // escritor lo rechaza con su código.
    const max = Buffer.alloc(5 * 1024 * 1024, 0x61).toString('base64');
    expect(
      await requestWriter(path, 'addAttachment', { ...valid, dataBase64: max }, 10_000)
    ).toMatchObject({ outcome: 'saved' });
    const over = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61).toString('base64');
    await expect(
      requestWriter(path, 'addAttachment', { ...valid, dataBase64: over }, 10_000)
    ).rejects.toMatchObject({ code: 'attachment_too_large' });
  });

  it('addAttachment por el socket con heading: se valida igual que en appendToNote', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const valid = {
      id: 'n1',
      name: 'a.txt',
      dataBase64: Buffer.from('hola').toString('base64'),
      mimeType: 'text/plain',
      operationId: 'op-1',
      privacy: OPEN
    };
    const inSection = { ...valid, heading: 'Uno', headingOccurrence: 2 };
    expect(await requestWriter(path, 'addAttachmentInSection', inSection, 2_000)).toMatchObject({
      outcome: 'saved'
    });
    expect(
      await requestWriter(path, 'addAttachmentInSection', { ...valid, heading: 'Uno' }, 2_000)
    ).toMatchObject({ outcome: 'saved' });
    // Falla cerrado: `addAttachment` no acepta apartado y la op nueva lo exige.
    await expect(requestWriter(path, 'addAttachment', inSection, 2_000)).rejects.toMatchObject({
      code: 'invalid_request'
    });
    await expect(requestWriter(path, 'addAttachmentInSection', valid, 2_000)).rejects.toMatchObject({
      code: 'invalid_request'
    });
    for (const extra of [
      { headingOccurrence: 1, heading: undefined },
      { heading: 7 },
      { heading: 'x'.repeat(1_025) },
      { heading: 'Uno', headingOccurrence: 0 },
      { heading: 'Uno', headingOccurrence: 1.5 },
      { heading: 'Uno', headingOccurrence: '2' }
    ]) {
      await expect(
        requestWriter(path, 'addAttachmentInSection', { ...valid, ...extra }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
  });

  it('una sola petición en vuelo por conexión: varias líneas seguidas se atienden en orden, de una en una', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const server = await WriterSocketServer.listen({
      path,
      handlers: {
        ...handlers,
        createFolder: async (input) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 30));
          order.push(input.name);
          inFlight -= 1;
          return { id: input.name, changed: true, sync: 'not_linked' };
        }
      }
    });
    servers.push(server);
    const names = ['uno', 'dos', 'tres', 'cuatro'];
    const lines = names
      .map((name, index) =>
        JSON.stringify({ id: index, op: 'createFolder', params: { parentId: 'root', name, privacy: OPEN } })
      )
      .join('\n');
    const responses = await new Promise<string[]>((resolve, reject) => {
      let out = '';
      const socket = createConnection(path, () => socket.write(`${lines}\n`));
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        out += chunk;
        const received = out.split('\n').filter((line) => line.length > 0);
        if (received.length === names.length) {
          socket.destroy();
          resolve(received);
        }
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('sin respuesta')), 5_000).unref();
    });
    expect(maxInFlight).toBe(1);
    expect(order).toEqual(names);
    expect(responses.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual([0, 1, 2, 3]);
  });

  it('el límite por defecto admite el base64 de un adjunto de 5 MiB con su sobre (D9)', () => {
    const worst = JSON.stringify({
      id: 1,
      op: 'addAttachment',
      params: {
        id: 'x'.repeat(200),
        name: '\u0001'.repeat(1_024),
        dataBase64: Buffer.alloc(5 * 1024 * 1024).toString('base64'),
        mimeType: '\u0001'.repeat(255),
        operationId: '\u0001'.repeat(200),
        privacy: OPEN
      }
    });
    expect(Buffer.byteLength(worst)).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(MAX_MESSAGE_BYTES).toBe(7_514_796);
  });

  it('el límite por defecto admite las sustituciones máximas de editNote en el peor escape JSON', () => {
    const worst = JSON.stringify({
      id: 1,
      op: 'editNote',
      params: {
        id: 'x'.repeat(200),
        edits: Array.from({ length: 50 }, () => ({
          find: '\u0001'.repeat(EDITS_TOTAL_MAX_LENGTH / 100),
          replace: '\u0001'.repeat(EDITS_TOTAL_MAX_LENGTH / 100)
        })),
        expectedRevision: 'r'.repeat(1_024),
        operationId: 'o'.repeat(200),
        privacy: { privateFolders: [['diario']], privateTags: ['secreto'] }
      }
    });
    expect(Buffer.byteLength(worst)).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  it('al cerrar no borra un writer.sock que ya es de otro escritor', async () => {
    const dataDir = tempDataDir();
    const old = await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const newer = await listen(dataDir); // borra el de `old` y escucha en su sitio
    const newerInode = statSync(path).ino;
    await old.close();
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).ino).toBe(newerInode);
    await newer.close();
    expect(existsSync(path)).toBe(false);
  });

  it('cliente: sin socket, nadie escuchando y sin respuesta a tiempo', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    await expect(requestWriter(path, 'status', {}, 1_000)).rejects.toMatchObject({
      reason: 'no_socket'
    });
    writeFileSync(path, '');
    await expect(requestWriter(path, 'status', {}, 1_000)).rejects.toMatchObject({
      reason: 'refused'
    });
    rmSync(path);
    const silent = createServer((socket) => socket.resume());
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(path, resolve));
    await expect(requestWriter(path, 'status', {}, 200)).rejects.toMatchObject({
      reason: 'timeout'
    });
  });
});
