import { expect, it } from 'vitest';
import { GateUsage, passGate } from '../../src/server/privacy-gate';
import { auditHarness, createNote, saveBody, AUDIT_CONFIG } from './audit-harness';

async function planHistory() {
  const h = await auditHarness(async (engine) => ({
    planned: (await createNote(engine, null, '# PlanCodex6\nANTES_PLAN\n')).id,
    target: (await createNote(engine, null, '# DestinoCodex6\nvisible\n')).id
  }));
  const plan = await h.call('hebra_replace_in_notes', {
    mode: 'simulate', pattern: 'ANTES_PLAN', replacement: 'DESPUES_PLAN', ids: [h.extra.planned]
  });
  expect(plan.isError, plan.raw).toBe(false);
  const operationId = 'codex6-plan-operation';
  const applied = await h.call('hebra_replace_in_notes', { mode: 'apply', planId: plan.json.planId, operationId });
  expect(applied.isError, applied.raw).toBe(false);
  return { h, operationId, planId: plan.json.planId as string };
}

it('operationId de un plan cuyas notas hoy son privadas no delata que ese plan existió', async () => {
  const { h, operationId } = await planHistory();
  try {
    await h.mutate((engine) => saveBody(engine, h.extra.planned, '# PlanCodex6\nDESPUES_PLAN\n#secreto\n'));
    const result = await h.call('hebra_append_to_note', {
      id: h.extra.target, text: 'nueva operación visible', operationId
    });
    expect(result.isError, result.raw).toBe(false);
  } finally { await h.close(); }
});

it('puerta final reevalúa las notas de un plan usado como destino del registro', async () => {
  const { h, planId } = await planHistory();
  try {
    const usage = new GateUsage();
    usage.operationTarget(planId);
    await h.mutate((engine) => saveBody(engine, h.extra.planned, '# PlanCodex6\nDESPUES_PLAN\n#secreto\n'));
    const verdict = await passGate(h.port, AUDIT_CONFIG, usage, { seals: false });
    expect(verdict.failedNotes.has(planId)).toBe(true);
  } finally { await h.close(); }
});

it('un destino ya purgado del registro tampoco revela su antiguo operationId', async () => {
  const h = await auditHarness(async (engine) =>
    (await createNote(engine, null, '# DestinoVisibleCodex6\n')).id);
  const operationId = 'codex6-unknown-operation';
  try {
    await h.mutate(async (_engine, _library, db) => {
      db.prepare(`INSERT INTO hebra_mcp_operations
        (operation_id, fingerprint, note_id, target_body_sha256, state, result, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(operationId, 'otra-huella', '00000000-0000-4000-8000-000000000000',
        '', 'done', null, Date.now());
    });
    const result = await h.call('hebra_append_to_note', {
      id: h.extra, text: 'nueva escritura', operationId
    });
    expect(result.isError, result.raw).toBe(false);
  } finally { await h.close(); }
});
