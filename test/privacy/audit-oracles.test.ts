/**
 * M1 a M4 y M6 del audit de privacidad adversarial (10 oct 2026): vías por las que se podía
 * deducir que algo oculto existe (o leer un adjunto privado conociendo su hash). Cada test
 * compara la respuesta CON lo oculto y SIN ello (un título, una versión, una carpeta o unos
 * bytes que no existen): tienen que ser la misma.
 *
 * M5 (la configuración se relee) está en `./audit-m5-config-reload.test.ts`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveNote } from '../../src/hebra';
import type { PrivacyConfig } from '../../src/privacy';
import { auditHarness, createNote, type ToolCall } from './audit-harness';

const v1 = (n: number): string => `v1.${Buffer.from(String(n), 'utf8').toString('base64url')}`;

afterEach(() => undefined);

/** Lo que dice `outgoing` sin los ids (distintos entre bibliotecas): si resolvió y a qué título. */
function outgoingShape(call: ToolCall): Array<{ ref: string; resolved: boolean; title?: string }> {
  return call.json.outgoing.map((link: { ref: string; resolvedId?: string; title?: string }) => ({
    ref: link.ref,
    resolved: link.resolvedId !== undefined,
    ...(link.title !== undefined ? { title: link.title } : {})
  }));
}

describe('M1: hebra_links no confirma títulos ocultos', () => {
  it('sonda p5: una homónima visible y un enlace resuelven igual si el título está oculto que si no existe', async () => {
    const h = await auditHarness(async () => ({}));
    try {
      const probe = async (title: string) => {
        await h.call('hebra_create_note', { body: `# ${title}\nhomónima visible\n` });
        const linker = (await h.call('hebra_create_note', { body: `# sonda ${title}\n[[${title}]]\n` })).json;
        return outgoingShape(await h.call('hebra_links', { id: linker.id }));
      };
      const ref = (title: string) => [{ ref: title.toLowerCase(), resolved: true, title }];
      expect(await probe('Nota oculta de carpeta')).toEqual(ref('Nota oculta de carpeta'));
      expect(await probe('Nota oculta por etiqueta')).toEqual(ref('Nota oculta por etiqueta'));
      expect(await probe('Título que no existe en ningún sitio')).toEqual(ref('Título que no existe en ningún sitio'));
    } finally {
      await h.close();
    }
  });

  it('la ruta del enlace solo desempata entre las visibles', async () => {
    const scenario = (withHidden: boolean) =>
      auditHarness(async (engine, library) => {
        await createNote(engine, null, '# Compartida\nvisible en la raíz\n');
        await createNote(engine, library.folders.proyectos, '# Compartida\nvisible en proyectos\n');
        if (withHidden) await createNote(engine, library.folders.diario2026, '# Compartida\noculta\n');
        const linker = await createNote(
          engine,
          null,
          '# Enlazadora\n[[Compartida]] [[proyectos/Compartida]] [[diario/2026/Compartida]]\n'
        );
        return { linker: linker.id };
      });
    const shapes: unknown[] = [];
    for (const withHidden of [false, true]) {
      const h = await scenario(withHidden);
      try {
        shapes.push(outgoingShape(await h.call('hebra_links', { id: h.extra.linker })));
      } finally {
        await h.close();
      }
    }
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[0]).toEqual([
      { ref: 'compartida', resolved: false },
      { ref: 'proyectos/compartida', resolved: true, title: 'Compartida' },
      { ref: 'diario/2026/compartida', resolved: false }
    ]);
  });
});

describe('M2: el cursor de hebra_list_versions no distingue una versión oculta de una inexistente', () => {
  it('sonda p5: invalid_input en los dos casos', async () => {
    const h = await auditHarness(async () => ({}));
    try {
      const id = h.library.formerlyPrivateNoteId;
      const hidden = await h.call('hebra_list_versions', { id, cursor: v1(h.library.formerlyPrivateVersionId) });
      const missing = await h.call('hebra_list_versions', { id, cursor: v1(999_999) });
      const otherNote = await h.call('hebra_list_versions', { id, cursor: v1(h.library.versionedNoteVersionId) });
      expect(missing.json).toEqual({ error: 'invalid_input' });
      expect(hidden.json).toEqual(missing.json);
      expect(otherNote.json).toEqual(missing.json);
    } finally {
      await h.close();
    }
  });
});

describe('M3: conflictOf solo nombra un original visible', () => {
  it('sonda p6: la copia de conflicto de una nota oculta no dice cuál es su original', async () => {
    const h = await auditHarness(async (engine) => {
      const original = await createNote(engine, null, '# Original secreta\n#secreto\nCEBO_M_ORIG\n');
      const body = '# Original secreta\nCEBO_M_COPY versión del otro dispositivo\n';
      const saved = await engine.noteSave({
        ...deriveNote(body),
        id: original.id,
        body,
        expectedLocalSeq: -1,
        baseBodySha256: null as unknown as string
      });
      const visibleOriginal = await createNote(engine, null, '# Original visible\nuno\n');
      const visibleBody = '# Original visible\ndos\n';
      const visibleCopy = await engine.noteSave({
        ...deriveNote(visibleBody),
        id: visibleOriginal.id,
        body: visibleBody,
        expectedLocalSeq: -1,
        baseBodySha256: null as unknown as string
      });
      return {
        original: original.id,
        copy: (saved as { redirectedTo: string }).redirectedTo,
        visibleOriginal: visibleOriginal.id,
        visibleCopy: (visibleCopy as { redirectedTo: string }).redirectedTo
      };
    });
    try {
      const copy = await h.call('hebra_read_note', { id: h.extra.copy });
      expect(copy.json.isConflictCopy).toBe(true);
      expect(copy.json).not.toHaveProperty('conflictOf');
      expect(copy.raw).not.toContain(h.extra.original);
      // Con un original visible, sí.
      const visible = await h.call('hebra_read_note', { id: h.extra.visibleCopy });
      expect(visible.json.conflictOf).toBe(h.extra.visibleOriginal);
    } finally {
      await h.close();
    }
  });
});

