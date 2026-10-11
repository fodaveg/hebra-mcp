import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applyCommand, checkoutCommand } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { PrivacyFilter } from '../../src/privacy';
import { capture, createFolder, createNote, OPEN, opener, removeTempDirs, tempDir, withWriter, writePrivacy } from '../workdir/helpers';

afterEach(() => { vi.restoreAllMocks(); removeTempDirs(); });

it('apply no revela ni reutiliza el id de una copia de conflicto movida a una carpeta privada', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const dataDir = tempDir('hc-');
  const cwd = tempDir('hc-');
  const edited = '# Nota visible\n\nTexto de la edición conocida\n';
  const { id, folderId } = await withWriter(dataDir, async (writer) => ({
    id: await createNote(writer, '# Nota visible\n\nBase\n'),
    folderId: await createFolder(writer, 'Diario')
  }));
  writePrivacy(dataDir, { privateFolders: ['Diario'], privateTags: ['secreto'] });
  await checkoutCommand(capture(cwd).io, opener(dataDir), {
    dir: 'trabajo', all: true, consultas: [], titulos: [], carpetas: [], forzar: false
  });
  const workdir = new Workdir(join(cwd, 'trabajo'));
  const ruta = workdir.readCheckout().notas.find((note) => note.id === id)!.ruta;
  writeFileSync(workdir.notePath(ruta), edited);
  const hiddenCopyId = await withWriter(dataDir, async (writer) => {
    await writer.appendToNote({ id, text: 'Cambio concurrente del original', privacy: OPEN });
    const result = await writer.replaceBodyLocal({
      id, body: edited, baseBodySha256: '0'.repeat(64), onConflict: 'copy', privacy: OPEN
    });
    if (result.outcome !== 'conflict_copy') throw new Error('Fixture: se esperaba una copia de conflicto');
    await writer.organizeLocal({ action: 'moveNote', id: result.copyId, folderId, privacy: OPEN });
    const filter = await PrivacyFilter.build(writer.port, { privateFolders: [['diario']], privateTags: ['secreto'] });
    expect(filter.isHiddenNote(result.copyId), 'Fixture: la copia está oculta antes de apply').toBe(true);
    return result.copyId;
  });
  const out = capture(cwd);
  await applyCommand(out.io, opener(dataDir), { dir: 'trabajo', conflicto: 'copia', simular: false });
  // El original y los bytes enviados son públicos. Solo la existencia y el id de esta
  // copia son privados; sin ella apply crea una copia distinta, visible.
  expect(out.text(), 'apply imprime el prefijo del id de una copia de conflicto oculta').not.toContain(hiddenCopyId.slice(0, 8));
  const conflict = workdir.readMeta(id)?.conflicto;
  expect(conflict?.tipo === 'copia' ? conflict.copyId : null, 'Los metadatos de apply revelan el id completo de la copia oculta').not.toBe(hiddenCopyId);
});
