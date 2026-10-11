import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkoutCommand, diffCommand, statusCommand, type OpenLibrary } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { auditHarness, createNote, saveBody, AUDIT_CONFIG, NOT_FOUND } from './audit-harness';
import { capture, removeTempDirs, tempDir } from '../workdir/helpers';

afterEach(removeTempDirs);

it('R4 control: status y diff son offline sobre lo exportado antes, incluso sin biblioteca', async () => {
  const h = await auditHarness(async (engine) => (await createNote(engine, null, '# OfflineCodex4\nBASE_PUBLICA\n')).id);
  const cwd = tempDir('codex4-offline-');
  let closed = false;
  const open: OpenLibrary = async () => ({
    role: 'this', linked: false, port: h.port, privacyConfig: AUDIT_CONFIG,
    replaceBody: async () => { throw new Error('esta sonda no escribe'); },
    trashConflictCopies: async () => { throw new Error('esta sonda no escribe'); },
    syncRound: async () => ({ kind: 'done', result: 'ok' }),
    close: async () => {}
  });
  try {
    await checkoutCommand(capture(cwd).io, open, {
      dir: 'trabajo', all: false, consultas: [], titulos: ['OfflineCodex4'], carpetas: [], forzar: false
    });
    const workdir = new Workdir(join(cwd, 'trabajo'));
    const ruta = workdir.readCheckout().notas[0]!.ruta;
    await h.mutate((engine) => saveBody(engine, h.extra, '# OfflineCodex4\nPRIVADO_NUEVO\n#secreto\n'));
    expect((await h.call('hebra_read_note', { id: h.extra })).json).toEqual(NOT_FOUND);
    await h.close();
    closed = true;
    expect(existsSync(h.sqlitePath)).toBe(false);
    writeFileSync(workdir.notePath(ruta), '# OfflineCodex4\nEDICION_LOCAL\n');
    const status = capture(cwd);
    expect(statusCommand(status.io, { dir: 'trabajo', rutas: true })).toBe(0);
    expect(status.text()).toContain(ruta);
    const diff = capture(cwd);
    expect(diffCommand(diff.io, { dir: 'trabajo', stat: false, files: [] })).toBe(0);
    expect(diff.text()).toContain('-BASE_PUBLICA');
    expect(diff.text()).toContain('+EDICION_LOCAL');
    expect(diff.text()).not.toContain('PRIVADO_NUEVO');
  } finally { if (!closed) await h.close(); }
});
