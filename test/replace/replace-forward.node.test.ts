/**
 * `hebra_replace_in_notes` desde un LECTOR (SPEC.md §8, D14): todo viaja al escritor por
 * `writer.sock` (op `replaceInNotes`), con la configuración de privados del lector, y el
 * escritor lo valida. Como `test/workdir/otro-escritor.node.test.ts`: el escritor es una
 * `LibraryInstance` de este proceso con su socket, y el lector declara el PID de otro
 * proceso vivo (así no puede tomar el bloqueo y queda de lector).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requestWriter,
  WRITER_SOCKET_FILE,
  WriterSocketServer,
  type WriterSocketHandlers
} from '../../src/ipc/writer-socket';
import type { PrivacyConfig } from '../../src/privacy/config';
import { resolveToolContext } from '../../src/server/context';
import { buildRoutedWriteContext, writerSocketHandlers } from '../../src/server/forward';
import { localWriteContext } from '../../src/server/serve';
import { runReplaceInNotes, type ReplaceInNotesInput } from '../../src/server/tools/replace-in-notes';
import type { ReplaceApplyReport, ReplacePlanView, ReplaceUndoReport } from '../../src/store/replace-batch';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { LibraryInstance } from '../../src/sync/library-instance';
import { codeOf, createNote, noteState, OPEN, removeTempDirs, tempDir } from './helpers';

const children: ChildProcess[] = [];
const instances: LibraryInstance[] = [];
const servers: WriterSocketServer[] = [];

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const instance of instances.splice(0)) await instance.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  vi.restoreAllMocks();
  removeTempDirs();
});

function livePid(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child.pid!;
}

describe('hebra_replace_in_notes desde un lector', () => {
  it('simular, páginas, aplicar, reintentar y deshacer viajan al escritor con la privacidad del lector', async () => {
    const dataDir = tempDir();
    const writer = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false },
      writerSocket: (opened) => writerSocketHandlers(localWriteContext(opened), opened)
    });
    instances.push(writer);
    const pub = await createNote(writer, '# Pública\n\nfoo\n');
    const other = await createNote(writer, '# Otra\n\nfoo\n');
    const hidden = await createNote(writer, '# Oculta\n#secreto\n\nfoo\n');

    const reader = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false, pid: livePid() }
    });
    instances.push(reader);
    expect(reader.role).toBe('other_instance');
    const write = buildRoutedWriteContext(reader, localWriteContext(reader));
    const privacy: PrivacyConfig = { privateFolders: [], privateTags: ['secreto'] };
    const call = async (input: ReplaceInNotesInput) =>
      runReplaceInNotes(
        await resolveToolContext({ port: reader.port, privacyConfig: privacy, status: new UnlinkedStatusSource(), write }),
        input
      );

    const plan = (await call({ mode: 'simulate', pattern: 'foo', replacement: 'bar', limit: 1 })) as ReplacePlanView;
    expect(plan.planNotes).toBe(2);
    expect(plan.notes).toHaveLength(1);
    const page = (await call({ mode: 'preview', planId: plan.planId!, cursor: plan.nextCursor! })) as ReplacePlanView;
    expect([...plan.notes, ...page.notes].map((note) => note.id).sort()).toEqual([pub, other].sort());
    expect(JSON.stringify([plan, page])).not.toContain(hidden);

    const report = (await call({ mode: 'apply', planId: plan.planId!, operationId: 'op-r' })) as ReplaceApplyReport & {
      sync: string;
    };
    expect(report.complete).toBe(true);
    expect(report.sync).toBe('not_linked');
    expect(report.notes.map((note) => note.outcome)).toEqual(['applied', 'applied']);
    // Lo escribió el escritor, en su base: el lector la lee de la réplica.
    expect(noteState(dataDir, pub).body).toBe('# Pública\n\nbar\n');
    expect(noteState(dataDir, hidden).body).toBe('# Oculta\n#secreto\n\nfoo\n');
    expect(reader.role).toBe('other_instance');

    const replay = (await call({ mode: 'apply', planId: plan.planId!, operationId: 'op-r' })) as ReplaceApplyReport;
    expect(replay.replayed).toBe(true);
    // Otra configuración de privados (la del escritor, sin privados) no puede aplicar el plan
    // del lector (deshacer sí podría: M4 de la revisión).
    expect(
      await codeOf(writer.replaceInNotesLocal({ mode: 'apply', planId: plan.planId!, operationId: 'op-r', privacy: OPEN }))
    ).toBe('plan_not_found');

    const undo = (await call({ mode: 'undo', planId: plan.planId! })) as ReplaceUndoReport;
    expect(undo.notes.map((note) => note.outcome)).toEqual(['restored', 'restored']);
    expect(noteState(dataDir, pub).body).toBe('# Pública\n\nfoo\n');
  }, 60_000);

  it('el escritor valida lo que llega; uno sin la op responde invalid_request', async () => {
    const dir = tempDir();
    const seen: unknown[] = [];
    const unused = async (): Promise<never> => {
      throw new Error('no se usa');
    };
    const base: WriterSocketHandlers = {
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
      status: async () => ({ lastSyncAt: null, lastSyncOutcome: null, pendingUpload: 0, errorsByCode: {}, revoked: false })
    };
    const path = join(dir, WRITER_SOCKET_FILE);
    servers.push(
      await WriterSocketServer.listen({
        path,
        handlers: {
          ...base,
          replaceInNotes: async (request) => {
            seen.push(request);
            return { mode: 'undo', planId: 'p', complete: true, notes: [], sync: 'not_linked' };
          }
        }
      })
    );
    const simulate = {
      mode: 'simulate',
      pattern: 'foo',
      regex: false,
      caseSensitive: false,
      replacement: 'bar',
      scope: { folder: 'A', subfolders: true, tag: 't', ids: ['n1'] },
      maxNotes: 10,
      limit: 5,
      privacy: OPEN
    };
    await requestWriter(path, 'replaceInNotes', simulate, 2_000);
    await requestWriter(path, 'replaceInNotes', { mode: 'apply', planId: 'p', operationId: 'o', privacy: OPEN }, 2_000);
    expect(seen).toEqual([simulate, { mode: 'apply', planId: 'p', operationId: 'o', privacy: OPEN }]);
    const bad: Array<Record<string, unknown>> = [
      { ...simulate, privacy: undefined },
      { ...simulate, mode: 'purge' },
      { ...simulate, pattern: '' },
      { ...simulate, pattern: 'x'.repeat(1_001) },
      { ...simulate, replacement: 7 },
      { ...simulate, regex: 'sí' },
      { ...simulate, maxNotes: 0 },
      { ...simulate, scope: { ids: [''] } },
      { ...simulate, scope: { ids: Array.from({ length: 201 }, (_, i) => `n${i}`) } },
      { mode: 'apply', planId: 'p', privacy: OPEN },
      { mode: 'apply', planId: '', operationId: 'o', privacy: OPEN },
      { mode: 'preview', planId: 'p', limit: 5, privacy: OPEN },
      { mode: 'undo', privacy: OPEN }
    ];
    for (const params of bad) {
      expect(await codeOf(requestWriter(path, 'replaceInNotes', params, 2_000)), JSON.stringify(params).slice(0, 80)).toBe(
        'invalid_request'
      );
    }
    expect(seen).toHaveLength(2);

    // Un escritor de una versión anterior (sin el manejador).
    const oldPath = join(tempDir(), WRITER_SOCKET_FILE);
    servers.push(await WriterSocketServer.listen({ path: oldPath, handlers: base }));
    expect(await codeOf(requestWriter(oldPath, 'replaceInNotes', simulate, 2_000))).toBe('invalid_request');
  });
});
