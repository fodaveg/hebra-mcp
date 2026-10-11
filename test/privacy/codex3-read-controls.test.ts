import { expect, it, vi } from 'vitest';
import { auditHarness, createNote, saveBody } from './audit-harness';

it.each(['hebra_read_note', 'hebra_note_outline'])('%s reevalúa ambiguous_title y resuelve solo la homónima que sigue visible', async (tool) => {
  const h = await auditHarness(async (engine) => ({
    visible: (await createNote(engine, null, '# TítuloHomónimoR3\n## Pública\ntexto\n')).id,
    hidden: (await createNote(engine, null, '# TítuloHomónimoR3\n## Ocultable\ntexto\n')).id
  }));
  const exact = h.port.notesByExactTitle.bind(h.port);
  const spy = vi.spyOn(h.port, 'notesByExactTitle').mockImplementationOnce(async (title) => {
    const page = await exact(title);
    await h.mutate((engine) => saveBody(engine, h.extra.hidden, '# TítuloHomónimoR3\n#secreto\n'));
    return page;
  });
  try {
    const result = await h.call(tool, { title: 'TítuloHomónimoR3' });
    expect(result.isError, result.raw).toBe(false);
    expect(result.json.id).toBe(h.extra.visible);
    expect(result.raw).not.toContain(h.extra.hidden);
    expect(spy).toHaveBeenCalledTimes(2);
  } finally { spy.mockRestore(); await h.close(); }
});

it('links repite la resolución por título cuando la homónima que la hacía ambigua pasa a oculta', async () => {
  const h = await auditHarness(async (engine) => ({
    source: (await createNote(engine, null, '# OrigenR3\n[[DestinoHomónimoR3]]\n')).id,
    visible: (await createNote(engine, null, '# DestinoHomónimoR3\nvisible\n')).id,
    hidden: (await createNote(engine, null, '# DestinoHomónimoR3\nocultable\n')).id
  }));
  const exact = h.port.notesByExactTitle.bind(h.port);
  const spy = vi.spyOn(h.port, 'notesByExactTitle').mockImplementationOnce(async (title) => {
    const page = await exact(title);
    await h.mutate((engine) => saveBody(engine, h.extra.hidden, '# DestinoHomónimoR3\n#secreto\n'));
    return page;
  });
  try {
    const result = await h.call('hebra_links', { id: h.extra.source });
    expect(result.isError, result.raw).toBe(false);
    expect(result.json.outgoing).toEqual([{ ref: 'destinohomónimor3', resolvedId: h.extra.visible, title: 'DestinoHomónimoR3' }]);
    expect(result.raw).not.toContain(h.extra.hidden);
    expect(spy).toHaveBeenCalledTimes(2);
  } finally { spy.mockRestore(); await h.close(); }
});

it.each(['hebra_list_notes', 'hebra_search'])('%s descarta el cursor si se oculta la nota que decidió mirar por delante', async (tool) => {
  const h = await auditHarness(async (engine) => {
    const folder = await engine.folderCreate(null, 'LecturasR3');
    const ids = [
      (await createNote(engine, folder.id, '# PrimeraR3\nCEBO_LISTA_R3\n')).id,
      (await createNote(engine, folder.id, '# SegundaR3\nCEBO_LISTA_R3\n')).id
    ];
    return { ids };
  });
  try {
    const args = { folder: 'LecturasR3', query: 'CEBO_LISTA_R3', limit: 1, fields: ['title'] };
    const control = await h.call(tool, args);
    expect(control.isError, control.raw).toBe(false);
    const key = tool === 'hebra_search' ? 'results' : 'notes';
    const firstId = control.json[key][0].id;
    const lookahead = h.extra.ids.find((id) => id !== firstId)!;
    expect(control.json.nextCursor).not.toBeNull();
    const recheck = h.port.privacyRecheck.bind(h.port);
    const spy = vi.spyOn(h.port, 'privacyRecheck').mockImplementationOnce(async (request) => {
      await h.mutate((engine) => saveBody(engine, lookahead, '# OcultaR3\nCEBO_LISTA_R3\n#secreto\n'));
      return recheck(request);
    });
    try {
      const result = await h.call(tool, args);
      expect(result.isError, result.raw).toBe(false);
      expect(result.json[key].map((n: { id: string }) => n.id)).toEqual([firstId]);
      expect(result.json.nextCursor).toBeNull();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  } finally { await h.close(); }
});
