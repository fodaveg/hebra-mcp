/**
 * Hallazgos MEDIOS de la revisión de `hebra_replace_in_notes` (D14):
 * - M1: un resultado enorme (un literal corto con un reemplazo largo) se corta mientras se
 *   construye, en el hilo principal y en el de la expresión, sin pico de memoria; y el plazo
 *   se mira también DENTRO de una nota grande.
 * - M2: tope de planes guardados sin aplicar (número y caracteres); al pasarlo cae el más
 *   antiguo sin aplicar, nunca uno aplicado.
 * - M3: los planes caducados se purgan solos (al pasar a escritor y en `checkWriter`).
 * - M4: `undo` vale con otra configuración de privados que se pueda resolver; lo que esa
 *   configuración oculta no se toca ni se nombra.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplaceBatch, type ReplacePlanView, type ReplaceUndoReport } from '../../src/store/replace-batch';
import { LibraryInstance } from '../../src/sync/library-instance';
import {
  codeOf,
  createFolder,
  createNote,
  exec,
  noteState,
  OPEN,
  openWriter,
  query,
  removeTempDirs,
  tempDir
} from './helpers';

const instances: LibraryInstance[] = [];

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

function simulate(pattern: string, replacement: string, extra: Record<string, unknown> = {}) {
  return {
    mode: 'simulate' as const,
    pattern,
    regex: false,
    caseSensitive: false,
    replacement,
    scope: {},
    maxNotes: 200,
    limit: 50,
    privacy: OPEN,
    ...extra
  };
}

describe('M1: un resultado enorme se corta mientras se construye', () => {
  for (const regex of [false, true]) {
    it(`${regex ? 'expresión regular (hilo)' : 'literal (hilo principal)'}: too_large, en poco tiempo y sin pico de memoria`, async () => {
      const { instance } = await library();
      // 30 000 «e» por un reemplazo de 10 000: 300 M de caracteres si se construyera.
      const big = await createNote(instance, `# Grande\n${'e'.repeat(30_000)}\n`);
      const small = await createNote(instance, '# Pequeña\ne\n');
      const batch = new ReplaceBatch(instance.port, instance);
      const heapBefore = process.memoryUsage().heapUsed;
      const started = Date.now();
      const plan = (await batch.run(simulate('e', 'x'.repeat(10_000), { regex }))).result as ReplacePlanView;
      const elapsed = Date.now() - started;
      const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
      expect(plan.skipped).toEqual([{ id: big, title: 'Grande', reason: 'too_large' }]);
      expect(plan.notes.map((note) => note.id)).toEqual([small]);
      expect(elapsed).toBeLessThan(2_000);
      expect(heapGrowth).toBeLessThan(100 * 1024 * 1024);
    }, 60_000);
  }

  it('el plazo se mira también dentro de una nota grande con un literal', async () => {
    const { instance } = await library();
    const big = await createNote(instance, `# Muchas líneas\n${'a\n'.repeat(400_000)}`);
    const batch = new ReplaceBatch(instance.port, instance, { simulateBudgetMs: 1 });
    const started = Date.now();
    const plan = (await batch.run(simulate('a', 'b'))).result as ReplacePlanView;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(plan.notes).toEqual([]);
    expect(plan.cutoff).toBe('time');
    expect(plan.skipped).toEqual([{ id: big, title: 'Muchas líneas', reason: 'too_slow' }]);
  }, 60_000);
});

describe('M2: tope de planes guardados sin aplicar', () => {
  it('al pasar el número, cae el más antiguo sin aplicar; uno aplicado se queda', async () => {
    const { dataDir, instance } = await library();
    await createNote(instance, '# N\n\nfoo\n');
    const batch = new ReplaceBatch(instance.port, instance, { maxStoredPlans: 3 });
    const applied = ((await batch.run(simulate('foo', 'bar'))).result as ReplacePlanView).planId!;
    await batch.run({ mode: 'apply', planId: applied, operationId: 'op-m2', privacy: OPEN });
    const plans: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      plans.push(((await batch.run(simulate('bar', `baz${i}`))).result as ReplacePlanView).planId!);
    }
    const stored = query<{ plan_id: string }>(dataDir, 'SELECT plan_id FROM hebra_mcp_replace_plans').map(
      (row) => row.plan_id
    );
    expect(stored).not.toContain(plans[0]);
    for (const planId of plans.slice(1)) expect(stored).toContain(planId);
    expect(stored).toContain(applied);
    expect(await codeOf(batch.run({ mode: 'apply', planId: plans[0]!, operationId: 'op-x', privacy: OPEN }))).toBe(
      'plan_not_found'
    );
    // El aplicado se sigue pudiendo deshacer.
    const undo = (await batch.run({ mode: 'undo', planId: applied, privacy: OPEN })).result as ReplaceUndoReport;
    expect(undo.notes.map((note) => note.outcome)).toEqual(['restored']);
  });

  it('al pasar los caracteres, también cae el más antiguo sin aplicar', async () => {
    const { dataDir, instance } = await library();
    await createNote(instance, `# N\n\n${'foo '.repeat(1_000)}\n`);
    // Cada resultado mide unos 3 000 caracteres («foo » → «bN »): el tercero no cabe con
    // los dos anteriores.
    const batch = new ReplaceBatch(instance.port, instance, { maxStoredPlanChars: 8_000 });
    const plans: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      plans.push(((await batch.run(simulate('foo', `b${i}`))).result as ReplacePlanView).planId!);
    }
    const stored = query<{ plan_id: string }>(dataDir, 'SELECT plan_id FROM hebra_mcp_replace_plans').map((row) => row.plan_id);
    expect(stored).not.toContain(plans[0]);
    expect(stored).toContain(plans[2]);
  });
});

describe('M3: los planes caducados se purgan solos', () => {
  it('en checkWriter (el temporizador) y al pasar a escritor, sin volver a llamar a la herramienta', async () => {
    const dataDir = tempDir();
    const first = await openWriter(dataDir);
    await createNote(first.instance, '# N\n\nfoo\n');
    const old = ((await first.call({ mode: 'simulate', pattern: 'foo', replacement: 'bar' })) as ReplacePlanView).planId!;
    exec(dataDir, 'UPDATE hebra_mcp_replace_plans SET created_at = created_at - ? WHERE plan_id = ?', 25 * 3600_000, old);
    await first.instance.checkWriter();
    expect(query(dataDir, 'SELECT plan_id FROM hebra_mcp_replace_plans WHERE plan_id = ?', old)).toEqual([]);
    expect(query(dataDir, 'SELECT plan_id FROM hebra_mcp_replace_plan_notes WHERE plan_id = ?', old)).toEqual([]);

    const other = ((await first.call({ mode: 'simulate', pattern: 'foo', replacement: 'baz' })) as ReplacePlanView).planId!;
    await first.instance.close();
    exec(dataDir, 'UPDATE hebra_mcp_replace_plans SET created_at = created_at - ? WHERE plan_id = ?', 25 * 3600_000, other);
    const second = await openWriter(dataDir);
    instances.push(second.instance);
    const deadline = Date.now() + 2_000;
    while (query(dataDir, 'SELECT plan_id FROM hebra_mcp_replace_plans WHERE plan_id = ?', other).length > 0) {
      if (Date.now() > deadline) throw new Error('el plan caducado sigue ahí tras pasar a escritor');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
});

describe('M4: undo con otra configuración de privados', () => {
  it('vuelve a la base con cualquier configuración resoluble; lo que oculta no se toca ni se nombra', async () => {
    const { dataDir, instance, call } = await library();
    await createFolder(instance, 'Diario');
    const visible = await createNote(instance, '# Visible\n\nfoo\n');
    const later = await createNote(instance, '# Luego oculta\n\nfoo\n');
    const plan = (await call({ mode: 'simulate', pattern: 'foo', replacement: 'bar' })) as ReplacePlanView;
    await call({ mode: 'apply', planId: plan.planId!, operationId: 'op-m4' });
    // Cambia config.json: la carpeta Diario pasa a ser privada, y `later` va a ella.
    const diario = (await instance.port.foldersList()).folders.find((folder) => folder.name === 'Diario')!.id;
    await instance.organize({ action: 'moveNote', id: later, folderId: diario, privacy: OPEN });
    const privacy = { privateFolders: [['diario']], privateTags: [] };
    const undo = (await call({ mode: 'undo', planId: plan.planId! }, privacy)) as ReplaceUndoReport;
    expect(undo.notes.map((note) => [note.id, note.outcome])).toEqual([[visible, 'restored']]);
    expect(JSON.stringify(undo)).not.toContain(later);
    expect(JSON.stringify(undo)).not.toContain('Luego oculta');
    expect(noteState(dataDir, visible).body).toBe('# Visible\n\nfoo\n');
    expect(noteState(dataDir, later).body).toBe('# Luego oculta\n\nbar\n');
    // `preview` y `apply` siguen ligados a la configuración con que se simuló.
    expect(await codeOf(call({ mode: 'apply', planId: plan.planId!, operationId: 'op-m4b' }, privacy))).toBe('plan_not_found');
  });
});
