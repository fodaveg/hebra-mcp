/**
 * Las tres ops de los ficheros de trabajo en `writer.sock` (SPEC.md §8, §13.6): validación
 * de lo que llega, y `trashConflictCopies` que solo toca copias de conflicto de ESA nota.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requestWriter,
  WRITER_SOCKET_FILE,
  WriterSocketServer,
  type WriterSocketHandlers
} from '../../src/ipc/writer-socket';
import type { ReplaceBodyInput, TrashConflictCopiesInput } from '../../src/store/body-writes';
import { createNote, OPEN, removeTempDirs, tempDir, withWriter } from './helpers';

const servers: WriterSocketServer[] = [];
const SHA = 'a'.repeat(64);

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
  removeTempDirs();
});

const status = async () => ({ lastSyncAt: null, lastSyncOutcome: null, pendingUpload: 0, errorsByCode: {}, revoked: false });

function baseHandlers(): WriterSocketHandlers {
  const unused = async (): Promise<never> => {
    throw new Error('no se usa');
  };
  return {
    createNote: unused,
    appendToNote: unused,
    editNote: unused,
    organize: unused,
    restoreVersion: unused,
    fetchAttachment: unused,
    createFolder: unused,
    renameFolder: unused,
    addAttachment: unused,
    organizeFile: unused,
    status
  };
}

async function listen(handlers: WriterSocketHandlers): Promise<string> {
  const path = join(tempDir(), WRITER_SOCKET_FILE);
  servers.push(await WriterSocketServer.listen({ path, handlers }));
  return path;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return String((error as { code?: unknown }).code ?? (error as Error).message);
  }
}

describe('validación de replaceBody, trashConflictCopies y syncRound en writer.sock', () => {
  it('lo válido llega tal cual; lo que no, invalid_request sin llamar al manejador', async () => {
    const seen: Array<ReplaceBodyInput | TrashConflictCopiesInput | 'round'> = [];
    const path = await listen({
      ...baseHandlers(),
      replaceBody: async (input) => {
        seen.push(input);
        return { outcome: 'already', localSeq: 3, bodySha256: SHA };
      },
      trashConflictCopies: async (input) => {
        seen.push(input);
        return { trashed: 0, already: 0, changed: 0 };
      },
      syncRound: async () => {
        seen.push('round');
        return { kind: 'no_sync' };
      }
    });
    const replace = { id: 'n1', body: '# x\n', baseBodySha256: SHA, onConflict: 'copy', privacy: OPEN };
    expect(await requestWriter(path, 'replaceBody', replace, 2_000)).toEqual({
      outcome: 'already',
      localSeq: 3,
      bodySha256: SHA
    });
    const trash = { originalId: 'n1', bodySha256: SHA, copyId: 'c1', notBefore: 5, exclude: ['c2'], privacy: OPEN };
    expect(await requestWriter(path, 'trashConflictCopies', trash, 2_000)).toEqual({ trashed: 0, already: 0, changed: 0 });
    expect(await requestWriter(path, 'syncRound', {}, 2_000)).toEqual({ kind: 'no_sync' });
    expect(seen).toEqual([{ ...replace }, { ...trash }, 'round']);

    const bad: Array<[op: 'replaceBody' | 'trashConflictCopies', params: Record<string, unknown>]> = [
      ['replaceBody', { ...replace, privacy: undefined }],
      ['replaceBody', { ...replace, baseBodySha256: 'xyz' }],
      ['replaceBody', { ...replace, onConflict: 'pisar' }],
      ['replaceBody', { ...replace, id: '' }],
      ['replaceBody', { ...replace, body: 42 }],
      ['replaceBody', { ...replace, body: 'x'.repeat(1_000_001) }],
      ['trashConflictCopies', { ...trash, privacy: undefined }],
      ['trashConflictCopies', { ...trash, bodySha256: 'A'.repeat(64) }],
      ['trashConflictCopies', { ...trash, copyId: 7 }],
      ['trashConflictCopies', { ...trash, notBefore: -1 }],
      ['trashConflictCopies', { ...trash, notBefore: 1.5 }],
      ['trashConflictCopies', { ...trash, exclude: 'c2' }],
      ['trashConflictCopies', { ...trash, exclude: [''] }],
      ['trashConflictCopies', { ...trash, exclude: Array.from({ length: 1_001 }, (_, i) => `c${i}`) }]
    ];
    for (const [op, params] of bad) {
      expect(await codeOf(requestWriter(path, op, params, 5_000)), `${op} ${JSON.stringify(params).slice(0, 80)}`).toBe(
        'invalid_request'
      );
    }
    expect(seen).toHaveLength(3);
  });

  it('un escritor sin los manejadores (versión anterior) responde invalid_request a las tres', async () => {
    const path = await listen(baseHandlers());
    expect(
      await codeOf(
        requestWriter(path, 'replaceBody', { id: 'n1', body: 'x', baseBodySha256: SHA, onConflict: 'copy', privacy: OPEN }, 2_000)
      )
    ).toBe('invalid_request');
    expect(
      await codeOf(requestWriter(path, 'trashConflictCopies', { originalId: 'n1', bodySha256: SHA, privacy: OPEN }, 2_000))
    ).toBe('invalid_request');
    expect(await codeOf(requestWriter(path, 'syncRound', {}, 2_000))).toBe('invalid_request');
  });
});

describe('trashConflictCopies solo toca copias de conflicto de esa nota', () => {
  it('se niega con una nota que no es copia y con una copia de otra nota', async () => {
    const dataDir = tempDir();
    await withWriter(dataDir, async (writer) => {
      const a = await createNote(writer, '# A\n\nuno\n');
      const b = await createNote(writer, '# B\n\ndos\n');
      const copy = await writer.replaceBodyLocal({
        id: b,
        body: '# B\n\ncopia\n',
        baseBodySha256: '0'.repeat(64),
        onConflict: 'copy',
        privacy: OPEN
      });
      if (copy.outcome !== 'conflict_copy') throw new Error('se esperaba una copia');
      const shaOf = async (id: string) => (await writer.port.noteRead(id))!.bodySha256;
      // La propia nota A, nombrada como si fuera su copia.
      expect(
        await writer.trashConflictCopiesLocal({ originalId: a, copyId: a, bodySha256: await shaOf(a), privacy: OPEN })
      ).toEqual({ trashed: 0, already: 0, changed: 1 });
      // La copia de B, pedida como copia de A.
      expect(
        await writer.trashConflictCopiesLocal({
          originalId: a,
          copyId: copy.copyId,
          bodySha256: await shaOf(copy.copyId),
          privacy: OPEN
        })
      ).toEqual({ trashed: 0, already: 0, changed: 1 });
      // Sin id: A no tiene copias, aunque el cuerpo case con la de B.
      expect(
        await writer.trashConflictCopiesLocal({ originalId: a, bodySha256: await shaOf(copy.copyId), privacy: OPEN })
      ).toEqual({ trashed: 0, already: 0, changed: 0 });
      for (const id of [a, copy.copyId]) expect((await writer.port.noteRead(id))!.trashedAt).toBeNull();
      // Y con la nota correcta, sí.
      expect(
        await writer.trashConflictCopiesLocal({
          originalId: b,
          copyId: copy.copyId,
          bodySha256: await shaOf(copy.copyId),
          privacy: OPEN
        })
      ).toEqual({ trashed: 1, already: 0, changed: 0 });
    });
  });
});
