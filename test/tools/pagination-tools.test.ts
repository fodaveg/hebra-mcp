/**
 * Paginación, `fields` y filtros comunes de las herramientas de lista (SPEC.md §5), sobre
 * la biblioteca de prueba con `Diario` (carpeta) y `secreto` (etiqueta) privados: las
 * páginas se rellenan con notas visibles, nunca delatan las ocultas y el cursor de una
 * herramienta no vale en otra.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { BAIT_FOLDER, BAIT_TAG } from '../fixtures/test-library';
import { runLinks } from '../../src/server/tools/links';
import { runListFolders } from '../../src/server/tools/list-folders';
import { runListNotes } from '../../src/server/tools/list-notes';
import { runListTags } from '../../src/server/tools/list-tags';
import { runSearch } from '../../src/server/tools/search';

describe('paginación de las herramientas de lista', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  describe('hebra_list_notes', () => {
    it('recorrer con limit 1 y 2 da lo mismo que una sola página, y acaba en null', async () => {
      test = await buildTestContext();
      const all = await runListNotes(test.ctx, { limit: 100 });
      expect(all.nextCursor).toBeNull();
      for (const limit of [1, 2]) {
        const ids: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 50; guard += 1) {
          const page = await runListNotes(test.ctx, { limit, cursor });
          expect(page.notes.length).toBeGreaterThan(0);
          ids.push(...page.notes.map((note) => note.id));
          if (page.nextCursor === null) break;
          expect(page.notes).toHaveLength(limit);
          cursor = page.nextCursor;
        }
        expect(ids).toEqual(all.notes.map((note) => note.id));
      }
    });

    it('ninguna página ni cursor delata las notas ocultas', async () => {
      test = await buildTestContext();
      const seen: unknown[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard += 1) {
        const page = await runListNotes(test.ctx, { limit: 1, cursor });
        seen.push(page);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      const text = JSON.stringify(seen);
      for (const hidden of [test.library.privateFolderNoteId, test.library.privateTagNoteId]) {
        expect(text).not.toContain(hidden);
      }
      expect(text).not.toContain(BAIT_FOLDER);
      expect(text).not.toContain(BAIT_TAG);
      // `limit` mayor que las visibles: una sola página, sin cursor de cola.
      const visible = (await runListNotes(test.ctx, { limit: 100 })).notes.length;
      const exact = await runListNotes(test.ctx, { limit: visible });
      expect(exact.notes).toHaveLength(visible);
      expect(exact.nextCursor).toBeNull();
    });

    it('acepta el cursor sin envolver de la versión anterior, y rechaza el de otra herramienta', async () => {
      test = await buildTestContext();
      const first = await runListNotes(test.ctx, { limit: 1 });
      expect(first.nextCursor).toMatch(/^n1\./u);
      const search = await runSearch(test.ctx, { query: 'nota', limit: 1 });
      await expect(
        runListNotes(test.ctx, { cursor: search.nextCursor ?? 's1.AAAA' })
      ).rejects.toThrowError();
      const raw = Buffer.from(first.nextCursor!.slice(3), 'base64url').toString('utf8');
      const legacy = await runListNotes(test.ctx, { limit: 1, cursor: raw });
      const wrapped = await runListNotes(test.ctx, { limit: 1, cursor: first.nextCursor! });
      expect(legacy.notes).toEqual(wrapped.notes);
    });

    it('`fields` deja `id` y lo pedido; sin `fields`, la salida de siempre', async () => {
      test = await buildTestContext();
      const full = await runListNotes(test.ctx, { limit: 3 });
      const slim = await runListNotes(test.ctx, { limit: 3, fields: ['title', 'tags'] });
      expect(slim.notes.map((note) => Object.keys(note))).toEqual(
        slim.notes.map(() => ['id', 'title', 'tags'])
      );
      expect(slim.notes.map((note) => note.id)).toEqual(full.notes.map((note) => note.id));
      expect(Object.keys(full.notes[0]!)).toEqual([
        'id',
        'title',
        'folderPath',
        'tags',
        'excerpt',
        'updatedAt',
        'isConflictCopy'
      ]);
    });
  });

  describe('hebra_search', () => {
    it('pagina con cursor, sin repetir ni saltar, y acaba en null', async () => {
      test = await buildTestContext();
      const all = await runSearch(test.ctx, { query: 'nota', limit: 50 });
      expect(all.results.length).toBeGreaterThan(2);
      expect(all.nextCursor).toBeNull();
      const ids: (string | undefined)[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard += 1) {
        const page = await runSearch(test.ctx, { query: 'nota', limit: 1, cursor });
        ids.push(...page.results.map((result) => result.id));
        if (page.nextCursor === null) break;
        expect(page.results).toHaveLength(1);
        cursor = page.nextCursor;
      }
      expect(ids).toEqual(all.results.map((result) => result.id));
    });

    it('el cursor no delata ocultas: ni sus ids ni el cebo salen en ninguna página', async () => {
      test = await buildTestContext();
      const pages: unknown[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard += 1) {
        const page = await runSearch(test.ctx, { query: 'nota OR contenido OR oculta', limit: 1, cursor });
        pages.push(page);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      const text = JSON.stringify(pages);
      expect(text).not.toContain(test.library.privateFolderNoteId);
      expect(text).not.toContain(test.library.privateTagNoteId);
      expect(text).not.toContain(BAIT_FOLDER);
    });

    it('`fields` deja `id` y lo pedido', async () => {
      test = await buildTestContext();
      const { results } = await runSearch(test.ctx, { query: 'pública', fields: ['snippet'] });
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) expect(Object.keys(result)).toEqual(['id', 'snippet']);
    });

    it('`subfolders` funciona como en hebra_list_notes', async () => {
      test = await buildTestContext();
      const direct = await runSearch(test.ctx, { query: 'nota OR título', folder: 'proyectos', limit: 50 });
      const deep = await runSearch(test.ctx, {
        query: 'nota OR título',
        folder: 'proyectos',
        subfolders: true,
        limit: 50
      });
      const listed = await runListNotes(test.ctx, {
        folder: 'proyectos',
        subfolders: true,
        limit: 100
      });
      expect(deep.results.length).toBeGreaterThan(direct.results.length);
      expect(new Set(deep.results.map((r) => r.id))).toEqual(
        new Set(listed.notes.map((n) => n.id))
      );
    });

    it('un cursor ilegible o de otra herramienta se rechaza', async () => {
      test = await buildTestContext();
      await expect(runSearch(test.ctx, { query: 'nota', cursor: 'basura' })).rejects.toThrowError();
      await expect(runSearch(test.ctx, { query: 'nota', cursor: 'n1.AAAA' })).rejects.toThrowError();
    });
  });

  describe('hebra_links', () => {
    it('sin `limit`, todo y nextCursor null; con limit 1 pagina outgoing y backlinks', async () => {
      test = await buildTestContext();
      const all = await runLinks(test.ctx, { id: test.library.publicNoteId });
      expect(all.nextCursor).toBeNull();
      expect(all.outgoing.length).toBeGreaterThanOrEqual(2);
      expect(all.backlinks.length).toBeGreaterThanOrEqual(2);

      const outgoing: string[] = [];
      const backlinks: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard += 1) {
        const page = await runLinks(test.ctx, { id: test.library.publicNoteId, limit: 1, cursor });
        expect(page.outgoing.length).toBeLessThanOrEqual(1);
        expect(page.backlinks.length).toBeLessThanOrEqual(1);
        outgoing.push(...page.outgoing.map((link) => link.ref));
        backlinks.push(...page.backlinks.map((note) => note.id));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(outgoing).toEqual(all.outgoing.map((link) => link.ref));
      expect(backlinks).toEqual(all.backlinks.map((note) => note.id));
    });

    it('las páginas de backlinks no delatan ocultas', async () => {
      test = await buildTestContext();
      const text: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard += 1) {
        const page = await runLinks(test.ctx, { id: test.library.publicNoteId, limit: 1, cursor });
        text.push(JSON.stringify(page));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(text.join('')).not.toContain(test.library.privateFolderNoteId);
      expect(text.join('')).not.toContain(BAIT_FOLDER);
    });

    it('un cursor de otra herramienta se rechaza', async () => {
      test = await buildTestContext();
      await expect(
        runLinks(test.ctx, { id: test.library.publicNoteId, cursor: 'n1.AAAA' })
      ).rejects.toThrowError();
    });
  });

  describe('hebra_list_tags y hebra_list_folders', () => {
    it('etiquetas: sin `limit` todas; con `limit` 1 recorre igual y acaba en null', async () => {
      test = await buildTestContext();
      const all = await runListTags(test.ctx);
      expect(all.nextCursor).toBeNull();
      expect(all.tags.length).toBeGreaterThan(1);
      const tags: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard += 1) {
        const page = await runListTags(test.ctx, { limit: 1, cursor });
        tags.push(...page.tags.map((entry) => entry.tag));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(tags).toEqual(all.tags.map((entry) => entry.tag));
      expect(tags.some((tag) => tag.startsWith('secreto'))).toBe(false);
    });

    it('carpetas: idem, y las privadas no aparecen en ninguna página', async () => {
      test = await buildTestContext();
      const all = await runListFolders(test.ctx);
      expect(all.nextCursor).toBeNull();
      const paths: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard += 1) {
        const page = await runListFolders(test.ctx, { limit: 2, cursor });
        paths.push(...page.folders.map((entry) => entry.path));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(paths).toEqual(all.folders.map((entry) => entry.path));
      expect(paths.some((path) => path.startsWith('diario'))).toBe(false);
    });
  });
});
