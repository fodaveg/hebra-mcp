import { expect, it, vi } from 'vitest';
import { auditHarness, createNote, decodeCursor, NOT_FOUND } from './audit-harness';

it('links no conserva en cursor el id del backlink que la recomprobación acaba de ocultar', async () => {
  const h = await auditHarness(async (engine) => {
    const target = await createNote(engine, null, '# Destino codex2 único\n');
    await createNote(engine, null, '# Backlink anterior\n[[Destino codex2 único]]\n');
    const hidden = await createNote(engine, null, '# CEBO_BACKLINK_OCULTO\n[[Destino codex2 único]]\n');
    return { target, hidden };
  });
  let hiddenId = h.extra.hidden.id;
  const backlinks = h.port.backlinks.bind(h.port);
  const backlinkSpy = vi.spyOn(h.port, 'backlinks').mockImplementationOnce(async (...args) => {
    const page = await backlinks(...args);
    hiddenId = page.items[0]!.id;
    return page;
  });
  const original = h.port.privacyRecheck.bind(h.port);
  const spy = vi.spyOn(h.port, 'privacyRecheck').mockImplementationOnce(async (ids) => {
    await h.mutate((engine, library) => engine.noteMove(hiddenId, library.folders.diario));
    return original(ids);
  });
  try {
    const response = await h.call('hebra_links', { id: h.extra.target.id, limit: 1 });
    spy.mockRestore();
    expect((await h.call('hebra_read_note', { id: hiddenId })).json).toEqual(NOT_FOUND);
    const decoded = decodeCursor(response.json.nextCursor) ?? '';
    const backlinkCursor = JSON.parse(decoded || '{}').b as string | undefined;
    const inner = backlinkCursor ? Buffer.from(backlinkCursor, 'base64url').toString('utf8') : '';
    expect(`${decoded}\n${inner}`, 'El backlink oculto desaparece de la lista pero su id sigue dentro del cursor de links')
      .not.toContain(hiddenId);
  } finally { spy.mockRestore(); backlinkSpy.mockRestore(); await h.close(); }
});

it('links resuelve la homónima visible después de ocultar otra durante la consulta por título', async () => {
  const h = await auditHarness(async (engine) => {
    const visible = await createNote(engine, null, '# Homonima codex2\n');
    const hidden = await createNote(engine, null, '# Homonima codex2\n');
    const source = await createNote(engine, null, '# Origen\n[[Homonima codex2]]\n');
    return { visible, hidden, source };
  });
  const original = h.port.notesByExactTitle.bind(h.port);
  const spy = vi.spyOn(h.port, 'notesByExactTitle').mockImplementationOnce(async (...args) => {
    await h.mutate((engine, library) => engine.noteMove(h.extra.hidden.id, library.folders.diario));
    return original(...args);
  });
  try {
    const response = await h.call('hebra_links', { id: h.extra.source.id });
    spy.mockRestore();
    const control = await h.call('hebra_links', { id: h.extra.source.id });
    expect(control.json.outgoing[0].resolvedId).toBe(h.extra.visible.id);
    expect(response.json, 'Una homónima ya oculta convierte el enlace visible en ambiguo: recheck solo retira resueltos y no recalcula candidatos')
      .toEqual(control.json);
  } finally { spy.mockRestore(); await h.close(); }
});
