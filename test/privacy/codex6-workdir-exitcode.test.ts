import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyCommand, checkoutCommand, undoCommand, type OpenLibrary } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { replaceBody, trashConflictCopies } from '../../src/store/body-writes';
import { auditHarness, createNote, saveBody, AUDIT_CONFIG } from './audit-harness';
import { capture, removeTempDirs, tempDir } from '../workdir/helpers';

afterEach(removeTempDirs);

async function scenario(hideOn: 'apply' | 'undo') {
  const h = await auditHarness(async (engine) =>
    (await createNote(engine, null, '# CodigoSalidaCodex6\nBASE\n')).id);
  const cwd = tempDir('codex6-workdir-exit-');
  let round: 'checkout' | 'apply' | 'undo' = 'checkout';
  const open: OpenLibrary = async () => ({
    role: 'this', linked: true, port: h.port, privacyConfig: AUDIT_CONFIG,
    currentPrivacyConfig: async () => AUDIT_CONFIG,
    replaceBody: (input) => replaceBody(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    trashConflictCopies: (input) => trashConflictCopies(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    syncRound: async () => {
      if (round === hideOn) {
        await h.mutate((engine) => saveBody(engine, h.extra, '# CodigoSalidaCodex6\nCAMBIO PRIVADO\n#secreto\n'));
      }
      return { kind: 'done', result: 'ok' };
    }, close: async () => {}
  });
  try {
    await checkoutCommand(capture(cwd).io, open, {
      dir: 'trabajo', all: false, consultas: [], titulos: ['CodigoSalidaCodex6'], carpetas: [], forzar: false
    });
    const workdir = new Workdir(join(cwd, 'trabajo'));
    const ruta = workdir.readCheckout().notas[0]!.ruta;
    writeFileSync(workdir.notePath(ruta), '# CodigoSalidaCodex6\nEDITADA\n');
    round = 'apply';
    const applied = capture(cwd);
    const applyCode = await applyCommand(applied.io, open, { dir: 'trabajo', conflicto: 'copia', simular: false });
    if (hideOn === 'apply') return { code: applyCode, text: applied.text(), ruta };
    const lote = workdir.lotes()[0]!;
    await h.mutate((engine) => saveBody(engine, h.extra, '# CodigoSalidaCodex6\nTERCERO\n'));
    round = 'undo';
    const undone = capture(cwd);
    const undoCode = await undoCommand(undone.io, open, { dir: 'trabajo', lote });
    return { code: undoCode, text: undone.text(), ruta };
  } finally { await h.close(); }
}

it('apply no cambia exitcode por aviso de sync que ya se ocultó del informe', async () => {
  const result = await scenario('apply');
  expect(result.text).not.toContain(result.ruta);
  expect(result.code).toBe(0);
});

it('undo no cambia exitcode por resultado que ya se ocultó del informe', async () => {
  const result = await scenario('undo');
  expect(result.text).not.toContain(result.ruta);
  expect(result.code).toBe(0);
});
