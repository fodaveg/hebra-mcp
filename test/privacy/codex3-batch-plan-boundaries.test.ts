import { expect, it, vi } from 'vitest';
import { auditHarness, createNote, NOT_FOUND, saveBody, type AuditHarness } from './audit-harness';

async function twoNotes(): Promise<AuditHarness<string[]>> {
  return auditHarness(async (engine) => {
    const ids = [
      (await createNote(engine, null, '# Uno\nCODIGO_PLAN\n')).id,
      (await createNote(engine, null, '# Dos\nCODIGO_PLAN\n')).id
    ];
    return ids.sort();
  });
}

const SIMULATE = { mode: 'simulate', pattern: 'CODIGO_PLAN', replacement: 'CAMBIADO', limit: 1 } as const;

it('simulate conserva los recuentos del turno que guardó el plan si después se oculta una nota fuera de página', async () => {
  const h = await twoNotes();
  const recheck = h.port.privacyRecheck.bind(h.port);
  let changed = false;
  const spy = vi.spyOn(h.port, 'privacyRecheck').mockImplementation(async (...args) => {
    if (!changed) {
      changed = true;
      await h.mutate((engine) => saveBody(engine, h.extra[1]!, '# Privada\nCODIGO_PLAN\n#secreto\n'));
    }
    return recheck(...args);
  });
  try {
    const result = await h.call('hebra_replace_in_notes', { ...SIMULATE, ids: h.extra });
    spy.mockRestore();
    expect(changed).toBe(true);
    expect((await h.call('hebra_read_note', { id: h.extra[1] })).json).toEqual(NOT_FOUND);
    expect(result.isError).toBe(false);
    expect(result.json.notes.map((note: { id: string }) => note.id)).toEqual([h.extra[0]]);
    expect([result.json.planNotes, result.json.planMatches]).toEqual([2, 2]);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});

it('una simulación repetida por la puerta conserva el plan anterior no aplicado hasta su caducidad', async () => {
  const h = await twoNotes();
  const recheck = h.port.privacyRecheck.bind(h.port);
  let changed = false;
  const spy = vi.spyOn(h.port, 'privacyRecheck').mockImplementation(async (...args) => {
    if (!changed) {
      changed = true;
      await h.mutate((engine) => saveBody(engine, h.extra[0]!, '# Privada\nCODIGO_PLAN\n#secreto\n'));
    }
    return recheck(...args);
  });
  try {
    const result = await h.call('hebra_replace_in_notes', { ...SIMULATE, ids: h.extra });
    spy.mockRestore();
    expect(changed).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.json.notes.map((note: { id: string }) => note.id)).toEqual([h.extra[1]]);
    expect([result.json.planNotes, result.json.planMatches]).toEqual([1, 1]);
    const plans = await h.mutate(async (_engine, _library, db) =>
      (db.prepare('SELECT plan_id FROM hebra_mcp_replace_plans').all() as Array<{ plan_id: string }>).map((row) => row.plan_id)
    );
    expect(plans).toHaveLength(2);
    expect(plans).toContain(result.json.planId);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});
