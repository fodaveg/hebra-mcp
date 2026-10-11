import { expect, it, vi } from 'vitest';
import { auditHarness, createNote, saveBody } from './audit-harness';

// updated_at tiene resolución de MILISEGUNDOS: dos guardados reales pueden compartirlo.
// El reloj fija ese caso, sin cambiar respuestas SQL, sellos ni contenido del puerto.
it.each(['hebra_list_notes', 'hebra_search'])('%s no acepta una fila privada por colisión de updated_at con otra pública', async (tool) => {
  const h = await auditHarness(async (engine) => {
    const folder = await engine.folderCreate(null, 'CollisionSeal');
    return createNote(engine, folder.id, '# Título público\naguja_colision\n');
  });
  let privateSeq = 0;
  let publicSeq = 0;
  let sameStamp = false;
  const race = async <T>(read: () => Promise<T>): Promise<T> => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const privateRow = await h.mutate(async (engine) => {
        await saveBody(engine, h.extra.id, '# CEBO_SOLO_EN_FILA_PRIVADA\n#secreto\naguja_colision CEBO_SOLO_EN_FILA_PRIVADA\n');
        return (await engine.noteRead(h.extra.id))!;
      });
      const response = await read();
      const publicRow = await h.mutate(async (engine) => {
        await saveBody(engine, h.extra.id, '# Título público posterior\naguja_colision\n');
        return (await engine.noteRead(h.extra.id))!;
      });
      privateSeq = privateRow.localSeq;
      publicSeq = publicRow.localSeq;
      sameStamp = privateRow.updatedAt === publicRow.updatedAt;
      return response;
    } finally { clock.mockRestore(); }
  };
  const readNotes = h.port.notesPage.bind(h.port);
  const readSearch = h.port.search.bind(h.port);
  const spy = tool === 'hebra_list_notes'
    ? vi.spyOn(h.port, 'notesPage').mockImplementationOnce((...args) => race(() => readNotes(...args)))
    : vi.spyOn(h.port, 'search').mockImplementationOnce((...args) => race(() => readSearch(...args)));
  try {
    const response = await h.call(tool, {
      folder: 'CollisionSeal', query: 'aguja_colision',
      fields: tool === 'hebra_list_notes' ? ['title', 'excerpt'] : ['title', 'snippet']
    });
    spy.mockRestore();
    expect(sameStamp, 'Los dos guardados reales tienen el mismo updated_at').toBe(true);
    expect(publicSeq).toBeGreaterThan(privateSeq);
    expect((await h.call('hebra_read_note', { id: h.extra.id })).raw).not.toContain('CEBO_SOLO_EN_FILA_PRIVADA');
    expect(response.raw, 'recheck acepta por updated_at idéntico el título/excerpt/snippet que solo existió en una fila privada')
      .not.toContain('CEBO_SOLO_EN_FILA_PRIVADA');
  } finally { spy.mockRestore(); await h.close(); }
});
