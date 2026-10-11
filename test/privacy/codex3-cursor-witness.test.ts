import { expect, it, vi } from 'vitest';
import { auditHarness, createNote, NOT_FOUND, saveBody } from './audit-harness';

it('R3: grep no anuncia otra página por una coincidencia de una nota recién oculta', async () => {
  const h = await auditHarness(async (engine) => [
    (await createNote(engine, null, '# Una\nCODIGO_GREPCOLA\n')).id,
    (await createNote(engine, null, '# Dos\nCODIGO_GREPCOLA\n')).id
  ].sort());
  const recheck = h.port.privacyRecheck.bind(h.port);
  const spy = vi.spyOn(h.port, 'privacyRecheck').mockImplementationOnce(async (request) => {
    await h.mutate((engine) => saveBody(engine, h.extra[1]!, '# Oculta\nCODIGO_GREPCOLA\n#secreto\n'));
    return recheck(request);
  });
  try {
    const result = await h.call('hebra_grep', { pattern: 'CODIGO_GREPCOLA', ids: h.extra, limit: 1 });
    spy.mockRestore();
    expect(result.isError, result.raw).toBe(false);
    expect(result.json.matches.map((m: { id: string }) => m.id)).toEqual([h.extra[0]]);
    expect((await h.call('hebra_read_note', { id: h.extra[1] })).json).toEqual(NOT_FOUND);
    const fresh = await h.call('hebra_grep', { pattern: 'CODIGO_GREPCOLA', ids: h.extra, limit: 1 });
    expect(fresh.json.nextCursor).toBeNull();
    expect(result.json.nextCursor, 'nextCursor confirma una coincidencia que solo está en una nota ya oculta').toBeNull();
  } finally { spy.mockRestore(); await h.close(); }
});
