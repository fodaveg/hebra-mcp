import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, openBusyWriteContext, type TestContext } from '../fixtures/test-context';
import { runAppendToNote } from '../../src/server/tools/append-to-note';
import { APPEND_SEPARATOR } from '../../src/store/writes';

describe('hebra_append_to_note', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('añade al final, con la forma de SPEC.md §5', async () => {
    test = await buildTestContext();
    const before = await test.ctx.port.noteRead(test.library.publicNote2Id);
    const result = await runAppendToNote(test.ctx, {
      id: test.library.publicNote2Id,
      text: 'Más texto.'
    });
    expect(result).toEqual({ id: test.library.publicNote2Id, outcome: 'saved' });
    const after = await test.ctx.port.noteRead(test.library.publicNote2Id);
    expect(after?.body).toBe(`${before?.body}${APPEND_SEPARATOR}Más texto.`);
  });

  it('texto por encima de 20 000 caracteres: invalid_input, sin tocar la nota', async () => {
    test = await buildTestContext();
    const before = await test.ctx.port.noteRead(test.library.publicNote2Id);
    await expect(
      runAppendToNote(test.ctx, { id: test.library.publicNote2Id, text: 'x'.repeat(20_001) })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const after = await test.ctx.port.noteRead(test.library.publicNote2Id);
    expect(after?.body).toBe(before?.body);
  });

  it('id inexistente: not_found', async () => {
    test = await buildTestContext();
    await expect(runAppendToNote(test.ctx, { id: 'no-existe', text: 'x' })).rejects.toMatchObject({
      code: 'not_found'
    });
  });

  it('nota en la papelera: not_found', async () => {
    test = await buildTestContext();
    await expect(
      runAppendToNote(test.ctx, { id: test.library.trashedNoteId, text: 'x' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('nota de carpeta privada: not_found', async () => {
    test = await buildTestContext();
    await expect(
      runAppendToNote(test.ctx, { id: test.library.privateFolderNoteId, text: 'x' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('nota de etiqueta privada (descendiente): not_found', async () => {
    test = await buildTestContext();
    await expect(
      runAppendToNote(test.ctx, { id: test.library.privateTagNoteId, text: 'x' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('etiqueta privada en el texto añadido: hidden true', async () => {
    test = await buildTestContext();
    const result = await runAppendToNote(test.ctx, {
      id: test.library.publicNote2Id,
      text: '#secreto\ncontenido oculto'
    });
    expect(result.outcome).toBe('saved');
    expect(result.hidden).toBe(true);
  });

  it('sin etiqueta privada: hidden ausente', async () => {
    test = await buildTestContext();
    const result = await runAppendToNote(test.ctx, {
      id: test.library.publicNote2Id,
      text: 'texto normal'
    });
    expect(result.hidden).toBeUndefined();
  });

  it('otra instancia tiene el bloqueo: busy_other_instance', async () => {
    test = await buildTestContext();
    const busy = await openBusyWriteContext(test);
    try {
      await expect(
        runAppendToNote(
          { ...test.ctx, write: busy.write },
          { id: test.library.publicNote2Id, text: 'x' }
        )
      ).rejects.toMatchObject({ code: 'busy_other_instance' });
    } finally {
      busy.close();
    }
  });
});
