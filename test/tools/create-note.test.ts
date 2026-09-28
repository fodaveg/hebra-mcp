import { DatabaseSync } from 'node:sqlite';
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
    expect(Object.keys(result).sort()).toEqual(['folderPath', 'id', 'title']);
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

  it('etiqueta privada (o descendiente) en el cuerpo: not_found, sin crear nada (decisión 4)', async () => {
    test = await buildTestContext();
    const before = (await test.ctx.port.notesPage(null, 200, { kind: 'all' })).items.length;
    for (const tag of ['#secreto', '#secreto/hija']) {
      await expect(
        runCreateNote(test.ctx, { body: `# Nota secreta\n${tag}\nContenido.\n` })
      ).rejects.toMatchObject({ code: 'not_found' });
    }
    const after = (await test.ctx.port.notesPage(null, 200, { kind: 'all' })).items.length;
    expect(after).toBe(before);
  });

  it('cuerpo que empieza por la marca de bloqueo: invalid_input y ninguna fila nueva', async () => {
    test = await buildTestContext();
    const count = (): number => {
      const db = new DatabaseSync(test!.sqlitePath, { readOnly: true });
      try {
        return Number((db.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number }).n);
      } finally {
        db.close();
      }
    };
    const before = count();
    for (const body of ['hebra-locked:x', 'hebra-locked:v1:{"title":"x"}\nbasura']) {
      await expect(runCreateNote(test.ctx, { body })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(count()).toBe(before);
  });

  it('el escritor lo comprueba dentro de la escritura, sin pasar por la herramienta', async () => {
    test = await buildTestContext();
    const privacy = test.serverContext.privacyConfig;
    const diario = test.ctx.privacy.folderIdForPath('diario');
    await expect(
      test.ctx.write!.createNote({ body: '# En Diario', folderId: diario, privacy })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      test.ctx.write!.createNote({ body: '# Etiquetada\n#secreto', privacy })
    ).rejects.toMatchObject({ code: 'not_found' });
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
