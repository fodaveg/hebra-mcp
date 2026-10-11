import { describe, expect, it, vi } from 'vitest';
import { auditHarness, createNote, lockedBody, NOT_FOUND, saveBody } from './audit-harness';

const BAIT = 'CEBO_CODEX_CAMBIO_PRIVADO';

/** Solo inserta un cambio REAL del motor en la frontera entre el filtro y la lectura.
 * No sustituye datos, errores ni respuestas. La misma intercalación puede hacerla sync. */
describe('privacidad al construir la respuesta, no solo al empezar la llamada', () => {
  it.each([
    ['entera', {}],
    ['por apartado', { heading: 'Plan' }],
    ['por líneas', { lines: { from: 1, to: 6 } }]
  ])('read_note %s no devuelve el cuerpo que acaba de adquirir etiqueta privada', async (_mode, extra) => {
    const h = await auditHarness(async (engine) =>
      createNote(engine, null, '# Visible inicialmente\n\n## Plan\ntexto público\n'));
    const original = h.port.noteRead.bind(h.port);
    const spy = vi.spyOn(h.port, 'noteRead').mockImplementationOnce(async (id) => {
      await h.mutate((engine) => saveBody(engine, id, `# Título privado\n#secreto\n## Plan\n${BAIT}\n`));
      return original(id);
    });
    try {
      const response = await h.call('hebra_read_note', { id: h.extra.id, ...extra });
      spy.mockRestore();
      expect((await h.call('hebra_read_note', { id: h.extra.id })).json).toEqual(NOT_FOUND);
      expect(response.json, `Se devuelve cuerpo/título privado: ${response.raw}`).toEqual(NOT_FOUND);
    } finally { spy.mockRestore(); await h.close(); }
  });

  it.each([['entera', {}], ['por apartado', { heading: 'Plan' }]])(
    'read_note %s no expone cabecera ni note_locked cuando la nota se bloquea y queda oculta', async (_mode, extra) => {
      const h = await auditHarness(async (engine) => createNote(engine, null, '# Visible\n## Plan\ntexto\n'));
      const original = h.port.noteRead.bind(h.port);
      const spy = vi.spyOn(h.port, 'noteRead').mockImplementationOnce(async (id) => {
        await h.mutate((engine) => saveBody(engine, id, lockedBody(BAIT, [], 'PISTA_PRIVADA_CODEX')));
        return original(id);
      });
      try {
        const response = await h.call('hebra_read_note', { id: h.extra.id, ...extra });
        spy.mockRestore();
        expect((await h.call('hebra_read_note', { id: h.extra.id })).json).toEqual(NOT_FOUND);
        expect(response.json, `Una bloqueada ya oculta devuelve cabecera o error distinguible: ${response.raw}`)
          .toEqual(NOT_FOUND);
      } finally { spy.mockRestore(); await h.close(); }
    }
  );

  it('read_note no devuelve contenido después de mover la nota a una carpeta privada', async () => {
    const h = await auditHarness(async (engine) => createNote(engine, null, `# Visible\n${BAIT}\n`));
    const original = h.port.noteRead.bind(h.port);
    const spy = vi.spyOn(h.port, 'noteRead').mockImplementationOnce(async (id) => {
      await h.mutate((engine, library) => engine.noteMove(id, library.folders.diario));
      return original(id);
    });
    try {
      const response = await h.call('hebra_read_note', { id: h.extra.id });
      spy.mockRestore();
      expect((await h.call('hebra_read_note', { id: h.extra.id })).json).toEqual(NOT_FOUND);
      expect(response.json, `Sale cuerpo privado y folderPath antiguo: ${response.raw}`).toEqual(NOT_FOUND);
    } finally { spy.mockRestore(); await h.close(); }
  });

  it('note_outline no expone títulos de apartados ni tamaños recién privados', async () => {
    const h = await auditHarness(async (engine) => createNote(engine, null, '# Visible\n'));
    const original = h.port.noteRead.bind(h.port);
    const spy = vi.spyOn(h.port, 'noteRead').mockImplementationOnce(async (id) => {
      await h.mutate((engine) => saveBody(engine, id, `# Título privado\n#secreto\n## ${BAIT}\ncontenido\n`));
      return original(id);
    });
    try {
      const response = await h.call('hebra_note_outline', { id: h.extra.id });
      expect(response.json, `Sale esquema de nota privada: ${response.raw}`).toEqual(NOT_FOUND);
    } finally { spy.mockRestore(); await h.close(); }
  });

  it('links no expone wikilinks del cuerpo recién privado', async () => {
    const h = await auditHarness(async (engine) => createNote(engine, null, '# Visible\n'));
    const original = h.port.noteRead.bind(h.port);
    const spy = vi.spyOn(h.port, 'noteRead').mockImplementationOnce(async (id) => {
      await h.mutate((engine) => saveBody(engine, id, `# Privada\n#secreto\n[[${BAIT}]]\n`));
      return original(id);
    });
    try {
      const response = await h.call('hebra_links', { id: h.extra.id });
      expect(response.json, `Sale enlace que solo existe en cuerpo oculto: ${response.raw}`).toEqual(NOT_FOUND);
    } finally { spy.mockRestore(); await h.close(); }
  });

  it('list_notes no devuelve título y excerpt nuevos de una nota que pasa a privada', async () => {
    const h = await auditHarness(async (engine) => createNote(engine, null, '# Visible\n'));
    const original = h.port.notesPage.bind(h.port);
    const spy = vi.spyOn(h.port, 'notesPage').mockImplementationOnce(async (...args) => {
      await h.mutate((engine) => saveBody(engine, h.extra.id, `# ${BAIT}\n#secreto\ncontenido oculto\n`));
      return original(...args);
    });
    try {
      const response = await h.call('hebra_list_notes', { limit: 100 });
      expect(response.raw, 'La lista contiene título y excerpt de una nota oculta').not.toContain(BAIT);
    } finally { spy.mockRestore(); await h.close(); }
  });

  it('search no devuelve snippet de un cuerpo que pasa a privado antes de buscar', async () => {
    const h = await auditHarness(async (engine) => createNote(engine, null, '# Visible\n'));
    const original = h.port.search.bind(h.port);
    const spy = vi.spyOn(h.port, 'search').mockImplementationOnce(async (...args) => {
      await h.mutate((engine) => saveBody(engine, h.extra.id, `# Privada\n#secreto\n${BAIT}\n`));
      return original(...args);
    });
    try {
      const response = await h.call('hebra_search', { query: BAIT });
      expect(response.json, `Sale snippet privado: ${response.raw}`).toEqual({ results: [], nextCursor: null });
    } finally { spy.mockRestore(); await h.close(); }
  });

  it('read_version no devuelve versiones después de ocultar su nota', async () => {
    const h = await auditHarness(async () => ({}));
    const original = h.port.noteVersionRead.bind(h.port);
    const spy = vi.spyOn(h.port, 'noteVersionRead').mockImplementationOnce(async (id) => {
      await h.mutate((engine, library) => engine.noteMove(library.versionedNoteId, library.folders.diario));
      return original(id);
    });
    try {
      const response = await h.call('hebra_read_version', {
        id: h.library.versionedNoteId, versionId: h.library.versionedNoteVersionId
      });
      expect(response.json, `Sale cuerpo de versión de nota ya oculta: ${response.raw}`).toEqual(NOT_FOUND);
    } finally { spy.mockRestore(); await h.close(); }
  });

  it('list_versions no devuelve ids y tamaños después de ocultar su nota', async () => {
    const h = await auditHarness(async () => ({}));
    const original = h.port.noteVersionsList.bind(h.port);
    const spy = vi.spyOn(h.port, 'noteVersionsList').mockImplementationOnce(async (id) => {
      await h.mutate((engine, library) => engine.noteMove(id, library.folders.diario));
      return original(id);
    });
    try {
      const response = await h.call('hebra_list_versions', { id: h.library.versionedNoteId });
      expect(response.json, `Sale metadato de versión de nota ya oculta: ${response.raw}`).toEqual(NOT_FOUND);
    } finally { spy.mockRestore(); await h.close(); }
  });

  it('conflictOf no nombra un original ocultado antes de devolver la copia visible', async () => {
    const h = await auditHarness(async () => ({}));
    const original = h.port.noteRead.bind(h.port);
    const spy = vi.spyOn(h.port, 'noteRead').mockImplementationOnce(async (id) => {
      await h.mutate((engine, library) => engine.noteMove(library.publicNoteId, library.folders.diario));
      return original(id);
    });
    try {
      const response = await h.call('hebra_read_note', { id: h.library.conflictCopyId });
      expect(response.json, 'conflictOf da el id de un original ya privado').not.toHaveProperty('conflictOf');
    } finally { spy.mockRestore(); await h.close(); }
  });
});
