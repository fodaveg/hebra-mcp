/**
 * `hebra_read_note` por título con MUCHAS candidatas (medición del audit, R4.6/R4.9):
 * el motor devuelve como mucho 50 por prefijo (`TITLE_PREFIX_LIMIT_MAX`), ordenadas por
 * `title_norm, id`. Tres casos:
 * - 60 notas visibles con el MISMO título: `ambiguous_title`, con candidatas (acotadas).
 * - Título «A» con 60 notas «A algo» más: la exacta sale la primera (un prefijo corto
 *   ordena antes que sus extensiones), así que no se pierde.
 * - 60 notas OCULTAS con el mismo título y una visible que, por id, queda más allá de las
 *   50 primeras: debe leerse, no dar `not_found` (que además delataría nada, pero sería
 *   un resultado falso).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PrivacyFilter } from '../../src/privacy';
import { ToolError } from '../../src/server/errors';
import { runReadNote } from '../../src/server/tools/read-note';
import { deriveNote, type NodeLibraryPort } from '../../src/store';
import type { ToolContext } from '../../src/server/context';
import { buildTestContext, type TestContext } from '../fixtures/test-context';

async function addNote(test: TestContext, body: string): Promise<string> {
  const created = await test.ctx.port.noteCreate(null);
  const derived = deriveNote(body);
  await test.ctx.port.noteSave({
    id: created.id,
    body,
    title: derived.title,
    titleNorm: derived.titleNorm,
    excerpt: derived.excerpt,
    expectedLocalSeq: created.localSeq,
    baseBodySha256: created.bodySha256,
    tags: derived.tags,
    links: derived.links,
    blobRefs: derived.blobRefs,
    props: derived.props
  });
  return created.id;
}

/** El contexto con el filtro de privados reconstruido tras crear las notas. */
async function refreshed(test: TestContext): Promise<ToolContext> {
  const privacy = await PrivacyFilter.build(test.ctx.port, test.ctx.privacyConfig);
  return { ...test.ctx, privacy };
}

describe('hebra_read_note por título con muchas candidatas', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('60 notas visibles con el mismo título: ambiguous_title con candidatas', async () => {
    test = await buildTestContext();
    const ids: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      ids.push(await addNote(test, `# Gemela\nCopia ${index}.\n`));
    }
    const ctx = await refreshed(test);
    const error = await runReadNote(ctx, { title: 'Gemela' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe('ambiguous_title');
    const candidates = (error as ToolError).extra?.candidates as Array<{ id: string }>;
    expect(candidates.length).toBeGreaterThan(1);
    for (const candidate of candidates) expect(ids).toContain(candidate.id);
  });

  it('título «A» con más de 50 notas «A algo»: la exacta se encuentra', async () => {
    test = await buildTestContext();
    const exact = await addNote(test, '# A\nLa exacta.\n');
    for (let index = 0; index < 60; index += 1) {
      await addNote(test, `# A algo ${String(index).padStart(2, '0')}\nOtra.\n`);
    }
    const ctx = await refreshed(test);
    const note = await runReadNote(ctx, { title: 'A' });
    expect(note.id).toBe(exact);
  });

  it('60 notas ocultas con el mismo título no esconden a la visible', async () => {
    test = await buildTestContext();
    for (let index = 0; index < 60; index += 1) {
      await addNote(test, `# Oculta\n#secreto\nPrivada ${index}.\n`);
    }
    // Una visible cuyo id quede más allá de las 50 primeras del motor (ordena por id):
    // si cae antes, a la papelera y otra (determinista, sin depender del azar de los uuid).
    let visible = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const candidate = await addNote(test, '# Oculta\nLa visible.\n');
      const { items } = await test.ctx.port.notesByTitlePrefix('Oculta', 50);
      if (!items.some((item) => item.id === candidate)) {
        visible = candidate;
        break;
      }
      await (test.ctx.port as NodeLibraryPort).writeExclusive((store) => store.noteTrash(candidate));
    }
    expect(visible).not.toBe('');
    const ctx = await refreshed(test);
    const note = await runReadNote(ctx, { title: 'Oculta' });
    expect(note.id).toBe(visible);
  });
});
