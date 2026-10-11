/**
 * La puerta final de privacidad (`src/server/privacy-gate.ts`, tarea d64e187e): si algo que
 * usó la respuesta cambió o dejó de verse, no poda, REPITE la llamada entera, como mucho
 * `GATE_ATTEMPTS` veces; si ningún intento pasa, responde el estado fresco (vacío o
 * `not_found`), nunca lo que se leyó.
 */
import { expect, it, vi } from 'vitest';
import { GATE_ATTEMPTS } from '../../src/server/privacy-gate';
import { auditHarness, createNote, NOT_FOUND, saveBody } from './audit-harness';

it('una nota editada mientras se lee: se repite la llamada y sale la fila nueva', async () => {
  const h = await auditHarness(async (engine) => (await createNote(engine, null, '# Puerta\nantes\n')).id);
  const read = h.port.noteRead.bind(h.port);
  const spy = vi.spyOn(h.port, 'noteRead').mockImplementationOnce(async (id) => {
    const row = await read(id);
    await h.mutate((engine) => saveBody(engine, id, '# Puerta\ndespués\n'));
    return row;
  });
  try {
    const response = await h.call('hebra_read_note', { id: h.extra });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(response.json.body).toBe('# Puerta\ndespués\n');
  } finally {
    spy.mockRestore();
    await h.close();
  }
});

it(`si ningún intento pasa (${GATE_ATTEMPTS}), una lectura responde not_found y no lo leído`, async () => {
  const h = await auditHarness(async (engine) => (await createNote(engine, null, '# Inestable\nv0\n')).id);
  const read = h.port.noteRead.bind(h.port);
  let edits = 0;
  const spy = vi.spyOn(h.port, 'noteRead').mockImplementation(async (id) => {
    const row = await read(id);
    edits += 1;
    await h.mutate((engine) => saveBody(engine, id, `# Inestable\nv${edits}\n`));
    return row;
  });
  try {
    const response = await h.call('hebra_read_note', { id: h.extra });
    expect(spy).toHaveBeenCalledTimes(GATE_ATTEMPTS);
    expect(response.json).toEqual(NOT_FOUND);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});

it('si ningún intento pasa, una lista responde vacía y sin cursor', async () => {
  const h = await auditHarness(async (engine) => {
    const folder = await engine.folderCreate(null, 'PuertaLista');
    return (await createNote(engine, folder.id, '# Listada\nv0\n')).id;
  });
  const page = h.port.notesPage.bind(h.port);
  let edits = 0;
  const spy = vi.spyOn(h.port, 'notesPage').mockImplementation(async (...args) => {
    edits += 1;
    await h.mutate((engine) => saveBody(engine, h.extra, `# Listada\nv${edits}\n`));
    return page(...args);
  });
  try {
    const response = await h.call('hebra_list_notes', { folder: 'PuertaLista' });
    expect(spy).toHaveBeenCalledTimes(GATE_ATTEMPTS);
    expect(response.json).toEqual({ notes: [], nextCursor: null });
  } finally {
    spy.mockRestore();
    await h.close();
  }
});

it('una escritura no se repite: si su nota pasa a oculta en la ronda, not_found una sola vez', async () => {
  const h = await auditHarness(async (engine) => (await createNote(engine, null, '# Escrita\n')).id);
  const append = vi.spyOn(h.serverContext.write!, 'appendToNote');
  const round = vi.spyOn(h.serverContext.write!, 'awaitRound').mockImplementation(async () => {
    await h.mutate(async (engine) => {
      const row = (await engine.noteRead(h.extra))!;
      await saveBody(engine, h.extra, `${row.body}\n#secreto\n`);
    });
    return { kind: 'no_sync' };
  });
  try {
    const response = await h.call('hebra_append_to_note', { id: h.extra, text: 'línea nueva' });
    expect(append).toHaveBeenCalledTimes(1);
    expect(response.json).toEqual(NOT_FOUND);
  } finally {
    append.mockRestore();
    round.mockRestore();
    await h.close();
  }
});
