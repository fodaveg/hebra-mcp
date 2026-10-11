import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { WriterSocketServer } from '../../src/ipc/writer-socket';
import { buildRoutedWriteContext, writerSocketHandlers } from '../../src/server/forward';
import { auditHarness, createNote, NOT_FOUND, saveBody, type AuditHarness } from './audit-harness';

type Notes = { old: string; target: string };

async function routeThroughWriter(h: AuditHarness<Notes>): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), 'codex5-ipc-history-'));
  const local = h.serverContext.write!;
  const socket = await WriterSocketServer.listen({
    path: join(dir, 'writer.sock'),
    handlers: writerSocketHandlers(local, {
      status: async () => ({
        writer: 'this',
        lastSyncAt: null,
        lastSyncOutcome: null,
        pendingUpload: 0,
        errorsByCode: {},
        revoked: false
      })
    })
  }).catch(async (error: unknown) => {
    await rm(dir, { recursive: true, force: true });
    throw error;
  });
  h.serverContext.write = buildRoutedWriteContext(
    {
      role: 'other_instance',
      writerSocketPath: join(dir, 'writer.sock'),
      checkWriter: async () => {},
      status: async () => ({
        writer: 'other_instance',
        lastSyncAt: null,
        lastSyncOutcome: null,
        pendingUpload: 0,
        errorsByCode: {},
        revoked: false
      })
    },
    local
  );
  return async () => {
    await socket.close();
    await rm(dir, { recursive: true, force: true });
  };
}

async function historyScenario() {
  const h = await auditHarness(async (engine) => ({
    old: (await createNote(engine, null, '# Anterior\ncontenido\n')).id,
    target: (await createNote(engine, null, '# Destino\ncontenido\n')).id
  }));
  const operationId = 'codex5-ipc-operation-history';
  const first = await h.call('hebra_append_to_note', {
    id: h.extra.old,
    text: 'primera escritura',
    operationId
  });
  expect(first.isError).toBe(false);
  return { h, operationId };
}

it('el escritor por socket trata el operationId de una nota ahora privada como nunca usado', async () => {
  const { h, operationId } = await historyScenario();
  let closeWriter: (() => Promise<void>) | undefined;
  try {
    await h.mutate((engine) => saveBody(engine, h.extra.old, '# Anterior\ncontenido\n#secreto\n'));
    closeWriter = await routeThroughWriter(h);
    const result = await h.call('hebra_append_to_note', {
      id: h.extra.target,
      text: 'segunda escritura',
      operationId
    });
    expect((await h.call('hebra_read_note', { id: h.extra.old })).json).toEqual(NOT_FOUND);
    expect(result.isError, 'el registro privado impide escribir en una nota visible').toBe(false);
  } finally {
    await closeWriter?.();
    await h.close();
  }
});

it('la puerta del lector oculta un rechazo remoto si la nota del registro pasa a privada durante la llamada', async () => {
  const { h, operationId } = await historyScenario();
  const local = h.serverContext.write!;
  const append = local.appendToNote.bind(local);
  const spy = vi.spyOn(local, 'appendToNote').mockImplementationOnce(async (input) => {
    try {
      return await append(input);
    } catch (error) {
      await h.mutate((engine) => saveBody(engine, h.extra.old, '# Anterior\ncontenido\n#secreto\n'));
      throw error;
    }
  });
  let closeWriter: (() => Promise<void>) | undefined;
  try {
    closeWriter = await routeThroughWriter(h);
    const result = await h.call('hebra_append_to_note', {
      id: h.extra.target,
      text: 'segunda escritura',
      operationId
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await h.call('hebra_read_note', { id: h.extra.old })).json).toEqual(NOT_FOUND);
    expect(result.json, 'el error remoto conserva el historial de una nota ya privada').toEqual(NOT_FOUND);
  } finally {
    spy.mockRestore();
    await closeWriter?.();
    await h.close();
  }
});

it('el escritor por socket conserva operation_id_reused cuando la nota anterior sigue visible', async () => {
  const { h, operationId } = await historyScenario();
  let closeWriter: (() => Promise<void>) | undefined;
  try {
    closeWriter = await routeThroughWriter(h);
    const result = await h.call('hebra_append_to_note', {
      id: h.extra.target,
      text: 'segunda escritura',
      operationId
    });
    expect(result.json).toEqual({ error: 'operation_id_reused' });
  } finally {
    await closeWriter?.();
    await h.close();
  }
});
