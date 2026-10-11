/**
 * A1 del audit de privacidad adversarial (10 oct 2026, sondas p1 y p6): una nota oculta
 * por ETIQUETA dejaba de estar oculta al bloquearla en Hebra, porque una nota bloqueada no
 * deriva etiquetas (ni enlaces) y el filtro solo miraba `note_tags`. Arreglo (SPEC.md §6.3,
 * D16): mientras haya etiquetas privadas configuradas, toda nota bloqueada está oculta (viva
 * y en la papelera), porque el MCP no puede leer su cuerpo para saber si llevaba una; y,
 * mientras exista una nota bloqueada oculta, se ocultan los ficheros sueltos que se pueden
 * enlazar por su nombre, porque el nombre que incrustaba va cifrado (variante de p6, opción
 * cerrada decidida el 10 oct 2026).
 *
 * También en lo que llegó después del audit: `hebra_grep`, `hebra_replace_in_notes`,
 * `hebra_read_file`, `hebra_replace_file_text` y los ficheros de trabajo (`checkout`/`apply`).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveNote } from '../../src/hebra';
import { applyCommand, checkoutCommand } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { capture, opener, removeTempDirs, tempDir, writePrivacy } from '../workdir/helpers';
import { auditHarness, createNote, lockedBody, NOT_FOUND, saveBody } from './audit-harness';

const BAIT_V1 = 'CEBO_LOCK_V1_a1';
const BAIT_V2 = 'CEBO_LOCK_V2_b2';
const BAIT_TITLE = 'CEBO_LOCK_TITLE_c3';
const BAIT_HINT = 'CEBO_LOCK_HINT_d4';
const BAIT_FILE = 'CEBO_LOCK_FILE_e5.pdf';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

afterEach(() => removeTempDirs());

/** Sonda p1: en la raíz, con `#secreto` y un fichero suelto incrustado por nombre; después
 *  bloqueada con la pista de la contraseña en la cabecera, y una nota visible que la enlaza. */
async function lockedTaggedNote() {
  return auditHarness(async (engine) => {
    const blob = await engine.blobPut(encode('pdf del diario'), { mime: 'application/pdf' });
    const file = (await engine.fileCreate(null, BAIT_FILE, blob.sha256)).id;
    const note = await createNote(engine, null, `# ${BAIT_TITLE}\n${BAIT_V1} primera redacción sin etiqueta\n`);
    await saveBody(engine, note.id, `# ${BAIT_TITLE}\n#secreto\n${BAIT_V2} con etiqueta\n\n![[${BAIT_FILE}]]\n`);
    await saveBody(engine, note.id, lockedBody(BAIT_TITLE, [], BAIT_HINT));
    const linker = await createNote(engine, null, `# Nota que apunta al diario\nVer [[${BAIT_TITLE}]].\n`);
    return { noteId: note.id, linkerId: linker.id, file };
  });
}