describe('M4: renombrar no localiza carpetas privadas', () => {
  const CONFIG: PrivacyConfig = { privateFolders: [['diario'], ['proyectos', 'secreto']], privateTags: ['secreto'] };

  it('sonda p5: con dos homónimas, la que tiene la privada debajo y la que no responden igual', async () => {
    const h = await auditHarness(async (engine, library, db) => {
      await engine.folderCreate(library.folders.proyectos, 'Secreto');
      // Una hermana homónima de `Proyectos` sin nada debajo, como la traería el sync de dos
      // dispositivos que la crearon a la vez (el motor solo las impide en local).
      const row = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(library.folders.proyectos) as {
        parent_id: string | null;
      };
      db.prepare(
        `INSERT INTO folders (id, parent_id, name, created_at, updated_at, deleted, dirty, local_seq)
         VALUES ('proyectos-homonima', ?, 'proyectos', 1, 1, 0, 0, 1)`
      ).run(row.parent_id);
      return { homonym: 'proyectos-homonima' };
    }, CONFIG);
    try {
      const L = h.library;
      const answer = async (folderId: string) => ({
        same: (await h.call('hebra_rename_folder', { folderId, name: 'Proyectos' })).json,
        other: (await h.call('hebra_rename_folder', { folderId, name: 'Trabajo' })).json
      });
      const withPrivate = await answer(L.folders.proyectos);
      const without = await answer(h.extra.homonym);
      expect(without).toEqual(withPrivate);
      expect(withPrivate).toEqual({ same: { error: 'folder_unavailable' }, other: { error: 'folder_unavailable' } });
      // Sin ninguna ruta configurada por debajo, renombrar a su nombre no escribe.
      expect((await h.call('hebra_rename_folder', { folderId: L.folders.historial, name: 'Historial' })).json).toMatchObject({
        path: 'historial',
        renamed: false
      });
    } finally {
      await h.close();
    }
  });

  it('una carpeta con una privada debajo que ya no está en su ruta configurada se renombra', async () => {
    // `Historial` tiene dentro la `Diario` vieja (movida, recordada por A3): renombrar
    // `Historial` no cambia la ruta por la que se oculta nada, porque se oculta por id.
    const h = await auditHarness(async () => ({}));
    try {
      await h.call('hebra_list_folders', {});
      await h.mutate(async (engine, library) => {
        await engine.folderMove(library.folders.diario, library.folders.historial);
        await engine.folderCreate(null, 'Diario');
      });
      const renamed = await h.call('hebra_rename_folder', { folderId: h.library.folders.historial, name: 'Archivo' });
      expect(renamed.json).toMatchObject({ path: 'archivo', renamed: true });
      expect((await h.call('hebra_read_note', { id: h.library.privateFolderNoteId })).json).toEqual({ error: 'not_found' });
    } finally {
      await h.close();
    }
  });
});

describe('M6: hebra_read_attachment no sirve los bytes de lo oculto aunque una nota visible los vuelva a enlazar', () => {
  it('sonda p6: con el hash de un adjunto privado responde como con un hash que no existe', async () => {
    const h = await auditHarness(async (engine, library) => {
      // Un fichero suelto en una carpeta privada: sus bytes, tampoco.
      const bytes = new TextEncoder().encode('CEBO_FICHERO_PRIVADO texto del diario\n');
      const blob = await engine.blobPut(bytes, { mime: 'text/plain' });
      await engine.fileCreate(library.folders.diario2026, 'apuntes.txt', blob.sha256);
      return { fileSha: blob.sha256 };
    });
    try {
      const noteId = h.library.publicNote2Id;
      const unknown = createHash('sha256').update(randomBytes(32)).digest('hex');
      const answers: Array<{ list: unknown; read: unknown }> = [];
      for (const sha of [h.library.privateAttachmentSha, h.extra.fileSha, unknown]) {
        await h.call('hebra_append_to_note', { id: noteId, text: `![[sha256:${sha}|x.txt]]` });
        const list = await h.call('hebra_list_attachments', { id: noteId });
        const entry = list.json.attachments.find((item: { attachmentId: string }) => item.attachmentId === sha);
        const read = await h.call('hebra_read_attachment', { id: noteId, attachmentId: sha });
        expect(read.raw).not.toContain('CEBO');
        answers.push({ list: { ...entry, attachmentId: 'H' }, read: read.json });
      }
      expect(answers[2]!.read).toEqual({ error: 'attachment_unavailable' });
      expect(answers[0]).toEqual(answers[2]);
      expect(answers[1]).toEqual(answers[2]);
    } finally {
      await h.close();
    }
  });
});
