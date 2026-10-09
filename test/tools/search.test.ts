import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveToolContext } from '../../src/server/context';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { BAIT_FOLDER, BAIT_TAG } from '../fixtures/test-library';
import { runReadNote } from '../../src/server/tools/read-note';
import { runSearch } from '../../src/server/tools/search';

describe('hebra_search', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('devuelve forma y campos de SPEC.md §5', async () => {
    test = await buildTestContext();
    const { results } = await runSearch(test.ctx, { query: 'pública' });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(typeof result.id).toBe('string');
      expect(typeof result.title).toBe('string');
      expect(typeof result.folderPath).toBe('string');
      expect(Array.isArray(result.tags)).toBe(true);
      expect(typeof result.snippet).toBe('string');
      expect(() => new Date(result.updatedAt).toISOString()).not.toThrow();
    }
  });

  it('recorta al límite pedido (1-50)', async () => {
    test = await buildTestContext();
    const { results } = await runSearch(test.ctx, { query: 'nota', limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('nunca trae el cebo de una carpeta privada', async () => {
    test = await buildTestContext();
    const { results } = await runSearch(test.ctx, { query: BAIT_FOLDER });
    expect(results).toHaveLength(0);
  });

  it('nunca trae el cebo de una etiqueta privada (descendiente)', async () => {
    test = await buildTestContext();
    const { results } = await runSearch(test.ctx, { query: BAIT_TAG });
    expect(results).toHaveLength(0);
  });

  it('filtra por carpeta', async () => {
    test = await buildTestContext();
    const { results } = await runSearch(test.ctx, { query: 'lumbre', folder: 'proyectos/lumbre' });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result.folderPath).toBe('proyectos/lumbre');
  });

  it('una carpeta privada como filtro no da resultados, no un error', async () => {
    test = await buildTestContext();
    const { results } = await runSearch(test.ctx, { query: 'oculta', folder: 'diario' });
    expect(results).toHaveLength(0);
  });

  it('filtra por etiqueta', async () => {
    test = await buildTestContext();
    const { results } = await runSearch(test.ctx, { query: 'lumbre', tag: 'proyectos/lumbre' });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result.tags).toContain('proyectos/lumbre');
  });

  it('una etiqueta privada como filtro no da resultados', async () => {
    test = await buildTestContext();
    const { results } = await runSearch(test.ctx, { query: 'oculta', tag: 'secreto' });
    expect(results).toHaveLength(0);
  });

  it('marca la copia de conflicto con isConflictCopy y las demás en false', async () => {
    test = await buildTestContext();
    const { results } = await runSearch(test.ctx, { query: 'conflicto' });
    const copy = results.find((result) => result.id === test!.library.conflictCopyId);
    expect(copy?.isConflictCopy).toBe(true);
    const { results: normal } = await runSearch(test.ctx, { query: 'pública' });
    expect(normal.length).toBeGreaterThan(0);
    for (const result of normal) {
      expect(result.isConflictCopy).toBe(result.id === test!.library.conflictCopyId);
    }
  });

  it('`fields` puede pedir isConflictCopy', async () => {
    test = await buildTestContext();
    const { results } = await runSearch(test.ctx, {
      query: 'conflicto',
      fields: ['isConflictCopy']
    });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(Object.keys(result).sort()).toEqual(['id', 'isConflictCopy']);
    }
  });

  it('carpeta sin `subfolders`: solo las notas directas; con `subfolders`, todo el subárbol', async () => {
    test = await buildTestContext();
    const direct = await runSearch(test.ctx, { query: 'candidata', folder: 'proyectos' });
    expect(direct.results.map((result) => result.id)).toEqual([test.library.duplicateNoteAId]);
    const deep = await runSearch(test.ctx, {
      query: 'candidata',
      folder: 'proyectos',
      subfolders: true
    });
    expect(deep.results.map((result) => result.id).sort()).toEqual(
      [test.library.duplicateNoteAId, test.library.duplicateNoteBId].sort()
    );
    // La raíz con subcarpetas es toda la biblioteca visible; sin ellas, solo la raíz.
    const all = await runSearch(test.ctx, { query: 'candidata', folder: '', subfolders: true });
    expect(all.results).toHaveLength(2);
    const rootOnly = await runSearch(test.ctx, { query: 'candidata', folder: '' });
    expect(rootOnly.results).toHaveLength(0);
  });

  it('carpeta y etiqueta a la vez se combinan en la propia consulta', async () => {
    test = await buildTestContext();
    const { results } = await runSearch(test.ctx, {
      query: 'lumbre',
      folder: 'proyectos',
      subfolders: true,
      tag: 'proyectos/lumbre'
    });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.folderPath.toLowerCase().startsWith('proyectos')).toBe(true);
      expect(result.tags).toContain('proyectos/lumbre');
    }
  });
  describe('heading (D11)', () => {
    const BODY = [
      'Preámbulo con la palabra zorzal suelto.',
      '',
      '# Aves',
      'texto general',
      '## Canto',
      'El zorzalito canta al amanecer',
      '## Vuelo',
      'nada que ver',
      '# Otros',
      'cierre'
    ].join('\n');

    async function withNote(body: string) {
      test = await buildTestContext();
      const created = await test.ctx.write!.createNote({
        body,
        folderId: null,
        privacy: test.serverContext.privacyConfig
      });
      return { id: created.id, ctx: await resolveToolContext(test.serverContext) };
    }

    it('el apartado más interno que contiene el fragmento; sirve tal cual para leer', async () => {
      const { id, ctx } = await withNote(BODY);
      const { results } = await runSearch(ctx, { query: 'zorzalito' });
      const hit = results.find((result) => result.id === id);
      expect(hit?.heading).toBe('Canto');
      const read = await runReadNote(ctx, { id, heading: hit!.heading! });
      expect(read.body).toBe('## Canto\nEl zorzalito canta al amanecer\n');
    });

    it('null si el fragmento cae antes del primer encabezado', async () => {
      const { id, ctx } = await withNote(BODY);
      const { results } = await runSearch(ctx, { query: 'preámbulo' });
      expect(results.find((result) => result.id === id)?.heading).toBeNull();
    });

    it('null si la nota no tiene encabezados', async () => {
      const { id, ctx } = await withNote('Una nota con zorzalitos y nada más.');
      const { results } = await runSearch(ctx, { query: 'zorzalitos' });
      expect(results.find((result) => result.id === id)?.heading).toBeNull();
    });

    it('se puede pedir con `fields`; sin `heading` en `fields`, no se lee ningún cuerpo', async () => {
      const { id, ctx } = await withNote(BODY);
      const reads = vi.spyOn(ctx.port, 'noteRead');
      const only = await runSearch(ctx, { query: 'zorzalito', fields: ['title'] });
      expect(reads).not.toHaveBeenCalled();
      expect(Object.keys(only.results[0]!).sort()).toEqual(['id', 'title']);
      const picked = await runSearch(ctx, { query: 'zorzalito', fields: ['heading'] });
      expect(reads).toHaveBeenCalled();
      expect(picked.results.find((result) => result.id === id)).toEqual({ id, heading: 'Canto' });
    });

    it('nunca lee el cuerpo de una nota oculta', async () => {
      test = await buildTestContext();
      const reads = vi.spyOn(test.ctx.port, 'noteRead');
      for (const query of [BAIT_FOLDER, BAIT_TAG, 'oculta']) {
        const { results } = await runSearch(test.ctx, { query });
        for (const result of results) expect(typeof result.heading === 'string' || result.heading === null).toBe(true);
      }
      const readIds = reads.mock.calls.map(([readId]) => readId);
      expect(readIds).not.toContain(test.library.privateFolderNoteId);
      expect(readIds).not.toContain(test.library.privateTagNoteId);
    });
  });
});
