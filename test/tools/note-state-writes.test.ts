/**
 * Cambios de estado de una nota de D23 (5 nov 2026; SPEC.md §5 y §6.3), por el cliente MCP sobre
 * la biblioteca de prueba: `hebra_set_hidden`, `hebra_clear_conflict` y `expectedRevision` en
 * `hebra_move_note`, `hebra_trash_note` y `hebra_restore_note`. Sin sync: `sync: "not_linked"`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveToolContext } from '../../src/server/context';
import { encodeRevision, decodeRevision, REVISION_MAX_LENGTH } from '../../src/store/revision';
import { startLooseFiles, type LooseFilesHarness } from '../fixtures/loose-files';
import { createNote } from '../fixtures/test-library';
import type { PrivacyConfig } from '../../src/privacy';

const NOT_FOUND = { isError: true, value: { error: 'not_found' } };
const NO_PRIVATE: PrivacyConfig = { privateFolders: [], privateTags: [] };

describe('cambios de estado de una nota (D23)', () => {
  let h: LooseFilesHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(
    config?: PrivacyConfig,
    options?: Parameters<typeof startLooseFiles>[1]
  ): Promise<LooseFilesHarness> {
    h = await startLooseFiles(config, options);
    return h;
  }

  const row = (harness: LooseFilesHarness, id: string) =>
    harness.withEngine(async (engine) => (await engine.noteRead(id))!);

  const revisionOf = async (harness: LooseFilesHarness, id: string): Promise<string> =>
    (await harness.call('hebra_read_note', { id })).value.revision as string;

  /** Las notas que responden como una inexistente. */
  const hiddenIds = (harness: LooseFilesHarness): string[] => [
    harness.test.library.privateFolderNoteId,
    harness.test.library.privateTagNoteId,
    'no-existe'
  ];

  describe('hebra_set_hidden', () => {
    it('oculta y muestra, viaja por el sync (fila sucia) y es idempotente sin escribir', async () => {
      const harness = await start();
      const { call, test } = harness;
      const id = test.library.publicNote2Id;
      const hidden = await call('hebra_set_hidden', { id, hidden: true });
      expect(hidden).toEqual({
        isError: false,
        value: {
          id,
          folderPath: 'proyectos/lumbre',
          favorite: false,
          archived: false,
          hidden: true,
          sync: 'not_linked'
        }
      });
      const once = await row(harness, id);
      expect(once.hiddenAt).toEqual(expect.any(Number));

      expect((await call('hebra_set_hidden', { id, hidden: true })).value).toMatchObject({ hidden: true });
      const twice = await row(harness, id);
      expect(twice.localSeq).toBe(once.localSeq);
      expect(twice.hiddenAt).toBe(once.hiddenAt);

      expect((await call('hebra_set_hidden', { id, hidden: false })).value).toMatchObject({ hidden: false });
      const shown = await row(harness, id);
      expect(shown.hiddenAt).toBeNull();
      expect(shown.localSeq).toBeGreaterThan(once.localSeq);
    });

    it('es una preferencia de vista, no privacidad: sigue saliendo por el MCP', async () => {
      const { call, test } = await start();
      const id = test.library.publicNote2Id;
      await call('hebra_set_hidden', { id, hidden: true });
      expect((await call('hebra_read_note', { id })).isError).toBe(false);
      const listed = (await call('hebra_list_notes', { limit: 100 })).value.notes as Array<{ id: string }>;
      expect(listed.map((note) => note.id)).toContain(id);
    });

    it('oculta por privacidad, en la papelera o inexistente: not_found, igual, sin escribir', async () => {
      const harness = await start();
      const { call, test } = harness;
      for (const id of [...hiddenIds(harness), test.library.trashedNoteId]) {
        for (const hidden of [true, false]) {
          expect(await call('hebra_set_hidden', { id, hidden }), id).toEqual(NOT_FOUND);
        }
      }
      expect((await row(harness, test.library.privateTagNoteId)).hiddenAt ?? null).toBeNull();
    });

    it('el escritor lo vuelve a comprobar en su turno, con un filtro de antes de que la nota cruce', async () => {
      const harness = await start();
      const { test, withEngine } = harness;
      const id = test.library.publicNote2Id;
      await withEngine((engine) => engine.noteMove(id, test.library.folders.diario));
      await expect(
        test.serverContext.write!.noteState!({
          action: 'setHidden',
          id,
          hidden: true,
          privacy: test.serverContext.privacyConfig
        })
      ).rejects.toMatchObject({ code: 'not_found' });
      expect((await row(harness, id)).hiddenAt ?? null).toBeNull();
    });
  });

  describe('hebra_clear_conflict', () => {
    it('sobre una copia: deja de serlo, el cuerpo no cambia y sigue viéndose igual', async () => {
      const harness = await start();
      const { call, test } = harness;
      const id = test.library.conflictCopyId;
      const before = await row(harness, id);
      expect(before.conflictOf).not.toBeNull();
      const cleared = await call('hebra_clear_conflict', { id });
      expect(cleared.value).toMatchObject({ id, cleared: true, sync: 'not_linked' });
      // La salida no nombra la nota original, que puede no verse.
      expect(JSON.stringify(cleared)).not.toContain(test.library.publicNoteId);
      const after = await row(harness, id);
      expect(after.conflictOf).toBeNull();
      expect(after.body).toBe(before.body);
      expect(after.folderId).toBe(before.folderId);
      const read = (await call('hebra_read_note', { id })).value;
      expect(read.isConflictCopy).toBe(false);
      expect(read).not.toHaveProperty('conflictOf');
    });

    it('sobre otra nota, o una ya resuelta: cleared false sin escribir (el motor subiría local_seq)', async () => {
      const harness = await start();
      const { call, test } = harness;
      const plain = test.library.publicNote2Id;
      const before = await row(harness, plain);
      expect((await call('hebra_clear_conflict', { id: plain })).value).toMatchObject({ id: plain, cleared: false });
      expect((await row(harness, plain)).localSeq).toBe(before.localSeq);

      const copy = test.library.conflictCopyId;
      await call('hebra_clear_conflict', { id: copy });
      const resolved = await row(harness, copy);
      expect((await call('hebra_clear_conflict', { id: copy })).value).toMatchObject({ cleared: false });
      expect((await row(harness, copy)).localSeq).toBe(resolved.localSeq);
    });

    it('una copia con una etiqueta privada sigue oculta: la marca no decide qué se ve (D3)', async () => {
      const harness = await start();
      const { call, test, withEngine } = harness;
      const copy = await withEngine(async (engine) => {
        const original = await createNote(engine, null, '# Original\nuno\n');
        const hidden = await createNote(engine, null, '# Copia\n#secreto\n');
        return { original: original.id, hidden: hidden.id };
      });
      harness.exec(`UPDATE notes SET conflict_of = ? WHERE id = ?`, copy.original, copy.hidden);
      const before = await row(harness, copy.hidden);
      expect(await call('hebra_clear_conflict', { id: copy.hidden })).toEqual(NOT_FOUND);
      expect(await row(harness, copy.hidden)).toEqual(before);
      // Y una copia visible de una original oculta: se resuelve sin decir nada de la original.
      const original = test.library.privateTagNoteId;
      const visible = await withEngine(async (engine) => (await createNote(engine, null, '# Copia visible\n')).id);
      harness.exec(`UPDATE notes SET conflict_of = ? WHERE id = ?`, original, visible);
      const resolved = await call('hebra_clear_conflict', { id: visible });
      expect(resolved.value).toMatchObject({ cleared: true });
      expect(JSON.stringify(resolved)).not.toContain(original);
    });

    it('oculta por privacidad, en la papelera o inexistente: not_found, igual', async () => {
      const harness = await start();
      const { call, test } = harness;
      for (const id of [...hiddenIds(harness), test.library.trashedNoteId]) {
        expect(await call('hebra_clear_conflict', { id }), id).toEqual(NOT_FOUND);
      }
    });
  });

  describe('expectedRevision en hebra_move_note, hebra_trash_note y hebra_restore_note', () => {
    it('sin cambios: mueve, manda y saca con la revisión leída', async () => {
      const harness = await start();
      const { call, test } = harness;
      const id = test.library.publicNote2Id;
      const expectedRevision = await revisionOf(harness, id);
      const moved = await call('hebra_move_note', { id, folderId: 'root', expectedRevision });
      expect(moved.value).toMatchObject({ id, folderPath: '', sync: 'not_linked' });
      expect((await row(harness, id)).folderId).toBe('root');
      // Mover sube `local_seq`, pero el texto es el mismo: la misma revisión sigue valiendo.
      const trashed = await call('hebra_trash_note', { id, expectedRevision });
      expect(trashed.value).toEqual({ id, trashed: true, sync: 'not_linked' });
      // La de ANTES de mandarla es la única que se puede tener: hebra_read_note no la lee.
      expect(await call('hebra_read_note', { id })).toEqual(NOT_FOUND);
      const restored = await call('hebra_restore_note', { id, expectedRevision });
      expect(restored.value).toMatchObject({ id, folderPath: '' });
      expect((await row(harness, id)).trashedAt).toBeNull();
    });

    it('el texto cambió: revision_conflict sin escribir, en las tres', async () => {
      const harness = await start();
      const { call, test } = harness;
      const id = test.library.publicNote2Id;
      const stale = await revisionOf(harness, id);
      const edited = await call('hebra_edit_note', {
        id,
        edits: [{ find: 'Texto normal', replace: 'Texto cambiado' }],
        expectedRevision: stale,
        operationId: 'op-edita'
      });
      expect(edited.value).toMatchObject({ outcome: 'saved' });
      const before = await row(harness, id);
      const conflict = { isError: true, value: { error: 'revision_conflict' } };
      expect(await call('hebra_move_note', { id, folderId: 'root', expectedRevision: stale })).toEqual(conflict);
      expect(await call('hebra_trash_note', { id, expectedRevision: stale })).toEqual(conflict);
      expect(await row(harness, id)).toEqual(before);
      // En la papelera, con la revisión de antes de editarla.
      expect((await call('hebra_trash_note', { id })).isError).toBe(false);
      const trashed = await row(harness, id);
      expect(await call('hebra_restore_note', { id, expectedRevision: stale })).toEqual(conflict);
      expect(await row(harness, id)).toEqual(trashed);
    });

    it('favorita y otros metadatos no cuentan como cambio, como hebra_edit_note', async () => {
      const harness = await start();
      const { call, test } = harness;
      const id = test.library.publicNote2Id;
      const expectedRevision = await revisionOf(harness, id);
      await call('hebra_set_favorite', { id, favorite: true });
      expect((await call('hebra_move_note', { id, folderId: 'root', expectedRevision })).isError).toBe(false);
    });

    it('sin expectedRevision, igual que siempre', async () => {
      const harness = await start();
      const { call, test } = harness;
      const id = test.library.publicNote2Id;
      expect((await call('hebra_move_note', { id, folderId: 'root' })).value).toMatchObject({ folderPath: '' });
      expect((await call('hebra_trash_note', { id })).value).toMatchObject({ trashed: true });
      expect((await call('hebra_restore_note', { id })).isError).toBe(false);
    });

    it('oculta o inexistente: not_found igual, aunque la revisión valga o no se pueda leer', async () => {
      const harness = await start();
      const { call } = harness;
      for (const id of hiddenIds(harness)) {
        for (const expectedRevision of ['ilegible', 'r1.e30']) {
          expect(await call('hebra_move_note', { id, folderId: 'root', expectedRevision }), id).toEqual(NOT_FOUND);
          expect(await call('hebra_trash_note', { id, expectedRevision }), id).toEqual(NOT_FOUND);
          expect(await call('hebra_restore_note', { id, expectedRevision }), id).toEqual(NOT_FOUND);
        }
      }
    });

    it('una de la papelera oculta, o una carpeta de destino privada: not_found igual que una inexistente', async () => {
      const harness = await start();
      const { call, test } = harness;
      const id = test.library.publicNote2Id;
      const expectedRevision = await revisionOf(harness, id);
      for (const hidden of [test.library.trashedPrivateFolderNoteId, test.library.trashedPrivateTagNoteId]) {
        expect(await call('hebra_restore_note', { id: hidden, expectedRevision })).toEqual(NOT_FOUND);
        expect(await call('hebra_trash_note', { id: hidden, expectedRevision })).toEqual(NOT_FOUND);
      }
      const before = await row(harness, id);
      for (const folderId of [test.library.folders.diario, 'no-existe']) {
        expect(await call('hebra_move_note', { id, folderId, expectedRevision })).toEqual(NOT_FOUND);
      }
      expect(await row(harness, id)).toEqual(before);
    });

    it('una revisión de más de REVISION_MAX_LENGTH: invalid_input, igual en una nota oculta, sin llegar al escritor', async () => {
      const harness = await start();
      const { call, test } = harness;
      const tooLong = 'r'.repeat(REVISION_MAX_LENGTH + 1);
      const reached = vi.spyOn(test.serverContext.write!, 'noteState');
      const invalid = { isError: true, value: { error: 'invalid_input' } };
      for (const id of [test.library.publicNote2Id, ...hiddenIds(harness)]) {
        expect(await call('hebra_move_note', { id, folderId: 'root', expectedRevision: tooLong }), id).toEqual(invalid);
        expect(await call('hebra_trash_note', { id, expectedRevision: tooLong }), id).toEqual(invalid);
        expect(await call('hebra_restore_note', { id, expectedRevision: tooLong }), id).toEqual(invalid);
      }
      expect(reached).not.toHaveBeenCalled();
      reached.mockRestore();
      // Justo en el tope no se rechaza por largo: sigue a la comprobación de siempre.
      const atLimit = 'r'.repeat(REVISION_MAX_LENGTH);
      expect(
        await call('hebra_move_note', { id: test.library.publicNote2Id, folderId: 'root', expectedRevision: atLimit })
      ).toEqual(invalid);
    });

    it('una revisión ilegible o de otra nota: invalid_input; de otra biblioteca: revision_conflict', async () => {
      const harness = await start();
      const { call, test } = harness;
      const id = test.library.publicNote2Id;
      const other = await revisionOf(harness, test.library.publicNoteId);
      const mine = decodeRevision(await revisionOf(harness, id))!;
      const before = await row(harness, id);
      const invalid = { isError: true, value: { error: 'invalid_input' } };
      expect(await call('hebra_move_note', { id, folderId: 'root', expectedRevision: 'ilegible' })).toEqual(invalid);
      expect(await call('hebra_move_note', { id, folderId: 'root', expectedRevision: other })).toEqual(invalid);
      expect(
        await call('hebra_trash_note', { id, expectedRevision: encodeRevision({ ...mine, libraryId: 'otra-biblioteca' }) })
      ).toEqual({ isError: true, value: { error: 'revision_conflict' } });
      expect(await row(harness, id)).toEqual(before);
    });

    it('ya en el estado pedido: sin escribir aunque la revisión sea vieja (un reintento no es un conflicto)', async () => {
      const harness = await start();
      const { call, test } = harness;
      const id = test.library.publicNote2Id;
      const expectedRevision = await revisionOf(harness, id);
      await call('hebra_edit_note', {
        id,
        edits: [{ find: 'Texto normal', replace: 'Otro texto' }],
        expectedRevision,
        operationId: 'op-edita-2'
      });
      await call('hebra_move_note', { id, folderId: 'root' });
      const moved = await row(harness, id);
      expect((await call('hebra_move_note', { id, folderId: 'root', expectedRevision })).isError).toBe(false);
      expect((await row(harness, id)).localSeq).toBe(moved.localSeq);
      await call('hebra_trash_note', { id });
      const trashed = await row(harness, id);
      expect((await call('hebra_trash_note', { id, expectedRevision })).value).toMatchObject({ trashed: true });
      expect((await row(harness, id)).localSeq).toBe(trashed.localSeq);
    });

    it('una bloqueada visible: note_locked con revisión (el motor no la mueve con guarda); sin ella, como siempre', async () => {
      const harness = await start(NO_PRIVATE, { lockedNote: true });
      const { call, test } = harness;
      const id = test.library.lockedPrivateNoteId;
      const expectedRevision = await revisionOf(harness, id);
      const before = await row(harness, id);
      const locked = { isError: true, value: { error: 'note_locked' } };
      expect(await call('hebra_move_note', { id, folderId: 'root', expectedRevision })).toEqual(locked);
      expect(await call('hebra_trash_note', { id, expectedRevision })).toEqual(locked);
      expect(await row(harness, id)).toEqual(before);
      expect((await call('hebra_move_note', { id, folderId: 'root' })).value).toMatchObject({ folderPath: '' });
    });

    it('la herramienta de un filtro de antes de que la nota cruce: el escritor responde not_found', async () => {
      const harness = await start();
      const { test, withEngine } = harness;
      const id = test.library.publicNote2Id;
      const expectedRevision = await revisionOf(harness, id);
      const ctx = await resolveToolContext(test.serverContext);
      await withEngine((engine) => engine.noteMove(id, test.library.folders.diario));
      const before = await row(harness, id);
      await expect(
        ctx.write!.noteState!({ action: 'trashNote', id, expectedRevision, privacy: ctx.privacyConfig })
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(await row(harness, id)).toEqual(before);
    });
  });

  it('las dos tools nuevas y la revisión están en el esquema, con `space` como las demás', async () => {
    const harness = await start();
    await harness.call('hebra_status', {});
    const tools = await harness.listTools();
    const shape = (name: string): string[] =>
      Object.keys((tools.find((tool) => tool.name === name)!.inputSchema.properties ?? {}) as object).sort();
    expect(shape('hebra_set_hidden')).toEqual(['hidden', 'id', 'space']);
    expect(shape('hebra_clear_conflict')).toEqual(['id', 'space']);
    expect(shape('hebra_move_note')).toEqual(['expectedRevision', 'folderId', 'id', 'space']);
    expect(shape('hebra_trash_note')).toEqual(['expectedRevision', 'id', 'space']);
    expect(shape('hebra_restore_note')).toEqual(['expectedRevision', 'id', 'space']);
    const description = tools.find((tool) => tool.name === 'hebra_rename_file')!.description!;
    expect(description).not.toContain('dejan de encontrarlo');
    expect(description).toContain('relinked');
    expect(tools.find((tool) => tool.name === 'hebra_set_hidden')!.description).toContain('NO privacidad');
    expect(tools.find((tool) => tool.name === 'hebra_restore_note')!.description).toContain('antes de mandarla');
  });
});
