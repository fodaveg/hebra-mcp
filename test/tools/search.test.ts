import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { BAIT_FOLDER, BAIT_TAG } from '../fixtures/test-library';
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
});
