import { expect, it, vi } from 'vitest';
import { auditHarness, createNote, NOT_FOUND } from './audit-harness';

it('recheck incluye carpetas que otra llamada recordó como privadas durante la lectura', async () => {
  const h = await auditHarness(async (engine) => {
    const folder = await engine.folderCreate(null, 'Pasarela');
    const child = await engine.folderCreate(folder.id, 'Hija');
    const note = await createNote(engine, child.id, '# CEBO_CARPETA_RECORDADA\ncontenido secreto\n');
    return { folder, note };
  });
  const original = h.port.noteRead.bind(h.port);
  const spy = vi.spyOn(h.port, 'noteRead').mockImplementationOnce(async (id) => {
    // Primer sync: la ruta configurada apunta a una carpeta nueva.
    await h.mutate(async (engine, library) => {
      await engine.folderMove(library.folders.diario, library.folders.historial);
      await engine.folderRename(h.extra.folder.id, 'Diario');
    });
    // Una llamada independiente recuerda REALMENTE el nuevo id privado (A3).
    expect((await h.call('hebra_status')).isError).toBe(false);
    // Segundo sync: la privada recordada se mueve y otra carpeta ocupa su ruta.
    await h.mutate(async (engine, library) => {
      await engine.folderMove(h.extra.folder.id, library.folders.proyectos);
      await engine.folderCreate(null, 'Diario');
    });
    return original(id);
  });
  try {
    const response = await h.call('hebra_read_note', { id: h.extra.note.id });
    spy.mockRestore();
    expect((await h.port.rememberedPrivateFolders()).some((x) => x.folderId === h.extra.folder.id)).toBe(true);
    expect((await h.port.noteRead(h.extra.note.id))!.localSeq).toBe(h.extra.note.localSeq);
    expect((await h.call('hebra_read_note', { id: h.extra.note.id })).json).toEqual(NOT_FOUND);
    expect(response.json, 'La tabla recuerda la antecesora privada pero recheck solo usa knownPrivateFolderIds del principio y entrega su cuerpo')
      .toEqual(NOT_FOUND);
  } finally { spy.mockRestore(); await h.close(); }
});
