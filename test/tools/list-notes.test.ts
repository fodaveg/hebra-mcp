import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { BAIT_FOLDER, BAIT_TAG } from '../fixtures/test-library';
import { runListNotes } from '../../src/server/tools/list-notes';

describe('hebra_list_notes', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('forma de SPEC.md §5, orden por updatedAt desc', async () => {
    test = await buildTestContext();
    const { notes, nextCursor } = await runListNotes(test.ctx, {});
    expect(notes.length).toBeGreaterThan(0);
    expect(nextCursor === null || typeof nextCursor === 'string').toBe(true);
    for (const note of notes) {
      expect(typeof note.id).toBe('string');
      expect(typeof note.title).toBe('string');
      expect(typeof note.folderPath).toBe('string');
      expect(Array.isArray(note.tags)).toBe(true);
      expect(typeof note.excerpt).toBe('string');
      expect(typeof note.isConflictCopy).toBe('boolean');
    }
    const updatedAts = notes.map((note) => Date.parse(note.updatedAt));
    for (let i = 1; i < updatedAts.length; i += 1) expect(updatedAts[i - 1]).toBeGreaterThanOrEqual(updatedAts[i]!);
  });

  it('nunca trae la nota en la papelera', async () => {
    test = await buildTestContext();
    const { notes } = await runListNotes(test.ctx, { limit: 100 });
    expect(notes.some((note) => note.id === test!.library.trashedNoteId)).toBe(false);
  });

  it('marca la copia de conflicto', async () => {
    test = await buildTestContext();
    const { notes } = await runListNotes(test.ctx, { limit: 100 });
    const copy = notes.find((note) => note.id === test!.library.conflictCopyId);
    expect(copy?.isConflictCopy).toBe(true);
  });

  it('nunca trae el cebo de carpeta ni de etiqueta privada', async () => {
    test = await buildTestContext();
    const { notes } = await runListNotes(test.ctx, { limit: 100 });
    for (const note of notes) {
      expect(note.excerpt).not.toContain(BAIT_FOLDER);
      expect(note.excerpt).not.toContain(BAIT_TAG);
      expect(note.id).not.toBe(test!.library.privateFolderNoteId);
      expect(note.id).not.toBe(test!.library.privateTagNoteId);
    }
  });

  it('la paginación rellena hasta el límite con notas visibles', async () => {
    test = await buildTestContext();
    const { notes } = await runListNotes(test.ctx, { limit: 2 });
    expect(notes).toHaveLength(2);
  });

  it('filtra por carpeta anidada (subárbol)', async () => {
    test = await buildTestContext();
    const { notes } = await runListNotes(test.ctx, { folder: 'diario', limit: 100 });
    expect(notes).toHaveLength(0); // la carpeta entera es privada
  });

  it('filtra por etiqueta anidada', async () => {
    test = await buildTestContext();
    const { notes } = await runListNotes(test.ctx, { tag: 'proyectos', limit: 100 });
    expect(notes.length).toBeGreaterThanOrEqual(2);
    for (const note of notes) expect(note.tags.some((tag) => tag.startsWith('proyectos'))).toBe(true);
  });

  it('un cursor devuelto sigue paginando', async () => {
    test = await buildTestContext();
    const first = await runListNotes(test.ctx, { limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const second = await runListNotes(test.ctx, { limit: 1, cursor: first.nextCursor! });
    expect(second.notes[0]?.id).not.toBe(first.notes[0]?.id);
  });
});
