/**
 * Hallazgos BAJOS de la revisión de `hebra_replace_in_notes` (D14):
 * - B1: un `apply` repetido sobre un plan deshecho a medias responde `complete: true` y
 *   `undone: true`, no `complete: false` para siempre.
 * - B2: un `apply` cortado no se reanuda pasada la hora desde que empezó.
 * - B3: deshacer pasados 7 días responde `plan_expired`; y `undo` tiene plazo por llamada.
 * - B4: el estado de sync de `undo` mira lo que de verdad escribió (la copia mandada a la
 *   papelera, no la nota que no se tocó).
 * - B5: deshacer no manda a la papelera una copia de conflicto que creó otro plan.
 * - B7: `complete` no cuenta las notas que ya no son visibles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivacyConfig } from '../../src/privacy/config';
import {
  ReplaceBatch,
  type ReplaceApplyReport,
  type ReplacePlanView,
  type ReplaceUndoReport
} from '../../src/store/replace-batch';
import type { LibraryInstance } from '../../src/sync/library-instance';
import { codeOf, createFolder, createNote, exec, noteState, OPEN, openWriter, query, removeTempDirs, tempDir } from './helpers';

const instances: LibraryInstance[] = [];
const DAY = 24 * 3600_000;

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
  vi.restoreAllMocks();
  removeTempDirs();
});

async function library() {
  const dataDir = tempDir();
  const writer = await openWriter(dataDir);
  instances.push(writer.instance);
  return { dataDir, ...writer };
}

function simulate(privacy: PrivacyConfig = OPEN) {
  return {
    mode: 'simulate' as const,
    pattern: 'foo',
    regex: false,
    caseSensitive: false,
    replacement: 'bar',
    scope: {},
    maxNotes: 200,
    limit: 50,
    privacy
  };
}

/** Los ids del plan en su orden de aplicación. */
function planOrder(dataDir: string, planId: string): string[] {
  return query<{ note_id: string }>(
    dataDir,
    'SELECT note_id FROM hebra_mcp_replace_plan_notes WHERE plan_id = ? ORDER BY position',
    planId
  ).map((row) => row.note_id);
}

describe('B1 y B2: aplicar tras un corte', () => {
  it('B1: deshecho a medias, repetir apply responde complete: true y undone: true', async () => {
    const { instance } = await library();
    for (let i = 0; i < 3; i += 1) await createNote(instance, `# N${i}\n\nfoo\n`);
    const batch = new ReplaceBatch(instance.port, instance, { applyBudgetMs: 0 });
    const planId = ((await batch.run(simulate())).result as ReplacePlanView).planId!;
    const cut = (await batch.run({ mode: 'apply', planId, operationId: 'op-b1', privacy: OPEN })).result as ReplaceApplyReport;
    expect(cut.complete).toBe(false);
    await batch.run({ mode: 'undo', planId, privacy: OPEN });
    const again = (await batch.run({ mode: 'apply', planId, operationId: 'op-b1', privacy: OPEN })).result as ReplaceApplyReport;
    expect(again).toMatchObject({ complete: true, undone: true, replayed: true });
  });

  it('B2: un apply cortado no se reanuda pasada la hora desde que empezó', async () => {
    const { dataDir, instance } = await library();
    const ids = [];
    for (let i = 0; i < 2; i += 1) ids.push(await createNote(instance, `# N${i}\n\nfoo\n`));
    const batch = new ReplaceBatch(instance.port, instance, { applyBudgetMs: 0 });
    const planId = ((await batch.run(simulate())).result as ReplacePlanView).planId!;
    await batch.run({ mode: 'apply', planId, operationId: 'op-b2', privacy: OPEN });
    exec(dataDir, 'UPDATE hebra_mcp_replace_plans SET applied_at = applied_at - ?, created_at = created_at - ? WHERE plan_id = ?', 2 * 3600_000, 2 * 3600_000, planId);
    const pending = planOrder(dataDir, planId)[1]!;
    expect(await codeOf(batch.run({ mode: 'apply', planId, operationId: 'op-b2', privacy: OPEN }))).toBe('plan_expired');
    expect(noteState(dataDir, pending).body).toBe(`# N${ids.indexOf(pending)}\n\nfoo\n`);
    // Deshacer lo que sí entró sigue valiendo.
    const undo = (await batch.run({ mode: 'undo', planId, privacy: OPEN })).result as ReplaceUndoReport;
    expect(undo.notes.map((note) => note.outcome)).toEqual(['restored']);
  });
});

