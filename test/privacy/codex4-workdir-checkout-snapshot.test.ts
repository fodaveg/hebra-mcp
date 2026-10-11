import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { checkoutCommand, type OpenLibrary } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { replaceBody, trashConflictCopies } from '../../src/store/body-writes';
import { auditHarness, createNote, AUDIT_CONFIG, NOT_FOUND } from './audit-harness';
import { capture, removeTempDirs, tempDir } from '../workdir/helpers';

afterEach(removeTempDirs);

async function checkoutAcrossFolderMove(moveDuringFreshFilter: boolean) {
  const h = await auditHarness(async (engine, library) => {
    const parent = await engine.folderCreate(library.folders.historial, 'PadreCodex4');
    const child = await engine.folderCreate(parent.id, 'Hija');
    const note = await createNote(engine, child.id, '# CheckoutCodex4\nCEBO_PRIVADO\n');
    return { parentId: parent.id, noteId: note.id };
  });
  const cwd = tempDir('codex4-wd-checkout-');
  const foldersList = h.port.foldersList.bind(h.port);
  const notesVisibilityIndex = h.port.notesVisibilityIndex.bind(h.port);
  let folderReads = 0;
  let indexReads = 0;
  let moved = false;
  let releaseMove!: () => void;
  const moveFinished = new Promise<void>((resolve) => { releaseMove = resolve; });
  const folderSpy = vi.spyOn(h.port, 'foldersList').mockImplementation(async () => {
    const rows = await foldersList();
    folderReads += 1;
    if (moveDuringFreshFilter && folderReads === 2) {
      await h.mutate((engine, library) => engine.folderMove(h.extra.parentId, library.folders.diario));
      moved = true;
      releaseMove();
    }
    return rows;
  });
  const indexSpy = vi.spyOn(h.port, 'notesVisibilityIndex').mockImplementation(async () => {
    indexReads += 1;
    if (moveDuringFreshFilter && indexReads === 2) await moveFinished;
    return notesVisibilityIndex();
  });
  const open: OpenLibrary = async () => ({
    role: 'this', linked: true, port: h.port, privacyConfig: AUDIT_CONFIG,
    replaceBody: (input) => replaceBody(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    trashConflictCopies: (input) => trashConflictCopies(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    syncRound: async () => ({ kind: 'done', result: 'ok' }),
    close: async () => {}
  });
  try {
    const out = capture(cwd);
    await checkoutCommand(out.io, open, {
      dir: 'trabajo', all: true, consultas: [], titulos: [], carpetas: [], forzar: false
    });
    folderSpy.mockRestore();
    indexSpy.mockRestore();
    const workdir = new Workdir(join(cwd, 'trabajo'));
    const entry = workdir.readCheckout().notas.find((item) => item.id === h.extra.noteId);
    return {
      moved,
      indexReads,
      exported: entry === undefined ? null : readFileSync(workdir.notePath(entry.ruta), 'utf8'),
      currentRead: (await h.call('hebra_read_note', { id: h.extra.noteId })).json
    };
  } finally {
    folderSpy.mockRestore();
    indexSpy.mockRestore();
    await h.close();
  }
}

it('checkout no exporta la nota si una antecesora pasa a privada dentro del filtro fresco', async () => {
  const result = await checkoutAcrossFolderMove(true);
  expect(result.moved).toBe(true);
  // Ajustado en la 3.ª vuelta de d64e187e: checkout compara la época de privacidad antes de
  // leer y después del filtro, y al ver el cambio vuelve a leer (un filtro más).
  expect(result.indexReads).toBeGreaterThanOrEqual(2);
  expect(result.currentRead).toEqual(NOT_FOUND);
  expect(result.exported, 'El árbol antiguo y el índice nuevo dejan salir el cuerpo privado').toBeNull();
});

it('checkout exporta una nota cuya antecesora permanece visible', async () => {
  const result = await checkoutAcrossFolderMove(false);
  expect(result.exported).toContain('CEBO_PRIVADO');
});
