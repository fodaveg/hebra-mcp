import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import {
  ATTACHMENT_BIG_BYTES,
  ATTACHMENT_PDF,
  ATTACHMENT_PNG,
  ATTACHMENT_TEXT,
  BAIT_ATTACHMENT,
  BAIT_FOLDER
} from '../fixtures/test-library';
import { resolveToolContext, type ToolContext } from '../../src/server/context';
import { ToolContent, ToolError } from '../../src/server/errors';
import { registerTools } from '../../src/server/register-tools';
import {
  ATTACHMENT_MAX_BYTES,
  detectAttachmentType,
  runListAttachments,
  runReadAttachment
} from '../../src/server/tools/attachments';

/**
 * Adjuntos en solo lectura (ampliación de D2, decisión de David del 30 sep 2026) sobre la
 * biblioteca de prueba, sin sync: `attachmentsNoteId` (carpeta `Adjuntos`) adjunta un
 * PNG, un texto, un PDF, uno de 5 MiB + 1 sin bytes, un ZIP y uno que nadie tiene; en
 * `Diario/2026` (privada) hay otra con un adjunto cebo. Bajar del relé, con dos
 * dispositivos, va en `test/write-tools-sync.test.ts`.
 */

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

describe('adjuntos en solo lectura', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
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

  async function read(attachmentId: string): Promise<CallToolResult> {
    const result = await runReadAttachment(await fresh(), {
      id: test!.library.attachmentsNoteId,
      attachmentId
    });
    expect(result).toBeInstanceOf(ToolContent);
    return (result as ToolContent).result;
  }

  it('hebra_list_attachments: en el orden del cuerpo, con nombre, tipo y tamaño cuando se saben', async () => {
    test = await buildTestContext();
    const { attachmentsNoteId: id, attachments } = test.library;
    const { attachments: listed } = await runListAttachments(await fresh(), { id });
    expect(listed).toEqual([
      { attachmentId: attachments.png, name: 'foto.png', mimeType: 'image/png', byteLength: ATTACHMENT_PNG.length },
      {
        attachmentId: attachments.text,
        name: `${BAIT_ATTACHMENT}.txt`,
        mimeType: 'text/plain',
        byteLength: Buffer.byteLength(ATTACHMENT_TEXT)
      },
      { attachmentId: attachments.pdf, name: 'plano.pdf', mimeType: 'application/pdf', byteLength: ATTACHMENT_PDF.length },
      { attachmentId: attachments.big, name: 'grande.png', mimeType: 'image/png', byteLength: ATTACHMENT_BIG_BYTES },
      { attachmentId: attachments.zip, name: 'comprimido.zip', mimeType: 'application/zip', byteLength: 8 },
      // Sin fila: ni tipo declarado ni tamaño; el tipo sale del nombre, orientativo.
      { attachmentId: attachments.missing, name: 'perdido.png', mimeType: 'image/png', byteLength: null }
    ]);
  });

  it('imagen como contenido image, texto como texto y PDF como recurso embebido, sin rutas ni URLs', async () => {
    test = await buildTestContext();
    const { attachments, attachmentsNoteId: id } = test.library;

    const image = await read(attachments.png);
    expect(JSON.parse((image.content[0] as { text: string }).text)).toEqual({
      id,
      attachmentId: attachments.png,
      name: 'foto.png',
      mimeType: 'image/png',
      byteLength: ATTACHMENT_PNG.length
    });
    expect(image.content[1]).toEqual({ type: 'image', data: base64(ATTACHMENT_PNG), mimeType: 'image/png' });

    const text = await read(`sha256:${attachments.text.toUpperCase()}`);
    expect(text.content[1]).toEqual({ type: 'text', text: ATTACHMENT_TEXT });

    const pdf = await read(attachments.pdf);
    expect(pdf.content[1]).toEqual({
      type: 'resource',
      resource: {
        uri: `hebra-attachment:${attachments.pdf}`,
        mimeType: 'application/pdf',
        blob: base64(ATTACHMENT_PDF)
      }
    });

    const serialized = JSON.stringify([image, text, pdf]);
    for (const forbidden of [test.dataDir, '/blobs/', 'file:', 'http:', 'https:', 'blob:']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('demasiado grande: attachment_too_large con el tamaño, sin intentar bajarlo', async () => {
    test = await buildTestContext();
    let fetched = 0;
    const ctx = await fresh();
    const write = ctx.write!;
    const spied: ToolContext = {
      ...ctx,
      write: {
        ...write,
        fetchAttachment: async (input) => {
          fetched += 1;
          return write.fetchAttachment(input);
        }
      }
    };
    const error = await expectCode(
      runReadAttachment(spied, { id: test.library.attachmentsNoteId, attachmentId: test.library.attachments.big }),
      'attachment_too_large'
    );
    expect(error.extra).toEqual({ byteLength: ATTACHMENT_BIG_BYTES, maxBytes: ATTACHMENT_MAX_BYTES });
    expect(fetched).toBe(0);
  });

  it('tipo no permitido y adjunto sin bytes en ningún sitio', async () => {
    test = await buildTestContext();
    const zip = await expectCode(read(test.library.attachments.zip), 'attachment_type_not_allowed');
    expect(zip.extra).toEqual({ mimeType: 'application/zip' });
    await expectCode(read(test.library.attachments.missing), 'attachment_unavailable');
  });

  it('nota oculta, adjunto de nota oculta o de otra nota: not_found, igual que inexistente', async () => {
    test = await buildTestContext();
    const library = test.library;
    for (const id of [library.privateAttachmentNoteId, library.privateFolderNoteId, library.trashedNoteId, 'no-existe']) {
      await expectCode(runListAttachments(await fresh(), { id }), 'not_found');
      await expectCode(
        runReadAttachment(await fresh(), { id, attachmentId: library.privateAttachmentSha }),
        'not_found'
      );
    }
    // Un adjunto de la nota privada pedido a través de una nota visible que no lo adjunta.
    for (const attachmentId of [library.privateAttachmentSha, 'no-es-un-hash', '../../etc/passwd']) {
      await expectCode(
        runReadAttachment(await fresh(), { id: library.attachmentsNoteId, attachmentId }),
        'not_found'
      );
    }
    // El escritor tampoco lo trae para una nota oculta, aunque se salte la herramienta.
    const error = await test.ctx
      .write!.fetchAttachment({
        noteId: library.privateAttachmentNoteId,
        sha256: library.privateAttachmentSha,
        privacy: test.ctx.privacyConfig
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'not_found' });
  });

  it('por MCP: contenido image/text/resource, cebos fuera de stderr y ninguna herramienta que cambie o borre adjuntos', async () => {
    test = await buildTestContext();
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const server = new McpServer({ name: 'hebra-mcp-attachments-test', version: '0.0.0' });
    registerTools(server, test.serverContext);
    const client = new Client({ name: 'hebra-mcp-attachments-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(['hebra_list_attachments', 'hebra_read_attachment']));
      // Añadir es `hebra_add_attachment` (D9, 3 oct 2026) y nada más: ninguna herramienta
      // que suba por otra vía, cambie, sustituya o borre adjuntos, blobs o ficheros.
      for (const name of names) {
        if (name === 'hebra_add_attachment') continue;
        expect(name).not.toMatch(
          /(add|put|upload|delete|remove|write|update|replace|change)_(attachment|blob|file)/i
        );
      }
      expect(names).toContain('hebra_add_attachment');

      const { attachments, attachmentsNoteId: id } = test.library;
      const types: string[] = [];
      for (const attachmentId of [attachments.png, attachments.text, attachments.pdf]) {
        const result = (await client.callTool({
          name: 'hebra_read_attachment',
          arguments: { id, attachmentId }
        })) as CallToolResult;
        expect(result.isError).not.toBe(true);
        types.push(result.content[1]!.type);
      }
      expect(types).toEqual(['image', 'text', 'resource']);
      const hidden = (await client.callTool({
        name: 'hebra_read_attachment',
        arguments: { id: test.library.privateAttachmentNoteId, attachmentId: test.library.privateAttachmentSha }
      })) as CallToolResult;
      expect(hidden.isError).toBe(true);
      expect(JSON.stringify(hidden)).not.toContain(BAIT_FOLDER);
    } finally {
      process.stderr.write = original;
      await client.close();
      await server.close();
    }
    const logged = writes.join('');
    for (const bait of [BAIT_ATTACHMENT, BAIT_FOLDER, 'foto.png', 'plano.pdf', test.library.attachments.png]) {
      expect(logged).not.toContain(bait);
    }
  });
});

describe('detectAttachmentType: decide el contenido, no la extensión', () => {
  const text = new TextEncoder().encode('a,b\n1,2\n');

  it('la firma manda sobre lo declarado y el nombre', () => {
    expect(detectAttachmentType(ATTACHMENT_PNG, 'application/octet-stream', 'x.bin')).toMatchObject({
      allowed: true,
      mimeType: 'image/png'
    });
    expect(detectAttachmentType(ATTACHMENT_PDF, null, null)).toMatchObject({ allowed: true, mimeType: 'application/pdf' });
  });

  it('una imagen declarada o con nombre de imagen cuyos bytes no lo son no pasa', () => {
    expect(detectAttachmentType(text, 'image/png', 'foto.png')).toEqual({ allowed: false, mimeType: 'image/png' });
    expect(detectAttachmentType(text, null, 'foto.png')).toEqual({ allowed: false, mimeType: null });
  });

  it('texto: solo con un tipo de texto declarado o, sin tipo, una extensión de texto, y UTF-8 válido', () => {
    expect(detectAttachmentType(text, 'text/csv; charset=utf-8', 'x')).toMatchObject({ allowed: true, mimeType: 'text/csv' });
    expect(detectAttachmentType(text, null, 'datos.csv')).toMatchObject({ allowed: true, mimeType: 'text/csv' });
    expect(detectAttachmentType(text, 'text/html', 'x.html')).toEqual({ allowed: false, mimeType: 'text/html' });
    expect(detectAttachmentType(text, null, 'script.sh')).toEqual({ allowed: false, mimeType: null });
    expect(detectAttachmentType(new Uint8Array([0xff, 0xfe, 0x00]), 'text/plain', 'x.txt')).toEqual({
      allowed: false,
      mimeType: 'text/plain'
    });
    expect(detectAttachmentType(new TextEncoder().encode('{"a":1}'), 'application/json', null)).toMatchObject({
      allowed: true,
      mimeType: 'application/json'
    });
    expect(detectAttachmentType(new TextEncoder().encode('{roto'), null, 'x.json')).toMatchObject({
      allowed: true,
      mimeType: 'text/plain'
    });
  });
});
