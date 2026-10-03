/**
 * `hebra_add_attachment` (D9, decisión de David del 3 oct 2026) sobre la biblioteca de
 * prueba, sin sync: validaciones, privacidad, idempotencia por `operationId` y que lo
 * añadido se lista y se lee con las herramientas de lectura. Que el blob SUBA al relé y
 * otro dispositivo lo lea, y la copia de conflicto, van en `test/write-tools-sync.test.ts`;
 * que lo haga un lector por `writer.sock`, en `test/forward/forward.test.ts`.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveToolContext, type ToolContext } from '../../src/server/context';
import { ToolContent, ToolError } from '../../src/server/errors';
import { runAddAttachment } from '../../src/server/tools/add-attachment';
import {
  ATTACHMENT_MAX_BYTES,
  runListAttachments,
  runReadAttachment
} from '../../src/server/tools/attachments';
import { encodeRevision } from '../../src/store/revision';
import { buildTestContext, openBusyWriteContext, type TestContext } from '../fixtures/test-context';

/** Un PNG de verdad (1×1, transparente). */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'));
const PNG_SHA = createHash('sha256').update(PNG).digest('hex');

describe('hebra_add_attachment (D9)', () => {
  let test: TestContext | undefined;
  const closers: Array<() => void> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) close();
    await test?.close();
    test = undefined;
  });

  function fresh(): Promise<ToolContext> {
    return resolveToolContext(test!.serverContext);
  }

  async function expectCode(promise: Promise<unknown>, code: string): Promise<ToolError> {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe(code);
    return error as ToolError;
  }

  async function body(id: string): Promise<string> {
    return (await test!.ctx.port.noteRead(id))!.body;
  }

  it('un PNG pequeño: queda al final del cuerpo, se lista y se lee idéntico', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const before = await body(id);
    const result = await runAddAttachment(await fresh(), {
      id,
      name: ' captura.png ',
      dataBase64: PNG_BASE64,
      operationId: 'op-png-1'
    });
    const markdown = `![[sha256:${PNG_SHA}|captura.png]]`;
    expect(result).toEqual({
      id,
      outcome: 'saved',
      revision: expect.any(String),
      sync: 'not_linked',
      attachmentId: PNG_SHA,
      markdown
    });
    expect(await body(id)).toBe(`${before}\n\n${markdown}`);

    const listed = await runListAttachments(await fresh(), { id });
    expect(listed.attachments).toEqual([
      { attachmentId: PNG_SHA, name: 'captura.png', mimeType: 'image/png', byteLength: PNG.length }
    ]);

    const read = await runReadAttachment(await fresh(), { id, attachmentId: PNG_SHA });
    expect(read).toBeInstanceOf(ToolContent);
    const content = (read as ToolContent).result.content as CallToolResult['content'];
    expect(JSON.parse((content[0] as { text: string }).text)).toEqual({
      id,
      attachmentId: PNG_SHA,
      name: 'captura.png',
      mimeType: 'image/png',
      byteLength: PNG.length
    });
    expect(content[1]).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });

    // La revisión devuelta es la de la nota tras añadir: vale para editarla.
    const note = await test.ctx.port.noteRead(id);
    expect(result.outcome === 'saved' && result.revision).toBeTruthy();
    expect(note?.localSeq).toBeGreaterThan(0);
  });

  it('texto y Markdown por tipo declarado o extensión; base64 partido en líneas', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const text = 'línea 1\nlínea 2\n';
    const wrapped = Buffer.from(text).toString('base64').replace(/(.{4})/g, '$1\n');
    const byExtension = await runAddAttachment(await fresh(), {
      id,
      name: 'notas.md',
      dataBase64: wrapped,
      operationId: 'op-md'
    });
    const byType = await runAddAttachment(await fresh(), {
      id,
      name: 'notas',
      dataBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
      mimeType: 'text/csv',
      operationId: 'op-csv'
    });
    const read = (await runReadAttachment(await fresh(), {
      id,
      attachmentId: byExtension.attachmentId
    })) as ToolContent;
    expect((read.result.content[1] as { text: string }).text).toBe(text);
    const listed = await runListAttachments(await fresh(), { id });
    expect(listed.attachments.map((item) => item.mimeType)).toEqual(['text/markdown', 'text/csv']);
    expect(byType.markdown).toBe(`![[sha256:${byType.attachmentId}|notas]]`);
  });

  it('tipo no permitido: attachment_type_not_allowed, sin escribir nada', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const before = await body(id);
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]).toString('base64');
    await expectCode(
      runAddAttachment(await fresh(), { id, name: 'a.zip', dataBase64: zip, operationId: 'op-zip' }),
      'attachment_type_not_allowed'
    );
    // Un texto que dice ser PNG: los bytes mandan.
    const fake = await expectCode(
      runAddAttachment(await fresh(), {
        id,
        name: 'falsa.png',
        dataBase64: Buffer.from('no soy una imagen').toString('base64'),
        mimeType: 'image/png',
        operationId: 'op-fake'
      }),
      'attachment_type_not_allowed'
    );
    expect(fake.extra).toEqual({ mimeType: 'image/png' });
    // Binario sin tipo ni extensión de texto.
    await expectCode(
      runAddAttachment(await fresh(), {
        id,
        name: 'datos.bin',
        dataBase64: Buffer.from([0x00, 0x01, 0x02]).toString('base64'),
        operationId: 'op-bin'
      }),
      'attachment_type_not_allowed'
    );
    expect(await body(id)).toBe(before);
  });

  it('más de 5 MiB: attachment_too_large con el tamaño; justo 5 MiB, sí', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const before = await body(id);
    const tooBig = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61).toString('base64');
    const error = await expectCode(
      runAddAttachment(await fresh(), { id, name: 'grande.txt', dataBase64: tooBig, operationId: 'op-big' }),
      'attachment_too_large'
    );
    expect(error.extra).toEqual({ byteLength: ATTACHMENT_MAX_BYTES + 1, maxBytes: ATTACHMENT_MAX_BYTES });
    expect(await body(id)).toBe(before);

    const exact = Buffer.alloc(ATTACHMENT_MAX_BYTES, 0x61).toString('base64');
    const ok = await runAddAttachment(await fresh(), {
      id,
      name: 'justo.txt',
      dataBase64: exact,
      operationId: 'op-exact'
    });
    expect(ok.outcome).toBe('saved');
    expect((await runListAttachments(await fresh(), { id })).attachments[0]?.byteLength).toBe(
      ATTACHMENT_MAX_BYTES
    );
  });

  it('base64 mal formado, nombre que no vale u operationId vacío: invalid_input', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const before = await body(id);
    for (const dataBase64 of ['', '   ', 'no es base64!!', 'YQ=', 'YQ==YQ==', 'YR==', 'YQ-_']) {
      await expectCode(
        runAddAttachment(await fresh(), { id, name: 'a.txt', dataBase64, operationId: 'op-b64' }),
        'invalid_input'
      );
    }
    for (const name of ['', '  ', 'a|b.png', '[a].png', 'a]b.png', 'a\\b.png', '#a.png', 'a\nb.png', 'x'.repeat(256)]) {
      await expectCode(
        runAddAttachment(await fresh(), { id, name, dataBase64: PNG_BASE64, operationId: 'op-name' }),
        'invalid_input'
      );
    }
    await expectCode(
      runAddAttachment(await fresh(), { id, name: 'a.png', dataBase64: PNG_BASE64, operationId: '' }),
      'invalid_input'
    );
    expect(await body(id)).toBe(before);
  });

  it('nota oculta, en la papelera o inexistente: not_found, igual en todos los casos y sin guardar el blob', async () => {
    test = await buildTestContext();
    const responses = new Set<string>();
    for (const id of [
      test.library.privateFolderNoteId,
      test.library.privateTagNoteId,
      test.library.trashedNoteId,
      'no-existe'
    ]) {
      const error = await expectCode(
        runAddAttachment(await fresh(), { id, name: 'a.png', dataBase64: PNG_BASE64, operationId: `op-${id}` }),
        'not_found'
      );
      responses.add(JSON.stringify({ code: error.code, extra: error.extra ?? null }));
    }
    expect(responses.size).toBe(1);
    expect(await test.ctx.port.blobRead(PNG_SHA)).toBeNull();
    // El escritor lo rechaza igual aunque la petición no pase por la herramienta.
    await expect(
      test.ctx.write!.addAttachment({
        id: test.library.privateFolderNoteId,
        name: 'a.png',
        bytes: PNG,
        mimeType: null,
        operationId: 'op-directo',
        privacy: test.ctx.privacyConfig
      })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await test.ctx.port.blobRead(PNG_SHA)).toBeNull();
  });

  it('el escritor revalida tamaño, tipo y nombre aunque no pase por la herramienta', async () => {
    test = await buildTestContext();
    const base = {
      id: test.library.publicNote2Id,
      mimeType: null,
      operationId: 'op-w',
      privacy: test.ctx.privacyConfig
    };
    const write = test.ctx.write!;
    await expect(
      write.addAttachment({ ...base, name: 'a.zip', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) })
    ).rejects.toMatchObject({ code: 'attachment_type_not_allowed' });
    await expect(
      write.addAttachment({ ...base, name: 'g.txt', bytes: new Uint8Array(ATTACHMENT_MAX_BYTES + 1).fill(0x61) })
    ).rejects.toMatchObject({ code: 'attachment_too_large' });
    await expect(write.addAttachment({ ...base, name: 'a|b.png', bytes: PNG })).rejects.toMatchObject({
      code: 'invalid_input'
    });
  });

  it('nota bloqueada: note_locked, sin escribir', async () => {
    test = await buildTestContext();
    const created = await test.ctx.port.noteCreate(null);
    const locked = 'hebra-locked:v1:no-es-un-envoltorio-valido';
    const db = new DatabaseSync(test.sqlitePath);
    db.prepare('UPDATE notes SET body = ? WHERE id = ?').run(locked, created.id);
    db.close();
    await expectCode(
      runAddAttachment(await fresh(), {
        id: created.id,
        name: 'a.png',
        dataBase64: PNG_BASE64,
        operationId: 'op-locked'
      }),
      'note_locked'
    );
    expect(await body(created.id)).toBe(locked);
  });

  it('reintento con el mismo operationId: replayed, sin duplicar la referencia; con otra petición, operation_id_reused', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const input = { id, name: 'captura.png', dataBase64: PNG_BASE64, operationId: 'op-retry' };
    const first = await runAddAttachment(await fresh(), input);
    const after = await body(id);
    const again = await runAddAttachment(await fresh(), input);
    expect(again).toEqual({ ...first, replayed: true });
    expect(await body(id)).toBe(after);
    expect(after.split(first.markdown)).toHaveLength(2);

    await expectCode(
      runAddAttachment(await fresh(), { ...input, name: 'otra.png' }),
      'operation_id_reused'
    );
    // Un `operationId` de una edición no vale para añadir un adjunto.
    const read = await test.ctx.port.noteRead(id);
    await test.ctx.write!.editNote({
      id,
      edits: [{ find: 'Texto normal', replace: 'Texto' }],
      expectedRevision: encodeRevision({
        libraryId: await test.ctx.port.libraryId(),
        noteId: id,
        localSeq: read!.localSeq,
        bodySha256: read!.bodySha256
      }),
      operationId: 'op-edicion',
      privacy: test.ctx.privacyConfig
    });
    await expectCode(
      runAddAttachment(await fresh(), { ...input, operationId: 'op-edicion' }),
      'operation_id_reused'
    );
  });

  it('registro a medias (started) y la nota ya cambiada después: no vuelve a añadir la referencia', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const input = { id, name: 'captura.png', dataBase64: PNG_BASE64, operationId: 'op-medias' };
    const first = await runAddAttachment(await fresh(), input);
    // Como si el proceso hubiera muerto entre `noteSave` y `finish`…
    const db = new DatabaseSync(test.sqlitePath);
    db.prepare(
      "UPDATE hebra_mcp_operations SET state = 'started', result = NULL WHERE operation_id = ?"
    ).run(input.operationId);
    db.close();
    // …y otra escritura hubiera cambiado la nota antes del reintento (el SHA-256 del
    // cuerpo ya no es el que se guardó).
    await test.ctx.write!.appendToNote({ id, text: 'texto de después', privacy: test.ctx.privacyConfig });
    const changed = await body(id);

    const again = await runAddAttachment(await fresh(), input);
    expect(again).toMatchObject({ outcome: 'saved', replayed: true, attachmentId: PNG_SHA });
    expect(await body(id)).toBe(changed);
    expect(changed.split(first.markdown)).toHaveLength(2);
    // Y el registro quedó cerrado: el siguiente reintento sale del registro.
    const third = await runAddAttachment(await fresh(), input);
    expect(third).toMatchObject({ outcome: 'saved', replayed: true });
    expect(await body(id)).toBe(changed);
  });

  it('nota que termina dentro de un bloque de código sin cerrar: lo cierra y la referencia cuenta como adjunto', async () => {
    test = await buildTestContext();
    for (const [fence, operationId] of [
      ['```', 'op-fence-1'],
      ['~~~~', 'op-fence-2']
    ] as const) {
      const created = await test.ctx.write!.createNote({
        body: `# Con código\n\n${fence}js\nconst a = 1;`,
        privacy: test.ctx.privacyConfig
      });
      const result = await runAddAttachment(await fresh(), {
        id: created.id,
        name: 'captura.png',
        dataBase64: PNG_BASE64,
        operationId
      });
      expect(await body(created.id)).toBe(
        `# Con código\n\n${fence}js\nconst a = 1;\n${fence}\n\n${result.markdown}`
      );
      expect((await runListAttachments(await fresh(), { id: created.id })).attachments).toEqual([
        { attachmentId: PNG_SHA, name: 'captura.png', mimeType: 'image/png', byteLength: PNG.length }
      ]);
    }
    // Un bloque ya cerrado no se toca.
    const closed = await test.ctx.write!.createNote({
      body: '# Cerrado\n\n```\nx\n```',
      privacy: test.ctx.privacyConfig
    });
    const plain = await runAddAttachment(await fresh(), {
      id: closed.id,
      name: 'captura.png',
      dataBase64: PNG_BASE64,
      operationId: 'op-fence-3'
    });
    expect(await body(closed.id)).toBe(`# Cerrado\n\n\`\`\`\nx\n\`\`\`\n\n${plain.markdown}`);
  });

  it('nota que termina en otra construcción sin cerrar (un comentario HTML): invalid_input, sin guardar el blob', async () => {
    test = await buildTestContext();
    const created = await test.ctx.write!.createNote({
      body: '# Comentario\n\n<!--\nnota a medias',
      privacy: test.ctx.privacyConfig
    });
    const before = await body(created.id);
    await expectCode(
      runAddAttachment(await fresh(), {
        id: created.id,
        name: 'captura.png',
        dataBase64: PNG_BASE64,
        operationId: 'op-html'
      }),
      'invalid_input'
    );
    expect(await body(created.id)).toBe(before);
    expect(await test.ctx.port.blobRead(PNG_SHA)).toBeNull();
  });

  it('nombres con caracteres de formato invisibles (Unicode Cf): invalid_input', async () => {
    test = await buildTestContext();
    const id = test.library.publicNote2Id;
    const before = await body(id);
    for (const code of [0x200b, 0x202e, 0xfeff, 0x00ad, 0x2066]) {
      await expectCode(
        runAddAttachment(await fresh(), {
          id,
          name: `cap${String.fromCharCode(code)}tura.png`,
          dataBase64: PNG_BASE64,
          operationId: `op-cf-${code}`
        }),
        'invalid_input'
      );
    }
    expect(await body(id)).toBe(before);
  });

  it('otra instancia en solo lectura sin escritor: busy_other_instance', async () => {
    test = await buildTestContext();
    const busy = await openBusyWriteContext(test);
    closers.push(() => busy.close());
    const ctx: ToolContext = { ...(await fresh()), write: busy.write };
    await expectCode(
      runAddAttachment(ctx, {
        id: test.library.publicNote2Id,
        name: 'a.png',
        dataBase64: PNG_BASE64,
        operationId: 'op-busy'
      }),
      'busy_other_instance'
    );
  });
});
