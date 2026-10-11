import { expect, it, vi } from 'vitest';
import { auditHarness, createNote, NOT_FOUND } from './audit-harness';

it('search no conserva resultado ni heading cuando se mueve su carpeta antecesora durante noteRead', async () => {
  const h = await auditHarness(async (engine, library) => {
    const parent = await engine.folderCreate(library.folders.historial, 'Padre');
    const child = await engine.folderCreate(parent.id, 'Hija');
    const note = await createNote(engine, child.id, '# Visible\n\n## CEBO_APARTADO_OCULTO\naguja_codex2\n');
    return { parentId: parent.id, note };
  });
  const original = h.port.noteRead.bind(h.port);
  let changed = false;
  const spy = vi.spyOn(h.port, 'noteRead').mockImplementation(async (id) => {
    if (!changed && id === h.extra.note.id) {
      changed = true;
      await h.mutate((engine, library) => engine.folderMove(h.extra.parentId, library.folders.diario));
    }
    return original(id);
  });
  try {
    const response = await h.call('hebra_search', { query: 'aguja_codex2' });
    spy.mockRestore();
    expect(changed).toBe(true);
    const row = await h.port.noteRead(h.extra.note.id);
    expect(row!.localSeq, 'folderMove de la antecesora no toca el sello de la nota').toBe(h.extra.note.localSeq);
    expect((await h.call('hebra_read_note', { id: h.extra.note.id })).json).toEqual(NOT_FOUND);
    expect(response.json, 'search entrega id, snippet y heading de la nota ya oculta: lee el cuerpo después de recheck')
      .toEqual({ results: [], nextCursor: null });
  } finally { spy.mockRestore(); await h.close(); }
});

it.each(['hebra_read_note', 'hebra_note_outline'])('%s no devuelve contenido tras mover una antecesora durante libraryId', async (tool) => {
  const h = await auditHarness(async (engine, library) => {
    const parent = await engine.folderCreate(library.folders.historial, 'Padre');
    const child = await engine.folderCreate(parent.id, 'Hija');
    const note = await createNote(engine, child.id, '# CEBO_CUERPO_OCULTO\n\n## Apartado privado\ntexto\n');
    return { parentId: parent.id, note };
  });
  const original = h.port.libraryId.bind(h.port);
  const spy = vi.spyOn(h.port, 'libraryId').mockImplementationOnce(async () => {
    await h.mutate((engine, library) => engine.folderMove(h.extra.parentId, library.folders.diario));
    return original();
  });
  try {
    const response = await h.call(tool, { id: h.extra.note.id });
    spy.mockRestore();
    expect((await h.call('hebra_read_note', { id: h.extra.note.id })).json).toEqual(NOT_FOUND);
    expect(response.json, 'Una lectura posterior al filtro permite ocultar la carpeta antecesora sin cambiar local_seq y aun así sale contenido')
      .toEqual(NOT_FOUND);
  } finally { spy.mockRestore(); await h.close(); }
});
