import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { replaceBody, trashConflictCopies } from '../../src/store/body-writes';
import { ROOT_FOLDER_ID } from '../../src/hebra';
import { checkoutCommand, type OpenLibrary } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { auditHarness, createNote, saveBody, AUDIT_CONFIG } from './audit-harness';
import { capture, removeTempDirs, tempDir } from '../workdir/helpers';

afterEach(removeTempDirs);

it('checkout no exporta una nota seleccionada por un título que desapareció antes del filtro final', async () => {
  const oldTitle = 'TituloPrivadoCodex6';
  const h = await auditHarness(async (engine, library) => {
    const note = await createNote(engine, library.folders.diario, `# ${oldTitle}\nSECRETO_ANTIGUO\n`);
    return note.id;
  });
  const cwd = tempDir('codex6-checkout-selection-');
  let changed = false;
  const original = h.port.notesByExactTitle.bind(h.port);
  const spy = vi.spyOn(h.port, 'notesByExactTitle').mockImplementation(async (title) => {
    const result = await original(title);
    if (!changed) {
      changed = true;
      await h.mutate(async (engine) => {
        await saveBody(engine, h.extra, '# PublicoAhora\nCUERPO_VISIBLE\n');
        await engine.noteMove(h.extra, ROOT_FOLDER_ID);
      });
    }
    return result;
  });
  const open: OpenLibrary = async () => ({
    role: 'this', linked: true, port: h.port, privacyConfig: AUDIT_CONFIG,
    currentPrivacyConfig: async () => AUDIT_CONFIG,
    replaceBody: (input) => replaceBody(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    trashConflictCopies: (input) => trashConflictCopies(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    syncRound: async () => ({ kind: 'done', result: 'ok' }), close: async () => {}
  });
  try {
    await checkoutCommand(capture(cwd).io, open, {
      dir: 'trabajo', all: false, consultas: [], titulos: [oldTitle], carpetas: [], forzar: false
    });
    expect(changed).toBe(true);
    expect(new Workdir(join(cwd, 'trabajo')).readCheckout().notas).toEqual([]);
  } finally {
    spy.mockRestore();
    await h.close();
  }
});
