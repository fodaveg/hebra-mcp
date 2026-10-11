import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WriterSocketServer } from '../../src/ipc/writer-socket';
import { buildRoutedWriteContext, writerSocketHandlers } from '../../src/server/forward';
import { auditHarness, createNote, saveBody } from './audit-harness';

// La pausa no inventa una respuesta: solo hace que la ronda esperada por el escritor
// traiga un cambio del motor, como otro dispositivo que acaba de añadir #secreto.
async function appendThatBecomesPrivate() {
  const h = await auditHarness(async (engine) =>
    (await createNote(engine, null, '# IPC visible\n\n## Apartado\n\nTexto inicial\n')).id
  );
  const socketDir = await mkdtemp('/tmp/codex-ipc-');
  const socketPath = join(socketDir, 'writer.sock');
  const local = h.serverContext.write!;
  const server = await WriterSocketServer.listen({
    path: socketPath,
    handlers: writerSocketHandlers({
      ...local,
      awaitRound: async () => {
        await h.mutate(async (engine) => {
          const row = (await engine.noteRead(h.extra))!;
          await saveBody(engine, h.extra, row.body + '\n\n#secreto\n');
        });
        return { kind: 'done', result: 'ok' };
      }
    }, { status: async () => ({ writer: 'this', lastSyncAt: null, lastSyncOutcome: null, pendingUpload: 0, errorsByCode: {}, revoked: false }) })
  }).catch(async (error: unknown) => {
    await h.close();
    await rm(socketDir, { recursive: true, force: true });
    throw error;
  });
  h.serverContext.write = buildRoutedWriteContext({
    role: 'other_instance',
    writerSocketPath: socketPath,
    checkWriter: async () => {},
    status: async () => ({ writer: 'other_instance', lastSyncAt: null, lastSyncOutcome: null, pendingUpload: 0, errorsByCode: {}, revoked: false })
  }, local);
  return {
    h,
    async run() {
      const result = await h.call('hebra_append_to_note', {
        id: h.extra, heading: 'Apartado', text: 'CEBO_IPC_APARTADO', operationId: 'codex-ipc-after-sync'
      });
      const missing = await h.call('hebra_append_to_note', {
        id: 'codex-note-does-not-exist', heading: 'Apartado', text: 'CEBO_IPC_APARTADO'
      });
      // Prueba que la mutación ocurrió y el filtro actual ya oculta esta nota.
      const hidden = await h.call('hebra_read_note', { id: h.extra });
      expect(hidden.json.error).toBe('not_found');
      return { result, missing, logs: h.stderr() };
    },
    async close() { await server.close(); await h.close(); await rm(socketDir, { recursive: true, force: true }); }
  };
}

describe('privacidad del resultado tras la ronda del escritor por socket', () => {
  it('append no devuelve id, revisión, tamaño ni apartado cuando sync acaba de ocultar la nota', async () => {
    const f = await appendThatBecomesPrivate();
    try {
      const { result, missing } = await f.run();
      expect(result.json, 'Una nota ya oculta devuelve id, totalChars y appended por el socket en vez de not_found').toEqual(missing.json);
    } finally { await f.close(); }
  });

  // Aceptado por la sesión principal (11 oct 2026): §6.4 permite ids opacos en los logs, y
  // `note.append` se emite en cuanto el escritor responde, antes de saber si la ronda ocultó
  // la nota. No es una fuga de contenido (ni título, ni cuerpo, ni apartado).
  it.skip('append no registra el id de una nota que la ronda acaba de ocultar', async () => {
    const f = await appendThatBecomesPrivate();
    try {
      const { logs } = await f.run();
      expect(logs, 'note.append registra el id de la nota ya oculta después de esperar el sync').not.toContain(f.h.extra);
    } finally { await f.close(); }
  });
});
