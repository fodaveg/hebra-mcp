/**
 * Las herramientas que escriben sobre una nota, perezosas (A5b del plan de memoria, 6 nov
 * 2026): registradas con `privacyLoad: 'lazy'`, solo cargan en el filtro de privados la nota
 * sobre la que actúan (`requireLoadedVisibleNote`, `./src/server/tools/guards.ts`) o, en
 * `hebra_replace_in_notes`, las que nombra su respuesta.
 *
 * Cada caso pasa por `expectLazyWriteEquivalent` (`test/fixtures/privacy-load-writes.ts`): dos
 * copias idénticas de la biblioteca, una con `'all'` forzado y otra con la carga declarada, con
 * la misma respuesta, el mismo estado final de las notas y sin preguntas por notas no
 * cargadas. Además se comprueba QUÉ responde (las dos podrían estar mal a la vez).
 *
 * Ninguna de estas herramientas acepta `title`: no hay homónimas que cargar.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { PrivacyConfig } from '../../src/privacy';
import { callToolWithLoad } from '../fixtures/privacy-load';
import {
  expectLazyWriteEquivalent,
  twinHarness,
  type TwinHarness,
  type TwinSide
} from '../fixtures/privacy-load-writes';
import { AUDIT_CONFIG, createNote, lockedBody, NOT_FOUND, saveBody } from '../privacy/audit-harness';

/** Sin etiquetas privadas: una nota bloqueada se ve (A1 solo la oculta con etiquetas privadas). */
const NO_TAGS_CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: [] };

const LOCKED_TITLE = 'Nota bloqueada de escrituras perezosas';

interface Extra {
  lockedId: string;
  /** En la raíz, con texto que reemplazar en `hebra_replace_in_notes`. */
  replaceIds: string[];
  /** Oculta por etiqueta, con el mismo texto: nunca entra en el plan. */
  hiddenReplaceId: string;
}

/** Un cebo común a las notas del reemplazo, que no sale en ninguna otra. */
const REPLACE_WORD = 'palabraperezosa';

async function harness(config: PrivacyConfig = AUDIT_CONFIG): Promise<TwinHarness<Extra>> {
  return twinHarness<Extra>(async (engine, library) => {
    const locked = await createNote(engine, null, `# ${LOCKED_TITLE}\nAntes de bloquearla.\n`);
    await saveBody(engine, locked.id, lockedBody(LOCKED_TITLE, []));
    const replaceIds: string[] = [];
    for (const n of [1, 2, 3]) {
      replaceIds.push((await createNote(engine, null, `# Reemplazo ${n}\nUna ${REPLACE_WORD} aquí.\n`)).id);
    }
    // Una más en una carpeta privada, para el ámbito por ids.
    await createNote(engine, library.folders.diario2026, `# Reemplazo oculto\nOtra ${REPLACE_WORD}.\n`);
    const hidden = await createNote(engine, null, `# Reemplazo con etiqueta\n#secreto\nY ${REPLACE_WORD}.\n`);
    return { lockedId: locked.id, replaceIds, hiddenReplaceId: hidden.id };
  }, config);
}

/** La revisión de una nota visible, la misma en las dos copias. */
async function revisionOf(h: TwinHarness<Extra>, id: string): Promise<string> {
  return (await readBoth(h, id)).revision;
}

/** Revisión y primera línea (única: el H1) de una nota visible, iguales en las dos copias. */
async function readBoth(h: TwinHarness<Extra>, id: string): Promise<{ revision: string; firstLine: string }> {
  const all = await callToolWithLoad(h.all.serverContext, 'hebra_read_note', { id });
  const lazy = await callToolWithLoad(h.lazy.serverContext, 'hebra_read_note', { id });
  // Las fechas de la salida dependen del reloj de cada escritura; la revisión y el cuerpo no.
  expect(lazy.json.revision).toBe(all.json.revision);
  expect(lazy.json.body).toBe(all.json.body);
  return { revision: all.json.revision as string, firstLine: (all.json.body as string).split('\n')[0]! };
}

/** Las notas ocultas o inexistentes de la biblioteca de prueba, para los `not_found`. */
function hiddenIds(h: TwinHarness<Extra>): string[] {
  return [
    h.library.privateFolderNoteId,
    h.library.privateTagNoteId,
    h.library.trashedNoteId,
    h.library.trashedPrivateTagNoteId,
    'no-existe-0000'
  ];
}

const TEXT_BASE64 = Buffer.from('hola perezosa\n').toString('base64');

