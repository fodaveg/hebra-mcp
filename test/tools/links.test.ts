import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { BAIT_FOLDER } from '../fixtures/test-library';
import { runLinks } from '../../src/server/tools/links';
import { ToolError } from '../../src/server/errors';

describe('hebra_links', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('outgoing resuelve una nota visible y deja sin resolver una oculta', async () => {
    test = await buildTestContext();
    const { outgoing } = await runLinks(test.ctx, { id: test.library.publicNoteId });
    const toPublic2 = outgoing.find((link) => link.ref.toLowerCase() === 'nota pública 2 de lumbre');
    expect(toPublic2?.resolvedId).toBe(test.library.publicNote2Id);
    expect(toPublic2?.title).toBe('Nota pública 2 de Lumbre');

    const toHidden = outgoing.find((link) => link.ref.toLowerCase() === 'nota oculta de carpeta');
    expect(toHidden).toBeDefined();
    expect(toHidden?.resolvedId).toBeUndefined();
    expect(toHidden?.title).toBeUndefined();
  });

  it('nunca trae el cebo en un enlace saliente sin resolver', async () => {
    test = await buildTestContext();
    const { outgoing } = await runLinks(test.ctx, { id: test.library.publicNoteId });
    expect(JSON.stringify(outgoing)).not.toContain(BAIT_FOLDER);
  });

  it('backlinks: solo notas visibles que enlazan aquí', async () => {
    test = await buildTestContext();
    const { backlinks } = await runLinks(test.ctx, { id: test.library.publicNoteId });
    expect(backlinks.some((b) => b.id === test!.library.linkingNoteId)).toBe(true);
  });

  it('una nota oculta por carpeta: not_found', async () => {
    test = await buildTestContext();
    await expect(runLinks(test.ctx, { id: test.library.privateFolderNoteId })).rejects.toMatchObject({
      code: 'not_found'
    });
  });

  it('una nota oculta por etiqueta: not_found', async () => {
    test = await buildTestContext();
    await expect(runLinks(test.ctx, { id: test.library.privateTagNoteId })).rejects.toMatchObject({
      code: 'not_found'
    });
  });

  it('una nota inexistente: not_found', async () => {
    test = await buildTestContext();
    await expect(runLinks(test.ctx, { id: 'no-existe' })).rejects.toBeInstanceOf(ToolError);
  });
});
