import { describe, expect, it, vi } from 'vitest';
import { auditHarness, createNote, saveBody, NOT_FOUND } from './audit-harness';

const BAIT = 'CEBO_CODEX2_AUX_RECIEN_PRIVADO';

describe('ronda 2: filtro final de los listados auxiliares', () => {
  it('list_trash no devuelve título ni excerpt leídos después de adquirir etiqueta privada', async () => {
    const h = await auditHarness(async (engine) => {
      const note = await createNote(engine, null, '# Pública en papelera\nAntes.\n');
      await engine.noteTrash(note.id);
      return { id: note.id };
    });
    try {
      const read = h.port.notesPage.bind(h.port);
      const spy = vi.spyOn(h.port, 'notesPage').mockImplementationOnce(async (...args) => {
        await h.mutate(async (engine) => saveBody(engine, h.extra.id, `# ${BAIT}\n#secreto\n${BAIT}\n`));
        return read(...args);
      });
      const raced = await h.call('hebra_list_trash', { limit: 100 });
      spy.mockRestore();
      const stable = await h.call('hebra_list_trash', { limit: 100 });
      expect(stable.raw).not.toContain(h.extra.id);
      expect(raced.raw, 'La papelera publica metadatos recién privados con TrashFilter anterior').not.toContain(BAIT);
    } finally {
      await h.close();
    }
  });

  it('list_tags no cuenta una etiqueta exclusiva de una nota ya oculta al leer tagsList', async () => {
    const tag = 'codex2_aux_exclusiva';
    const h = await auditHarness(async (engine) => {
      const note = await createNote(engine, null, `# Nota pública\n#${tag}\n`);
      return { id: note.id };
    });
    try {
      const read = h.port.tagsList.bind(h.port);
      const spy = vi.spyOn(h.port, 'tagsList').mockImplementationOnce(async () => {
        await h.mutate(async (engine) => saveBody(engine, h.extra.id, `# Nota privada\n#${tag}\n#secreto\n`));
        return read();
      });
      const raced = await h.call('hebra_list_tags', { limit: 100 });
      spy.mockRestore();
      const stable = await h.call('hebra_list_tags', { limit: 100 });
      expect(stable.raw).not.toContain(tag);
      expect((await h.call('hebra_read_note', { id: h.extra.id })).json).toEqual(NOT_FOUND);
      expect(raced.json.tags, 'La etiqueta y su count siguen saliendo aunque su única nota ya es privada')
        .not.toContainEqual({ tag, count: 1 });
    } finally {
      await h.close();
    }
  });

  it('list_folders no publica una carpeta creada ya privada antes de la lectura del listado', async () => {
    const h = await auditHarness(async () => ({}));
    try {
      const read = h.port.foldersList.bind(h.port);
      let calls = 0;
      let hiddenId = '';
      const spy = vi.spyOn(h.port, 'foldersList').mockImplementation(async () => {
        calls += 1;
        if (calls === 2) {
          hiddenId = (await h.mutate(async (engine, library) =>
            engine.folderCreate(library.folders.diario, BAIT))).id;
        }
        return read();
      });
      const raced = await h.call('hebra_list_folders', { limit: 100 });
      spy.mockRestore();
      expect(calls).toBeGreaterThanOrEqual(2);
      const stable = await h.call('hebra_list_folders', { limit: 100 });
      expect(hiddenId).not.toBe('');
      expect(stable.raw).not.toContain(hiddenId);
      expect(raced.raw, 'La carpeta nació privada y el filtro inicial ni siquiera conoce su id').not.toContain(hiddenId);
    } finally {
      await h.close();
    }
  });

  it.each([false, true])('list_files trashed=%s no publica un fichero recién enlazado por nota privada', async (trashed) => {
    const h = await auditHarness(async (engine, library) => {
      const note = await createNote(engine, null, '# Nota pública enlazadora\n');
      const fileId = trashed ? library.files.trashed : library.files.acta;
      const name = `${BAIT}-${trashed ? 'trash' : 'live'}.pdf`;
      return { noteId: note.id, fileId, name };
    });
    try {
      const read = h.port.filesIndex.bind(h.port);
      const spy = vi.spyOn(h.port, 'filesIndex').mockImplementationOnce(async () => {
        await h.mutate(async (engine) => {
          // Primero se oculta la nota que referencia el nombre nuevo; solo después
          // recibe ese nombre el fichero. Este nombre nunca perteneció a algo visible.
          await saveBody(engine, h.extra.noteId,
            `# ${BAIT}\n#secreto\n![[${h.extra.name}]]\n`);
          await engine.fileRename(h.extra.fileId, h.extra.name);
        });
        return read();
      });
      const raced = await h.call('hebra_list_files', { trashed, limit: 100 });
      spy.mockRestore();
      const stable = await h.call('hebra_list_files', { trashed, limit: 100 });
      expect(stable.raw).not.toContain(h.extra.fileId);
      expect(raced.raw, 'FileFilter publica el nombre nuevo, que nunca fue visible').not.toContain(h.extra.name);
    } finally {
      await h.close();
    }
  });
});
