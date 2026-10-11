/**
 * Lo que AGUANTÓ en el audit de privacidad adversarial (10 oct 2026, §5 de la nota): las
 * sondas p3 (homónimas, apartados y enlaces), p4 (paginación con ocultas al final) y p5
 * (escrituras, D9 y logs), convertidas en tests para que lo sigan aguantando. Las fugas que
 * encontraron esas mismas sondas (M1, M2, M4) están en `./audit-oracles.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { auditHarness, createNote, decodeCursor, lockedBody, NOT_FOUND } from './audit-harness';

const SHARED = 'Título Compartido';

describe('sonda p3: homónimas ocultas, apartados y enlaces', () => {
  async function scenario(withHidden: boolean) {
    return auditHarness(async (engine, library) => {
      const visible = await createNote(engine, null, `# ${SHARED}\nVisible.\n\n## Plan\nuno\n`);
      let hidden: string | undefined;
      let hiddenLocked: string | undefined;
      if (withHidden) {
        hidden = (await createNote(engine, library.folders.diario2026, `# ${SHARED}\nOCULTA CEBO_HOM_1\n\n## Plan\ndos\n\n## Plan\ntres\n`)).id;
        await createNote(engine, library.folders.diario, `# ${library.duplicateTitle}\nCEBO_HOM_2\n`);
        await createNote(engine, null, `# ${library.duplicateTitle}\n#secreto\nCEBO_HOM_3\n`);
        hiddenLocked = (await createNote(engine, library.folders.diario, lockedBody('Bloqueada privada CEBO_HOM_4', []))).id;
        await createNote(engine, library.folders.diario, `# Oculta que enlaza\n[[${SHARED}]] CEBO_HOM_5\n`);
      }
      const linker = await createNote(
        engine,
        null,
        `# Enlazadora\nVer [[${SHARED}]] y [[diario/2026/${SHARED}]] y [[Nota oculta de carpeta]].\n`
      );
      return { visible: visible.id, hidden, hiddenLocked, linker: linker.id };
    });
  }

  it('las respuestas de lo visible son las mismas con y sin homónimas ocultas, y lo oculto da not_found', async () => {
    const answers: Array<Record<string, unknown>> = [];
    for (const withHidden of [false, true]) {
      const h = await scenario(withHidden);
      try {
        const sameIds = (value: unknown): unknown =>
          JSON.parse(
            JSON.stringify(value)
              .replaceAll(h.extra.visible, 'VISIBLE')
              .replaceAll(h.extra.linker, 'LINKER')
              .replaceAll(h.library.duplicateNoteAId, 'DUP_A')
              .replaceAll(h.library.duplicateNoteBId, 'DUP_B')
              .replace(/"revision":"[^"]*"/g, '"revision":"R"')
          );
        const candidates = (value: { candidates?: Array<{ id: string }> }) =>
          (sameIds(value.candidates?.map((candidate) => candidate.id)) as string[] | undefined)?.sort();
        const answer: Record<string, unknown> = {
          links: sameIds((await h.call('hebra_links', { id: h.extra.linker })).json.outgoing.map(
            (link: { ref: string; resolvedId?: string }) => ({ ref: link.ref, resolved: link.resolvedId ?? null })
          )),
          backlinks: sameIds((await h.call('hebra_links', { id: h.extra.visible })).json.backlinks),
          readByTitle: sameIds((await h.call('hebra_read_note', { title: SHARED })).json.id),
          ambiguous: sameIds(candidates((await h.call('hebra_read_note', { title: h.library.duplicateTitle })).json)),
          outlineAmbiguous: sameIds(
            candidates((await h.call('hebra_note_outline', { title: h.library.duplicateTitle })).json)
          ),
          heading: (await h.call('hebra_read_note', { title: SHARED, heading: 'Plan' })).json.section,
          appendHeading: (await h.call('hebra_append_to_note', { id: h.extra.visible, text: 'x', heading: 'Plan' })).json
            .appended
        };
        answers.push(answer);
        if (withHidden) {
          const hidden = h.extra.hidden!;
          const locked = h.extra.hiddenLocked!;
          const notFound = [
            await h.call('hebra_read_note', { id: hidden, heading: 'Plan' }),
            await h.call('hebra_note_outline', { id: hidden }),
            await h.call('hebra_append_to_note', { id: hidden, text: 'x', heading: 'Plan' }),
            await h.call('hebra_read_note', { id: locked, heading: 'x' }),
            await h.call('hebra_note_outline', { id: locked }),
            await h.call('hebra_append_to_note', { id: locked, text: 'x' }),
            await h.call('hebra_list_attachments', { id: locked }),
            await h.call('hebra_list_versions', { id: locked }),
            await h.call('hebra_edit_note', {
              id: locked,
              edits: [{ find: 'a', replace: 'b' }],
              expectedRevision: 'r1.x',
              operationId: 'op-x'
            })
          ];
          for (const call of notFound) expect(call.json).toEqual(NOT_FOUND);
          expect((await h.call('hebra_search', { query: 'CEBO_HOM' })).json.results).toEqual([]);
        }
      } finally {
        await h.close();
      }
    }
    expect(answers[1]).toEqual(answers[0]);
  });
});

describe('sonda p4: paginación con ocultas al final de cada lista', () => {
  it('ninguna página vacía, nextCursor null en la última visible y ni un id oculto en cursores o salidas', async () => {
    const h = await auditHarness(async (engine, library, db) => {
      const tailHidden = await createNote(engine, library.folders.diario, `# Cola oculta\n[[${library.publicNoteTitle}]] CEBO_PAG_1\n`);
      db.prepare('UPDATE notes SET updated_at = 1 WHERE id = ?').run(tailHidden.id);
      const tailHiddenTag = await createNote(engine, null, `# Cola oculta tag\n#secreto\n[[${library.publicNoteTitle}]] CEBO_PAG_2\n`);
      db.prepare('UPDATE notes SET updated_at = 2 WHERE id = ?').run(tailHiddenTag.id);
      const trashedHidden = await createNote(engine, library.folders.diario, '# Tirada oculta\nCEBO_PAG_3\n');
      await engine.noteTrash(trashedHidden.id);
      db.prepare('UPDATE notes SET trashed_at = 1 WHERE id = ?').run(trashedHidden.id);
      await createNote(engine, library.folders.diario, '# Etiqueta oculta\n#zzzz/oculta\nCEBO_PAG_4\n');
      return { hiddenIds: [tailHidden.id, tailHiddenTag.id, trashedHidden.id] };
    });
    try {
      const L = h.library;
      const hiddenIds = [
        ...h.extra.hiddenIds,
        L.privateFolderNoteId,
        L.privateTagNoteId,
        L.trashedPrivateFolderNoteId,
        L.trashedPrivateTagNoteId,
        L.trashedDeletedPrivateFolderNoteId,
        L.privateAttachmentNoteId,
        L.lockedPrivateNoteId,
        L.folders.diario,
        L.folders.diario2026,
        L.files.privateFolder,
        L.files.referencedByHash,
        L.files.referencedByName,
        L.files.referencedByLockedNote,
        L.files.trashedPrivateFolder,
        L.files.trashedDeletedPrivateFolder
      ];
      const tools: Array<[string, Record<string, unknown>, string]> = [
        ['hebra_list_notes', {}, 'notes'],
        ['hebra_search', { query: 'nota OR CEBO OR Lumbre OR diario OR secreto' }, 'results'],
        ['hebra_list_trash', {}, 'notes'],
        ['hebra_list_files', {}, 'files'],
        ['hebra_list_files', { trashed: true }, 'files'],
        ['hebra_list_tags', {}, 'tags'],
        ['hebra_list_folders', {}, 'folders'],
        ['hebra_links', { id: L.publicNoteId }, 'backlinks']
      ];
      for (const [tool, args, field] of tools) {
        const full = await h.call(tool, { ...args, limit: 50 });
        let cursor: string | undefined;
        const seen: unknown[] = [];
        const decoded: string[] = [];
        let pages = 0;
        for (;;) {
          const page = await h.call(tool, { ...args, limit: 1, ...(cursor ? { cursor } : {}) });
          expect(page.isError, `${tool}: ${page.raw}`).toBe(false);
          const items = page.json[field] ?? [];
          pages += 1;
          seen.push(...items, ...(page.json.outgoing ?? []));
          decoded.push(decodeCursor(page.json.nextCursor) ?? '');
          if (!page.json.nextCursor) break;
          // Sin páginas vacías antes de la última.
          expect(items.length, tool).toBe(1);
          cursor = page.json.nextCursor;
          expect(pages, tool).toBeLessThan(60);
        }
        const text = JSON.stringify(full.json) + JSON.stringify(seen) + decoded.join('|');
        for (const id of hiddenIds) expect(text, `${tool} ${id}`).not.toContain(id);
        expect(text, tool).not.toMatch(/CEBO_PAG|CEBO_PRIVADO/);
      }
    } finally {
      await h.close();
    }
  });
});

describe('sonda p5: escrituras hacia lo oculto, D9 y logs', () => {
  it('todo not_found sin escribir, folder_unavailable decidido por la configuración y logs sin nada privado', async () => {
    const config = { privateFolders: [['diario'], ['proyectos', 'secreto']], privateTags: ['secreto'] };
    const h = await auditHarness(async (engine, library) => {
      const secreto = await engine.folderCreate(library.folders.proyectos, 'Secreto');
      const inSecreto = await createNote(engine, secreto.id, '# Plan secreto\nCEBO_W_1\n');
      const trashedTag = await createNote(engine, library.folders.historial, '# Tirada con tag\n#secreto/x\nCEBO_W_2\n');
      await engine.noteTrash(trashedTag.id);
      return { secretoId: secreto.id, inSecreto: inSecreto.id, trashedTag: trashedTag.id };
    }, config);
    try {
      const L = h.library;
      const notFound = [
        await h.call('hebra_move_note', { id: L.publicNote2Id, folderId: L.folders.diario }),
        await h.call('hebra_move_note', { id: L.publicNote2Id, folderId: 'no-existe' }),
        await h.call('hebra_move_note', { id: L.publicNote2Id, folderId: h.extra.secretoId }),
        await h.call('hebra_create_note', { body: '# x\n', folder: 'diario/2026' }),
        await h.call('hebra_create_note', { body: '# x\n', folder: 'no/existe' }),
        await h.call('hebra_create_note', { body: '# x\n#secreto/hijo\n' }),
        await h.call('hebra_append_to_note', { id: L.publicNote2Id, text: '#Secreto' }),
        await h.call('hebra_restore_note', { id: L.trashedDeletedPrivateFolderNoteId }),
        await h.call('hebra_restore_note', { id: h.extra.trashedTag }),
        await h.call('hebra_trash_note', { id: h.extra.trashedTag }),
        await h.call('hebra_read_version', { id: L.formerlyPrivateNoteId, versionId: L.formerlyPrivateVersionId }),
        await h.call('hebra_read_version', { id: L.formerlyPrivateNoteId, versionId: 999_999 }),
        await h.call('hebra_create_folder', { name: 'x', parentId: L.folders.diario }),
        await h.call('hebra_create_folder', { name: 'x', parent: 'diario' }),
        await h.call('hebra_rename_folder', { folderId: h.extra.secretoId, name: 'x' })
      ];
      const read = (await h.call('hebra_read_note', { id: L.publicNote2Id })).json;
      notFound.push(
        await h.call('hebra_edit_note', {
          id: L.publicNote2Id,
          edits: [{ find: 'Texto normal', replace: '#secreto Texto normal' }],
          expectedRevision: read.revision,
          operationId: 'w-1'
        })
      );
      const fp = (await h.call('hebra_read_note', { id: L.formerlyPrivateNoteId })).json;
      notFound.push(
        await h.call('hebra_restore_version', {
          id: L.formerlyPrivateNoteId,
          versionId: L.formerlyPrivateVersionId,
          expectedRevision: fp.revision,
          operationId: 'w-2'
        })
      );
      for (const call of notFound) expect(call.json).toEqual(NOT_FOUND);
      expect((await h.call('hebra_read_note', { id: L.publicNote2Id })).json.body).toBe(read.body);

      const unavailable = [
        await h.call('hebra_create_folder', { name: ' DIARIO ' }),
        await h.call('hebra_create_folder', { name: 'Diario' }),
        await h.call('hebra_create_folder', { name: 'secreto', parentId: L.folders.proyectos }),
        await h.call('hebra_rename_folder', { folderId: L.folders.proyectos, name: 'Proyectos' }),
        await h.call('hebra_rename_folder', { folderId: L.folders.proyectos, name: 'Trabajo' }),
        await h.call('hebra_rename_folder', { folderId: L.folders.lumbre, name: 'Secreto' })
      ];
      for (const call of unavailable) expect(call.json).toEqual({ error: 'folder_unavailable' });
      expect((await h.call('hebra_rename_folder', { folderId: L.folders.historial, name: 'Historial' })).json).toMatchObject({
        renamed: false
      });

      // Logs (§6.4): eventos cerrados, ni ids ocultos ni cebos.
      const log = h.stderr();
      for (const id of [L.privateFolderNoteId, L.privateTagNoteId, h.extra.trashedTag, h.extra.secretoId, h.extra.inSecreto, L.folders.diario]) {
        expect(log).not.toContain(id);
      }
      expect(log).not.toMatch(/CEBO|Nota oculta|secreto|diario|Proyectos|Trabajo/i);
    } finally {
      await h.close();
    }
  });
});
