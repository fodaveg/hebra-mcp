import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { runListTags } from '../../src/server/tools/list-tags';

describe('hebra_list_tags', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('forma {tag,count}, anidadas como a/b', async () => {
    test = await buildTestContext();
    const { tags } = await runListTags(test.ctx);
    const byTag = new Map(tags.map((t) => [t.tag, t.count]));
    expect(byTag.get('proyectos')).toBe(2);
    expect(byTag.get('proyectos/lumbre')).toBe(2);
    for (const entry of tags) expect(entry.count).toBeGreaterThan(0);
  });

  it('una etiqueta privada nunca aparece', async () => {
    test = await buildTestContext();
    const { tags } = await runListTags(test.ctx);
    expect(tags.some((t) => t.tag === 'secreto')).toBe(false);
    expect(tags.some((t) => t.tag === 'secreto/personal')).toBe(false);
  });
});
