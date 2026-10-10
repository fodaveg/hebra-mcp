/**
 * `hebra_replace_in_notes` (D14, SPEC.md §5) sobre un escritor real sin sync: simular no
 * escribe, aplicar escribe SOLO lo simulado con instantánea forzada y prueba de lo
 * guardado, reintentar con el mismo `operationId` no escribe, un choque deja copia de
 * conflicto, deshacer devuelve el lote entero y no toca lo cambiado después, y los topes,
 * la caducidad, la configuración de privados del plan, la etiqueta privada del resultado
 * y una expresión catastrófica.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeRevision } from '../../src/store/revision';
import { ReplaceBatch, type ReplaceApplyReport, type ReplacePlanView, type ReplaceUndoReport } from '../../src/store/replace-batch';
import type { LibraryInstance } from '../../src/sync/library-instance';
import {
  allNotes,
  codeOf,
  createFolder,
  createNote,
  exec,
  noteState,
  OPEN,
  openWriter,
  query,
  removeTempDirs,
  tempDir,
  versionBodies
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

const SIMULATE = { mode: 'simulate', pattern: 'foo', replacement: 'bar' } as const;

describe('simular, aplicar y reintentar', () => {
  it('simular no escribe; aplicar escribe lo simulado con instantánea; el mismo operationId no repite', async () => {
    const { dataDir, instance, call } = await library();
    const folder = await createFolder(instance, 'Proyectos');
    const seeds = {
      uno: '# Uno\n\nfoo y FOO\n',
      dos: '# Dos\n\nnada que ver\n',
      tres: '# Tres\n\n- foo\n- otro\n',
      cuatro: '# Cuatro\n\nfoofoo\n'
    };
    const ids = {
      uno: await createNote(instance, seeds.uno),
      dos: await createNote(instance, seeds.dos),
      tres: await createNote(instance, seeds.tres),
      cuatro: await createNote(instance, seeds.cuatro, folder)
    };
    const before = Object.fromEntries(Object.values(ids).map((id) => [id, noteState(dataDir, id).local_seq]));

    const plan = (await call(SIMULATE)) as ReplacePlanView;
    expect(plan.mode).toBe('simulate');
    expect(plan.planId).toEqual(expect.any(String));
    expect(plan.planNotes).toBe(3);
    expect(plan.planMatches).toBe(5);
    expect(plan.cutoff).toBeNull();
    expect(plan.continueAfter).toBeNull();
    const byId = new Map(plan.notes.map((note) => [note.id, note]));
    expect(byId.get(ids.uno)).toMatchObject({
      title: 'Uno',
      isConflictCopy: false,
      matches: 2,
      changes: [{ line: 3, column: 1, before: 'foo y FOO', after: 'bar y bar' }]
    });
    expect(byId.has(ids.dos)).toBe(false);
    // Simular no toca ninguna nota.
    for (const id of Object.values(ids)) expect(noteState(dataDir, id).local_seq).toBe(before[id]);

    const report = (await call({ mode: 'apply', planId: plan.planId!, operationId: 'op-1' })) as ReplaceApplyReport & {
      sync: string;
    };
    expect(report).toMatchObject({ mode: 'apply', planId: plan.planId, complete: true, sync: 'not_linked' });
    expect(report.replayed).toBeUndefined();
    expect(report.notes.map((note) => note.outcome)).toEqual(['applied', 'applied', 'applied']);
    for (const note of report.notes) {
      // La prueba sale de lo guardado: la revisión vale como `expectedRevision`.
      const row = query<{ local_seq: number; body_sha256: string; body: string }>(
        dataDir,
        'SELECT local_seq, body_sha256, body FROM notes WHERE id = ?',
        note.id
      )[0]!;
      const libraryId = query<{ value: string }>(dataDir, "SELECT value FROM meta WHERE key = 'library_id'")[0]!.value;
      expect(note.revision).toBe(encodeRevision({ libraryId, noteId: note.id, localSeq: row.local_seq, bodySha256: row.body_sha256 }));
      expect(note.totalChars).toBe(row.body.length);
      expect(note.bodySha256).toBe(row.body_sha256);
    }
    expect(noteState(dataDir, ids.uno).body).toBe('# Uno\n\nbar y bar\n');
    expect(noteState(dataDir, ids.cuatro).body).toBe('# Cuatro\n\nbarbar\n');
    expect(noteState(dataDir, ids.dos).body).toBe(seeds.dos);
    // Instantánea forzada: el cuerpo base queda como versión anterior aunque la nota sea
    // de hace un segundo (la automática es una cada 5 minutos).
    expect(versionBodies(dataDir, ids.uno)).toContain(seeds.uno);
    // Y el cuerpo base del lote, en el plan (AC6).
    expect(
      query<{ base_body: string }>(dataDir, 'SELECT base_body FROM hebra_mcp_replace_plan_notes WHERE note_id = ?', ids.uno)[0]!
        .base_body
    ).toBe(seeds.uno);

    // Reintentar con el mismo operationId: lo anotado, sin escribir.
    const seqs = Object.values(ids).map((id) => noteState(dataDir, id).local_seq);
    const again = (await call({ mode: 'apply', planId: plan.planId!, operationId: 'op-1' })) as ReplaceApplyReport;
    expect(again.replayed).toBe(true);
    expect(again.notes).toEqual(report.notes);
    expect(Object.values(ids).map((id) => noteState(dataDir, id).local_seq)).toEqual(seqs);
    // Con otro operationId, el plan ya está aplicado.
    expect(await codeOf(call({ mode: 'apply', planId: plan.planId!, operationId: 'op-2' }))).toBe('plan_already_applied');
  });

  it('el operationId se comparte con las demás escrituras: el de otra no vale', async () => {
    const { instance, call } = await library();
    const id = await createNote(instance, '# Nota\n\nfoo\n');
    await instance.appendToNote({ id, text: 'más', operationId: 'op-append', privacy: OPEN });
    const plan = (await call(SIMULATE)) as ReplacePlanView;
    expect(await codeOf(call({ mode: 'apply', planId: plan.planId!, operationId: 'op-append' }))).toBe(
      'operation_id_reused'
    );
    await call({ mode: 'apply', planId: plan.planId!, operationId: 'op-plan' });
    // Y al revés: el de una aplicación no vale para editar.
    await expect(
      instance.appendToNote({ id, text: 'otra', operationId: 'op-plan', privacy: OPEN })
    ).rejects.toMatchObject({ code: 'operation_id_reused' });
  });

  it('la entrada de otro modo, o la que falta, es invalid_input sin tocar nada', async () => {
    const { call } = await library();
    const cases = [
      { mode: 'simulate', pattern: 'foo' },
      { mode: 'simulate', pattern: '', replacement: 'x' },
      { mode: 'simulate', pattern: 'a\nb', replacement: 'x' },
      { mode: 'simulate', pattern: '(', replacement: 'x', regex: true },
      { mode: 'simulate', pattern: '(a)', replacement: '$2', regex: true },
      { mode: 'simulate', pattern: 'foo', replacement: 'x', planId: 'p' },
      { mode: 'simulate', pattern: 'foo', replacement: 'x', after: 'rc1.no' },
      { mode: 'apply', planId: 'p' },
      { mode: 'apply', planId: 'p', operationId: '' },
      { mode: 'apply', planId: 'p', operationId: 'o', pattern: 'foo' },
      { mode: 'preview', planId: 'p' },
      { mode: 'undo' }
    ] as const;
    for (const input of cases) {
      expect(await codeOf(call(input as never)), JSON.stringify(input)).toBe('invalid_input');
    }
    expect(await codeOf(call({ mode: 'apply', planId: 'no-existe', operationId: 'o' }))).toBe('plan_not_found');
  });
});

describe('choque y vuelta atrás', () => {
  it('una nota editada entre simular y aplicar deja una copia de conflicto; deshacer la manda a la papelera', async () => {
    const { dataDir, instance, call } = await library();
    const a = await createNote(instance, '# A\n\nfoo\n');
    const b = await createNote(instance, '# B\n\nfoo\n');
    const plan = (await call(SIMULATE)) as ReplacePlanView;
    await instance.appendToNote({ id: a, text: 'OTRO', privacy: OPEN });

    const report = (await call({ mode: 'apply', planId: plan.planId!, operationId: 'op-c' })) as ReplaceApplyReport;
    const entryA = report.notes.find((note) => note.id === a)!;
    expect(entryA.outcome).toBe('conflict_copy');
    expect(entryA.revision).toBeUndefined();
    const copy = noteState(dataDir, entryA.copyId!);
    expect(copy.conflict_of).toBe(a);
    expect(copy.body).toBe('# A\n\nbar\n');
    // El original conserva la edición ajena y no lleva el resultado.
    expect(noteState(dataDir, a).body).toBe('# A\n\nfoo\n\n\nOTRO');
    expect(report.notes.find((note) => note.id === b)!.outcome).toBe('applied');

    const undo = (await call({ mode: 'undo', planId: plan.planId! })) as ReplaceUndoReport;
    expect(undo.notes.find((note) => note.id === a)).toEqual({
      id: a,
      title: 'A',
      copyId: entryA.copyId,
      copyOutcome: 'trashed'
    });
    expect(undo.notes.find((note) => note.id === b)).toMatchObject({ outcome: 'restored' });
    expect(noteState(dataDir, entryA.copyId!).trashed_at).not.toBeNull();
    expect(noteState(dataDir, a).body).toBe('# A\n\nfoo\n\n\nOTRO');
    expect(noteState(dataDir, b).body).toBe('# B\n\nfoo\n');
  });

  it('deshacer el lote entero; una nota cambiada después no se toca, y repetir no cambia nada más', async () => {
    const { dataDir, instance, call } = await library();
    const seeds = ['# N1\n\nfoo uno\n', '# N2\n\nfoo dos\n', '# N3\n\nfoo tres\n'];
    const ids = [];
    for (const seed of seeds) ids.push(await createNote(instance, seed));
    const plan = (await call(SIMULATE)) as ReplacePlanView;
    await call({ mode: 'apply', planId: plan.planId!, operationId: 'op-u' });
    await instance.appendToNote({ id: ids[1]!, text: 'después', privacy: OPEN });

    const undo = (await call({ mode: 'undo', planId: plan.planId! })) as ReplaceUndoReport & { sync: string };
    expect(undo.sync).toBe('not_linked');
    expect(Object.fromEntries(undo.notes.map((note) => [note.id, note.outcome]))).toEqual({
      [ids[0]!]: 'restored',
      [ids[1]!]: 'changed',
      [ids[2]!]: 'restored'
    });
    expect(noteState(dataDir, ids[0]!).body).toBe(seeds[0]);
    expect(noteState(dataDir, ids[2]!).body).toBe(seeds[2]);
    expect(noteState(dataDir, ids[1]!).body).toBe('# N2\n\nbar dos\n\n\ndespués');
    // Con instantánea antes de volver: el resultado del lote queda como versión anterior.
    expect(versionBodies(dataDir, ids[0]!)).toContain('# N1\n\nbar uno\n');

    const seqs = ids.map((id) => noteState(dataDir, id).local_seq);
    const again = (await call({ mode: 'undo', planId: plan.planId! })) as ReplaceUndoReport;
    expect(Object.fromEntries(again.notes.map((note) => [note.id, note.outcome]))).toEqual({
      [ids[0]!]: 'already',
      [ids[1]!]: 'changed',
      [ids[2]!]: 'already'
    });
    expect(ids.map((id) => noteState(dataDir, id).local_seq)).toEqual(seqs);
    // Deshecho, aplicar con el mismo operationId no vuelve a escribir.
    const replay = (await call({ mode: 'apply', planId: plan.planId!, operationId: 'op-u' })) as ReplaceApplyReport;
    expect(replay.replayed).toBe(true);
    expect(ids.map((id) => noteState(dataDir, id).local_seq)).toEqual(seqs);
  });
});

describe('topes, páginas y caducidad', () => {
  it('maxNotes corta el plan y continueAfter sigue el ámbito; preview pagina el mismo plan', async () => {
    const { instance, call } = await library();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await createNote(instance, `# Nota ${i}\n\nfoo ${i}\n`));
    await createNote(instance, '# Sin\n\nnada\n');
    const seen: string[] = [];
    let after: string | undefined;
    for (let round = 0; round < 5; round += 1) {
      const plan = (await call({ ...SIMULATE, maxNotes: 2, limit: 1, ...(after ? { after } : {}) })) as ReplacePlanView;
      const pageIds = plan.notes.map((note) => note.id);
      let cursor = plan.nextCursor;
      while (cursor) {
        const page = (await call({ mode: 'preview', planId: plan.planId!, cursor, limit: 1 })) as ReplacePlanView;
        pageIds.push(...page.notes.map((note) => note.id));
        cursor = page.nextCursor;
      }
      expect(pageIds).toHaveLength(plan.planNotes!);
      seen.push(...pageIds);
      if (!plan.continueAfter) {
        expect(plan.cutoff).toBeNull();
        break;
      }
      expect(plan.cutoff).toBe('maxNotes');
      after = plan.continueAfter;
    }
    expect(seen.sort()).toEqual([...ids].sort());
    // Una página con un cursor de otro plan, o roto: invalid_input.
    const plan = (await call(SIMULATE)) as ReplacePlanView;
    const other = (await call({ ...SIMULATE, limit: 1 })) as ReplacePlanView;
    expect(await codeOf(call({ mode: 'preview', planId: plan.planId!, cursor: other.nextCursor! }))).toBe('invalid_input');
    expect(await codeOf(call({ mode: 'preview', planId: plan.planId!, cursor: 'rp1.x' }))).toBe('invalid_input');
  });

  it('un plan caducado no se aplica; uno de otra configuración de privados no existe', async () => {
    const { dataDir, instance, call } = await library();
    const id = await createNote(instance, '# N\n\nfoo\n');
    const plan = (await call(SIMULATE)) as ReplacePlanView;
    const other = { privateFolders: [], privateTags: ['otra'] };
    expect(await codeOf(call({ mode: 'apply', planId: plan.planId!, operationId: 'o1' }, other))).toBe('plan_not_found');
    expect(await codeOf(call({ mode: 'undo', planId: plan.planId! }, other))).toBe('plan_not_found');
    const cursor = `rp1.${Buffer.from(JSON.stringify([plan.planId, 0])).toString('base64url')}`;
    expect(await codeOf(call({ mode: 'preview', planId: plan.planId!, cursor }, other))).toBe('plan_not_found');
    expect(((await call({ mode: 'preview', planId: plan.planId!, cursor })) as ReplacePlanView).notes).toHaveLength(1);

    exec(dataDir, 'UPDATE hebra_mcp_replace_plans SET created_at = created_at - ? WHERE plan_id = ?', 2 * 60 * 60 * 1000, plan.planId!);
    expect(await codeOf(call({ mode: 'apply', planId: plan.planId!, operationId: 'o2' }))).toBe('plan_expired');
    expect(noteState(dataDir, id).body).toBe('# N\n\nfoo\n');
    // A las 24 h sin aplicar, el plan se borra.
    exec(dataDir, 'UPDATE hebra_mcp_replace_plans SET created_at = created_at - ? WHERE plan_id = ?', 23 * 60 * 60 * 1000, plan.planId!);
    expect(await codeOf(call({ mode: 'apply', planId: plan.planId!, operationId: 'o3' }))).toBe('plan_not_found');
  });

  it('una etiqueta privada creada por el reemplazo: la nota no entra, como si no existiera', async () => {
    const { dataDir, instance, call } = await library();
    const privacy = { privateFolders: [], privateTags: ['secreto'] };
    const id = await createNote(instance, '# N\n\nfoo\n');
    const blocked = (await call({ ...SIMULATE, replacement: '#secreto/sub' }, privacy)) as ReplacePlanView;
    expect(blocked).toMatchObject({ planId: null, notes: [], planNotes: 0, cutoff: null, continueAfter: null });
    expect(blocked.skipped).toBeUndefined();
    const allowed = (await call({ ...SIMULATE, replacement: '#secretos' }, privacy)) as ReplacePlanView;
    expect(allowed.notes.map((note) => note.id)).toEqual([id]);
    expect(noteState(dataDir, id).body).toBe('# N\n\nfoo\n');
  });

  it('una expresión catastrófica la corta el plazo: se salta esa nota, se dice y el servidor sigue', async () => {
    const dataDir = tempDir();
    const { instance } = await openWriter(dataDir);
    instances.push(instance);
    const slow = await createNote(instance, `# Lenta\n${'a'.repeat(40)}!\n`);
    const fast = await createNote(instance, '# Rápida\naaa\n');
    const ordered = [slow, fast].sort();
    const batch = new ReplaceBatch(instance.port, instance, { simulateBudgetMs: 300 });
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 20);
    const started = Date.now();
    const request = {
      mode: 'simulate' as const,
      pattern: '(a+)+$',
      regex: true,
      caseSensitive: false,
      replacement: 'x',
      scope: {},
      maxNotes: 200,
      limit: 50,
      privacy: OPEN
    };
    let result = (await batch.run(request)).result as ReplacePlanView;
    clearInterval(timer);
    expect(Date.now() - started).toBeLessThan(5_000);
    // El bucle de eventos siguió vivo mientras el hilo se colgaba.
    expect(ticks).toBeGreaterThan(3);
    if (ordered[0] === fast) {
      // La rápida va antes: entra, y la lenta corta el plan (se reintenta desde ella).
      expect(result.notes.map((note) => note.id)).toEqual([fast]);
      expect(result.cutoff).toBe('time');
      result = (await batch.run({ ...request, after: result.continueAfter! })).result as ReplacePlanView;
    }
    expect(result.skipped).toEqual([{ id: slow, title: 'Lenta', reason: 'too_slow' }]);
    expect(result.cutoff).toBe('time');
    expect(result.notes.map((note) => note.id)).not.toContain(slow);
    const rest = (await batch.run({ ...request, after: result.continueAfter! })).result as ReplacePlanView;
    expect(rest.notes.map((note) => note.id)).toEqual(ordered[0] === slow ? [fast] : []);
    expect(noteState(dataDir, slow).body).toBe(`# Lenta\n${'a'.repeat(40)}!\n`);
    expect(allNotes(dataDir)).toHaveLength(2);
  });
});
