import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/server/errors';
import { runListNotes } from '../../src/server/tools/list-notes';
import { runReadNote } from '../../src/server/tools/read-note';
import { createNote } from '../fixtures/test-library';
import { withOwnLibrary } from '../fixtures/own-library';

/**
 * Estado de una nota (D23, 5 nov 2026): `favorite`, `archivedAt` y `generalHidden` en
 * `hebra_list_notes` y `hebra_read_note`, y `hebra_list_notes` con `archived: true`.
 * `Diario` es una carpeta privada y `#secreto` una etiqueta privada.
 */

const BAIT = 'CEBO_ESTADO_NOTA_3c7a';
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

async function expectCode(promise: Promise<unknown>, code: string): Promise<ToolError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ToolError);
  expect((error as ToolError).code).toBe(code);
  return error as ToolError;
}

/** Una biblioteca con una nota de cada estado, visibles y ocultas. */
async function build(engine: Parameters<Parameters<typeof withOwnLibrary>[0]>[0]) {
  const diario = await engine.folderCreate(null, 'Diario');
  const oculta = await engine.folderCreate(null, 'Oculta');
  const proyectos = await engine.folderCreate(null, 'Proyectos');
  await engine.folderHide(oculta.id);
  const sub = await engine.folderCreate(oculta.id, 'Hija');
  const plain = await createNote(engine, proyectos.id, '# Normal\nTexto.\n');
  const fav = await createNote(engine, proyectos.id, '# Favorita\nTexto.\n');
  await engine.noteSetFavorite(fav.id, true);
  const hiddenOwn = await createNote(engine, proyectos.id, '# Oculta propia\nTexto.\n');
  await engine.noteHide(hiddenOwn.id);
  const inHiddenFolder = await createNote(engine, oculta.id, '# En carpeta oculta\nTexto.\n');
  const inHiddenChild = await createNote(engine, sub.id, '# En hija de oculta\nTexto.\n');
  const archivedOld = await createNote(engine, proyectos.id, '# Archivada vieja\n## Apartado\nTexto.\n');
  await engine.noteArchive(archivedOld.id);
  await tick();
  const archivedNew = await createNote(engine, proyectos.id, '# Archivada nueva\nTexto.\n');
  await engine.noteArchive(archivedNew.id);
  await tick();
  const archivedHidden = await createNote(engine, proyectos.id, '# Archivada y oculta\nTexto.\n');
  await engine.noteArchive(archivedHidden.id);
  await engine.noteHide(archivedHidden.id);
  // Archivadas pero privadas: por carpeta y por etiqueta. Nunca salen.
  const privFolder = await createNote(engine, diario.id, `# Privada de carpeta\n${BAIT}\n`);
  await engine.noteArchive(privFolder.id);
  const privTag = await createNote(engine, proyectos.id, `# Privada de etiqueta\n#secreto\n${BAIT}\n`);
  await engine.noteArchive(privTag.id);
  // Archivada y en la papelera: no sale en ninguna lista.
  const archivedTrashed = await createNote(engine, proyectos.id, '# Archivada y tirada\nTexto.\n');
  await engine.noteArchive(archivedTrashed.id);
  await engine.noteTrash(archivedTrashed.id);
  return {
    plain: plain.id,
    fav: fav.id,
    hiddenOwn: hiddenOwn.id,
    inHiddenFolder: inHiddenFolder.id,
    inHiddenChild: inHiddenChild.id,
    archivedOld: archivedOld.id,
    archivedNew: archivedNew.id,
    archivedHidden: archivedHidden.id,
    hiddenIds: [privFolder.id, privTag.id],
    archivedTrashed: archivedTrashed.id
  };
}