describe('B3: caducidad y plazo de undo', () => {
  it('pasados 7 días, undo responde plan_expired (no plan_not_found)', async () => {
    const { dataDir, instance } = await library();
    await createNote(instance, '# N\n\nfoo\n');
    const batch = new ReplaceBatch(instance.port, instance);
    const planId = ((await batch.run(simulate())).result as ReplacePlanView).planId!;
    await batch.run({ mode: 'apply', planId, operationId: 'op-b3', privacy: OPEN });
    exec(dataDir, 'UPDATE hebra_mcp_replace_plans SET applied_at = applied_at - ?, created_at = created_at - ? WHERE plan_id = ?', 8 * DAY, 8 * DAY, planId);
    expect(await codeOf(batch.run({ mode: 'undo', planId, privacy: OPEN }))).toBe('plan_expired');
    // Sin cuerpos guardados: la lápida es mínima.
    expect(query(dataDir, 'SELECT plan_id FROM hebra_mcp_replace_plan_notes WHERE plan_id = ?', planId)).toEqual([]);
  });

  it('undo tiene plazo por llamada: complete: false y repetir sigue', async () => {
    const { dataDir, instance } = await library();
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push(await createNote(instance, `# N${i}\n\nfoo\n`));
    const batch = new ReplaceBatch(instance.port, instance, { undoBudgetMs: 0 });
    const planId = ((await batch.run(simulate())).result as ReplacePlanView).planId!;
    await batch.run({ mode: 'apply', planId, operationId: 'op-b3b', privacy: OPEN });
    const first = (await batch.run({ mode: 'undo', planId, privacy: OPEN })).result as ReplaceUndoReport;
    expect(first.complete).toBe(false);
    let last = first;
    for (let round = 0; round < 5 && !last.complete; round += 1) {
      last = (await batch.run({ mode: 'undo', planId, privacy: OPEN })).result as ReplaceUndoReport;
    }
    expect(last.complete).toBe(true);
    expect(last.notes.map((note) => note.outcome)).toEqual(['restored', 'restored', 'restored']);
    for (const [i, id] of ids.entries()) expect(noteState(dataDir, id).body).toBe(`# N${i}\n\nfoo\n`);
  });
});

describe('B4 y B5: copias de conflicto al deshacer', () => {
  it('B4: el estado de sync de undo cuenta la copia mandada a la papelera', async () => {
    const { dataDir, instance } = await library();
    const id = await createNote(instance, '# N\n\nfoo\n');
    const batch = new ReplaceBatch(instance.port, instance);
    const planId = ((await batch.run(simulate())).result as ReplacePlanView).planId!;
    // Como tras un corte entre guardar la base y escribir: la base ya está en el plan, y
    // después otro escritor cambia la nota.
    exec(dataDir, 'UPDATE hebra_mcp_replace_plan_notes SET base_body = ? WHERE plan_id = ?', '# N\n\nfoo\n', planId);
    await instance.appendToNote({ id, text: 'OTRO', privacy: OPEN });
    const report = (await batch.run({ mode: 'apply', planId, operationId: 'op-b4', privacy: OPEN })).result as ReplaceApplyReport;
    const copyId = report.notes[0]!.copyId!;
    expect(copyId).toEqual(expect.any(String));
    const undo = await batch.run({ mode: 'undo', planId, privacy: OPEN });
    expect(noteState(dataDir, copyId).trashed_at).not.toBeNull();
    expect(undo.written).toEqual([copyId]);
  });

  it('B5: deshacer no manda a la papelera la copia que creó otro plan', async () => {
    const { dataDir, instance } = await library();
    const id = await createNote(instance, '# N\n\nfoo\n');
    const batch = new ReplaceBatch(instance.port, instance);
    const first = ((await batch.run(simulate())).result as ReplacePlanView).planId!;
    const second = ((await batch.run(simulate())).result as ReplacePlanView).planId!;
    await instance.appendToNote({ id, text: 'OTRO', privacy: OPEN });
    const a = (await batch.run({ mode: 'apply', planId: first, operationId: 'op-b5a', privacy: OPEN })).result as ReplaceApplyReport;
    const b = (await batch.run({ mode: 'apply', planId: second, operationId: 'op-b5b', privacy: OPEN })).result as ReplaceApplyReport;
    const copyId = a.notes[0]!.copyId!;
    expect(b.notes[0]!.copyId).toBe(copyId);
    await batch.run({ mode: 'undo', planId: second, privacy: OPEN });
    expect(noteState(dataDir, copyId).trashed_at).toBeNull();
    await batch.run({ mode: 'undo', planId: first, privacy: OPEN });
    expect(noteState(dataDir, copyId).trashed_at).not.toBeNull();
  });
});

describe('B7: complete no cuenta las notas que ya no son visibles', () => {
  it('si lo único pendiente pasó a oculto, complete: true', async () => {
    const { dataDir, instance } = await library();
    const diario = await createFolder(instance, 'Diario');
    for (let i = 0; i < 3; i += 1) await createNote(instance, `# N${i}\n\nfoo\n`);
    const privacy = { privateFolders: [['diario']], privateTags: [] };
    const batch = new ReplaceBatch(instance.port, instance, { applyBudgetMs: 0 });
    const planId = ((await batch.run(simulate(privacy))).result as ReplacePlanView).planId!;
    const order = planOrder(dataDir, planId);
    await batch.run({ mode: 'apply', planId, operationId: 'op-b7', privacy });
    // Las dos pendientes pasan a la carpeta privada.
    for (const hidden of order.slice(1)) {
      await instance.organize({ action: 'moveNote', id: hidden, folderId: diario, privacy: OPEN });
    }
    const again = (await batch.run({ mode: 'apply', planId, operationId: 'op-b7', privacy })).result as ReplaceApplyReport;
    expect(again.notes.map((note) => note.id)).toEqual([order[0]]);
    expect(again.complete).toBe(true);
  });
});
