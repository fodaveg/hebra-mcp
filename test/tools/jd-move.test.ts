/**
 * `hebra_jd_move` (D19, 19 oct 2026; SPEC.md §5) por el cliente MCP, con la puerta final:
 * mover una nota con `as`, un fichero a una subcarpeta que se crea y una carpeta entera;
 * repetir con el mismo `operationId`; un `apply` cortado a mitad que se completa; `plan_stale`
 * si algo cambió entre simular y aplicar; deshacer, también con una pieza que se movió
 * después (`not_where_left`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LibraryMovePort } from '../../src/jd';
import { runJdMove } from '../../src/store/jd-move';
import { JD_DEFAULT_CONFIG, startJd, type JdHarness } from '../fixtures/jd-library';
import { createNote } from '../fixtures/test-library';

const PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');

describe('hebra_jd_move (D19)', () => {
  let h: JdHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function simulate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await h!.call('hebra_jd_move', { mode: 'simulate', ...args });
    expect(result.isError, JSON.stringify(result.value)).toBe(false);
    return result.value;
  }

  async function apply(planId: unknown, operationId: string): Promise<Record<string, unknown>> {
    const result = await h!.call('hebra_jd_move', { mode: 'apply', planId, operationId });
    expect(result.isError, JSON.stringify(result.value)).toBe(false);
    return result.value;
  }

  function folderNamed(name: string) {
    return h!.rawFolders().find((folder) => folder.name === name);
  }

  it('una nota con `as`: a la carpeta del ID con el título nuevo; repetir no hace nada más', async () => {
    let noteId = '';
    h = await startJd({
      prepare: async (engine) => {
        noteId = (await createNote(engine, null, '# Factura luz\n\nImporte.\n')).id;
      }
    });
    const notesBefore = h.rawNotes();
    const plan = await simulate({ kind: 'note', id: noteId, toId: '21.11', as: 'Factura de la luz' });
    expect(plan).toMatchObject({
      mode: 'simulate',
      id: '21.11',
      destination: { folderName: '21.11 Uno', subfolder: null },
      move: {
        kind: 'note',
        id: noteId,
        name: 'Factura luz',
        from: { folderId: 'root', folderPath: '' },
        to: { folderId: h.ids.id2111, name: 'Factura de la luz' }
      },
      createFolders: []
    });
    expect(h.rawNotes()).toEqual(notesBefore);

    const applied = await apply(plan.planId, 'op-n');
    expect(applied).toMatchObject({
      mode: 'apply',
      moved: [{ kind: 'note', id: noteId, fromName: 'Factura luz', toName: 'Factura de la luz' }],
      alreadyDone: [],
      created: [],
      sync: 'not_linked'
    });
    const note = h.rawNotes().find((row) => row.id === noteId)!;
    expect(note).toMatchObject({ folderId: h.ids.id2111, title: 'Factura de la luz' });
    expect(note.body).toContain('Importe.');
    expect(await apply(plan.planId, 'op-n')).toEqual({ ...applied, replayed: true });
  });

  it('un fichero a una subcarpeta que se crea', async () => {
    let fileId = '';
    h = await startJd({
      prepare: async (engine) => {
        const blob = await engine.blobPut(PDF, { mime: 'application/pdf' });
        fileId = (await engine.fileCreate(null, 'contrato.pdf', blob.sha256)).id;
      }
    });
    const plan = await simulate({ kind: 'file', id: fileId, toId: '21.12', subfolder: 'Docs' });
    expect(plan.createFolders).toEqual([{ name: 'Docs', folderPath: '20-29 trabajo/21 productos/21.12 dos/docs' }]);
    expect(plan.move).toMatchObject({ kind: 'file', to: { folderId: null, name: 'contrato.pdf' } });
    expect(folderNamed('Docs')).toBeUndefined();
    const applied = await apply(plan.planId, 'op-f');
    const docs = folderNamed('Docs')!;
    expect(docs.parentId).toBe(h.ids.id2112);
    expect(applied).toMatchObject({ created: [{ kind: 'folder', id: docs.id, name: 'Docs' }], moved: [{ kind: 'file', id: fileId }] });
    const files = await h.test.ctx.port.filesIndex();
    expect(files.files.find((file) => file.id === fileId)).toMatchObject({ folderId: docs.id, name: 'contrato.pdf' });
  });

  it('una carpeta entera, con su contenido, a una subcarpeta que se crea; una de primer nivel no se mueve', async () => {
    let projectId = '';
    let insideNote = '';
    h = await startJd({
      prepare: async (engine) => {
        const inbox = await engine.folderCreate(null, 'Bandeja');
        const project = await engine.folderCreate(inbox.id, 'Proyecto X');
        projectId = project.id;
        insideNote = (await createNote(engine, project.id, '# Dentro\n')).id;
      }
    });
    const plan = await simulate({ kind: 'folder', id: projectId, toId: '21.11', subfolder: 'Archivo' });
    expect(plan.move).toMatchObject({ kind: 'folder', name: 'Proyecto X', from: { folderPath: 'bandeja' } });
    await apply(plan.planId, 'op-d');
    const archivo = folderNamed('Archivo')!;
    expect(archivo.parentId).toBe(h.ids.id2111);
    expect(folderNamed('Proyecto X')!.parentId).toBe(archivo.id);
    expect(h.rawNotes().find((note) => note.id === insideNote)!.folderId).toBe(projectId);

    const bandeja = folderNamed('Bandeja')!;
    expect(await h.call('hebra_jd_move', { mode: 'simulate', kind: 'folder', id: bandeja.id, toId: '21.11' })).toEqual({
      isError: true,
      value: { error: 'source_not_found' }
    });
  });

  it('un apply cortado a mitad (la subcarpeta creada, el fichero sin mover) se completa con el mismo operationId', async () => {
    let fileId = '';
    h = await startJd({
      prepare: async (engine) => {
        const blob = await engine.blobPut(PDF, { mime: 'application/pdf' });
        fileId = (await engine.fileCreate(null, 'acta.pdf', blob.sha256)).id;
      }
    });
    const plan = await simulate({ kind: 'file', id: fileId, toId: '21.11', subfolder: 'Actas' });
    const cutting = (port: LibraryMovePort): LibraryMovePort =>
      new Proxy(port, {
        get(target, key, receiver) {
          if (key === 'moveFile') {
            return () => {
              throw new Error('corte simulado');
            };
          }
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
      });
    let rounds = 0;
    await expect(
      runJdMove(
        h.port,
        { mode: 'apply', planId: String(plan.planId), operationId: 'op-cut', privacy: JD_DEFAULT_CONFIG },
        () => {
          rounds += 1;
        },
        { port: cutting }
      )
    ).rejects.toThrow('corte simulado');
    // La carpeta quedó creada (y pidió su ronda); el fichero, sin mover.
    expect(rounds).toBe(1);
    const actas = folderNamed('Actas')!;
    expect((await h.test.ctx.port.filesIndex()).files.find((file) => file.id === fileId)!.folderId).toBe('root');

    const retried = await apply(plan.planId, 'op-cut');
    expect(retried).toMatchObject({ created: [], existing: [{ kind: 'folder', id: actas.id }], moved: [{ kind: 'file', id: fileId }] });
    expect(h.rawFolders().filter((folder) => folder.name === 'Actas')).toHaveLength(1);
    expect((await h.test.ctx.port.filesIndex()).files.find((file) => file.id === fileId)!.folderId).toBe(actas.id);
  });

  it('plan_stale si la pieza cambió entre simular y aplicar, sin mover nada', async () => {
    let noteId = '';
    h = await startJd({
      prepare: async (engine) => {
        noteId = (await createNote(engine, null, '# Suelta\n')).id;
      }
    });
    const plan = await simulate({ kind: 'note', id: noteId, toId: '21.11' });
    await h.withEngine((engine) => engine.noteMove(noteId, h!.ids.id2112));
    const notesBefore = h.rawNotes();
    const foldersBefore = h.rawFolders();
    expect(await h.call('hebra_jd_move', { mode: 'apply', planId: plan.planId, operationId: 'op-s' })).toEqual({
      isError: true,
      value: { error: 'plan_stale' }
    });
    expect(h.rawNotes()).toEqual(notesBefore);
    expect(h.rawFolders()).toEqual(foldersBefore);
  });

  it('deshacer devuelve la pieza; una que se movió después se salta con not_where_left', async () => {
    let noteId = '';
    let otherId = '';
    h = await startJd({
      prepare: async (engine) => {
        noteId = (await createNote(engine, null, '# Para volver\n')).id;
        otherId = (await createNote(engine, null, '# Para mover luego\n')).id;
      }
    });
    const plan = await simulate({ kind: 'note', id: noteId, toId: '21.11', as: 'Vuelve' });
    await apply(plan.planId, 'op-u1');
    const undone = await h.call('hebra_jd_move', { mode: 'undo', planId: plan.planId, operationId: 'op-u2' });
    expect(undone.value).toMatchObject({
      mode: 'undo',
      restored: [{ kind: 'note', id: noteId, fromName: 'Vuelve', toName: 'Para volver' }],
      alreadyRestored: [],
      skipped: []
    });
    expect(h.rawNotes().find((note) => note.id === noteId)).toMatchObject({ folderId: 'root', title: 'Para volver' });
    // Otra vez, ya está.
    const again = await h.call('hebra_jd_move', { mode: 'undo', planId: plan.planId, operationId: 'op-u3' });
    expect(again.value).toMatchObject({ restored: [], alreadyRestored: [{ id: noteId }], skipped: [] });

    const other = await simulate({ kind: 'note', id: otherId, toId: '21.11' });
    await apply(other.planId, 'op-u4');
    await h.withEngine((engine) => engine.noteMove(otherId, h!.ids.id2112));
    const skipped = await h.call('hebra_jd_move', { mode: 'undo', planId: other.planId, operationId: 'op-u5' });
    expect(skipped.value).toMatchObject({
      restored: [],
      skipped: [{ kind: 'note', id: otherId, reason: 'not_where_left' }]
    });
    expect(h.rawNotes().find((note) => note.id === otherId)!.folderId).toBe(h.ids.id2112);
    // Un plan sin aplicar no se deshace.
    const fresh = await simulate({ kind: 'note', id: otherId, toId: '21.11' });
    expect(await h.call('hebra_jd_move', { mode: 'undo', planId: fresh.planId, operationId: 'op-u6' })).toEqual({
      isError: true,
      value: { error: 'plan_not_found' }
    });
  });

  it('valida la entrada sin eco y no deja usar un plan de hebra_jd_new_id', async () => {
    h = await startJd();
    for (const args of [
      { mode: 'simulate', id: 'x', toId: '21.11' },
      { mode: 'simulate', kind: 'note', toId: '21.11' },
      { mode: 'simulate', kind: 'note', id: 'x', toId: '21.11', planId: 'p' },
      { mode: 'apply', planId: 'p' },
      { mode: 'undo', planId: 'p', operationId: 'o', kind: 'note' }
    ]) {
      expect(await h.call('hebra_jd_move', args), JSON.stringify(args)).toEqual({ isError: true, value: { error: 'invalid_input' } });
    }
    const newId = await h.call('hebra_jd_new_id', { mode: 'simulate', category: '21', title: 'Otro' });
    expect(await h.call('hebra_jd_move', { mode: 'apply', planId: newId.value.planId, operationId: 'o' })).toEqual({
      isError: true,
      value: { error: 'plan_not_found' }
    });
    expect(await h.call('hebra_jd_move', { mode: 'simulate', kind: 'note', id: 'no-existe', toId: '21.11' })).toEqual({
      isError: true,
      value: { error: 'source_not_found' }
    });
    const notes = h.rawNotes();
    const some = notes.find((note) => note.title === '21.12 Dos')!;
    expect(await h.call('hebra_jd_move', { mode: 'simulate', kind: 'note', id: some.id, toId: '29.99' })).toEqual({
      isError: true,
      value: { error: 'id_not_found' }
    });
  });
});
