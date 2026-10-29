/**
 * A2 del audit de privacidad adversarial (10 oct 2026, sonda p2): una nota VIVA cuya carpeta
 * es una lápida debajo de una carpeta privada salía en la raíz, con su cuerpo entero. Se
 * llegaba con un cliente antiguo de Hebra: borrar una subcarpeta privada (`folderTrash` dejaba la
 * carpeta como lápida y manda sus notas a la papelera sin tocar su `folder_id`) y sacar una
 * nota suya de la papelera (`noteRestore` tampoco lo toca). El motor la enseña en la raíz
 * (la carpeta efectiva de una lápida), y el filtro solo conocía carpetas vivas.
 *
 * Arreglo (SPEC.md §6.3): para una nota viva cuya carpeta guardada no está viva se sube por
 * las lápidas como en la papelera (`climbFolder`, `src/privacy/tombstones.ts`) y, si la
 * subida no resuelve (ruta privada, fila que falta, sin nombre o en ciclo), se oculta.
 *
 * El escenario se monta con el puerto ya abierto (`mutate`): llega «por sync» entre dos
 * llamadas, y la raíz de `hebra_list_folders` cuenta lo mismo antes y después.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutCommand } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { capture, opener, removeTempDirs, tempDir, writePrivacy } from '../workdir/helpers';
import { auditHarness, createNote, NOT_FOUND } from './audit-harness';
import { legacyFolderTombstone } from '../fixtures/test-library';

const BAIT = 'CEBO_LAPIDA_f6';

afterEach(() => removeTempDirs());

function rootCount(folders: Array<{ id: string; count: number }>): number {
  return folders.find((folder) => folder.id === 'root')!.count;
}

describe('A2: una nota viva en una lápida de una carpeta privada sigue oculta', () => {
  it('sonda p2: ni lectura, ni listas, ni búsqueda, ni etiquetas, ni recuentos, ni escrituras', async () => {
    const h = await auditHarness(async () => ({}));
    try {
      const before = rootCount((await h.call('hebra_list_folders', {})).json.folders);
      const tagsBefore = (await h.call('hebra_list_tags', {})).json.tags;
      const { noteId, fileId } = await h.mutate(async (engine, library) => {
        const sub = await engine.folderCreate(library.folders.diario, 'Sub');
        const note = await createNote(engine, sub.id, `# Diario de ${BAIT}\n#salud\n${BAIT}: texto privado por carpeta.\n`);
        const blob = await engine.blobPut(new TextEncoder().encode('fichero de sub'), { mime: 'application/pdf' });
        const file = (await engine.fileCreate(sub.id, `${BAIT}.pdf`, blob.sha256)).id;
        // Estado legado recibido por sync: carpeta lápida, nota y fichero vivos.
        await legacyFolderTombstone(engine, sub.id);
        return { noteId: note.id, fileId: file };
      });
      const row = await h.port.noteRead(noteId);
      expect(row?.trashedAt).toBeNull();
      expect(row?.folderState).toBe('deleted');

      const outputs: string[] = [];
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await h.call(name, args);
        outputs.push(result.raw);
        return result;
      };
      expect((await call('hebra_read_note', { id: noteId })).json).toEqual(NOT_FOUND);
      expect((await call('hebra_read_note', { title: `Diario de ${BAIT}` })).json).toEqual(NOT_FOUND);
      expect((await call('hebra_list_notes', { limit: 100 })).raw).not.toContain(noteId);
      expect((await call('hebra_search', { query: BAIT })).json.results).toEqual([]);
      expect((await call('hebra_list_tags', {})).json.tags).toEqual(tagsBefore);
      expect(rootCount((await call('hebra_list_folders', {})).json.folders)).toBe(before);
      expect((await call('hebra_list_files', { name: BAIT })).json.files).toEqual([]);
      expect((await call('hebra_read_file', { id: fileId })).json).toEqual(NOT_FOUND);
      expect((await call('hebra_append_to_note', { id: noteId, text: 'escrito por el MCP' })).json).toEqual(NOT_FOUND);
      // Herramientas de después del audit (D13, D14).
      const grep = await call('hebra_grep', { pattern: BAIT });
      expect(grep.json.matches).toEqual([]);
      const simulated = await call('hebra_replace_in_notes', { mode: 'simulate', pattern: BAIT, replacement: 'x' });
      expect(simulated.raw).not.toContain(noteId);
      expect(outputs.join('\n')).not.toContain(BAIT);
      expect((await h.port.noteRead(noteId))?.body).not.toContain('escrito por el MCP');

      // Ficheros de trabajo: `checkout --all` no la saca.
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
      expect(ids).not.toContain(noteId);
      expect(out.text()).not.toContain(BAIT);
    } finally {
      await h.close();
    }
  });

  it('una ruta privada configurada por debajo de una carpeta pública, también por las lápidas', async () => {
    const config = { privateFolders: [['diario'], ['proyectos', 'secreto']], privateTags: ['secreto'] };
    const h = await auditHarness(async () => ({}), config);
    try {
      const noteId = await h.mutate(async (engine, library) => {
        const secreto = await engine.folderCreate(library.folders.proyectos, 'Secreto');
        const deeper = await engine.folderCreate(secreto.id, 'Más');
        const note = await createNote(engine, deeper.id, `# Plan ${BAIT}\n${BAIT}\n`);
        await legacyFolderTombstone(engine, deeper.id);
        await legacyFolderTombstone(engine, secreto.id);
        // Y vuelve a crear la carpeta con el mismo nombre: la configuración resuelve.
        await engine.folderCreate(library.folders.proyectos, 'Secreto');
        return note.id;
      });
      expect((await h.call('hebra_read_note', { id: noteId })).json).toEqual(NOT_FOUND);
      expect((await h.call('hebra_search', { query: BAIT })).json.results).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('una nota cuya carpeta no existe aún (pendiente del sync) queda oculta: cerrado ante la duda', async () => {
    const h = await auditHarness(async (engine) => {
      const note = await createNote(engine, null, `# Sin carpeta ${BAIT}\n${BAIT}\n`);
      return { noteId: note.id };
    });
    try {
      expect((await h.call('hebra_read_note', { id: h.extra.noteId })).isError).toBe(false);
      await h.mutate(async (_engine, _library, db) => {
        db.prepare('UPDATE notes SET folder_id = ? WHERE id = ?').run('carpeta-que-no-ha-llegado', h.extra.noteId);
      });
      expect((await h.call('hebra_read_note', { id: h.extra.noteId })).json).toEqual(NOT_FOUND);
    } finally {
      await h.close();
    }
  });

  it('control: una nota restaurada desde una carpeta PÚBLICA borrada sigue saliendo en la raíz, como en Hebra', async () => {
    const h = await auditHarness(async () => ({}));
    try {
      const id = h.library.trashedDeletedPublicFolderNoteId;
      await h.mutate(async (engine) => {
        await engine.noteRestore(id);
      });
      const read = await h.call('hebra_read_note', { id });
      expect(read.isError).toBe(false);
      expect(read.json.folderPath).toBe('');
    } finally {
      await h.close();
    }
  });
});
