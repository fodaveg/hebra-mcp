import { expect, it, vi } from 'vitest';
import { deriveNote } from '../../src/hebra';
import { auditHarness } from './audit-harness';

const BODY = '# Ficha heredada\n\n#secreto\nCEBO_REINDEX_EPOCA\n';

// Una importación de un cliente anterior puede traer las etiquetas que calculaba
// aquella versión. Hebra las recalcula con tagsReindexWrite, sin guardar la nota.
async function legacyTagHarness() {
  return auditHarness(async (engine) => {
    const id = 'nota-etiquetas-antiguas';
    await engine.libraryImportBatch({
      notes: [{
        ...deriveNote(BODY),
        id,
        folderId: 'root',
        body: BODY,
        createdAt: 1,
        updatedAt: 1,
        tags: []
      }]
    });
    return { id };
  });
}

async function reindexCurrentTags(h: Awaited<ReturnType<typeof legacyTagHarness>>) {
  return h.mutate(async (engine) => {
    const note = (await engine.noteRead(h.extra.id))!;
    return engine.tagsReindexWrite(10, [{
      id: note.id,
      bodySha256: note.bodySha256!,
      tags: deriveNote(note.body!).tags,
      hasOpenTasks: false
    }], false);
  });
}

it('la época cambia al reindexar una etiqueta que vuelve privada una nota', async () => {
  const h = await legacyTagHarness();
  try {
    expect((await h.call('hebra_read_note', { id: h.extra.id })).raw).toContain('CEBO_REINDEX_EPOCA');
    const before = await h.port.privacyEpoch();
    const changed = await reindexCurrentTags(h);
    expect(changed.changed).toEqual([h.extra.id]);
    expect((await h.call('hebra_read_note', { id: h.extra.id })).json).toEqual({ error: 'not_found' });
    expect(await h.port.privacyEpoch(), 'La reindexación del motor alteró la privacidad sin mover el token global')
      .not.toBe(before);
  } finally {
    await h.close();
  }
});

it('read_note no entrega la nota tras una reindexación privada durante la llamada', async () => {
  const h = await legacyTagHarness();
  const original = h.port.noteRead.bind(h.port);
  const spy = vi.spyOn(h.port, 'noteRead').mockImplementationOnce(async (id) => {
    const row = await original(id);
    await reindexCurrentTags(h);
    return row;
  });
  try {
    const raced = await h.call('hebra_read_note', { id: h.extra.id });
    expect(raced.json).toEqual({ error: 'not_found' });
  } finally {
    spy.mockRestore();
    await h.close();
  }
});

it('la época distingue un reset y reimportación con igual número de filas y local_seq', async () => {
  const id = 'nota-reimportada';
  const publicBody = '# Antes del reset\ncontenido público\n';
  const privateBody = '# Después del reset\n#secreto\nCEBO_RESET_PRIVADO\n';
  const imported = (body: string) => ({
    ...deriveNote(body), id, folderId: 'root', body, createdAt: 1, updatedAt: 1
  });
  const h = await auditHarness(async (engine) => {
    await engine.libraryReset();
    await engine.libraryImportBatch({ notes: [imported(publicBody)] });
    return { id };
  }, { privateFolders: [], privateTags: ['secreto'] });
  try {
    expect((await h.call('hebra_read_note', { id })).json.body).toBe(publicBody);
    const before = await h.port.privacyEpoch();
    await h.mutate(async (engine) => {
      await engine.libraryReset();
      await engine.libraryImportBatch({ notes: [imported(privateBody)] });
    });
    expect((await h.call('hebra_read_note', { id })).json).toEqual({ error: 'not_found' });
    expect(await h.port.privacyEpoch(), 'El reset y la nueva importación dejaron count/sum iguales con privacidad distinta')
      .not.toBe(before);
  } finally {
    await h.close();
  }
});

it('read_note no devuelve el cuerpo privado de una reimportación ABA con el mismo sello', async () => {
  const id = 'nota-aba';
  const publicBody = '# Pública ABA\ntexto común\n';
  const privateBody = '# Privada ABA\n#secreto\nCEBO_RESET_ABA_PRIVADO\n';
  const imported = (body: string) => ({
    ...deriveNote(body), id, folderId: 'root', body, createdAt: 1, updatedAt: 1
  });
  const h = await auditHarness(async (engine) => {
    await engine.libraryReset();
    await engine.libraryImportBatch({ notes: [imported(publicBody)] });
    return { id };
  }, { privateFolders: [], privateTags: ['secreto'] });
  const initialEpoch = await h.port.privacyEpoch();
  const original = h.port.noteRead.bind(h.port);
  const spy = vi.spyOn(h.port, 'noteRead').mockImplementationOnce(async (ref) => {
    await h.mutate(async (engine) => {
      await engine.libraryReset();
      await engine.libraryImportBatch({ notes: [imported(privateBody)] });
    });
    const privateRow = await original(ref);
    await h.mutate(async (engine) => {
      await engine.libraryReset();
      await engine.libraryImportBatch({ notes: [imported(publicBody)] });
    });
    return privateRow;
  });
  try {
    const raced = await h.call('hebra_read_note', { id });
    expect(await h.port.privacyEpoch()).toBe(initialEpoch);
    expect((await h.call('hebra_read_note', { id })).json.body).toBe(publicBody);
    expect(raced.raw, 'La puerta aceptó un cuerpo privado con id, local_seq y época iguales a los de la nota pública')
      .not.toContain('CEBO_RESET_ABA_PRIVADO');
  } finally {
    spy.mockRestore();
    await h.close();
  }
});