describe('escrituras sobre una nota con privacyLoad lazy: igual que con la biblioteca entera', () => {
  let h: TwinHarness<Extra> | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  const same = (name: string, args: Record<string, unknown> | ((side: TwinSide) => Record<string, unknown>)) =>
    expectLazyWriteEquivalent(h!, name, args);

  describe('hebra_edit_note', () => {
    it('pública: guarda; repetida con el mismo operationId: replayed', async () => {
      h = await harness();
      const { revision, firstLine } = await readBoth(h, h.library.publicNote2Id);
      const args = {
        id: h.library.publicNote2Id,
        edits: [{ find: firstLine, replace: `${firstLine} editada` }],
        expectedRevision: revision,
        operationId: 'op-lazy-edit-0001'
      };
      const first = await same('hebra_edit_note', args);
      expect(first.lazy.json.outcome).toBe('saved');
      const again = await same('hebra_edit_note', args);
      expect(again.lazy.json.replayed).toBe(true);
    });

    it('privada por carpeta o etiqueta, papelera, inexistente o bloqueada con etiquetas privadas: not_found', async () => {
      h = await harness();
      for (const id of [...hiddenIds(h), h.extra.lockedId]) {
        const call = await same('hebra_edit_note', {
          id,
          edits: [{ find: 'a', replace: 'b' }],
          expectedRevision: 'r1.x',
          operationId: 'op-lazy-edit-0002'
        });
        expect(call.lazy.json).toEqual(NOT_FOUND);
      }
    });

    it('bloqueada sin etiquetas privadas: la ve y responde igual', async () => {
      h = await harness(NO_TAGS_CONFIG);
      const call = await same('hebra_edit_note', {
        id: h.extra.lockedId,
        edits: [{ find: 'a', replace: 'b' }],
        expectedRevision: await revisionOf(h, h.extra.lockedId),
        operationId: 'op-lazy-edit-0003'
      });
      expect(call.lazy.isError).toBe(true);
      expect(call.lazy.json).not.toEqual(NOT_FOUND);
    });
  });

  describe('hebra_append_to_note', () => {
    it('pública: añade; repetida con el mismo operationId: replayed', async () => {
      h = await harness();
      const args = { id: h.library.publicNote2Id, text: 'Añadido perezoso.', operationId: 'op-lazy-append-01' };
      const first = await same('hebra_append_to_note', args);
      expect(first.lazy.json.outcome).toBe('saved');
      const again = await same('hebra_append_to_note', args);
      expect(again.lazy.json.replayed).toBe(true);
    });

    it('ocultas, inexistente y bloqueada con etiquetas privadas: not_found', async () => {
      h = await harness();
      for (const id of [...hiddenIds(h), h.extra.lockedId]) {
        const call = await same('hebra_append_to_note', { id, text: 'x' });
        expect(call.lazy.json).toEqual(NOT_FOUND);
      }
    });

    it('bloqueada sin etiquetas privadas: note_locked', async () => {
      h = await harness(NO_TAGS_CONFIG);
      const call = await same('hebra_append_to_note', { id: h.extra.lockedId, text: 'x' });
      expect(call.lazy.json).toMatchObject({ error: 'note_locked' });
    });
  });

  describe('hebra_add_attachment', () => {
    it('pública: añade; repetida con el mismo operationId: replayed', async () => {
      h = await harness();
      const args = {
        id: h.library.publicNote2Id,
        name: 'perezoso.txt',
        dataBase64: TEXT_BASE64,
        mimeType: 'text/plain',
        operationId: 'op-lazy-attach-01'
      };
      const first = await same('hebra_add_attachment', args);
      expect(first.lazy.json.outcome).toBe('saved');
      expect(first.lazy.json.attachmentId).toBe(
        createHash('sha256').update(Buffer.from(TEXT_BASE64, 'base64')).digest('hex')
      );
      const again = await same('hebra_add_attachment', args);
      expect(again.lazy.json.replayed).toBe(true);
    });

    it('ocultas e inexistente: not_found; bloqueada sin etiquetas privadas: note_locked', async () => {
      h = await harness();
      for (const id of [...hiddenIds(h), h.extra.lockedId]) {
        const call = await same('hebra_add_attachment', {
          id,
          name: 'x.txt',
          dataBase64: TEXT_BASE64,
          mimeType: 'text/plain',
          operationId: 'op-lazy-attach-02'
        });
        expect(call.lazy.json).toEqual(NOT_FOUND);
      }
      await h.close();
      h = await harness(NO_TAGS_CONFIG);
      const locked = await same('hebra_add_attachment', {
        id: h.extra.lockedId,
        name: 'x.txt',
        dataBase64: TEXT_BASE64,
        mimeType: 'text/plain',
        operationId: 'op-lazy-attach-03'
      });
      expect(locked.lazy.json).toMatchObject({ error: 'note_locked' });
    });
  });

  describe('estado de la nota: favorita, archivar, ocultar del listado, mover, conflicto', () => {
    it('pública: cada una escribe lo mismo', async () => {
      h = await harness();
      const id = h.library.publicNote2Id;
      expect((await same('hebra_set_favorite', { id, favorite: true })).lazy.json.favorite).toBe(true);
      expect((await same('hebra_set_archived', { id, archived: true })).lazy.json.archived).toBe(true);
      expect((await same('hebra_set_hidden', { id, hidden: true })).lazy.json.hidden).toBe(true);
      const moved = await same('hebra_move_note', { id, folderId: h.library.folders.lumbre });
      expect(moved.lazy.json.folderPath).toMatch(/^proyectos\/lumbre$/i);
      const withRevision = await same('hebra_move_note', {
        id,
        folderId: 'root',
        expectedRevision: await revisionOf(h, id)
      });
      expect(withRevision.lazy.json.folderPath).toBe('');
      expect((await same('hebra_clear_conflict', { id: h.library.conflictCopyId })).lazy.json.cleared).toBe(true);
    });

    it('ocultas, inexistente y bloqueada con etiquetas privadas: not_found en todas', async () => {
      h = await harness();
      for (const id of [...hiddenIds(h), h.extra.lockedId]) {
        expect((await same('hebra_set_favorite', { id, favorite: true })).lazy.json).toEqual(NOT_FOUND);
        expect((await same('hebra_set_archived', { id, archived: true })).lazy.json).toEqual(NOT_FOUND);
        expect((await same('hebra_set_hidden', { id, hidden: true })).lazy.json).toEqual(NOT_FOUND);
        expect((await same('hebra_clear_conflict', { id })).lazy.json).toEqual(NOT_FOUND);
        expect((await same('hebra_move_note', { id, folderId: 'root' })).lazy.json).toEqual(NOT_FOUND);
      }
    });

    it('mover a una carpeta privada: not_found', async () => {
      h = await harness();
      const call = await same('hebra_move_note', {
        id: h.library.publicNote2Id,
        folderId: h.library.folders.diario2026
      });
      expect(call.lazy.json).toEqual(NOT_FOUND);
    });

    it('bloqueada sin etiquetas privadas: favorita como cualquiera', async () => {
      h = await harness(NO_TAGS_CONFIG);
      const call = await same('hebra_set_favorite', { id: h.extra.lockedId, favorite: true });
      expect(call.lazy.json.favorite).toBe(true);
    });
  });

  describe('papelera: hebra_trash_note y hebra_restore_note', () => {
    it('manda una pública, repite sobre la que ya está y la saca', async () => {
      h = await harness();
      const id = h.library.publicNote2Id;
      expect((await same('hebra_trash_note', { id })).lazy.json.trashed).toBe(true);
      expect((await same('hebra_trash_note', { id })).lazy.json.trashed).toBe(true);
      expect((await same('hebra_restore_note', { id })).lazy.json.id).toBe(id);
      expect((await same('hebra_restore_note', { id })).lazy.json.id).toBe(id);
    });

    it('con expectedRevision, igual', async () => {
      h = await harness();
      const id = h.library.publicNote2Id;
      const call = await same('hebra_trash_note', { id, expectedRevision: await revisionOf(h, id) });
      expect(call.lazy.json.trashed).toBe(true);
    });

    it('las de la papelera visibles se sacan; las ocultas, not_found', async () => {
      h = await harness();
      for (const id of [h.library.trashedNoteId, h.library.trashedDeletedPublicFolderNoteId]) {
        expect((await same('hebra_restore_note', { id })).lazy.json.id).toBe(id);
      }
      for (const id of [
        h.library.trashedPrivateFolderNoteId,
        h.library.trashedPrivateTagNoteId,
        h.library.trashedDeletedPrivateFolderNoteId,
        h.library.privateFolderNoteId,
        h.library.privateTagNoteId,
        h.extra.lockedId,
        'no-existe-0000'
      ]) {
        expect((await same('hebra_restore_note', { id })).lazy.json).toEqual(NOT_FOUND);
        expect((await same('hebra_trash_note', { id })).lazy.json).toEqual(NOT_FOUND);
      }
    });
  });

  describe('versiones: hebra_list_versions, hebra_read_version y hebra_restore_version', () => {
    it('lista y lee la visible; la que fue privada no sale', async () => {
      h = await harness();
      const listed = await same('hebra_list_versions', { id: h.library.versionedNoteId });
      expect(listed.lazy.json.versions.map((v: { versionId: number }) => v.versionId)).toContain(
        h.library.versionedNoteVersionId
      );
      const read = await same('hebra_read_version', {
        id: h.library.versionedNoteId,
        versionId: h.library.versionedNoteVersionId
      });
      expect(read.lazy.json.body).toContain('Primera redacción');
      const formerly = await same('hebra_list_versions', { id: h.library.formerlyPrivateNoteId });
      expect(formerly.lazy.json.versions).toEqual([]);
      const hiddenVersion = await same('hebra_read_version', {
        id: h.library.formerlyPrivateNoteId,
        versionId: h.library.formerlyPrivateVersionId
      });
      expect(hiddenVersion.lazy.json).toEqual(NOT_FOUND);
    });

    it('restaura; repetida con el mismo operationId: replayed', async () => {
      h = await harness();
      const args = {
        id: h.library.versionedNoteId,
        versionId: h.library.versionedNoteVersionId,
        expectedRevision: await revisionOf(h, h.library.versionedNoteId),
        operationId: 'op-lazy-restore-01'
      };
      const first = await same('hebra_restore_version', args);
      expect(first.lazy.json.outcome).toBe('saved');
      const again = await same('hebra_restore_version', args);
      expect(again.lazy.json.replayed).toBe(true);
    });

    it('sobre notas ocultas, inexistentes o bloqueadas con etiquetas privadas: not_found', async () => {
      h = await harness();
      for (const id of [...hiddenIds(h), h.extra.lockedId]) {
        expect((await same('hebra_list_versions', { id })).lazy.json).toEqual(NOT_FOUND);
        expect((await same('hebra_read_version', { id, versionId: 1 })).lazy.json).toEqual(NOT_FOUND);
        const restored = await same('hebra_restore_version', {
          id,
          versionId: 1,
          expectedRevision: 'r1.x',
          operationId: 'op-lazy-restore-02'
        });
        expect(restored.lazy.json).toEqual(NOT_FOUND);
      }
    });
  });

  describe('hebra_replace_in_notes', () => {
    const simulate = (extra: Record<string, unknown> = {}) => ({
      mode: 'simulate',
      pattern: REPLACE_WORD,
      replacement: 'sustituida',
      ...extra
    });

    it('simular (toda la biblioteca, por ids con ocultas, por etiqueta), ver otra página, aplicar dos veces y deshacer', async () => {
      h = await harness();
      const extra = h.extra;
      const plan = await same('hebra_replace_in_notes', simulate({ limit: 1 }));
      expect(plan.lazy.json.planNotes).toBe(3);
      expect(plan.lazy.json.nextCursor).not.toBeNull();
      const byIds = await same(
        'hebra_replace_in_notes',
        simulate({ ids: [extra.replaceIds[0], extra.hiddenReplaceId, h.library.privateFolderNoteId] })
      );
      expect(byIds.lazy.json.planNotes).toBe(1);
      const byTag = await same('hebra_replace_in_notes', simulate({ tag: 'secreto' }));
      expect(byTag.lazy.json.planNotes ?? 0).toBe(0);

      const planOf = (side: TwinSide): string => plan[side].json.planId as string;
      const page = await same('hebra_replace_in_notes', (side) => ({
        mode: 'preview',
        planId: planOf(side),
        cursor: plan[side].json.nextCursor as string
      }));
      expect(page.lazy.json.notes).toHaveLength(2);

      const apply = (side: TwinSide) => ({ mode: 'apply', planId: planOf(side), operationId: 'op-lazy-replace-1' });
      const applied = await same('hebra_replace_in_notes', apply);
      expect(applied.lazy.json.complete).toBe(true);
      expect(applied.lazy.json.notes).toHaveLength(3);
      const again = await same('hebra_replace_in_notes', apply);
      expect(again.lazy.json.replayed).toBe(true);
      const undone = await same('hebra_replace_in_notes', (side) => ({ mode: 'undo', planId: planOf(side) }));
      expect(undone.lazy.json.notes).toHaveLength(3);
    });
  });
});
