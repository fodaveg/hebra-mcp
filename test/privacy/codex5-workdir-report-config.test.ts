import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadPrivacyConfig } from '../../src/privacy/config';
import { GateUsage, passGate } from '../../src/server/privacy-gate';
import { replaceBody, trashConflictCopies } from '../../src/store/body-writes';
import { applyCommand, checkoutCommand, type OpenLibrary } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { auditHarness, createNote } from './audit-harness';
import { capture, removeTempDirs, tempDir, writePrivacy } from '../workdir/helpers';

afterEach(removeTempDirs);

async function applyAcrossGateConfigChange(changeDuringRecheck: boolean) {
  const h = await auditHarness(async (engine) =>
    (await createNote(engine, null, '# InformeCodex5\nBASE\n#secreto\n')).id);
  const cwd = tempDir('codex5-wd-report-');
  writePrivacy(h.dataDir, { privateFolders: ['Diario'], privateTags: [] });
  const openedConfig = await loadPrivacyConfig(h.dataDir);
  let afterCheckout = false;
  let afterApplyRound = false;
  let changed = false;
  const open: OpenLibrary = async () => ({
    role: 'this', linked: true, port: h.port, privacyConfig: openedConfig,
    currentPrivacyConfig: () => loadPrivacyConfig(h.dataDir),
    replaceBody: (input) => replaceBody(h.port, { ...input, privacy: openedConfig }, () => {}),
    trashConflictCopies: (input) => trashConflictCopies(h.port, { ...input, privacy: openedConfig }, () => {}),
    syncRound: async () => {
      if (afterCheckout) afterApplyRound = true;
      return { kind: 'done', result: 'ok' };
    },
    close: async () => {}
  });
  let restoreRecheck: () => void = () => undefined;
  try {
    await checkoutCommand(capture(cwd).io, open, {
      dir: 'trabajo', all: false, consultas: [], titulos: ['InformeCodex5'], carpetas: [], forzar: false
    });
    const workdir = new Workdir(join(cwd, 'trabajo'));
    const ruta = workdir.readCheckout().notas.find((item) => item.id === h.extra)!.ruta;
    writeFileSync(workdir.notePath(ruta), '# InformeCodex5\nEDITADA\n#secreto\n');
    afterCheckout = true;
    const originalRecheck = h.port.privacyRecheck.bind(h.port);
    const recheckSpy = vi.spyOn(h.port, 'privacyRecheck').mockImplementation(async (args) => {
      if (changeDuringRecheck && afterApplyRound && !changed) {
        // La puerta ya leyó la configuración pública. Ahora cambia antes de tomar
        // el snapshot real de SQLite, que se evalúa con la configuración capturada.
        writePrivacy(h.dataDir, { privateFolders: ['Diario'], privateTags: ['secreto'] });
        changed = true;
      }
      return originalRecheck(args);
    });
    restoreRecheck = () => recheckSpy.mockRestore();
    const out = capture(cwd);
    await applyCommand(out.io, open, { dir: 'trabajo', conflicto: 'copia', simular: false });
    const usage = new GateUsage();
    usage.noteInAnyState(h.extra);
    const currentHidden = (await passGate(h.port, await loadPrivacyConfig(h.dataDir), usage, { seals: false }))
      .failedNotes.has(h.extra);
    return { changed, currentHidden, out: out.text(), ruta };
  } finally {
    restoreRecheck();
    await h.close();
  }
}

it('apply no informa de una nota ocultada mientras la puerta espera el snapshot final', async () => {
  const result = await applyAcrossGateConfigChange(true);
  expect(result.changed).toBe(true);
  expect(result.currentHidden).toBe(true);
  expect(result.out, 'El informe usa la configuración previa al snapshot final').not.toContain(result.ruta);
});

it('apply conserva la ruta y el resultado si la configuración sigue visible', async () => {
  const result = await applyAcrossGateConfigChange(false);
  expect(result.currentHidden).toBe(false);
  expect(result.out).toContain(result.ruta);
  expect(result.out).toContain('1 aplicada');
});