describe('A1: una nota con etiqueta privada sigue oculta al bloquearla', () => {
  it('sonda p1: no sale por ninguna lectura, enlace, lista ni escritura', async () => {
    const h = await lockedTaggedNote();
    try {
      const { noteId, linkerId, file } = h.extra;
      const outputs: string[] = [];
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await h.call(name, args);
        outputs.push(result.raw);
        return result;
      };

      const list = await call('hebra_list_notes', { limit: 100 });
      expect(list.json.notes.map((note: { id: string }) => note.id)).not.toContain(noteId);
      expect((await call('hebra_read_note', { id: noteId })).json).toEqual(NOT_FOUND);
      expect((await call('hebra_read_note', { title: BAIT_TITLE })).json).toEqual(NOT_FOUND);
      const search = await call('hebra_search', { query: 'CEBO' });
      expect(search.json.results.map((note: { id: string }) => note.id)).not.toContain(noteId);
      // El enlace de una nota visible sale sin resolver, como uno a una nota inexistente.
      const links = await call('hebra_links', { id: linkerId });
      expect(links.json.outgoing).toEqual([{ ref: BAIT_TITLE.toLowerCase() }]);
      expect((await call('hebra_list_versions', { id: noteId })).json).toEqual(NOT_FOUND);
      expect((await call('hebra_list_attachments', { id: noteId })).json).toEqual(NOT_FOUND);
      expect((await call('hebra_note_outline', { id: noteId })).json).toEqual(NOT_FOUND);
      // El fichero que incrustaba por nombre, oculto (regla b con la variante de A1).
      expect((await call('hebra_list_files', { name: 'CEBO_LOCK' })).json.files).toEqual([]);
      expect((await call('hebra_read_file', { id: file })).json).toEqual(NOT_FOUND);
      expect(
        (await call('hebra_replace_file_text', { id: file, expectedSha256: '0'.repeat(64), text: 'x', operationId: 'a1-file' })).json
      ).toEqual(NOT_FOUND);
      expect((await call('hebra_trash_file', { id: file })).json).toEqual(NOT_FOUND);
      // Escrituras: nada.
      expect(
        (await call('hebra_move_note', { id: noteId, folderId: h.library.folders.proyectos })).json
      ).toEqual(NOT_FOUND);
      expect((await call('hebra_trash_note', { id: noteId })).json).toEqual(NOT_FOUND);
      expect((await call('hebra_append_to_note', { id: noteId, text: 'x' })).json).toEqual(NOT_FOUND);
      const trash = await call('hebra_list_trash', { limit: 100 });
      expect(trash.json.notes.map((note: { id: string }) => note.id)).not.toContain(noteId);
      // Herramientas de después del audit (D13, D14): nunca la nombran.
      const grep = await call('hebra_grep', { pattern: 'CEBO_LOCK' });
      expect(grep.raw).not.toContain(noteId);
      const simulated = await call('hebra_replace_in_notes', {
        mode: 'simulate',
        pattern: 'CEBO_LOCK',
        replacement: 'x'
      });
      expect(simulated.raw).not.toContain(noteId);

      const all = outputs.join('\n');
      for (const bait of [BAIT_V1, BAIT_V2, BAIT_HINT, BAIT_FILE, noteId]) expect(all).not.toContain(bait);
      const row = await h.port.noteRead(noteId);
      expect(row?.folderId).toBe('root');
      expect(row?.trashedAt).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('en la papelera, una nota bloqueada no sale ni se restaura', async () => {
    const h = await auditHarness(async (engine) => {
      const note = await createNote(engine, null, `# ${BAIT_TITLE}\n#secreto\n${BAIT_V2}\n`);
      await saveBody(engine, note.id, lockedBody(BAIT_TITLE, [], BAIT_HINT));
      await engine.noteTrash(note.id);
      return { noteId: note.id };
    });
    try {
      const trash = await h.call('hebra_list_trash', { limit: 100 });
      expect(trash.raw).not.toContain(h.extra.noteId);
      expect(trash.raw).not.toContain(BAIT_TITLE);
      expect((await h.call('hebra_restore_note', { id: h.extra.noteId })).json).toEqual(NOT_FOUND);
      expect((await h.port.noteRead(h.extra.noteId))?.trashedAt).not.toBeNull();
    } finally {
      await h.close();
    }
  });

  it('sin etiquetas privadas configuradas, una nota bloqueada se ve (y da note_locked)', async () => {
    const h = await auditHarness(
      async (engine) => {
        const note = await createNote(engine, null, '# Bloqueada sin más\nnada\n');
        await saveBody(engine, note.id, lockedBody('Bloqueada sin más', []));
        return { noteId: note.id };
      },
      { privateFolders: [['diario']], privateTags: [] }
    );
    try {
      const read = await h.call('hebra_read_note', { id: h.extra.noteId });
      expect(read.isError).toBe(false);
      expect(read.json.title).toBe('Bloqueada sin más');
      expect((await h.call('hebra_note_outline', { id: h.extra.noteId })).json).toEqual({ error: 'note_locked' });
    } finally {
      await h.close();
    }
  });

  it('sonda p6: una nota oculta por carpeta y bloqueada oculta el fichero de la raíz que incrustaba por nombre', async () => {
    const h = await auditHarness(async (engine, library) => {
      const blob = await engine.blobPut(encode('dibujo'), { mime: 'image/png' });
      const file = (await engine.fileCreate(null, 'CEBO_M_FILE.png', blob.sha256)).id;
      const plain = '# Diario dibujo\n![[CEBO_M_FILE.png]]\n';
      const note = await createNote(engine, library.folders.diario, plain);
      await saveBody(engine, note.id, lockedBody('Diario dibujo', deriveNote(plain).blobRefs));
      // Un fichero sin extensión (no se puede incrustar por nombre) sigue visible.
      const plainFile = (await engine.fileCreate(null, 'CEBO_M_SIN_EXTENSION', blob.sha256)).id;
      return { file, plainFile };
    });
    try {
      const files = await h.call('hebra_list_files', { name: 'CEBO_M' });
      expect(files.json.files.map((entry: { id: string }) => entry.id)).toEqual([h.extra.plainFile]);
      expect((await h.call('hebra_read_file', { id: h.extra.file })).json).toEqual(NOT_FOUND);
      expect((await h.call('hebra_trash_file', { id: h.extra.file })).json).toEqual(NOT_FOUND);
    } finally {
      await h.close();
    }
  });

  it('sin ninguna nota bloqueada oculta, los ficheros que se pueden incrustar por nombre se ven', async () => {
    const h = await auditHarness(
      async (engine) => {
        const blob = await engine.blobPut(encode('dibujo'), { mime: 'image/png' });
        return { file: (await engine.fileCreate(null, 'CEBO_M_FILE.png', blob.sha256)).id };
      },
      // Sin carpetas ni etiquetas privadas, la bloqueada del fixture se ve.
      { privateFolders: [], privateTags: [] }
    );
    try {
      const files = await h.call('hebra_list_files', { name: 'CEBO_M' });
      expect(files.json.files.map((entry: { id: string }) => entry.id)).toEqual([h.extra.file]);
    } finally {
      await h.close();
    }
  });

  it('ficheros de trabajo: checkout no la saca, y apply no escribe una que se bloqueó después', async () => {
    const h = await auditHarness(async (engine) => {
      const locked = await createNote(engine, null, `# ${BAIT_TITLE}\n#secreto\n${BAIT_V2}\n`);
      await saveBody(engine, locked.id, lockedBody(BAIT_TITLE, [], BAIT_HINT));
      const later = await createNote(engine, null, '# Se bloqueará\nLumbre visible\n');
      return { lockedId: locked.id, laterId: later.id };
    });
    try {
      writePrivacy(h.dataDir, { privateFolders: ['Diario'], privateTags: ['secreto'] });
      const cwd = tempDir();
      const out = capture(cwd);
      expect(
        await checkoutCommand(out.io, opener(h.dataDir), {
          dir: 'trabajo',
          all: false,
          consultas: [],
          titulos: [BAIT_TITLE, 'Se bloqueará'],
          carpetas: [],
          forzar: false
        })
      ).toBe(0);
      const root = join(cwd, 'trabajo');
      const ids = new Workdir(root).readCheckout().notas.map((entry) => entry.id);
      expect(ids).toEqual([h.extra.laterId]);
      expect(out.text()).toContain(`Sin nota con el título «${BAIT_TITLE}».`);

      // Se edita en disco y, antes de devolverla, David la etiqueta y la bloquea en Hebra.
      const [file] = new Workdir(root).listMarkdown();
      writeFileSync(join(root, file!), '# Se bloqueará\nLumbre visible y más\n');
      await h.mutate(async (engine) => {
        await saveBody(engine, h.extra.laterId, '# Se bloqueará\n#secreto\nLumbre visible\n');
        await saveBody(engine, h.extra.laterId, lockedBody('Se bloqueará', []));
      });
      const applied = capture(cwd);
      expect(await applyCommand(applied.io, opener(h.dataDir), { dir: 'trabajo', conflicto: 'copia', simular: false })).toBe(0);
      expect(applied.text()).toContain('nada escrito');
      expect(applied.text()).not.toContain(file!);
      expect(applied.text()).not.toContain(h.extra.laterId);
      expect((await h.port.noteRead(h.extra.laterId))?.body.startsWith('hebra-locked:')).toBe(true);
    } finally {
      await h.close();
    }
  });
});
