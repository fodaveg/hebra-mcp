import { expect, it } from 'vitest';
import { auditHarness, createNote } from './audit-harness';

it('search no revela por snippet ni existencia el nombre de un fichero privado incrustado por hash', async () => {
  const secret = 'QuimeraSecretaCodex6';
  const h = await auditHarness(async (engine, library) => {
    const blob = await engine.blobPut(new TextEncoder().encode('contenido privado'), { mime: 'text/plain' });
    await engine.fileCreate(library.folders.diario, `${secret}.txt`, blob.sha256);
    const visible = await createNote(
      engine,
      null,
      `# Busqueda visible\n![[sha256:${blob.sha256}|inofensivo.txt]]\ncontenido público\n`
    );
    return { visibleId: visible.id };
  });
  try {
    // El motor indexa el nombre por la referencia al hash, aunque el fichero sea privado.
    const engineHits = await h.mutate(async (engine) => engine.search(secret, null, 20, null, null));
    expect(engineHits.items.map((item) => item.id)).toContain(h.extra.visibleId);

    const result = await h.call('hebra_search', { query: secret });
    expect(result.json).toEqual({ results: [], nextCursor: null });
    expect(result.raw).not.toContain(secret);
    const publicResult = await h.call('hebra_search', { query: 'público' });
    expect(publicResult.json.results.map((item: { id: string }) => item.id)).toContain(h.extra.visibleId);
  } finally {
    await h.close();
  }
});

it('un PDF privado no altera ni resultados positivos ni la exclusión de texto público', async () => {
  const secret = 'ClavePdfCodex6';
  const h = await auditHarness(async (engine, library) => {
    const blob = await engine.blobPut(new TextEncoder().encode('%PDF-1.4\n'), { mime: 'application/pdf' });
    await engine.fileCreate(library.folders.diario, 'documento.pdf', blob.sha256);
    await engine.pdfTextReindexWrite(1, [{ sha256: blob.sha256, text: secret }], 1, 0, null);
    const note = await createNote(engine, null,
      `# Informe visible\npublico\n![[sha256:${blob.sha256}|documento.pdf]]\n`);
    return note.id;
  });
  try {
    const enginePositive = await h.mutate(async (engine) => engine.search(secret, null, 20, null, null));
    expect(enginePositive.items.map((item) => item.id)).toContain(h.extra);
    const engineNegative = await h.mutate(async (engine) => engine.search(`publico -${secret}`, null, 20, null, null));
    expect(engineNegative.items.map((item) => item.id)).not.toContain(h.extra);
    expect((await h.call('hebra_search', { query: secret })).json.results).toEqual([]);
    const safe = await h.call('hebra_search', { query: `publico -${secret}` });
    expect(safe.json.results.map((item: { id: string }) => item.id)).toContain(h.extra);
    expect(safe.raw).not.toContain(secret);
  } finally { await h.close(); }
});

it('conserva subcadenas y rellena la página tras una exclusión por subcadena', async () => {
  const h = await auditHarness(async (engine) => {
    const b = await createNote(engine, null, '# Dos\npublico trigo\n');
    const c = await createNote(engine, null, '# Tres\npublico cebada\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const a = await createNote(engine, null, '# Uno\npublico Garbanzos\n');
    return { excluded: a.id, visible: [b.id, c.id] };
  });
  try {
    const substring = await h.call('hebra_search', { query: 'anzos' });
    expect(substring.json.results.map((item: { id: string }) => item.id)).toContain(h.extra.excluded);
    const bodyOnly = await h.mutate(async (engine) =>
      engine.search('publico -anzos', null, 2, { bodyOnly: true }, null));
    expect(bodyOnly.items[0]?.id).toBe(h.extra.excluded);
    const safePort = await h.port.search('publico -anzos', null, 2);
    expect(new Set(safePort.items.map((item) => item.id))).toEqual(new Set(h.extra.visible));
    const first = await h.call('hebra_search', { query: 'publico -anzos', limit: 1 });
    expect(first.json.results).toHaveLength(1);
    expect(first.json.nextCursor).not.toBeNull();
    const second = await h.call('hebra_search', {
      query: 'publico -anzos', limit: 1, cursor: first.json.nextCursor
    });
    expect(new Set([...first.json.results, ...second.json.results].map((item: { id: string }) => item.id)))
      .toEqual(new Set(h.extra.visible));
  } finally { await h.close(); }
});
