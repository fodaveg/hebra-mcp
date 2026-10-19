import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { REPLACE_PLANS_SQLITE_FILE } from '../../src/store/replace-plans';
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

// Ajustados en la 2.ª vuelta de d64e187e (revisión independiente, puntos 2 y 5): la puerta
// final juzga ahora TODAS las notas del plan (de ellas salen `planNotes` y `planMatches`) y
// borra el plan de un intento descartado. Estos dos controles fijaban lo de antes (recuentos
// del turno que guardó el plan y un plan de más por repetición); ahora fijan lo contrario.
it('simulate no conserva en los recuentos una nota que se oculta fuera de página antes de responder', async () => {
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
    expect([result.json.planNotes, result.json.planMatches]).toEqual([1, 1]);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});

it('una simulación repetida por la puerta no deja el plan del intento descartado', async () => {
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
    // Los planes viven en su propio fichero, junto a la biblioteca.
    const plansDb = new DatabaseSync(join(h.dataDir, REPLACE_PLANS_SQLITE_FILE), { readOnly: true });
    const plans = (plansDb.prepare('SELECT plan_id FROM hebra_mcp_replace_plans').all() as Array<{ plan_id: string }>).map(
      (row) => row.plan_id
    );
    plansDb.close();
    expect(plans).toEqual([result.json.planId]);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});
