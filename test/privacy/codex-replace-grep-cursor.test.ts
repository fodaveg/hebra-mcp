import { expect, it, vi } from 'vitest';
import { resolveToolContext } from '../../src/server/context';
import { runGrep } from '../../src/server/tools/grep';
import { auditHarness, createNote, saveBody, decodeCursor, NOT_FOUND, type AuditHarness } from './audit-harness';

// Ajustado en la 3.ª vuelta de d64e187e: con la época de privacidad, la nota que pasa a oculta
// a mitad de la llamada cambia la época y la puerta final repite la llamada entera, así que por
// el MCP ya no se ve el corte (el reloj falso del primer intento no se repite). Se comprueban
// las dos cosas: por el MCP, que nada de la oculta sale; y la herramienta sola, sin puerta
// (`runGrep`), que su cursor tras el corte entre lotes sigue sin nombrarla (C6).
async function withInterleaving<T>(
  h: AuditHarness<{ ids: string[] }>,
  hiddenId: string,
  run: () => Promise<T>
): Promise<T> {
  const realRead = h.port.grepBodies.bind(h.port);
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  let intercepted = false;
  const spy = vi.spyOn(h.port, 'grepBodies').mockImplementation(async (...args) => {
    const result = await realRead(...args);
    if (!intercepted) {
      intercepted = true;
      await h.mutate((engine) => saveBody(engine, hiddenId, '# Oculta\nCODIGO_GREPCURSOR\n#secreto\n'));
      const now = Date.now();
      let calls = 0;
      // 63 consultas entre las 64 notas del primer lote; el plazo vence justo antes
      // del segundo. No se espera tiempo real ni se cambia el resultado del almacén.
      clock = vi.spyOn(Date, 'now').mockImplementation(() => ++calls <= 63 ? now : now + 10_000);
    }
    return result;
  });
  try {
    return await run();
  } finally {
    clock?.mockRestore();
    spy.mockRestore();
  }
}

async function library(): Promise<AuditHarness<{ ids: string[] }>> {
  return auditHarness(async (engine) => {
    const folder = await engine.folderCreate(null, 'CodexGrep');
    const ids: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      ids.push((await createNote(engine, folder.id, `# Nota ${index}\nCODIGO_GREPCURSOR\n`)).id);
    }
    return { ids: ids.sort() };
  });
}

it('grep no publica en cursor la nota que pasó a oculta al vencer el plazo entre lotes', async () => {
  const h = await library();
  const hiddenId = h.extra.ids[64]!;
  try {
    const result = await withInterleaving(h, hiddenId, () =>
      h.call('hebra_grep', { pattern: 'CODIGO_GREPCURSOR', folder: 'CodexGrep', limit: 100 })
    );
    expect(result.isError).toBe(false);
    expect((await h.call('hebra_read_note', { id: hiddenId })).json).toEqual(NOT_FOUND);
    expect(result.raw, 'La respuesta nombra la nota oculta').not.toContain(hiddenId);
    expect(decodeCursor(result.json.nextCursor) ?? '').not.toContain(hiddenId);
  } finally {
    await h.close();
  }
});

it('grep, sin puerta: el cursor tras el corte entre lotes va detrás de la última recorrida (C6)', async () => {
  const h = await library();
  const hiddenId = h.extra.ids[64]!;
  try {
    const ctx = await resolveToolContext(h.serverContext);
    const result = await withInterleaving(h, hiddenId, () =>
      runGrep(ctx, { pattern: 'CODIGO_GREPCURSOR', folder: 'CodexGrep', limit: 100 })
    );
    expect(result.cutoff).toBe('time');
    expect(decodeCursor(result.nextCursor), 'El cursor del grep revela el id de la nota oculta del siguiente lote')
      .not.toContain(hiddenId);
  } finally {
    await h.close();
  }
});
