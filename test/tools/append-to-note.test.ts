import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveToolContext } from '../../src/server/context';
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
    const after = await test.ctx.port.noteRead(test.library.publicNote2Id);
    expect(after?.body).toBe(`${before?.body}${APPEND_SEPARATOR}Más texto.`);
    // D11: la prueba de lo guardado sale del cuerpo guardado.
    expect(result).toEqual({
      id: test.library.publicNote2Id,
      outcome: 'saved',
      revision: expect.stringMatching(/^r1\./),
      totalChars: after!.body.length,
      appended: { chars: 10, tail: 'Más texto.', line: (before!.body.match(/\n/g)?.length ?? 0) + 3 }
    });
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

  it('etiqueta privada en el texto añadido: not_found, sin escribir (decisión 4)', async () => {
    test = await buildTestContext();
    const before = await test.ctx.port.noteRead(test.library.publicNote2Id);
    for (const tag of ['#secreto', '#secreto/hija']) {
      await expect(
        runAppendToNote(test.ctx, { id: test.library.publicNote2Id, text: `${tag}\ncontenido oculto` })
      ).rejects.toMatchObject({ code: 'not_found' });
    }
    expect((await test.ctx.port.noteRead(test.library.publicNote2Id))?.body).toBe(before?.body);
  });

  it('el escritor lo comprueba dentro de la escritura, sin pasar por la herramienta', async () => {
    test = await buildTestContext();
    const privacy = test.serverContext.privacyConfig;
    await expect(
      test.ctx.write!.appendToNote({ id: test.library.privateTagNoteId, text: 'x', privacy })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      test.ctx.write!.appendToNote({ id: test.library.privateFolderNoteId, text: 'x', privacy })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('nota bloqueada: note_locked, sin escribir', async () => {
    test = await buildTestContext();
    const created = await test.ctx.port.noteCreate(null);
    const locked = 'hebra-locked:v1:no-es-un-envoltorio-valido';
    const db = new DatabaseSync(test.sqlitePath);
    db.prepare('UPDATE notes SET body = ? WHERE id = ?').run(locked, created.id);
    db.close();
    const ctx = await resolveToolContext(test.serverContext);
    await expect(runAppendToNote(ctx, { id: created.id, text: 'x' })).rejects.toMatchObject({
      code: 'note_locked'
    });
    expect((await test.ctx.port.noteRead(created.id))?.body).toBe(locked);
  });

  it('sin etiqueta privada: ni hidden ni copyId; la prueba de lo guardado (D11)', async () => {
    test = await buildTestContext();
    const result = await runAppendToNote(test.ctx, {
      id: test.library.publicNote2Id,
      text: 'texto normal'
    });
    expect(Object.keys(result).sort()).toEqual(['appended', 'id', 'outcome', 'revision', 'totalChars']);
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

/**
 * `operationId` opcional (10 oct 2026, ampliación de D2 y D11 por delegación de David,
 * tras el audit de robustez): la regresión es el duplicado que dejaba el reintento de un
 * append cuya respuesta se perdió (un despliegue, un SIGKILL del escritor).
 */
describe('hebra_append_to_note con operationId', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('el reintento con el mismo operationId no vuelve a añadir y devuelve la misma respuesta', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const before = (await test.ctx.port.noteRead(id))!.body;
    const input = { id, text: 'Decisión: una sola vez.', operationId: 'op-append-1' };
    const first = await runAppendToNote(test.ctx, input);
    const retry = await runAppendToNote(test.ctx, input);
    const after = (await test.ctx.port.noteRead(id))!.body;
    expect(after).toBe(`${before}${APPEND_SEPARATOR}Decisión: una sola vez.`);
    expect(first.replayed).toBeUndefined();
    expect(retry).toEqual({ ...first, replayed: true });
  });

  it('con apartado: el reintento tampoco duplica', async () => {
    test = await buildTestContext();
    const created = await test.ctx.write!.createNote({
      body: '# Decisiones\n\n## Abiertas\n\nuna\n\n## Cerradas\n\notra',
      privacy: test.ctx.privacyConfig
    });
    const ctx = await resolveToolContext(test.serverContext);
    const input = { id: created.id, text: 'nueva', heading: 'Abiertas', operationId: 'op-append-2' };
    const first = await runAppendToNote(ctx, input);
    const retry = await runAppendToNote(ctx, input);
    expect((await test.ctx.port.noteRead(created.id))?.body).toBe(
      '# Decisiones\n\n## Abiertas\n\nuna\n\nnueva\n\n## Cerradas\n\notra'
    );
    expect(retry).toEqual({ ...first, replayed: true });
  });

  it('sin operationId, cada llamada añade (comportamiento de siempre)', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    await runAppendToNote(test.ctx, { id, text: 'doble' });
    const second = await runAppendToNote(test.ctx, { id, text: 'doble' });
    expect(second.replayed).toBeUndefined();
    expect((await test.ctx.port.noteRead(id))!.body.split('doble').length - 1).toBe(2);
  });

  it('el mismo operationId con otro texto, otro apartado o el de una edición: operation_id_reused', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const first = await runAppendToNote(test.ctx, { id, text: 'uno', operationId: 'op-append-3' });
    // Comparten registro con la edición, con huella propia: un id de edición no vale aquí.
    await test.ctx.write!.editNote({
      id,
      edits: [{ find: 'uno', replace: 'UNO' }],
      expectedRevision: first.revision!,
      operationId: 'op-edit-x',
      privacy: test.ctx.privacyConfig
    });
    const before = (await test.ctx.port.noteRead(id))!.body;
    await expect(
      runAppendToNote(test.ctx, { id, text: 'dos', operationId: 'op-append-3' })
    ).rejects.toMatchObject({ code: 'operation_id_reused' });
    await expect(
      runAppendToNote(test.ctx, { id, text: 'uno', heading: 'x', operationId: 'op-append-3' })
    ).rejects.toMatchObject({ code: 'operation_id_reused' });
    await expect(
      runAppendToNote(test.ctx, { id, text: 'cuatro', operationId: 'op-edit-x' })
    ).rejects.toMatchObject({ code: 'operation_id_reused' });
    expect((await test.ctx.port.noteRead(id))!.body).toBe(before);
  });

  it('operationId vacío o de más de 200 caracteres: invalid_input, sin escribir', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const before = (await test.ctx.port.noteRead(id))!.body;
    await expect(runAppendToNote(test.ctx, { id, text: 'x', operationId: '' })).rejects.toMatchObject({
      code: 'invalid_input'
    });
    await expect(
      runAppendToNote(test.ctx, { id, text: 'x', operationId: 'o'.repeat(201) })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await test.ctx.port.noteRead(id))!.body).toBe(before);
  });
});
