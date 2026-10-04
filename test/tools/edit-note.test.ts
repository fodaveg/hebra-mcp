import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, openBusyWriteContext, type TestContext } from '../fixtures/test-context';
import { runAppendToNote } from '../../src/server/tools/append-to-note';
import { runEditNote } from '../../src/server/tools/edit-note';
import { runReadNote } from '../../src/server/tools/read-note';
import { ToolError } from '../../src/server/errors';
import { resolveToolContext } from '../../src/server/context';
import { deriveNote } from '../../src/hebra';

/**
 * `hebra_edit_note` (D2 ampliada, 28 sep 2026) sobre la biblioteca de prueba, sin sync
 * (`sync: "not_linked"`). La idempotencia tras un reinicio y el conflicto con otro
 * dispositivo van en `test/store/edit-idempotency.node.test.ts` y
 * `test/write-tools-sync.test.ts`.
 */

let counter = 0;
function opId(): string {
  counter += 1;
  return `op-${process.pid}-${counter}`;
}

describe('hebra_edit_note', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  async function read(id: string) {
    return runReadNote(test!.ctx, { id });
  }

  /** Cabecera de `publicNote2` (`test-library.ts`) antes de su párrafo. */
  const HEAD = '# Nota pública 2 de Lumbre\n#proyectos/lumbre\n';

  /** Pone `list` en lugar del párrafo de `publicNote2` y devuelve su id. */
  async function withList(list: string): Promise<string> {
    const id = test!.library.publicNote2Id;
    await runEditNote(test!.ctx, {
      id,
      edits: [{ find: 'Texto normal, sin enlaces.', replace: list }],
      expectedRevision: (await read(id)).revision,
      operationId: opId()
    });
    return id;
  }

  it('leer → editar → releer devuelve el cambio y una revisión nueva', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const before = await read(id);
    const result = await runEditNote(test.ctx, {
      id,
      edits: [
        { find: '# Nota pública 2 de Lumbre', replace: '# Nota renombrada' },
        { find: 'Texto normal', replace: 'Texto editado' }
      ],
      expectedRevision: before.revision,
      operationId: opId()
    });
    expect(result).toMatchObject({ id, outcome: 'saved', sync: 'not_linked' });
    expect(result.outcome === 'saved' && result.revision).not.toBe(before.revision);

    const after = await read(id);
    expect(after.title).toBe('Nota renombrada');
    expect(after.body).toBe(
      before.body.replace('# Nota pública 2 de Lumbre', '# Nota renombrada').replace('Texto normal', 'Texto editado')
    );
    expect(result.outcome === 'saved' && result.revision).toBe(after.revision);
  });

  it('revisión vieja: revision_conflict y la nota no cambia', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const stale = await read(id);
    await runAppendToNote(test.ctx, { id, text: 'cambio de otro' });
    const current = await read(id);
    await expect(
      runEditNote(test.ctx, {
        id,
        edits: [{ find: 'Texto normal', replace: 'PISADO' }],
        expectedRevision: stale.revision,
        operationId: opId()
      })
    ).rejects.toMatchObject({ code: 'revision_conflict' });
    expect((await read(id)).body).toBe(current.body);
  });

  it('find ausente o ambiguo: no escribe nada y dice qué sustitución falló', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const before = await read(id);
    const missing = await runEditNote(test.ctx, {
      id,
      edits: [
        { find: 'Texto normal', replace: 'x' },
        { find: 'no está en la nota', replace: 'y' }
      ],
      expectedRevision: before.revision,
      operationId: opId()
    }).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(ToolError);
    expect(missing).toMatchObject({ code: 'no_match', extra: { edit: 1 } });

    await expect(
      runEditNote(test.ctx, {
        id,
        // «e» aparece varias veces en el cuerpo.
        edits: [{ find: 'e', replace: 'x' }],
        expectedRevision: before.revision,
        operationId: opId()
      })
    ).rejects.toMatchObject({ code: 'ambiguous_match', extra: { edit: 0 } });

    const after = await read(id);
    expect(after.body).toBe(before.body);
    expect(after.revision).toBe(before.revision);
  });

  it('reintento con el mismo operationId: no duplica y devuelve lo mismo, marcado replayed', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const before = await read(id);
    const input = {
      id,
      edits: [{ find: 'Texto normal', replace: 'Texto normal y más' }],
      expectedRevision: before.revision,
      operationId: opId()
    };
    const first = await runEditNote(test.ctx, input);
    const again = await runEditNote(test.ctx, input);
    expect(first.replayed).toBeUndefined();
    expect(again).toMatchObject({ ...first, replayed: true });
    const after = await read(id);
    expect(after.body.match(/y más/g)).toHaveLength(1);
    expect(after.revision).toBe(first.outcome === 'saved' ? first.revision : '');

    await expect(
      runEditNote(test.ctx, { ...input, edits: [{ find: 'sin', replace: 'otra petición' }] })
    ).rejects.toMatchObject({ code: 'operation_id_reused' });
  });

  it('marcar 3 tareas las deja al final de su lista, como el editor de Hebra, en UN guardado', async () => {
    // David, 4 oct 2026: «el orden tiene que ser el mismo venga de donde venga el cambio».
    // El texto esperado es el que deja el editor marcándolas de arriba abajo (la paridad
    // editor/función la prueba Hebra: `notes/completed-tasks-to-end.test.ts`).
    test = await buildTestContext();
    const id = await withList(
      '\n- [ ] Uno\n- [ ] Dos\n  - [ ] Dos.a\n- [ ] Tres\n- [ ] Cuatro\n- [x] Ya hecha\n\nFin'
    );
    const before = await read(id);
    const localSeq = (): number => {
      const db = new DatabaseSync(test!.sqlitePath, { readOnly: true });
      try {
        return (db.prepare('SELECT local_seq FROM notes WHERE id = ?').get(id) as { local_seq: number })
          .local_seq;
      } finally {
        db.close();
      }
    };
    const seqBefore = localSeq();
    const input = {
      id,
      edits: [
        { find: '- [ ] Uno', replace: '- [x] Uno' },
        { find: '- [ ] Dos\n', replace: '- [x] Dos\n' },
        { find: '- [ ] Cuatro', replace: '- [x] Cuatro' }
      ],
      expectedRevision: before.revision,
      operationId: opId()
    };
    const result = await runEditNote(test.ctx, input);

    const after = await read(id);
    expect(after.body).toBe(
      `${HEAD}\n- [ ] Tres\n- [x] Ya hecha\n- [x] Uno\n- [x] Dos\n  - [ ] Dos.a\n- [x] Cuatro\n\nFin\n`
    );
    expect(result.outcome === 'saved' && result.revision).toBe(after.revision);
    // Una sola escritura: el reordenado no es un segundo guardado.
    expect(localSeq()).toBe(seqBefore + 1);
    // El registro de idempotencia guarda el SHA del cuerpo REORDENADO: reintentar no escribe.
    expect(await runEditNote(test.ctx, input)).toMatchObject({ ...result, replayed: true });
    expect(localSeq()).toBe(seqBefore + 1);
  });

  it('desmarcar o editar sin marcar no mueve nada', async () => {
    test = await buildTestContext();
    const id = await withList('\n- [x] Hecha\n- [ ] Pendiente\n- [x] Otra hecha');
    const before = await read(id);
    await runEditNote(test.ctx, {
      id,
      edits: [
        { find: '- [x] Hecha', replace: '- [ ] Hecha' },
        { find: 'Pendiente', replace: 'Pendiente editada' }
      ],
      expectedRevision: before.revision,
      operationId: opId()
    });
    expect((await read(id)).body).toBe(`${HEAD}\n- [ ] Hecha\n- [ ] Pendiente editada\n- [x] Otra hecha\n`);
  });

  it('guarda los derivados completos del cuerpo editado (tareas, etiquetas, título)', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const before = await read(id);
    await runEditNote(test.ctx, {
      id,
      edits: [{ find: 'Texto normal, sin enlaces.', replace: '- [ ] tarea nueva #hecho/pronto' }],
      expectedRevision: before.revision,
      operationId: opId()
    });
    const body = (await read(id)).body;
    const expected = deriveNote(body);
    const db = new DatabaseSync(test.sqlitePath, { readOnly: true });
    try {
      const tasks = db.prepare('SELECT line, text FROM note_tasks WHERE note_id = ?').all(id);
      expect(tasks).toEqual((expected.tasks ?? []).map(({ line, text }) => ({ line, text })));
      expect(tasks).toHaveLength(1);
      const note = db.prepare('SELECT has_open_tasks, title_sort FROM notes WHERE id = ?').get(id) as {
        has_open_tasks: number;
        title_sort: string;
      };
      expect(note).toEqual({ has_open_tasks: 1, title_sort: expected.titleSort });
      const tags = (db.prepare('SELECT tag FROM note_tags WHERE note_id = ?').all(id) as Array<{ tag: string }>)
        .map((row) => row.tag)
        .sort();
      expect(tags).toEqual((expected.tags ?? []).map(({ tag }) => tag).sort());
    } finally {
      db.close();
    }
  });

  it('notas ocultas, en la papelera o inexistentes: not_found, las tres igual', async () => {
    test = await buildTestContext();
    const { revision } = await read(test.library.publicNote2Id);
    for (const id of [
      test.library.privateFolderNoteId,
      test.library.privateTagNoteId,
      test.library.trashedNoteId,
      'no-existe'
    ]) {
      const error = await runEditNote(test.ctx, {
        id,
        edits: [{ find: 'contenido', replace: 'x' }],
        expectedRevision: revision,
        operationId: opId()
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe('not_found');
      expect((error as ToolError).extra).toBeUndefined();
    }
  });

  it('una edición que pondría una etiqueta privada se rechaza como not_found, sin escribir', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const before = await read(id);
    for (const tag of ['#secreto', '#secreto/hija']) {
      await expect(
        runEditNote(test.ctx, {
          id,
          edits: [{ find: 'Texto normal', replace: `Texto normal ${tag}` }],
          expectedRevision: before.revision,
          operationId: opId()
        })
      ).rejects.toMatchObject({ code: 'not_found' });
    }
    expect((await read(id)).body).toBe(before.body);
  });

  it('nota bloqueada: note_locked, sin escribir', async () => {
    test = await buildTestContext();
    const port = test.ctx.port;
    const created = await port.noteCreate(null);
    const locked = 'hebra-locked:v1:no-es-un-envoltorio-valido';
    // Un envoltorio de verdad solo lo escribe la app; aquí basta con que el cuerpo
    // empiece por la marca (la comprobación de hebra-mcp va antes que la del motor).
    const db = new DatabaseSync(test.sqlitePath);
    db.prepare('UPDATE notes SET body = ? WHERE id = ?').run(locked, created.id);
    db.close();
    // El filtro de `test.ctx` es de antes de crear la nota: uno recién calculado.
    const ctx = await resolveToolContext(test.serverContext);
    const note = await runReadNote(ctx, { id: created.id });
    await expect(
      runEditNote(ctx, {
        id: created.id,
        edits: [{ find: 'no-es', replace: 'si-es' }],
        expectedRevision: note.revision,
        operationId: opId()
      })
    ).rejects.toMatchObject({ code: 'note_locked' });
    expect((await runReadNote(ctx, { id: created.id })).body).toBe(locked);
  });

  it('revisión de otra nota o ilegible: invalid_input', async () => {
    test = await buildTestContext();
    const other = await read(test.library.linkingNoteId);
    for (const expectedRevision of [other.revision, 'no-es-una-revision']) {
      await expect(
        runEditNote(test.ctx, {
          id: test.library.publicNote2Id,
          edits: [{ find: 'Texto normal', replace: 'x' }],
          expectedRevision,
          operationId: opId()
        })
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });

  it('límites: sin sustituciones, find vacío o demasiado texto, invalid_input sin tocar la nota', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const before = await read(id);
    for (const edits of [
      [],
      [{ find: '', replace: 'x' }],
      [{ find: 'Texto normal', replace: 'x'.repeat(100_000) }]
    ]) {
      await expect(
        runEditNote(test.ctx, { id, edits, expectedRevision: before.revision, operationId: opId() })
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(
      runEditNote(test.ctx, {
        id,
        edits: [{ find: 'Texto normal', replace: 'x' }],
        expectedRevision: before.revision,
        operationId: ''
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await read(id)).body).toBe(before.body);
  });

  it('otra instancia tiene el bloqueo: busy_other_instance', async () => {
    test = await buildTestContext();
    const busy = await openBusyWriteContext(test);
    const before = await read(test.library.publicNote2Id);
    try {
      await expect(
        runEditNote(
          { ...test.ctx, write: busy.write },
          {
            id: test.library.publicNote2Id,
            edits: [{ find: 'Texto normal', replace: 'x' }],
            expectedRevision: before.revision,
            operationId: opId()
          }
        )
      ).rejects.toMatchObject({ code: 'busy_other_instance' });
    } finally {
      busy.close();
    }
  });
});
