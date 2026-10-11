import { expect, it, vi } from 'vitest';
import { ReplaceBatch, type ReplacePlanView } from '../../src/store/replace-batch';
import { auditHarness, createNote, saveBody, decodeCursor, NOT_FOUND, AUDIT_CONFIG, type AuditHarness } from './audit-harness';

// Ajustado en la 3.ª vuelta de d64e187e: con la época de privacidad, la nota que pasa a oculta
// entre lotes cambia la época y la puerta final repite la simulación entera, así que por el MCP
// ya no se ve el corte (el reloj falso del primer intento no se repite). Se comprueban las dos
// cosas: por el MCP, que nada de la oculta sale; y el lote solo, sin puerta (`ReplaceBatch`),
// que `continueAfter` tras el corte entre lotes sigue sin nombrarla.
async function withInterleaving<T>(h: AuditHarness<string[]>, hiddenId: string, run: () => Promise<T>): Promise<T> {
  const read = h.port.grepBodies.bind(h.port);
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  let intercepted = false;
  const spy = vi.spyOn(h.port, 'grepBodies').mockImplementation(async (...args) => {
    const result = await read(...args);
    if (!intercepted) {
      intercepted = true;
      await h.mutate((engine) => saveBody(engine, hiddenId, '# Privada\nTOKEN_SIMULATE_CUTOFF\n#secreto\n'));
      const now = Date.now();
      let calls = 0;
      // Una llamada fija deadline y 63 miran el plazo entre las 64 notas leídas.
      // La siguiente vence antes de que se lea el segundo lote.
      clock = vi.spyOn(Date, 'now').mockImplementation(() => ++calls <= 64 ? now : now + 10_000);
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

async function library(): Promise<AuditHarness<string[]>> {
  return auditHarness(async (engine) => {
    const folder = await engine.folderCreate(null, 'Codex2Simulate');
    const ids: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      ids.push((await createNote(engine, folder.id, `# Lote ${index}\nTOKEN_SIMULATE_CUTOFF\n`)).id);
    }
    return ids.sort();
  });
}

it('simulate no revela en continueAfter la nota que se ocultó entre lotes', async () => {
  const h = await library();
  const hiddenId = h.extra[64]!;
  try {
    const result = await withInterleaving(h, hiddenId, () =>
      h.call('hebra_replace_in_notes', {
        mode: 'simulate', pattern: 'TOKEN_SIMULATE_CUTOFF', replacement: 'RESULTADO', folder: 'Codex2Simulate', limit: 100
      })
    );
    expect(result.isError).toBe(false);
    expect((await h.call('hebra_read_note', { id: hiddenId })).json).toEqual(NOT_FOUND);
    expect(result.raw, 'La simulación nombra la nota oculta').not.toContain(hiddenId);
    expect(decodeCursor(result.json.continueAfter) ?? '').not.toContain(hiddenId);
  } finally {
    await h.close();
  }
});

it('simulate, sin puerta: continueAfter tras el corte entre lotes va detrás de la última mirada', async () => {
  const h = await library();
  const hiddenId = h.extra[64]!;
  try {
    const batch = new ReplaceBatch(h.port, h.port);
    const { result } = await withInterleaving(h, hiddenId, () =>
      batch.run({
        mode: 'simulate',
        pattern: 'TOKEN_SIMULATE_CUTOFF',
        regex: false,
        caseSensitive: false,
        replacement: 'RESULTADO',
        scope: { folder: 'Codex2Simulate' },
        maxNotes: 200,
        limit: 100,
        privacy: AUDIT_CONFIG
      })
    );
    const view = result as ReplacePlanView;
    expect(view.cutoff).toBe('time');
    expect(decodeCursor(view.continueAfter ?? null), 'continueAfter revela el id oculto del lote todavía no leído')
      .not.toContain(hiddenId);
  } finally {
    await h.close();
  }
});
