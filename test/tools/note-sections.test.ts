/**
 * Notas por apartados (D11, SPEC.md §5 «Notas por apartados»): leer un apartado
 * (`hebra_read_note` con `heading`), el esquema (`hebra_note_outline`), añadir a un
 * apartado (`hebra_append_to_note` con `heading`) y la prueba de lo guardado de
 * `hebra_append_to_note` y `hebra_edit_note`. El analizador por su cuenta va en
 * `test/store/sections.test.ts`.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveToolContext, type ToolContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import { runAppendToNote } from '../../src/server/tools/append-to-note';
import { runEditNote } from '../../src/server/tools/edit-note';
import { runNoteOutline } from '../../src/server/tools/note-outline';
import { runReadNote } from '../../src/server/tools/read-note';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { BAIT_FOLDER } from '../fixtures/test-library';

const BODY = [
  '# Decisiones',
  'intro',
  '',
  '## Uno',
  'texto uno',
  '### Uno.a',
  'hijo',
  '',
  '## Dos',
  'texto dos',
  '',
  '## Dos',
  'otro dos',
  ''
].join('\n');

let counter = 0;
function opId(): string {
  counter += 1;
  return `op-sections-${process.pid}-${counter}`;
}

describe('notas por apartados (D11)', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  /** Crea una nota y devuelve su id y un contexto con el filtro al día (la nota es nueva). */
  async function create(body = BODY): Promise<{ id: string; ctx: ToolContext }> {
    test = test ?? (await buildTestContext());
    const created = await test.ctx.write!.createNote({
      body,
      folderId: null,
      privacy: test.serverContext.privacyConfig
    });
    return { id: created.id, ctx: await resolveToolContext(test.serverContext) };
  }

  async function bodyOf(id: string): Promise<string> {
    return (await test!.ctx.port.noteRead(id))!.body;
  }

  async function rejection(promise: Promise<unknown>): Promise<ToolError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof ToolError) return error;
      throw error;
    }
    throw new Error('no rechazó');
  }

  describe('hebra_read_note con heading', () => {
    it('devuelve solo el apartado (subapartados incluidos) con section y totalChars', async () => {
      const { id, ctx } = await create();
      const whole = await runReadNote(ctx, { id });
      const part = await runReadNote(ctx, { id, heading: 'uno' });
      expect(part.body).toBe('## Uno\ntexto uno\n### Uno.a\nhijo\n\n');
      expect(part.section).toEqual({ heading: 'Uno', level: 2, line: 4, occurrence: 1 });
      expect(part.totalChars).toBe(BODY.length);
      // Misma salida que la lectura entera salvo `body`, `section` y `totalChars`; la
      // revisión es la de la NOTA entera.
      expect(part.revision).toBe(whole.revision);
      const { body: _a, section: _b, totalChars: _c, ...rest } = part;
      const { body: _d, ...wholeRest } = whole;
      expect(rest).toEqual(wholeRest);
    });

    it('un subapartado se lee solo', async () => {
      const { id, ctx } = await create();
      const part = await runReadNote(ctx, { id, heading: 'Uno.a' });
      expect(part.body).toBe('### Uno.a\nhijo\n\n');
      expect(part.section).toMatchObject({ level: 3, line: 6 });
    });

    it('sin heading, la salida es la de siempre: ni section ni totalChars', async () => {
      const { id, ctx } = await create();
      const whole = await runReadNote(ctx, { id });
      expect(whole.body).toBe(BODY);
      expect('section' in whole).toBe(false);
      expect('totalChars' in whole).toBe(false);
    });

    it('headingOccurrence sin heading: invalid_input', async () => {
      const { id, ctx } = await create();
      expect((await rejection(runReadNote(ctx, { id, headingOccurrence: 1 }))).code).toBe(
        'invalid_input'
      );
    });

    it('heading_not_found y ambiguous_heading con candidatos; headingOccurrence elige', async () => {
      const { id, ctx } = await create();
      expect((await rejection(runReadNote(ctx, { id, heading: 'No existe' }))).code).toBe(
        'heading_not_found'
      );
      const ambiguous = await rejection(runReadNote(ctx, { id, heading: 'Dos' }));
      expect(ambiguous.code).toBe('ambiguous_heading');
      expect(ambiguous.extra).toEqual({
        candidates: [
          { heading: 'Dos', level: 2, line: 9, occurrence: 1 },
          { heading: 'Dos', level: 2, line: 12, occurrence: 2 }
        ]
      });
      const second = await runReadNote(ctx, { id, heading: 'Dos', headingOccurrence: 2 });
      expect(second.body).toBe('## Dos\notro dos\n');
      expect(second.section?.occurrence).toBe(2);
      expect(
        (await rejection(runReadNote(ctx, { id, heading: 'Dos', headingOccurrence: 3 }))).code
      ).toBe('heading_not_found');
    });

    it('una nota oculta responde not_found con heading, igual que una inexistente', async () => {
      test = await buildTestContext();
      const hidden = await rejection(
        runReadNote(test.ctx, { id: test.library.privateFolderNoteId, heading: BAIT_FOLDER })
      );
      const missing = await rejection(runReadNote(test.ctx, { id: 'no-existe', heading: BAIT_FOLDER }));
      expect(hidden.code).toBe('not_found');
      expect(hidden.extra).toEqual(missing.extra);
      expect(missing.code).toBe('not_found');
    });

    it('una nota bloqueada: note_locked', async () => {
      const { id } = await create();
      const db = new DatabaseSync(test!.sqlitePath);
      db.prepare('UPDATE notes SET body = ? WHERE id = ?').run('hebra-locked:v1:x', id);
      db.close();
      const ctx = await resolveToolContext(test!.serverContext);
      expect((await rejection(runReadNote(ctx, { id, heading: 'Uno' }))).code).toBe('note_locked');
    });
  });

  describe('hebra_note_outline', () => {
    it('lista los apartados con tamaños que coinciden con lo que devuelve la lectura', async () => {
      const { id, ctx } = await create();
      const outline = await runNoteOutline(ctx, { id });
      expect(outline).toMatchObject({
        id,
        totalChars: BODY.length,
        nextCursor: null,
        revision: (await runReadNote(ctx, { id })).revision
      });
      expect(outline.sections.map((s) => [s.heading, s.level, s.line, s.occurrence])).toEqual([
        ['Decisiones', 1, 1, undefined],
        ['Uno', 2, 4, undefined],
        ['Uno.a', 3, 6, undefined],
        ['Dos', 2, 9, 1],
        ['Dos', 2, 12, 2]
      ]);
      for (const section of outline.sections) {
        const read = await runReadNote(ctx, {
          id,
          heading: section.heading,
          ...(section.occurrence !== undefined ? { headingOccurrence: section.occurrence } : {})
        });
        expect(section.chars).toBe(read.body.length);
      }
      // Sin cuerpo.
      expect(JSON.stringify(outline)).not.toContain('texto uno');
    });

    it('también por título exacto; título ambiguo e inexistente como en la lectura', async () => {
      const { id, ctx } = await create();
      const title = (await runReadNote(ctx, { id })).title;
      expect((await runNoteOutline(ctx, { title })).id).toBe(id);
      expect((await rejection(runNoteOutline(ctx, { title: 'no existe' }))).code).toBe('not_found');
      expect((await rejection(runNoteOutline(ctx, {}))).code).toBe('invalid_input');
      expect((await rejection(runNoteOutline(ctx, { id, title }))).code).toBe('invalid_input');
    });

    it('maxLevel deja solo los de ese nivel o menor, y occurrence cuenta sobre todos', async () => {
      const { id, ctx } = await create('# A\n### Dup\nx\n## B\n### Dup\ny\n');
      const outline = await runNoteOutline(ctx, { id, maxLevel: 2 });
      expect(outline.sections.map((s) => s.heading)).toEqual(['A', 'B']);
      const deep = await runNoteOutline(ctx, { id, maxLevel: 3 });
      expect(deep.sections.filter((s) => s.heading === 'Dup').map((s) => s.occurrence)).toEqual([1, 2]);
      expect((await rejection(runNoteOutline(ctx, { id, maxLevel: 7 }))).code).toBe('invalid_input');
    });

    it('pagina con cursor; el cursor de otra revisión o de otro maxLevel es invalid_input', async () => {
      const { id, ctx } = await create();
      const first = await runNoteOutline(ctx, { id, limit: 2 });
      expect(first.sections).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await runNoteOutline(ctx, { id, limit: 2, cursor: first.nextCursor! });
      expect(second.sections.map((s) => s.heading)).toEqual(['Uno.a', 'Dos']);
      const third = await runNoteOutline(ctx, { id, limit: 2, cursor: second.nextCursor! });
      expect(third.sections.map((s) => s.occurrence)).toEqual([2]);
      expect(third.nextCursor).toBeNull();

      expect(
        (await rejection(runNoteOutline(ctx, { id, limit: 2, maxLevel: 2, cursor: first.nextCursor! }))).code
      ).toBe('invalid_input');

      // La nota cambia entre páginas.
      await runAppendToNote(ctx, { id, text: 'más' });
      const fresh = await resolveToolContext(test!.serverContext);
      expect(
        (await rejection(runNoteOutline(fresh, { id, limit: 2, cursor: first.nextCursor! }))).code
      ).toBe('invalid_input');
      // Un cursor de otra herramienta tampoco vale.
      expect((await rejection(runNoteOutline(fresh, { id, cursor: 'n1.abc' }))).code).toBe(
        'invalid_input'
      );
    });

    it('nota oculta, inexistente o en la papelera: not_found; bloqueada: note_locked', async () => {
      test = await buildTestContext();
      for (const id of [
        test.library.privateFolderNoteId,
        test.library.privateTagNoteId,
        test.library.trashedNoteId,
        'no-existe'
      ]) {
        expect((await rejection(runNoteOutline(test.ctx, { id }))).code).toBe('not_found');
      }
      const { id } = await create();
      const db = new DatabaseSync(test.sqlitePath);
      db.prepare('UPDATE notes SET body = ? WHERE id = ?').run('hebra-locked:v1:x', id);
      db.close();
      const ctx = await resolveToolContext(test.serverContext);
      expect((await rejection(runNoteOutline(ctx, { id }))).code).toBe('note_locked');
    });
  });

  describe('hebra_append_to_note con heading', () => {
    it('apartado intermedio: cuerpo exacto y prueba leída del cuerpo guardado', async () => {
      const { id, ctx } = await create('# A\nuno\n\n# B\ndos\n');
      const result = await runAppendToNote(ctx, { id, text: 'nuevo', heading: 'a' });
      const body = await bodyOf(id);
      expect(body).toBe('# A\nuno\n\nnuevo\n\n# B\ndos\n');
      expect(result).toEqual({
        id,
        outcome: 'saved',
        revision: expect.stringMatching(/^r1\./),
        totalChars: body.length,
        appended: { chars: 5, tail: 'nuevo', line: 4, heading: 'A' }
      });
    });

    it('último apartado: conserva el final de la nota', async () => {
      const { id, ctx } = await create('# A\nuno\n# B\ndos\n\n');
      await runAppendToNote(ctx, { id, text: 'nuevo', heading: 'B' });
      expect(await bodyOf(id)).toBe('# A\nuno\n# B\ndos\n\nnuevo\n\n');
    });

    it('apartado con subapartados: tras el último subapartado', async () => {
      const { id, ctx } = await create();
      await runAppendToNote(ctx, { id, text: 'cola', heading: 'Uno' });
      expect(await bodyOf(id)).toBe(
        BODY.replace('hijo\n\n## Dos', 'hijo\n\ncola\n\n## Dos')
      );
    });

    it('blancos de más al final del apartado: una línea exacta antes, el resto detrás', async () => {
      const { id, ctx } = await create('# A\nuno\n\n\n\n# B\nx\n');
      await runAppendToNote(ctx, { id, text: 'nuevo', heading: 'A' });
      expect(await bodyOf(id)).toBe('# A\nuno\n\nnuevo\n\n\n\n# B\nx\n');
    });

    it('un encabezado dentro de un cercado no es el apartado', async () => {
      const { id, ctx } = await create('# A\n```\n# B\n```\n# C\nx\n');
      expect((await rejection(runAppendToNote(ctx, { id, text: 'n', heading: 'B' }))).code).toBe(
        'heading_not_found'
      );
      await runAppendToNote(ctx, { id, text: 'n', heading: 'A' });
      expect(await bodyOf(id)).toBe('# A\n```\n# B\n```\n\nn\n\n# C\nx\n');
    });

    it('con el frontmatter, lo anterior no cambia', async () => {
      const { id, ctx } = await create('---\ntitle: T\n---\n# A\nuno\n');
      await runAppendToNote(ctx, { id, text: 'nuevo', heading: 'A' });
      expect(await bodyOf(id)).toBe('---\ntitle: T\n---\n# A\nuno\n\nnuevo\n');
    });

    it('sin heading: el cuerpo de siempre y la prueba al final', async () => {
      const { id, ctx } = await create('# A\nuno\n');
      const result = await runAppendToNote(ctx, { id, text: 'fin' });
      const body = await bodyOf(id);
      expect(body).toBe('# A\nuno\n\n\nfin');
      expect(result.appended).toEqual({ chars: 3, tail: 'fin', line: 5 });
      expect(result.totalChars).toBe(body.length);
    });

    it('tail: los últimos 200 caracteres del texto insertado', async () => {
      const { id, ctx } = await create('# A\nuno\n# B\nx\n');
      const text = `${'a'.repeat(100)}${'b'.repeat(200)}`;
      const result = await runAppendToNote(ctx, { id, text, heading: 'A' });
      expect(result.appended?.chars).toBe(300);
      expect(result.appended?.tail).toBe('b'.repeat(200));
    });

    it('heading_not_found y ambiguous_heading no escriben; headingOccurrence elige', async () => {
      const { id, ctx } = await create();
      const before = await bodyOf(id);
      expect((await rejection(runAppendToNote(ctx, { id, text: 'x', heading: 'Nada' }))).code).toBe(
        'heading_not_found'
      );
      const ambiguous = await rejection(runAppendToNote(ctx, { id, text: 'x', heading: 'Dos' }));
      expect(ambiguous.code).toBe('ambiguous_heading');
      expect(ambiguous.extra?.candidates).toHaveLength(2);
      expect(await bodyOf(id)).toBe(before);
      await runAppendToNote(ctx, { id, text: 'segundo', heading: 'Dos', headingOccurrence: 2 });
      expect((await bodyOf(id)).endsWith('## Dos\notro dos\n\nsegundo\n')).toBe(true);
    });

    it('headingOccurrence sin heading: invalid_input', async () => {
      const { id, ctx } = await create();
      expect((await rejection(runAppendToNote(ctx, { id, text: 'x', headingOccurrence: 1 }))).code).toBe(
        'invalid_input'
      );
    });

    it('una nota oculta responde not_found también con heading, sin escribir', async () => {
      test = await buildTestContext();
      const before = await bodyOf(test.library.privateFolderNoteId);
      const hidden = await rejection(
        runAppendToNote(test.ctx, { id: test.library.privateFolderNoteId, text: 'x', heading: 'H' })
      );
      const missing = await rejection(runAppendToNote(test.ctx, { id: 'no-existe', text: 'x', heading: 'H' }));
      expect(hidden.code).toBe('not_found');
      expect(missing.code).toBe('not_found');
      expect(await bodyOf(test.library.privateFolderNoteId)).toBe(before);
    });

    it('una nota bloqueada: note_locked antes de mirar el apartado', async () => {
      const { id } = await create();
      const db = new DatabaseSync(test!.sqlitePath);
      db.prepare('UPDATE notes SET body = ? WHERE id = ?').run('hebra-locked:v1:x', id);
      db.close();
      const ctx = await resolveToolContext(test!.serverContext);
      expect((await rejection(runAppendToNote(ctx, { id, text: 'x', heading: 'Uno' }))).code).toBe(
        'note_locked'
      );
    });

    it('una etiqueta privada en el texto: not_found, sin escribir', async () => {
      const { id, ctx } = await create();
      const before = await bodyOf(id);
      expect(
        (await rejection(runAppendToNote(ctx, { id, text: '#secreto', heading: 'Uno' }))).code
      ).toBe('not_found');
      expect(await bodyOf(id)).toBe(before);
    });

    it('la revisión devuelta vale como expectedRevision', async () => {
      const { id, ctx } = await create('# A\nuno\n');
      const appended = await runAppendToNote(ctx, { id, text: 'dos', heading: 'A' });
      const edited = await runEditNote(ctx, {
        id,
        edits: [{ find: 'uno', replace: 'UNO' }],
        expectedRevision: appended.revision!,
        operationId: opId()
      });
      expect(edited.outcome).toBe('saved');
    });
  });

  describe('hebra_edit_note: prueba de lo guardado', () => {
    it('applied en el orden de edits, con chars y tail del cuerpo guardado', async () => {
      const { id, ctx } = await create('# T\nalfa\nbeta\ngamma\n');
      const revision = (await runReadNote(ctx, { id })).revision;
      const long = 'z'.repeat(250);
      const result = await runEditNote(ctx, {
        id,
        edits: [
          { find: 'gamma', replace: long },
          { find: 'alfa', replace: 'ALFA' },
          { find: 'beta', replace: '' }
        ],
        expectedRevision: revision,
        operationId: opId()
      });
      const body = await bodyOf(id);
      expect(result).toMatchObject({
        outcome: 'saved',
        totalChars: body.length,
        applied: [
          { chars: 250, tail: 'z'.repeat(200) },
          { chars: 4, tail: 'ALFA' },
          { chars: 0, tail: '' }
        ]
      });
    });

    it('una edición que no cambia nada devuelve applied igual', async () => {
      const { id, ctx } = await create('# T\nalfa\n');
      const result = await runEditNote(ctx, {
        id,
        edits: [{ find: 'alfa', replace: 'alfa' }],
        expectedRevision: (await runReadNote(ctx, { id })).revision,
        operationId: opId()
      });
      expect(result).toMatchObject({
        outcome: 'saved',
        totalChars: '# T\nalfa\n'.length,
        applied: [{ chars: 4, tail: 'alfa' }]
      });
    });

    it('una casilla que se reordena: la sustitución movida sale con moved', async () => {
      const { id, ctx } = await create('# T\n- [ ] Uno\n- [ ] Dos\n- [ ] Tres\n');
      const result = await runEditNote(ctx, {
        id,
        edits: [{ find: '- [ ] Uno', replace: '- [x] Uno' }],
        expectedRevision: (await runReadNote(ctx, { id })).revision,
        operationId: opId()
      });
      // La tarea marcada baja al final de su lista: el cuerpo guardado ya no tiene
      // `- [x] Uno` donde `applyEdits` lo puso, pero sí una sola vez.
      expect(await bodyOf(id)).toBe('# T\n- [ ] Dos\n- [ ] Tres\n- [x] Uno\n');
      expect(result).toMatchObject({
        applied: [{ chars: 9, tail: '- [x] Uno' }]
      });
    });

    it('si el replace queda repetido tras reordenar, no se puede ubicar: moved, sin tail', async () => {
      const { id, ctx } = await create('# T\n- [ ] a\n- [ ] b\n- [x] a\n');
      const result = await runEditNote(ctx, {
        id,
        edits: [{ find: '- [ ] a', replace: '- [x] a' }],
        expectedRevision: (await runReadNote(ctx, { id })).revision,
        operationId: opId()
      });
      expect(result).toMatchObject({ applied: [{ chars: 7, moved: true }] });
      expect(JSON.stringify(result)).not.toContain('"tail"');
    });

    it('un reintento con el mismo operationId devuelve lo guardado, con la prueba', async () => {
      const { id, ctx } = await create('# T\nalfa\n');
      const input = {
        id,
        edits: [{ find: 'alfa', replace: 'ALFA' }],
        expectedRevision: (await runReadNote(ctx, { id })).revision,
        operationId: opId()
      };
      const first = await runEditNote(ctx, input);
      const again = await runEditNote(ctx, input);
      expect(first).toMatchObject({ applied: [{ chars: 4, tail: 'ALFA' }] });
      expect(again).toEqual({ ...first, replayed: true });
    });
  });
});
