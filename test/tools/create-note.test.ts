import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, openBusyWriteContext, type TestContext } from '../fixtures/test-context';
import { runCreateNote } from '../../src/server/tools/create-note';

describe('hebra_create_note', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('crea en la raíz por defecto, con la forma de SPEC.md §5', async () => {
    test = await buildTestContext();
    const body = '# Nota nueva\nContenido.\n';
    const result = await runCreateNote(test.ctx, { body });
    expect(result.title).toBe('Nota nueva');
    expect(result.folderPath).toBe('');
    expect(result.hidden).toBeUndefined();
    expect(typeof result.id).toBe('string');

    const note = await test.ctx.port.noteRead(result.id);
    expect(note?.body).toBe(body);
  });

  it('crea en una carpeta existente por ruta', async () => {
    test = await buildTestContext();
    const result = await runCreateNote(test.ctx, { body: '# En Lumbre\n', folder: 'Proyectos/Lumbre' });
    expect(result.folderPath).toBe('proyectos/lumbre');
    const note = await test.ctx.port.noteRead(result.id);
    expect(note?.folderId).toBe(test.ctx.privacy.folderIdForPath('Proyectos/Lumbre'));
  });

  it('cuerpo por encima de 100 000 caracteres: invalid_input, sin tocar el almacén', async () => {
    test = await buildTestContext();
    const before = (await test.ctx.port.notesPage(null, 200, { kind: 'all' })).items.length;
    await expect(runCreateNote(test.ctx, { body: 'x'.repeat(100_001) })).rejects.toMatchObject({
      code: 'invalid_input'
    });
    const after = (await test.ctx.port.notesPage(null, 200, { kind: 'all' })).items.length;
    expect(after).toBe(before);
  });

  it('carpeta que no existe: not_found', async () => {
    test = await buildTestContext();
    await expect(runCreateNote(test.ctx, { body: '# Nota', folder: 'no-existe' })).rejects.toMatchObject({
      code: 'not_found'
    });
  });

  it('carpeta privada: not_found, como si no existiera', async () => {
    test = await buildTestContext();
    await expect(runCreateNote(test.ctx, { body: '# Nota', folder: 'Diario' })).rejects.toMatchObject({
      code: 'not_found'
    });
  });

  it('etiqueta privada en el cuerpo: hidden true', async () => {
    test = await buildTestContext();
    const result = await runCreateNote(test.ctx, { body: '# Nota secreta\n#secreto\nContenido.\n' });
    expect(result.hidden).toBe(true);
  });

  it('sin etiqueta privada: hidden ausente (nunca false explícito)', async () => {
    test = await buildTestContext();
    const result = await runCreateNote(test.ctx, { body: '# Nota pública\nContenido.\n' });
    expect(result.hidden).toBeUndefined();
  });

  it('otra instancia tiene el bloqueo: busy_other_instance', async () => {
    test = await buildTestContext();
    const busy = await openBusyWriteContext(test);
    try {
      await expect(
        runCreateNote({ ...test.ctx, write: busy.write }, { body: '# Nota' })
      ).rejects.toMatchObject({ code: 'busy_other_instance' });
    } finally {
      busy.close();
    }
  });
});
