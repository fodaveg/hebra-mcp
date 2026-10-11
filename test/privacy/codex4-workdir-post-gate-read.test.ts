import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applyCommand, checkoutCommand, type OpenLibrary } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { replaceBody, trashConflictCopies } from '../../src/store/body-writes';
import { auditHarness, createNote, saveBody, AUDIT_CONFIG, NOT_FOUND } from './audit-harness';
import { capture, removeTempDirs, tempDir } from '../workdir/helpers';

afterEach(removeTempDirs);

async function applyAcrossPostGateRead(hideDuringRead: boolean) {
  const h = await auditHarness(async (engine) =>
    (await createNote(engine, null, '# ColaCodex4\nBASE\n')).id);
  const cwd = tempDir('codex4-wd-tail-');
  let afterCheckout = false;
  let afterSync = false;
  let mutated = false;
  const originalRead = h.port.noteRead.bind(h.port);
  const spy = vi.spyOn(h.port, 'noteRead').mockImplementation(async (id) => {
    if (hideDuringRead && afterSync && !mutated && id === h.extra) {
      mutated = true;
      await h.mutate((engine) => saveBody(engine, id, '# ColaCodex4\nOTRA VERSION\n#secreto\n'));
    }
    return originalRead(id);
  });
  const open: OpenLibrary = async () => ({
    role: 'this', linked: true, port: h.port, privacyConfig: AUDIT_CONFIG,
    replaceBody: (input) => replaceBody(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    trashConflictCopies: (input) => trashConflictCopies(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    syncRound: async () => {
      if (afterCheckout) afterSync = true;
      return { kind: 'done', result: 'ok' };
    },
    close: async () => {}
  });
  try {
    await checkoutCommand(capture(cwd).io, open, {
      dir: 'trabajo', all: false, consultas: [], titulos: ['ColaCodex4'], carpetas: [], forzar: false
    });
    const workdir = new Workdir(join(cwd, 'trabajo'));
    const ruta = workdir.readCheckout().notas[0]!.ruta;
    writeFileSync(workdir.notePath(ruta), '# ColaCodex4\nEDITADA\n');
    afterCheckout = true;
    const out = capture(cwd);
    await applyCommand(out.io, open, { dir: 'trabajo', conflicto: 'copia', simular: false });
    spy.mockRestore();
    return { out: out.text(), ruta, mutated, currentRead: (await h.call('hebra_read_note', { id: h.extra })).json };
  } finally {
    spy.mockRestore();
    await h.close();
  }
}

it('apply no publica un aviso calculado leyendo una nota ocultada después de su puerta final', async () => {
  const result = await applyAcrossPostGateRead(true);
  expect(result.mutated).toBe(true);
  expect(result.currentRead).toEqual(NOT_FOUND);
  expect(result.out, 'changedBySync publica la ruta privada leída después de hiddenAfterRound')
    .not.toContain('la ronda de sync trajo otra versión');
  expect(result.out).not.toContain(result.ruta);
});

it('apply conserva el informe de una nota que sigue visible tras leerla', async () => {
  const result = await applyAcrossPostGateRead(false);
  expect(result.out).toContain('1 aplicada');
  expect(result.out).toContain(result.ruta);
});
