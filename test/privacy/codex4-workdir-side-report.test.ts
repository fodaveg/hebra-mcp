import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyCommand, checkoutCommand, type OpenLibrary } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { replaceBody, trashConflictCopies } from '../../src/store/body-writes';
import { auditHarness, createNote, saveBody, AUDIT_CONFIG, NOT_FOUND } from './audit-harness';
import { capture, removeTempDirs, tempDir } from '../workdir/helpers';

afterEach(removeTempDirs);

async function applyWithDamagedSide(hideOnRound: boolean) {
  const h = await auditHarness(async (engine) => ({
    edited: (await createNote(engine, null, '# EditadaCodex4\nBASE\n')).id,
    side: (await createNote(engine, null, '# LateralCodex4\nBASE_LATERAL\n')).id
  }));
  const cwd = tempDir('codex4-wd-side-');
  let afterCheckout = false;
  const open: OpenLibrary = async () => ({
    role: 'this', linked: true, port: h.port, privacyConfig: AUDIT_CONFIG,
    replaceBody: (input) => replaceBody(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    trashConflictCopies: (input) => trashConflictCopies(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    syncRound: async () => {
      if (afterCheckout && hideOnRound) await h.mutate(async (engine) => {
        const row = (await engine.noteRead(h.extra.side))!;
        await saveBody(engine, h.extra.side, `${row.body}\n#secreto\n`);
      });
      return { kind: 'done', result: 'ok' };
    },
    close: async () => {}
  });
  try {
    await checkoutCommand(capture(cwd).io, open, {
      dir: 'trabajo', all: true, consultas: [], titulos: [], carpetas: [], forzar: false
    });
    const workdir = new Workdir(join(cwd, 'trabajo'));
    const ruta = (id: string) => workdir.readCheckout().notas.find((entry) => entry.id === id)!.ruta;
    const sideRuta = ruta(h.extra.side);
    writeFileSync(workdir.notePath(ruta(h.extra.edited)), '# EditadaCodex4\nEDITADA\n');
    writeFileSync(join(workdir.metaDir, 'base', `${h.extra.side}.base`), '# LateralCodex4\nBASE_DANADA\n');
    afterCheckout = true;
    const out = capture(cwd);
    await applyCommand(out.io, open, { dir: 'trabajo', conflicto: 'copia', simular: false });
    return { out: out.text(), sideRuta, sideRead: (await h.call('hebra_read_note', { id: h.extra.side })).json };
  } finally {
    await h.close();
  }
}

it('workdir apply no nombra una base dañada cuya nota se ocultó en la ronda posterior', async () => {
  const result = await applyWithDamagedSide(true);
  expect(result.sideRead).toEqual(NOT_FOUND);
  expect(result.out).toContain('1 aplicada');
  expect(result.out, 'El informe lateral revela la ruta de la nota ya privada').not.toContain(result.sideRuta);
});

it('workdir apply conserva el aviso de base dañada cuando la nota sigue visible', async () => {
  const result = await applyWithDamagedSide(false);
  expect(result.out).toContain('1 aplicada');
  expect(result.out).toContain(`${result.sideRuta}  base dañada`);
});
