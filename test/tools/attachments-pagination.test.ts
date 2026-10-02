import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { ATTACHMENT_PNG, ATTACHMENT_TEXT } from '../fixtures/test-library';
import { ToolContent, ToolError } from '../../src/server/errors';
import {
  ATTACHMENT_TEXT_MAX_CHARS,
  runListAttachments,
  runReadAttachment,
  textChunk
} from '../../src/server/tools/attachments';

/**
 * R3 (texto por tramos) y C5 (`hebra_list_attachments` paginada), sobre `attachmentsNoteId`
 * de la biblioteca de prueba (seis adjuntos; el de texto mide `ATTACHMENT_TEXT.length`).
 */
describe('hebra_list_attachments paginada', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('sin limit, todos y nextCursor null', async () => {
    test = await buildTestContext();
    const { attachments, nextCursor } = await runListAttachments(test.ctx, {
      id: test.library.attachmentsNoteId
    });
    expect(attachments).toHaveLength(6);
    expect(nextCursor).toBeNull();
  });

  it('con limit, recorrer por páginas da lo mismo que todos y acaba en null', async () => {
    test = await buildTestContext();
    const id = test.library.attachmentsNoteId;
    const all = (await runListAttachments(test.ctx, { id })).attachments;
    for (const limit of [1, 2, 4, 6, 200]) {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await runListAttachments(test.ctx, { id, limit, cursor });
        ids.push(...page.attachments.map((item) => item.attachmentId));
        if (page.nextCursor === null) break;
        expect(page.nextCursor).toMatch(/^a1\./u);
        expect(page.attachments).toHaveLength(limit);
        cursor = page.nextCursor;
      }
      expect(ids).toEqual(all.map((item) => item.attachmentId));
    }
  });

  it('el cursor de otra herramienta o con un adjunto que no es de la nota: invalid_input', async () => {
    test = await buildTestContext();
    const id = test.library.attachmentsNoteId;
    await expect(runListAttachments(test.ctx, { id, limit: 1, cursor: 'n1.abc' })).rejects.toBeInstanceOf(
      ToolError
    );
    const foreign = `a1.${Buffer.from('f'.repeat(64)).toString('base64url')}`;
    await expect(runListAttachments(test.ctx, { id, limit: 1, cursor: foreign })).rejects.toMatchObject({
      code: 'invalid_input'
    });
  });

  it('una nota oculta sigue dando not_found con limit', async () => {
    test = await buildTestContext();
    await expect(
      runListAttachments(test.ctx, { id: test.library.privateAttachmentNoteId, limit: 1 })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('hebra_read_attachment: texto por tramos', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  async function read(
    attachmentId: string,
    extra: { offset?: number; maxChars?: number } = {}
  ): Promise<{ meta: Record<string, unknown>; text: string; result: CallToolResult }> {
    const out = await runReadAttachment(test!.ctx, {
      id: test!.library.attachmentsNoteId,
      attachmentId,
      ...extra
    });
    expect(out).toBeInstanceOf(ToolContent);
    const result = (out as ToolContent).result;
    const meta = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    return { meta, text: (result.content[1] as { text: string }).text, result };
  }

  it('sin parámetros: el texto entero con totalChars, truncated false y nextOffset null', async () => {
    test = await buildTestContext();
    const { meta, text } = await read(test.library.attachments.text);
    expect(text).toBe(ATTACHMENT_TEXT);
    expect(meta).toMatchObject({
      mimeType: 'text/plain',
      byteLength: Buffer.byteLength(ATTACHMENT_TEXT),
      totalChars: ATTACHMENT_TEXT.length,
      truncated: false,
      nextOffset: null
    });
  });

  it('por tramos: encadenar nextOffset reconstruye el texto', async () => {
    test = await buildTestContext();
    let offset = 0;
    let rebuilt = '';
    for (let guard = 0; guard < 50; guard += 1) {
      const { meta, text } = await read(test.library.attachments.text, { offset, maxChars: 7 });
      expect(text.length).toBeLessThanOrEqual(7);
      rebuilt += text;
      expect(meta.totalChars).toBe(ATTACHMENT_TEXT.length);
      if (meta.nextOffset === null) {
        expect(meta.truncated).toBe(false);
        break;
      }
      expect(meta.truncated).toBe(true);
      offset = meta.nextOffset as number;
    }
    expect(rebuilt).toBe(ATTACHMENT_TEXT);
  });

  it('offset en el total o más allá: vacío, truncated false, nextOffset null', async () => {
    test = await buildTestContext();
    for (const offset of [ATTACHMENT_TEXT.length, ATTACHMENT_TEXT.length + 1000]) {
      const { meta, text } = await read(test.library.attachments.text, { offset });
      expect(text).toBe('');
      expect(meta).toMatchObject({
        totalChars: ATTACHMENT_TEXT.length,
        truncated: false,
        nextOffset: null
      });
    }
  });

  it('parámetros fuera de rango: invalid_input', async () => {
    test = await buildTestContext();
    for (const extra of [
      { offset: -1 },
      { offset: 1.5 },
      { maxChars: 0 },
      { maxChars: ATTACHMENT_TEXT_MAX_CHARS + 1 }
    ]) {
      await expect(read(test.library.attachments.text, extra)).rejects.toMatchObject({
        code: 'invalid_input'
      });
    }
  });

  it('imagen y PDF: offset y maxChars se ignoran y los metadatos no cambian', async () => {
    test = await buildTestContext();
    const { attachments, attachmentsNoteId: id } = test.library;
    const image = await runReadAttachment(test.ctx, {
      id,
      attachmentId: attachments.png,
      offset: 5,
      maxChars: 1
    });
    const result = (image as ToolContent).result;
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      id,
      attachmentId: attachments.png,
      name: 'foto.png',
      mimeType: 'image/png',
      byteLength: ATTACHMENT_PNG.length
    });
    expect(result.content[1]).toMatchObject({ type: 'image' });
  });
});

describe('textChunk: pares sustitutos', () => {
  const smile = '\u{1F600}'; // 2 unidades UTF-16
  const text = `ab${smile}cd`; // a b [H L] c d  → 6 unidades

  it('el corte en medio de un par retrocede un carácter', () => {
    expect(textChunk(text, 0, 3)).toEqual({ text: 'ab', nextOffset: 2 });
    expect(textChunk(text, 2, 10)).toEqual({ text: `${smile}cd`, nextOffset: null });
  });

  it('si no cabe ni un carácter, el par se incluye entero', () => {
    expect(textChunk(text, 2, 1)).toEqual({ text: smile, nextOffset: 4 });
  });

  it('un offset en medio de un par salta su mitad final', () => {
    expect(textChunk(text, 3, 10)).toEqual({ text: 'cd', nextOffset: null });
  });

  it('ningún tramo termina en una mitad suelta, con cualquier maxChars', () => {
    for (let maxChars = 1; maxChars <= 7; maxChars += 1) {
      let offset = 0;
      let rebuilt = '';
      for (let guard = 0; guard < 20; guard += 1) {
        const chunk = textChunk(text, offset, maxChars);
        rebuilt += chunk.text;
        expect(chunk.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
        if (chunk.nextOffset === null) break;
        offset = chunk.nextOffset;
      }
      expect(rebuilt).toBe(text);
    }
  });

  it('límites: texto vacío y offset pasado el final', () => {
    expect(textChunk('', 0, 5)).toEqual({ text: '', nextOffset: null });
    expect(textChunk(text, 99, 5)).toEqual({ text: '', nextOffset: null });
  });
});
