/**
 * A3 del audit de privacidad adversarial (10 oct 2026, sonda p6): la configuración es por
 * RUTA y se resolvía a carpetas en cada llamada, así que mover la carpeta privada dentro de
 * otra y crear una nueva con el mismo nombre (reorganizar carpetas en Hebra) destapaba la
 * vieja con todo lo que tenía dentro.
 *
 * Arreglo (SPEC.md §6.3, D16): hebra-mcp recuerda a qué carpetas resolvió cada ruta privada
 * configurada y oculta siempre la unión de esas carpetas y las de la ruta de ahora. La
 * memoria vive en una tabla propia de `library.sqlite` (`hebra_mcp_private_folders`, la
 * escribe el escritor; un lector la lee y guarda lo suyo en memoria), así que sobrevive a un
 * reinicio y va ligada a la biblioteca cuyas carpetas nombra. Se anota en cada llamada de
 * herramienta, al abrir los ficheros de trabajo y, en el escritor, antes de cada ronda de
 * sync (por donde llegan las carpetas movidas): esto último y lo que se olvida, en
 * `./audit-a3-memory.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutCommand } from '../../src/workdir/commands';
import { runWorkdirCommand } from '../../src/workdir/cli';
import { Workdir } from '../../src/workdir/layout';
import { BAIT_FOLDER } from '../fixtures/test-library';
import { capture, opener, removeTempDirs, tempDir, writePrivacy } from '../workdir/helpers';
import { auditHarness, NOT_FOUND } from './audit-harness';

afterEach(() => removeTempDirs());

/** En Hebra: archivar la carpeta privada dentro de `Historial` y crear otra `Diario`. */
async function moveAndRecreate(h: Awaited<ReturnType<typeof auditHarness>>): Promise<string> {
  return h.mutate(async (engine, library) => {
    await engine.folderMove(library.folders.diario, library.folders.historial);
    return (await engine.folderCreate(null, 'Diario')).id;
  });
}

describe('A3: mover la carpeta privada y crear otra con su nombre no destapa la vieja', () => {
  it('sonda p6: la nota, la carpeta, el fichero y los ficheros de trabajo de la vieja siguen ocultos', async () => {
    const h = await auditHarness(async () => ({}));
    try {
      // Una llamada antes del cambio: hebra-mcp ya ha visto la carpeta privada.
      expect((await h.call('hebra_read_note', { id: h.library.privateFolderNoteId })).json).toEqual(NOT_FOUND);
      const newDiario = await moveAndRecreate(h);

      const outputs: string[] = [];
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await h.call(name, args);
        outputs.push(result.raw);
        return result;
      };
      expect((await call('hebra_read_note', { id: h.library.privateFolderNoteId })).json).toEqual(NOT_FOUND);
      const paths = (await call('hebra_list_folders', {})).json.folders.map((folder: { path: string }) => folder.path);
      expect(paths).not.toContain('historial/diario');
      expect(paths).not.toContain('historial/diario/2026');
      expect(paths).not.toContain('diario');
      expect((await call('hebra_search', { query: BAIT_FOLDER })).json.results).toEqual([]);
      expect((await call('hebra_list_notes', { folder: 'historial', subfolders: true, limit: 100 })).raw).not.toContain(
        h.library.privateFolderNoteId
      );
      expect((await call('hebra_read_file', { id: h.library.files.privateFolder })).json).toEqual(NOT_FOUND);
      expect((await call('hebra_list_files', { name: 'CEBO' })).raw).not.toContain(h.library.files.privateFolder);
      // Ni escribir en ella ni mover nada a ella.
      expect(
        (await call('hebra_move_note', { id: h.library.publicNote2Id, folderId: h.library.folders.diario })).json
      ).toEqual(NOT_FOUND);
      expect((await call('hebra_create_note', { body: '# x\n', folder: 'historial/diario' })).json).toEqual(NOT_FOUND);
      // La nueva `Diario` también es privada: la ruta configurada de ahora.
      expect(
        (await call('hebra_move_note', { id: h.library.publicNote2Id, folderId: newDiario })).json
      ).toEqual(NOT_FOUND);
      // Herramientas de después del audit (D13, D14).
      expect((await call('hebra_grep', { pattern: BAIT_FOLDER })).json.matches).toEqual([]);
      const simulated = await call('hebra_replace_in_notes', {
        mode: 'simulate',
        pattern: BAIT_FOLDER,
        replacement: 'x'
      });
      expect(simulated.raw).not.toContain(h.library.privateFolderNoteId);
      expect(outputs.join('\n')).not.toContain(BAIT_FOLDER);

      // Ficheros de trabajo, otro proceso con la memoria de la tabla.
      writePrivacy(h.dataDir, { privateFolders: ['Diario'], privateTags: ['secreto'] });
      const cwd = tempDir();
      const out = capture(cwd);
      expect(
        await checkoutCommand(out.io, opener(h.dataDir), {
          dir: 'trabajo',
          all: true,
          consultas: [],
          titulos: [],
          carpetas: [],
          forzar: false
        })
      ).toBe(0);
      const ids = new Workdir(`${cwd}/trabajo`).readCheckout().notas.map((entry) => entry.id);
      expect(ids).not.toContain(h.library.privateFolderNoteId);
      expect(out.text()).not.toContain(BAIT_FOLDER);
      const hidden = capture(cwd);
      const code = await runWorkdirCommand('checkout', ['--dir', 'otra', '--carpeta', 'historial/diario'], hidden.io, opener(h.dataDir));
      expect(code).toBe(2);
      expect(hidden.text()).toContain('no existe la carpeta «historial/diario»');
    } finally {
      await h.close();
    }
  });

  it('la memoria sobrevive a un reinicio del proceso', async () => {
    const h = await auditHarness(async () => ({}));
    try {
      await h.call('hebra_list_notes', {});
      await moveAndRecreate(h);
      await h.restart();
      expect((await h.call('hebra_read_note', { id: h.library.privateFolderNoteId })).json).toEqual(NOT_FOUND);
      const paths = (await h.call('hebra_list_folders', {})).json.folders.map((folder: { path: string }) => folder.path);
      expect(paths).not.toContain('historial/diario');
    } finally {
      await h.close();
    }
  });
});
