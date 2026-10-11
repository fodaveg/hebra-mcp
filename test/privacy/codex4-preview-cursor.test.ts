import { expect, it } from 'vitest';
import { auditHarness, createNote, decodeCursor, saveBody } from './audit-harness';

it('R4 control: preview usa la clave devuelta y continúa aunque esa nota ya sea privada', async () => {
  const h = await auditHarness(async (engine) => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await createNote(engine, null, `# Clave ${i}\nAGUJA_R4_CURSOR\n`)).id);
    return ids.sort();
  });
  try {
    const plan = await h.call('hebra_replace_in_notes', {
      mode: 'simulate', ids: h.extra, pattern: 'AGUJA_R4_CURSOR', replacement: 'otro', limit: 1
    });
    expect(plan.isError).toBe(false);
    const start = `rp1.${Buffer.from(JSON.stringify([plan.json.planId, 0])).toString('base64url')}`;
    const first = await h.call('hebra_replace_in_notes', { mode: 'preview', planId: plan.json.planId, cursor: start, limit: 1 });
    expect(first.isError).toBe(false);
    expect(JSON.parse(decodeCursor(first.json.nextCursor)!)).toEqual([plan.json.planId, h.extra[0]]);
    await h.mutate((engine) => saveBody(engine, h.extra[0]!, '# Privada\nAGUJA_R4_CURSOR\n#secreto\n'));
    const next = await h.call('hebra_replace_in_notes', {
      mode: 'preview', planId: plan.json.planId, cursor: first.json.nextCursor, limit: 1
    });
    expect(next.isError).toBe(false);
    expect(next.json.notes.map((note: { id: string }) => note.id)).toEqual([h.extra[1]]);
    expect(JSON.parse(decodeCursor(next.json.nextCursor)!)).toEqual([plan.json.planId, h.extra[1]]);
  } finally { await h.close(); }
});
