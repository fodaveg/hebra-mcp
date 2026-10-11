import { expect, it } from 'vitest';
import { ReplaceBatch } from '../../src/store/replace-batch';
import { NoteWriter } from '../../src/store/writes';
import { buildWriteContext } from '../../src/server/write-context';
import { auditHarness, createNote, saveBody, NOT_FOUND, type AuditHarness } from './audit-harness';

function withRound(h: AuditHarness<string>, round: () => Promise<void>): void {
  const writer = new NoteWriter(h.port);
  const batch = new ReplaceBatch(h.port, h.port);
  h.serverContext.write = buildWriteContext({
    replaceInNotes: (request) => batch.run(request),
    createNote: (input) => writer.createNote(input),
    appendToNote: (input) => writer.appendToNote(input),
    editNote: (input) => writer.editNoteLocal(input),
    recordEditConflict: (operationId, id, copyId) => writer.recordEditConflict(operationId, id, copyId),
    organize: (input) => writer.organizeLocal(input),
    restoreVersion: (input) => writer.restoreVersionLocal(input),
    fetchAttachment: (input) => writer.fetchAttachment(input, null),
    createFolder: (input) => writer.createFolderLocal(input),
    renameFolder: (input) => writer.renameFolderLocal(input),
    addAttachment: (input) => writer.addAttachmentLocal(input),
    organizeFile: (input) => writer.organizeFileLocal(input),
    noteRead: (id) => h.port.noteRead(id),
    folderDirty: (id) => h.port.folderDirty(id),
    blobUploaded: (hash) => h.port.blobUploaded(hash),
    looseFileDirty: (id) => h.port.looseFileDirty(id),
    onConflictCopy: () => () => {},
    isLinked: () => true,
    requestRound: async () => { await round(); return { result: 'ok' }; }
  });
}

for (const mode of ['apply', 'undo'] as const) {
  it(`replace_in_notes ${mode} omite el original que la ronda posterior volvió privado`, async () => {
    const h = await auditHarness(async (engine) => (await createNote(engine, null, '# Lote público\nTOKEN_RONDA\n')).id);
    try {
      const simulated = await h.call('hebra_replace_in_notes', {
        mode: 'simulate', pattern: 'TOKEN_RONDA', replacement: 'RESULTADO_RONDA', ids: [h.extra]
      });
      expect(simulated.isError).toBe(false);
      const planId = simulated.json.planId;
      if (mode === 'undo') {
        expect((await h.call('hebra_replace_in_notes', { mode: 'apply', planId, operationId: 'codex2-pre-undo' })).isError).toBe(false);
      }
      withRound(h, () => h.mutate(async (engine) => {
        const row = (await engine.noteRead(h.extra))!;
        await saveBody(engine, h.extra, `${row.body}\n#secreto\n`);
      }));
      const result = await h.call('hebra_replace_in_notes', {
        mode, planId, ...(mode === 'apply' ? { operationId: 'codex2-post-sync' } : {})
      });
      expect((await h.call('hebra_read_note', { id: h.extra })).json).toEqual(NOT_FOUND);
      expect(result.isError).toBe(false);
      expect(result.json.notes, 'El informe construido antes de sync sigue nombrando la nota que ya es privada').toEqual([]);
    } finally { await h.close(); }
  });
}

it('replace_in_notes apply omite el copyId que la ronda posterior volvió privado', async () => {
  const h = await auditHarness(async (engine) => (await createNote(engine, null, '# Original visible\nTOKEN_COPY_RONDA\n')).id);
  let copyId = '';
  try {
    const simulated = await h.call('hebra_replace_in_notes', {
      mode: 'simulate', pattern: 'TOKEN_COPY_RONDA', replacement: 'RESULTADO_COPY_RONDA', ids: [h.extra]
    });
    expect(simulated.isError).toBe(false);
    await h.mutate((engine) => saveBody(engine, h.extra, '# Original visible\nEdición concurrente\n'));
    withRound(h, () => h.mutate(async (engine, _library, db) => {
      const copy = db.prepare('SELECT id FROM notes WHERE conflict_of = ?').get(h.extra) as { id: string };
      copyId = copy.id;
      const row = (await engine.noteRead(copyId))!;
      await saveBody(engine, copyId, `${row.body}\n#secreto\n`);
    }));
    const result = await h.call('hebra_replace_in_notes', {
      mode: 'apply', planId: simulated.json.planId, operationId: 'codex2-copy-post-sync'
    });
    expect(copyId).not.toBe('');
    expect((await h.call('hebra_read_note', { id: copyId })).json).toEqual(NOT_FOUND);
    expect(result.isError).toBe(false);
    expect(result.raw, 'El informe sigue dando el copyId oculto después de sync').not.toContain(copyId);
  } finally { await h.close(); }
});
