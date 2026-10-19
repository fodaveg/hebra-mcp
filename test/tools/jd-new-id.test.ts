/**
 * `hebra_jd_new_id` (D18, 19 oct 2026; SPEC.md §5) por el cliente MCP, con la puerta final:
 * simular no escribe nada y guarda un plan; aplicar escribe exactamente lo simulado (la nota
 * del JDex con la plantilla y el título derivado, y la carpeta del ID); el mismo
 * `operationId` no repite nada. Los tres casos de reintento del contrato:
 * (1) un `apply` que se corta tras crear la nota y antes de la carpeta se completa con el
 *     mismo `operationId`, sin duplicar la nota;
 * (2) otra carpeta con ese ID y otro nombre entre simular y aplicar: `plan_stale`, sin
 *     escribir;
 * (3) la categoría pasa a tener algo oculto entre simular y aplicar: `plan_stale`.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { LibraryPort } from '../../src/jd';
import { runJdNewId } from '../../src/store/jd-new-id';
import { JD_PLANS_SQLITE_FILE } from '../../src/store/jd-plans';
import { startJd, JD_DEFAULT_CONFIG, type JdHarness } from '../fixtures/jd-library';
import { createNote } from '../fixtures/test-library';

describe('hebra_jd_new_id (D18)', () => {
  let h: JdHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function simulate(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await h!.call('hebra_jd_new_id', { mode: 'simulate', category: '21', title: 'Nuevo', ...args });
    expect(result.isError, JSON.stringify(result.value)).toBe(false);
    return result.value;
  }

  it('simular no escribe nada y devuelve el plan; aplicar escribe la nota y la carpeta; repetir no duplica', async () => {
    h = await startJd();
    const foldersBefore = h.rawFolders();
    const notesBefore = h.rawNotes();
    const plan = await simulate();
    expect(plan).toMatchObject({
      mode: 'simulate',
      id: '21.13',
      system: '',
      noteName: '21.13 Nuevo',
      folderName: '21.13 Nuevo',
      category: { number: '21', label: '21 Productos', folderId: h.ids.category21 },
      resolved: { jdex: { id: h.ids.jdex, name: '00.00 JDex' }, templates: { id: h.ids.templates, name: '00.03 Plantillas' } },
      template: { source: 'templates-folder', noteName: 'JDex - id', noteId: h.ids.templateNote }
    });
    expect(typeof plan.planId).toBe('string');
    const writes = plan.writes as Array<Record<string, unknown>>;
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ kind: 'ensure_note', folderId: h.ids.jdex, title: '21.13 Nuevo' });
    expect(String(writes[0]!.body)).toContain('Plantilla propia de 21 Productos.');
    expect(writes[1]).toEqual({ kind: 'ensure_folder', parent: { folderId: h.ids.category21 }, name: '21.13 Nuevo' });
    expect(h.rawFolders()).toEqual(foldersBefore);
    expect(h.rawNotes()).toEqual(notesBefore);

    const applied = await h.call('hebra_jd_new_id', { mode: 'apply', planId: plan.planId, operationId: 'op-1' });
    expect(applied.isError, JSON.stringify(applied.value)).toBe(false);
    expect(applied.value).toMatchObject({ mode: 'apply', id: '21.13', noteName: '21.13 Nuevo', existing: [], sync: 'not_linked' });
    const created = applied.value.created as Array<{ kind: string; id: string; name: string }>;
    expect(created.map((item) => [item.kind, item.name])).toEqual([
      ['note', '21.13 Nuevo'],
      ['folder', '21.13 Nuevo']
    ]);
    const note = h.rawNotes().find((row) => row.id === created[0]!.id)!;
    expect(note).toMatchObject({ folderId: h.ids.jdex, title: '21.13 Nuevo' });
    expect(note.body).toContain('title: "21.13 Nuevo"');
    expect(note.body).toContain('Plantilla propia de 21 Productos.');
    expect(h.rawFolders().find((row) => row.id === created[1]!.id)).toEqual({
      id: created[1]!.id,
      parentId: h.ids.category21,
      name: '21.13 Nuevo'
    });

    const again = await h.call('hebra_jd_new_id', { mode: 'apply', planId: plan.planId, operationId: 'op-1' });
    expect(again.value).toMatchObject({ mode: 'apply', replayed: true, created });
    expect(h.rawNotes().filter((row) => row.title === '21.13 Nuevo')).toHaveLength(1);
    expect(h.rawFolders().filter((row) => row.name === '21.13 Nuevo')).toHaveLength(1);

    // El siguiente ID de la categoría ya cuenta el nuevo.
    expect((await simulate({ title: 'Otro' })).id).toBe('21.14');
  });

  it('sin carpeta (`createFolder: false`) solo escribe la nota; una categoría sin carpeta pide crearla', async () => {
    h = await startJd({
      prepare: async (engine, ids) => {
        await createNote(engine, ids.jdex, '# 23 Sin carpeta\n');
      }
    });
    const plan = await simulate({ createFolder: false });
    expect(plan.folderName).toBeNull();
    expect(plan.writes as unknown[]).toHaveLength(1);
    const failed = await h.call('hebra_jd_new_id', { mode: 'simulate', category: '23', title: 'X' });
    expect(failed).toEqual({ isError: true, value: { error: 'category_folder_not_found' } });
    const missing = await h.call('hebra_jd_new_id', { mode: 'simulate', category: '29', title: 'X' });
    expect(missing).toEqual({ isError: true, value: { error: 'category_not_found' } });
    const empty = await h.call('hebra_jd_new_id', { mode: 'simulate', category: '21', title: '  ' });
    expect(empty).toEqual({ isError: true, value: { error: 'invalid_title' } });
  });

  it('valida la entrada sin eco: campos de otro modo, categoría mal escrita, plan inexistente', async () => {
    h = await startJd();
    for (const args of [
      { mode: 'simulate', title: 'X' },
      { mode: 'simulate', category: '2', title: 'X' },
      { mode: 'simulate', category: '21', title: 'X', planId: 'p' },
      { mode: 'apply', planId: 'p' },
      { mode: 'apply', planId: 'p', operationId: 'o', category: '21' }
    ]) {
      expect(await h.call('hebra_jd_new_id', args), JSON.stringify(args)).toEqual({
        isError: true,
        value: { error: 'invalid_input' }
      });
    }
    expect(await h.call('hebra_jd_new_id', { mode: 'apply', planId: 'no-existe', operationId: 'o' })).toEqual({
      isError: true,
      value: { error: 'plan_not_found' }
    });
  });

  it('(1) un apply que se corta tras crear la nota se completa con el mismo operationId, sin duplicar la nota', async () => {
    h = await startJd();
    const plan = await simulate();
    let cut = true;
    const cutting = (port: LibraryPort): LibraryPort => ({
      listFolders: () => port.listFolders(),
      listNotes: (id) => port.listNotes(id),
      readNote: (id) => port.readNote(id),
      hasHidden: (category) => port.hasHidden(category),
      ensureNote: (folderId, title, body) => port.ensureNote(folderId, title, body),
      ensureFolder: async (parentId, name) => {
        if (cut) {
          cut = false;
          throw new Error('corte simulado');
        }
        return port.ensureFolder(parentId, name);
      }
    });
    let rounds = 0;
    await expect(
      runJdNewId(
        h.port,
        { mode: 'apply', planId: String(plan.planId), operationId: 'op-cut', privacy: JD_DEFAULT_CONFIG },
        () => {
          rounds += 1;
        },
        { port: cutting }
      )
    ).rejects.toThrow('corte simulado');
    // La nota quedó escrita (y pidió su ronda); la carpeta, no.
    expect(rounds).toBe(1);
    expect(h.rawNotes().filter((row) => row.title === '21.13 Nuevo')).toHaveLength(1);
    expect(h.rawFolders().filter((row) => row.name === '21.13 Nuevo')).toHaveLength(0);

    const retried = await h.call('hebra_jd_new_id', { mode: 'apply', planId: plan.planId, operationId: 'op-cut' });
    expect(retried.isError, JSON.stringify(retried.value)).toBe(false);
    const created = retried.value.created as Array<{ kind: string; name: string }>;
    const existing = retried.value.existing as Array<{ kind: string; name: string }>;
    expect(created.map((item) => item.kind)).toEqual(['folder']);
    expect(existing.map((item) => [item.kind, item.name])).toEqual([['note', '21.13 Nuevo']]);
    expect(h.rawNotes().filter((row) => row.title === '21.13 Nuevo')).toHaveLength(1);
    expect(h.rawFolders().filter((row) => row.name === '21.13 Nuevo')).toHaveLength(1);
  });

  it('(2) otra carpeta con ese ID y otro nombre entre simular y aplicar: plan_stale, sin escribir', async () => {
    h = await startJd();
    const plan = await simulate();
    await h.withEngine((engine) => engine.folderCreate(h!.ids.category21, '21.13 De otro dispositivo'));
    const foldersBefore = h.rawFolders();
    const notesBefore = h.rawNotes();
    expect(await h.call('hebra_jd_new_id', { mode: 'apply', planId: plan.planId, operationId: 'op-2' })).toEqual({
      isError: true,
      value: { error: 'plan_stale' }
    });
    expect(h.rawFolders()).toEqual(foldersBefore);
    expect(h.rawNotes()).toEqual(notesBefore);
  });

  it('(3) la categoría pasa a tener algo oculto entre simular y aplicar: plan_stale, sin escribir', async () => {
    h = await startJd();
    const plan = await simulate();
    await h.withEngine((engine) => createNote(engine, h!.ids.jdex, '# 21.19 Oculta\n\n#secreto\n'));
    const notesBefore = h.rawNotes();
    const result = await h.call('hebra_jd_new_id', { mode: 'apply', planId: plan.planId, operationId: 'op-3' });
    expect(result).toEqual({ isError: true, value: { error: 'plan_stale' } });
    expect(JSON.stringify(result)).not.toContain('21.19');
    expect(h.rawNotes()).toEqual(notesBefore);
  });

  it('un plan vale una hora y solo con la configuración de privados con que se simuló', async () => {
    h = await startJd();
    const plan = await simulate();
    // Los planes viven en su propio fichero, junto a la biblioteca.
    const plans = new DatabaseSync(join(h.test.dataDir, JD_PLANS_SQLITE_FILE));
    try {
      plans
        .prepare('UPDATE hebra_mcp_jd_plans SET created_at = created_at - ? WHERE plan_id = ?')
        .run(61 * 60 * 1000, String(plan.planId));
    } finally {
      plans.close();
    }
    expect(await h.call('hebra_jd_new_id', { mode: 'apply', planId: plan.planId, operationId: 'op-4' })).toEqual({
      isError: true,
      value: { error: 'plan_expired' }
    });
    const other = await simulate();
    await expect(
      runJdNewId(
        h.port,
        {
          mode: 'apply',
          planId: String(other.planId),
          operationId: 'op-5',
          privacy: { privateFolders: [['diario']], privateTags: [] }
        },
        () => {}
      )
    ).rejects.toMatchObject({ code: 'plan_not_found' });
  });
});
