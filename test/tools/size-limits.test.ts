/**
 * Todo `invalid_input` por tamaño dice el campo, el límite y cuánto llegó (tarea de Lumbre
 * 48e8e6f6, 27 nov 2026). lacre-27 midió que `hebra_create_note` con un cuerpo de 121 KB
 * respondía `invalid_input` sin más, y no había forma de saber cuánto recortar.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { runCreateNote } from '../../src/server/tools/create-note';
import { runAppendToNote } from '../../src/server/tools/append-to-note';
import { runEditNote } from '../../src/server/tools/edit-note';
import { HEADING_INPUT_MAX_LENGTH, runReadNote } from '../../src/server/tools/read-note';
import { runCreateFolder, runRenameFolder } from '../../src/server/tools/folders';
import { runGrep } from '../../src/server/tools/grep';
import { runReplaceInNotes } from '../../src/server/tools/replace-in-notes';
import { runJdNewId } from '../../src/server/tools/jd';
import { runJdMove } from '../../src/server/tools/jd-move';
import { requireValidOperationId, requireValidRevision } from '../../src/server/tools/guards';
import { toErrorResult, ToolError } from '../../src/server/errors';
import { APPEND_TEXT_MAX_BYTES, jsonTextBytes, NOTE_BODY_MAX_BYTES } from '../../src/store/writes';
import { EDITS_MAX_COUNT, EDITS_TOTAL_MAX_LENGTH } from '../../src/store/edits';
import { OPERATION_ID_MAX_LENGTH } from '../../src/store/operations';
import { REVISION_MAX_LENGTH } from '../../src/store/revision';
import { FOLDER_NAME_MAX_LENGTH } from '../../src/store/folders';
import { GREP_PATTERN_MAX_CHARS } from '../../src/store/grep';
import { REPLACEMENT_MAX_CHARS } from '../../src/store/replace';
import { JD_TITLE_MAX_LENGTH } from '../../src/store/jd-new-id';
import { JD_MOVE_NAME_MAX_LENGTH } from '../../src/store/jd-move';

let test: TestContext | undefined;
afterEach(async () => {
  await test?.close();
  test = undefined;
});

/** El error que lanza `run`, como lo ve quien llama a la herramienta. */
async function errorOf(run: () => unknown): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    const content = toErrorResult(error).content as Array<{ text: string }>;
    return JSON.parse(content[0]!.text);
  }
  throw new Error('no lanzó');
}

const tooLarge = (field: string, limit: number, received: number, unit = 'chars') => ({
  error: 'invalid_input',
  field,
  limit,
  received,
  unit
});

