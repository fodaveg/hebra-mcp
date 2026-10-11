import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GateUsage, passGate } from '../../src/server/privacy-gate';
import { replaceBody, trashConflictCopies } from '../../src/store/body-writes';
import { checkoutCommand, type OpenLibrary } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { auditHarness, createNote, AUDIT_CONFIG } from './audit-harness';
import { capture, removeTempDirs, tempDir } from '../workdir/helpers';

afterEach(removeTempDirs);

async function checkoutAcrossLastConfigRead(moveDuringConfigRead: boolean) {
  const body = '# ExportCodex5\nCEBO_DE_EXPORTACION\n';
  const h = await auditHarness(async (engine, library) => {
    const parent = await engine.folderCreate(library.folders.historial, 'PadreCodex5');
    const child = await engine.folderCreate(parent.id, 'Hija');
    const note = await createNote(engine, child.id, body);
    return { parentId: parent.id, noteId: note.id };
  });
  const cwd = tempDir('codex5-wd-export-');
  let moved = false;
  const open: OpenLibrary = async () => ({
    role: 'this', linked: true, port: h.port, privacyConfig: AUDIT_CONFIG,
    currentPrivacyConfig: async () => {
      if (moveDuringConfigRead && !moved) {
        // La huella de configuración espera I/O después de comparar la época. Mientras
        // espera, otra conexión mueve una antecesora a Diario sin tocar la fila de la nota.
        await h.mutate((engine, library) => engine.folderMove(h.extra.parentId, library.folders.diario));
        moved = true;
      }
      return AUDIT_CONFIG;
    },
    replaceBody: (input) => replaceBody(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    trashConflictCopies: (input) => trashConflictCopies(h.port, { ...input, privacy: AUDIT_CONFIG }, () => {}),
    syncRound: async () => ({ kind: 'done', result: 'ok' }),
    close: async () => {}
  });
  try {
    const out = capture(cwd);
    await checkoutCommand(out.io, open, {
      dir: 'trabajo', all: false, consultas: [], titulos: ['ExportCodex5'], carpetas: [], forzar: false
    });
    const workdir = new Workdir(join(cwd, 'trabajo'));
    const entry = workdir.readCheckout().notas.find((item) => item.id === h.extra.noteId);
    const exported = entry ? readFileSync(workdir.notePath(entry.ruta), 'utf8') : null;
    const usage = new GateUsage();
    usage.noteInAnyState(h.extra.noteId);
    const currentHidden = (await passGate(h.port, AUDIT_CONFIG, usage, { seals: false }))
      .failedNotes.has(h.extra.noteId);
    return { moved, currentHidden, exported, out: out.text() };
  } finally {
    await h.close();
  }
}

it('checkout no exporta el cuerpo si una antecesora se vuelve privada durante la última lectura de configuración', async () => {
  const result = await checkoutAcrossLastConfigRead(true);
  expect(result.moved).toBe(true);
  expect(result.currentHidden).toBe(true);
  expect(result.exported, 'La época cambió después de compararla y sale el cuerpo privado').toBeNull();
});

it('checkout exporta el cuerpo cuando la época sigue estable durante la última lectura', async () => {
  const result = await checkoutAcrossLastConfigRead(false);
  expect(result.currentHidden).toBe(false);
  expect(result.exported).toContain('CEBO_DE_EXPORTACION');
});
