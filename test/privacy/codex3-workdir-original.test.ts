import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyCommand, checkoutCommand, type OpenLibrary } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { replaceBody, trashConflictCopies } from '../../src/store/body-writes';
import { auditHarness, createNote, saveBody, AUDIT_CONFIG, NOT_FOUND } from './audit-harness';
import { capture, removeTempDirs, tempDir } from '../workdir/helpers';

afterEach(removeTempDirs);

it('R3: workdir apply no publica el resultado de una original ocultada en la ronda posterior', async () => {
  const h = await auditHarness(async (engine) => (await createNote(engine, null,
    '# OriginalCodex3\nBASE_WORKDIR\n')).id);
  const cwd = tempDir('codex3-wd-original-');
  let hideOnRound = false;
  const open: OpenLibrary = async () => ({
    role: 'this', linked: true, port: h.port, privacyConfig: AUDIT_CONFIG,
    replaceBody: (input) => replaceBody(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    trashConflictCopies: (input) => trashConflictCopies(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    syncRound: async () => {
      if (hideOnRound) await h.mutate(async (engine) => {
        const row = (await engine.noteRead(h.extra))!;
        await saveBody(engine, h.extra, `${row.body}\n#secreto\n`);
      });
      return { kind: 'done', result: 'ok' };
    },
    close: async () => {}
  });
  try {
    expect(await checkoutCommand(capture(cwd).io, open, {
      dir: 'trabajo', all: false, consultas: [], titulos: ['OriginalCodex3'], carpetas: [], forzar: false
    })).toBe(0);
    const workdir = new Workdir(join(cwd, 'trabajo'));
    const ruta = workdir.readCheckout().notas[0]!.ruta;
    writeFileSync(workdir.notePath(ruta), '# OriginalCodex3\nEDICION_WORKDIR\n');
    hideOnRound = true;
    const out = capture(cwd);
    await applyCommand(out.io, open, { dir: 'trabajo', conflicto: 'copia', simular: false });
    expect((await h.call('hebra_read_note', { id: h.extra })).json).toEqual(NOT_FOUND);
    expect(out.text(), 'El informe posterior al sync nombra la original oculta y publica aplicada y su diff')
      .not.toContain(ruta);
  } finally { await h.close(); }
});
