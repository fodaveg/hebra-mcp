import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyCommand, checkoutCommand, undoCommand, type OpenLibrary } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { replaceBody, trashConflictCopies } from '../../src/store/body-writes';
import { GateUsage, passGate } from '../../src/server/privacy-gate';
import type { PrivacyConfig } from '../../src/privacy';
import { auditHarness, createNote, saveBody, AUDIT_CONFIG } from './audit-harness';
import { capture, removeTempDirs, tempDir } from '../workdir/helpers';

afterEach(removeTempDirs);

const PUBLIC_CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: [] };

async function undoCopy(hiddenOnRound: boolean) {
  const h = await auditHarness(async (engine) =>
    (await createNote(engine, null, '# OriginalCodex4\nBASE\n')).id, PUBLIC_CONFIG);
  const cwd = tempDir('codex4-wd-undo-');
  let hideOnUndoRound = false;
  let reportConfig: PrivacyConfig = PUBLIC_CONFIG;
  const open: OpenLibrary = async () => ({
    role: 'this', linked: true, port: h.port, privacyConfig: PUBLIC_CONFIG,
    currentPrivacyConfig: async () => reportConfig,
    replaceBody: (input) => replaceBody(h.port, { ...input, privacy: PUBLIC_CONFIG }, () => {}),
    trashConflictCopies: (input) => trashConflictCopies(h.port, { ...input, privacy: PUBLIC_CONFIG }, () => {}),
    syncRound: async () => {
      if (hideOnUndoRound && hiddenOnRound) reportConfig = AUDIT_CONFIG;
      return { kind: 'done', result: 'ok' };
    },
    close: async () => {}
  });
  try {
    await checkoutCommand(capture(cwd).io, open, {
      dir: 'trabajo', all: false, consultas: [], titulos: ['OriginalCodex4'], carpetas: [], forzar: false
    });
    const workdir = new Workdir(join(cwd, 'trabajo'));
    const ruta = workdir.readCheckout().notas[0]!.ruta;
    writeFileSync(workdir.notePath(ruta), '# OriginalCodex4\nEDICION\n#secreto\n');
    await h.mutate((engine) => saveBody(engine, h.extra, '# OriginalCodex4\nCAMBIO CONCURRENTE\n'));
    await applyCommand(capture(cwd).io, open, { dir: 'trabajo', conflicto: 'copia', simular: false });
    const conflict = workdir.readMeta(h.extra)?.conflicto;
    if (conflict?.tipo !== 'copia') throw new Error('apply debía crear una copia de conflicto');
    const copyId = conflict.copyId;
    const lote = workdir.lotes()[0]!;
    hideOnUndoRound = true;
    const out = capture(cwd);
    await undoCommand(out.io, open, { dir: 'trabajo', lote });
    const usage = new GateUsage();
    usage.noteInAnyState(copyId);
    const copyHidden = (await passGate(h.port, reportConfig, usage, { seals: false })).failedNotes.has(copyId);
    return { out: out.text(), ruta, copyHidden };
  } finally {
    await h.close();
  }
}

it('undo no informa de la copia que pasó a privada durante su ronda posterior', async () => {
  const result = await undoCopy(true);
  expect(result.copyHidden).toBe(true);
  expect(result.out, 'El informe cuenta la copia ya oculta').not.toContain('su copia de conflicto, a la papelera');
});

it('undo informa de la copia enviada a la papelera si sigue visible', async () => {
  const result = await undoCopy(false);
  expect(result.copyHidden).toBe(false);
  expect(result.out).toContain(`${result.ruta}  su copia de conflicto, a la papelera`);
});
