import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { BAIT_FOLDER, BAIT_TAG } from '../fixtures/test-library';
import { runReadNote } from '../../src/server/tools/read-note';
import { ToolError } from '../../src/server/errors';

describe('hebra_read_note', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('lee por id, con la forma de SPEC.md §5', async () => {
    test = await buildTestContext();
    const note = await runReadNote(test.ctx, { id: test.library.publicNoteId });
    expect(note.id).toBe(test.library.publicNoteId);
    expect(note.title).toBe(test.library.publicNoteTitle);
    expect(typeof note.body).toBe('string');
    expect(note.folderPath).toBe('proyectos/lumbre');
    expect(note.tags).toContain('proyectos/lumbre');
    expect(note.isConflictCopy).toBe(false);
    expect(note.conflictOf).toBeUndefined();
    expect(() => new Date(note.createdAt).toISOString()).not.toThrow();
  });

  it('lee por título exacto', async () => {
    test = await buildTestContext();
    const note = await runReadNote(test.ctx, { title: test.library.publicNoteTitle });
    expect(note.id).toBe(test.library.publicNoteId);
  });

  it('marca la copia de conflicto y su origen', async () => {
    test = await buildTestContext();
    const copy = await runReadNote(test.ctx, { id: test.library.conflictCopyId });
    expect(copy.isConflictCopy).toBe(true);
    expect(copy.conflictOf).toBe(test.library.publicNoteId);
  });

  it('título ambiguo: error con candidatos', async () => {
    test = await buildTestContext();
    await expect(runReadNote(test.ctx, { title: test.library.duplicateTitle })).rejects.toMatchObject({
      code: 'ambiguous_title'
    });
    try {
      await runReadNote(test.ctx, { title: test.library.duplicateTitle });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const candidates = (error as ToolError).extra?.candidates as Array<{ id: string }>;
      const ids = candidates.map((c) => c.id).sort();
      expect(ids).toEqual([test.library.duplicateNoteAId, test.library.duplicateNoteBId].sort());
    }
  });

  it('ni id ni título: invalid_input', async () => {
    test = await buildTestContext();
    await expect(runReadNote(test.ctx, {})).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('id y título a la vez: invalid_input', async () => {
    test = await buildTestContext();
    await expect(
      runReadNote(test.ctx, { id: test.library.publicNoteId, title: 'lo que sea' })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('id inexistente: not_found', async () => {
    test = await buildTestContext();
    await expect(runReadNote(test.ctx, { id: 'no-existe' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('una nota en la papelera: not_found', async () => {
    test = await buildTestContext();
    await expect(runReadNote(test.ctx, { id: test.library.trashedNoteId })).rejects.toMatchObject({
      code: 'not_found'
    });
  });

  it('una nota de carpeta privada: not_found, como una inexistente', async () => {
    test = await buildTestContext();
    await expect(runReadNote(test.ctx, { id: test.library.privateFolderNoteId })).rejects.toMatchObject({
      code: 'not_found'
    });
  });

  it('una nota de etiqueta privada (descendiente): not_found', async () => {
    test = await buildTestContext();
    await expect(runReadNote(test.ctx, { id: test.library.privateTagNoteId })).rejects.toMatchObject({
      code: 'not_found'
    });
  });

  it('nunca devuelve el cebo, ni en el error de not_found', async () => {
    test = await buildTestContext();
    try {
      await runReadNote(test.ctx, { id: test.library.privateFolderNoteId });
      expect.unreachable();
    } catch (error) {
      expect(JSON.stringify((error as ToolError).extra ?? {})).not.toContain(BAIT_FOLDER);
    }
    try {
      await runReadNote(test.ctx, { id: test.library.privateTagNoteId });
      expect.unreachable();
    } catch (error) {
      expect(JSON.stringify((error as ToolError).extra ?? {})).not.toContain(BAIT_TAG);
    }
  });
});