describe('estado de las notas en hebra_list_notes y hebra_read_note', () => {
  it('la lista trae favorite, archivedAt y generalHidden; no trae las archivadas y sí las ocultas', async () => {
    await withOwnLibrary(build, async (fresh, ids) => {
      const { notes } = await runListNotes(await fresh(), { limit: 100 });
      const byId = new Map(notes.map((note) => [note.id, note]));
      for (const note of notes) {
        expect(typeof note.favorite).toBe('boolean');
        expect(note.archivedAt).toBeNull();
        expect(typeof note.generalHidden).toBe('boolean');
      }
      expect(byId.get(ids.plain)).toMatchObject({ favorite: false, generalHidden: false });
      expect(byId.get(ids.fav)).toMatchObject({ favorite: true, generalHidden: false });
      // Oculta por su propia marca, por su carpeta y por una carpeta antecesora.
      for (const id of [ids.hiddenOwn, ids.inHiddenFolder, ids.inHiddenChild]) {
        expect(byId.get(id)?.generalHidden, id).toBe(true);
      }
      // Sin `archived`, ni las archivadas, ni las privadas, ni la tirada.
      for (const id of [
        ids.archivedOld,
        ids.archivedNew,
        ids.archivedHidden,
        ids.archivedTrashed,
        ...ids.hiddenIds
      ]) {
        expect(byId.has(id), id).toBe(false);
      }
      expect(JSON.stringify(notes)).not.toContain(BAIT);
    });
  });

  it('`archived: true` lista solo las archivadas visibles, la última archivada primero', async () => {
    await withOwnLibrary(build, async (fresh, ids) => {
      const { notes, nextCursor } = await runListNotes(await fresh(), { archived: true, limit: 100 });
      expect(nextCursor).toBeNull();
      // La última en archivarse primero; la oculta del listado general también sale.
      expect(notes.map((note) => note.id)).toEqual([ids.archivedHidden, ids.archivedNew, ids.archivedOld]);
      for (const note of notes) {
        expect(Number.isNaN(Date.parse(note.archivedAt!))).toBe(false);
        expect(typeof note.favorite).toBe('boolean');
      }
      expect(notes[0]).toMatchObject({ generalHidden: true });
      expect(notes[1]).toMatchObject({ generalHidden: false });
      const dates = notes.map((note) => Date.parse(note.archivedAt!));
      expect(dates[0]).toBeGreaterThanOrEqual(dates[1]!);
      expect(dates[1]).toBeGreaterThanOrEqual(dates[2]!);
      const text = JSON.stringify(notes);
      expect(text).not.toContain(BAIT);
      for (const id of [...ids.hiddenIds, ids.archivedTrashed]) expect(text).not.toContain(id);
    });
  });

  it('`archived: true` pagina de una en una sin saltarse ni repetir, y `archived: false` es lo de siempre', async () => {
    await withOwnLibrary(build, async (fresh, ids) => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 6; page += 1) {
        const result = await runListNotes(await fresh(), { archived: true, limit: 1, cursor });
        seen.push(...result.notes.map((note) => note.id));
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
      expect(seen).toEqual([ids.archivedHidden, ids.archivedNew, ids.archivedOld]);

      const normal = await runListNotes(await fresh(), { limit: 100 });
      const off = await runListNotes(await fresh(), { archived: false, limit: 100 });
      expect(off).toEqual(normal);
    });
  });

  it('`archived: true` con `folder` o `tag` es invalid_input, también con una carpeta o etiqueta privada', async () => {
    await withOwnLibrary(build, async (fresh) => {
      const ctx = await fresh();
      for (const input of [
        { archived: true, folder: 'proyectos' },
        { archived: true, tag: 'proyectos' },
        { archived: true, folder: 'diario' },
        { archived: true, tag: 'secreto' },
        { archived: true, folder: 'no-existe' }
      ]) {
        const error = await expectCode(runListNotes(ctx, input), 'invalid_input');
        expect(error.extra).toBeUndefined();
      }
    });
  });

  it('`fields` admite los tres campos nuevos y recorta lo demás', async () => {
    await withOwnLibrary(build, async (fresh, ids) => {
      const ctx = await fresh();
      const only = await runListNotes(ctx, { fields: ['generalHidden'], limit: 100 });
      const hidden = only.notes.find((note) => note.id === ids.hiddenOwn);
      expect(hidden).toEqual({ id: ids.hiddenOwn, generalHidden: true });
      const favorite = await runListNotes(ctx, { fields: ['favorite'], limit: 100 });
      expect(favorite.notes.find((note) => note.id === ids.fav)).toEqual({ id: ids.fav, favorite: true });
      const archived = await runListNotes(ctx, { archived: true, fields: ['archivedAt'], limit: 100 });
      expect(archived.notes.map((note) => Object.keys(note).sort())).toEqual([
        ['archivedAt', 'id'],
        ['archivedAt', 'id'],
        ['archivedAt', 'id']
      ]);
    });
  });

  it('hebra_read_note trae el estado, también por apartado, y una nota oculta sigue siendo not_found', async () => {
    await withOwnLibrary(build, async (fresh, ids) => {
      const ctx = await fresh();
      const fav = await runReadNote(ctx, { id: ids.fav });
      expect(fav).toMatchObject({ favorite: true, archivedAt: null, generalHidden: false });
      const hiddenFolder = await runReadNote(ctx, { id: ids.inHiddenChild });
      expect(hiddenFolder.generalHidden).toBe(true);
      const archived = await runReadNote(ctx, { id: ids.archivedOld });
      expect(Number.isNaN(Date.parse(archived.archivedAt!))).toBe(false);
      const section = await runReadNote(ctx, { id: ids.archivedOld, heading: 'Apartado' });
      expect(section.section).toBeDefined();
      expect(section.archivedAt).toBe(archived.archivedAt);
      const lines = await runReadNote(ctx, { id: ids.archivedOld, lines: { from: 1, to: 1 } });
      expect(lines.archivedAt).toBe(archived.archivedAt);

      const errors = [];
      for (const id of [...ids.hiddenIds, ids.archivedTrashed, 'no-existe']) {
        errors.push(await expectCode(runReadNote(ctx, { id }), 'not_found'));
      }
      for (const error of errors) expect(error.extra).toBeUndefined();
    });
  });
});
