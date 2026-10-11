import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyCommand, checkoutCommand, type OpenLibrary } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { replaceBody, trashConflictCopies } from '../../src/store/body-writes';
import { auditHarness, createNote, saveBody, AUDIT_CONFIG, NOT_FOUND } from './audit-harness';
import { capture, removeTempDirs, tempDir } from '../workdir/helpers';

afterEach(removeTempDirs);

it('workdir apply omite el id de una copia de conflicto ocultada en la ronda posterior', async () => {
  const h = await auditHarness(async (engine) => (await createNote(engine, null, '# Workdir pública\nBASE_WORKDIR\n')).id);
  const cwd = tempDir('codex2-wd-');
  let hideOnRound = false;
  let copyId = '';
  const open: OpenLibrary = async () => ({
    role: 'this', linked: true, port: h.port, privacyConfig: AUDIT_CONFIG,
    replaceBody: (input) => replaceBody(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    trashConflictCopies: (input) => trashConflictCopies(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    syncRound: async () => {
      if (hideOnRound) {
        await h.mutate(async (engine, _library, db) => {
          const copy = db.prepare('SELECT id FROM notes WHERE conflict_of = ?').get(h.extra) as { id: string };
          copyId = copy.id;
          const row = (await engine.noteRead(copyId))!;
          await saveBody(engine, copyId, `${row.body}\n#secreto\n`);
        });
      }
      return { kind: 'done', result: 'ok' };
    },
    close: async () => {}
  });
  try {
    await checkoutCommand(capture(cwd).io, open, {
      dir: 'trabajo', all: false, consultas: [], titulos: ['Workdir pública'], carpetas: [], forzar: false
    });
    const workdir = new Workdir(join(cwd, 'trabajo'));
    const ruta = workdir.readCheckout().notas[0]!.ruta;
    writeFileSync(workdir.notePath(ruta), '# Workdir pública\nEDICION_WORKDIR\n');
    await h.mutate((engine) => saveBody(engine, h.extra, '# Workdir pública\nCambio concurrente\n'));
    hideOnRound = true;
    const out = capture(cwd);
    await applyCommand(out.io, open, { dir: 'trabajo', conflicto: 'copia', simular: false });
    expect(copyId).not.toBe('');
    expect((await h.call('hebra_read_note', { id: copyId })).json).toEqual(NOT_FOUND);
    expect(out.text(), 'apply imprime el id de la copia que sync acaba de volver privada').not.toContain(copyId.slice(0, 8));
  } finally { await h.close(); }
});
