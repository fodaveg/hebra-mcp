/**
 * `hebra_read_note` con `lines` (D13, SPEC.md §5): solo un tramo de líneas, con la
 * numeración de la nota entera (la de `hebra_grep` y `hebra_note_outline`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveToolContext, type ToolContext } from '../../src/server/context';
import { runGrep } from '../../src/server/tools/grep';
import { runReadNote } from '../../src/server/tools/read-note';
import { READ_LINES_MAX } from '../../src/store/grep';
import { buildTestContext, type TestContext } from '../fixtures/test-context';

const BODY = '# Título\r\n\r\nuno\r\ndos\ntres\n\n## Apartado\ncuatro';

describe('hebra_read_note con lines (D13)', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  async function create(body = BODY): Promise<{ id: string; ctx: ToolContext }> {
    test = test ?? (await buildTestContext());
    const created = await test.ctx.write!.createNote({
      body,
      folderId: null,
      privacy: test.serverContext.privacyConfig
    });
    return { id: created.id, ctx: await resolveToolContext(test.serverContext) };
  }

  it('el tramo tal cual, con sus terminadores, y la revisión de la nota entera', async () => {
    const { id, ctx } = await create();
    const whole = await runReadNote(ctx, { id });
    const part = await runReadNote(ctx, { id, lines: { from: 3, to: 4 } });
    expect(part.body).toBe('uno\r\ndos\n');
    expect(part.lines).toEqual({ from: 3, to: 4 });
    expect(part.totalLines).toBe(8);
    expect(part.totalChars).toBe(BODY.length);
    expect(part.revision).toBe(whole.revision);
    expect(whole.lines).toBeUndefined();
    expect(whole.totalLines).toBeUndefined();
  });

  it('bordes: una sola línea, la última sin salto, `to` más allá del final o ausente', async () => {
    const { id, ctx } = await create();
    expect((await runReadNote(ctx, { id, lines: { from: 1, to: 1 } })).body).toBe('# Título\r\n');
    const last = await runReadNote(ctx, { id, lines: { from: 8, to: 8 } });
    expect(last.body).toBe('cuatro');
    const beyond = await runReadNote(ctx, { id, lines: { from: 6, to: 99 } });
    expect(beyond.body).toBe('\n## Apartado\ncuatro');
    expect(beyond.lines).toEqual({ from: 6, to: 8 });
    const open = await runReadNote(ctx, { id, lines: { from: 1 } });
    expect(open.body).toBe(BODY);
    expect(open.lines).toEqual({ from: 1, to: 8 });
  });

  it('un tramo más largo que el tope se recorta al tope', async () => {
    const many = Array.from({ length: READ_LINES_MAX + 10 }, (_, index) => `l${index + 1}`).join('\n');
    const { id, ctx } = await create(`# Muchas\n${many}\n`);
    const out = await runReadNote(ctx, { id, lines: { from: 2 } });
    expect(out.lines).toEqual({ from: 2, to: READ_LINES_MAX + 1 });
    expect(out.body.split('\n').filter(Boolean)).toHaveLength(READ_LINES_MAX);
    expect(out.totalLines).toBe(READ_LINES_MAX + 11);
  });

  it('fuera de rango o mal formado: invalid_input; con heading, también', async () => {
    const { id, ctx } = await create();
    for (const lines of [
      { from: 9 },
      { from: 0 },
      { from: 3, to: 2 },
      { from: 1.5 },
      { from: 1, to: Number.NaN }
    ]) {
      await expect(runReadNote(ctx, { id, lines }), JSON.stringify(lines)).rejects.toMatchObject({
        code: 'invalid_input'
      });
    }
    await expect(
      runReadNote(ctx, { id, heading: 'Apartado', lines: { from: 1 } })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    // Una nota vacía no tiene líneas.
    const empty = await create('');
    await expect(runReadNote(empty.ctx, { id: empty.id, lines: { from: 1 } })).rejects.toMatchObject({
      code: 'invalid_input'
    });
  });

  it('las líneas de hebra_grep se leen tal cual', async () => {
    const { id, ctx } = await create();
    const [match] = (await runGrep(ctx, { pattern: 'dos' })).matches;
    expect(match).toMatchObject({ id, line: 4, text: 'dos' });
    const read = await runReadNote(ctx, { id, lines: { from: match!.line, to: match!.line } });
    expect(read.body).toBe('dos\n');
  });

  it('nota bloqueada: note_locked; oculta: not_found', async () => {
    test = await buildTestContext();
    const ctx = test.ctx;
    await expect(
      runReadNote(ctx, { id: test.library.attachmentsNoteId, lines: { from: 1 } })
    ).resolves.toMatchObject({ lines: { from: 1 } });
    // `lockedPrivateNoteId` está en una carpeta privada: antes que bloqueada, oculta.
    await expect(
      runReadNote(ctx, { id: test.library.lockedPrivateNoteId, lines: { from: 1 } })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      runReadNote(ctx, { id: test.library.privateTagNoteId, lines: { from: 1 } })
    ).rejects.toMatchObject({ code: 'not_found' });
    // Una bloqueada visible: con la carpeta privada fuera de la configuración.
    const open = await resolveToolContext({
      ...test.serverContext,
      privacyConfig: { privateFolders: [], privateTags: [] }
    });
    await expect(
      runReadNote(open, { id: test.library.lockedPrivateNoteId, lines: { from: 1 } })
    ).rejects.toMatchObject({ code: 'note_locked' });
  });
});