describe('invalid_input por tamaño lleva campo, límite y recibido', () => {
  it('tope honesto: lo que cabe en un sobre del relé (2 MiB) menos el margen de Hebra', () => {
    expect(NOTE_BODY_MAX_BYTES).toBe(2 * 1024 * 1024 - 28 - 64 * 1024);
    expect(APPEND_TEXT_MAX_BYTES).toBe(1024 * 1024);
    // Bytes del JSON: comillas y escapes incluidos, nunca menos que `length`.
    expect(jsonTextBytes('a')).toBe(3);
    expect(jsonTextBytes('ñ')).toBe(4);
    expect(jsonTextBytes('\u0001')).toBe(8);
  });

  it('hebra_create_note con un cuerpo de 121 KB (lacre-27) se crea; uno que no cabe en el sobre, no', async () => {
    test = await buildTestContext();
    const created = await runCreateNote(test.ctx, { body: `# Grande\n${'x'.repeat(121_000)}` });
    expect((await test.ctx.port.noteRead(created.id))?.body.length).toBe(121_009);
    const body = 'ñ'.repeat(NOTE_BODY_MAX_BYTES / 2);
    expect(await errorOf(() => runCreateNote(test!.ctx, { body }))).toEqual(
      tooLarge('body', NOTE_BODY_MAX_BYTES, jsonTextBytes(body), 'bytes')
    );
  });

  it('hebra_append_to_note: el texto de una llamada hasta 1 MiB y la nota entera hasta su tope', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const start = (await test.ctx.port.noteRead(id))!.body.length;
    // Un append de 100 000 caracteres, que antes se rechazaba, entra.
    await runAppendToNote(test.ctx, { id, text: 'a'.repeat(100_000) });
    const text = 'b'.repeat(APPEND_TEXT_MAX_BYTES);
    expect(await errorOf(() => runAppendToNote(test!.ctx, { id, text }))).toEqual(
      tooLarge('text', APPEND_TEXT_MAX_BYTES, APPEND_TEXT_MAX_BYTES + 2, 'bytes')
    );
    // Un append de casi 1 MiB cabe; el siguiente dejaría la nota por encima de su tope.
    const chunk = 'c'.repeat(APPEND_TEXT_MAX_BYTES - 10);
    await runAppendToNote(test.ctx, { id, text: chunk });
    const error = await errorOf(() => runAppendToNote(test!.ctx, { id, text: chunk }));
    expect(error).toMatchObject({ error: 'invalid_input', field: 'body', limit: NOTE_BODY_MAX_BYTES, unit: 'bytes' });
    expect(error.received as number).toBeGreaterThan(NOTE_BODY_MAX_BYTES);
    expect((await test.ctx.port.noteRead(id))?.body.length).toBe(start + 2 + 100_000 + 2 + chunk.length);
  });

  it('hebra_edit_note: demasiadas sustituciones o demasiado texto sumado', async () => {
    test = await buildTestContext();
    const many = Array.from({ length: EDITS_MAX_COUNT + 1 }, () => ({ find: 'a', replace: 'b' }));
    const base = { id: 'n', expectedRevision: 'r', operationId: 'op' };
    expect(await errorOf(() => runEditNote(test!.ctx, { ...base, edits: many }))).toEqual(
      tooLarge('edits', EDITS_MAX_COUNT, EDITS_MAX_COUNT + 1, 'items')
    );
    const big = [{ find: 'a', replace: 'x'.repeat(EDITS_TOTAL_MAX_LENGTH) }];
    expect(await errorOf(() => runEditNote(test!.ctx, { ...base, edits: big }))).toEqual(
      tooLarge('edits', EDITS_TOTAL_MAX_LENGTH, EDITS_TOTAL_MAX_LENGTH + 1)
    );
    // Lo que no es tamaño sigue a secas.
    expect(await errorOf(() => runEditNote(test!.ctx, { ...base, edits: [{ find: '', replace: 'b' }] }))).toEqual({
      error: 'invalid_input'
    });
  });

  it('heading, operationId y expectedRevision', async () => {
    test = await buildTestContext();
    const heading = 'h'.repeat(HEADING_INPUT_MAX_LENGTH + 5);
    expect(await errorOf(() => runReadNote(test!.ctx, { id: 'n', heading }))).toEqual(
      tooLarge('heading', HEADING_INPUT_MAX_LENGTH, HEADING_INPUT_MAX_LENGTH + 5)
    );
    expect(await errorOf(() => requireValidOperationId('o'.repeat(OPERATION_ID_MAX_LENGTH + 1)))).toEqual(
      tooLarge('operationId', OPERATION_ID_MAX_LENGTH, OPERATION_ID_MAX_LENGTH + 1)
    );
    expect(await errorOf(() => requireValidOperationId(''))).toEqual({ error: 'invalid_input' });
    expect(await errorOf(() => requireValidRevision('r'.repeat(REVISION_MAX_LENGTH + 1)))).toEqual(
      tooLarge('expectedRevision', REVISION_MAX_LENGTH, REVISION_MAX_LENGTH + 1)
    );
  });

  it('nombre de carpeta al crear y al renombrar (sin contar los espacios de los extremos)', async () => {
    test = await buildTestContext();
    const name = `  ${'c'.repeat(FOLDER_NAME_MAX_LENGTH + 1)}  `;
    expect(await errorOf(() => runCreateFolder(test!.ctx, { name }))).toEqual(
      tooLarge('name', FOLDER_NAME_MAX_LENGTH, FOLDER_NAME_MAX_LENGTH + 1)
    );
    expect(await errorOf(() => runRenameFolder(test!.ctx, { folderId: 'f', name }))).toEqual(
      tooLarge('name', FOLDER_NAME_MAX_LENGTH, FOLDER_NAME_MAX_LENGTH + 1)
    );
  });

  it('patrón de hebra_grep y patrón y sustitución de hebra_replace_in_notes', async () => {
    test = await buildTestContext();
    const pattern = 'p'.repeat(GREP_PATTERN_MAX_CHARS + 1);
    expect(await errorOf(() => runGrep(test!.ctx, { pattern }))).toEqual(
      tooLarge('pattern', GREP_PATTERN_MAX_CHARS, GREP_PATTERN_MAX_CHARS + 1)
    );
    expect(
      await errorOf(() => runReplaceInNotes(test!.ctx, { mode: 'simulate', pattern, replacement: 'x' }))
    ).toEqual(tooLarge('pattern', GREP_PATTERN_MAX_CHARS, GREP_PATTERN_MAX_CHARS + 1));
    const replacement = 'r'.repeat(REPLACEMENT_MAX_CHARS + 1);
    expect(
      await errorOf(() => runReplaceInNotes(test!.ctx, { mode: 'simulate', pattern: 'a', replacement }))
    ).toEqual(tooLarge('replacement', REPLACEMENT_MAX_CHARS, REPLACEMENT_MAX_CHARS + 1));
  });

  it('título de hebra_jd_new_id y nombres de hebra_jd_move', async () => {
    test = await buildTestContext();
    const title = 't'.repeat(JD_TITLE_MAX_LENGTH + 1);
    expect(await errorOf(() => runJdNewId(test!.ctx, { mode: 'simulate', category: '11', title }))).toEqual(
      tooLarge('title', JD_TITLE_MAX_LENGTH, JD_TITLE_MAX_LENGTH + 1)
    );
    const as = 'a'.repeat(JD_MOVE_NAME_MAX_LENGTH + 1);
    expect(
      await errorOf(() => runJdMove(test!.ctx, { mode: 'simulate', kind: 'note', id: 'n', toId: '11.01', as }))
    ).toEqual(tooLarge('as', JD_MOVE_NAME_MAX_LENGTH, JD_MOVE_NAME_MAX_LENGTH + 1));
  });
});
