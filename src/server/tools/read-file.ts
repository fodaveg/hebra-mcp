/**
 * `hebra_read_file` (D15, decidido por David el 10 oct 2026, tarea F2 de Lumbre; amplía
 * D10): el contenido de un fichero suelto (la tabla `files` de Hebra: un `.base`, un `.md`
 * o un PDF con carpeta propia), por su id de `hebra_list_files`.
 *
 * Tipos y tope, los de los adjuntos (decisión 7 de D2), decididos por el CONTENIDO
 * (`../../store/file-content.ts`): una imagen PNG, JPEG, GIF o WebP sale como contenido
 * `image`; un PDF, como recurso embebido con la URI opaca `hebra-file:<sha256>`; el texto
 * (texto plano, Markdown, CSV, JSON y YAML, que incluye el `.base` de Obsidian Bases), como
 * texto, por tramos de hasta 100 000 caracteres (`offset`, `maxChars`, como
 * `hebra_read_attachment`). Más de 5 MiB, `file_too_large`; otro tipo,
 * `file_type_not_allowed`. Nunca rutas locales ni URLs.
 *
 * Privacidad (SPEC.md §6.3): el filtro de los ficheros de D10 (carpeta privada o
 * subcarpeta, también ya borrada; o enlazado desde una nota oculta, por nombre o por
 * SHA-256). Un fichero oculto, uno inexistente, una lápida, el id de una nota y uno de la
 * papelera responden el mismo `not_found` (de la papelera no se lee: como una nota de la
 * papelera, hay que sacarlo antes). Se comprueba antes de leer y OTRA VEZ después, con un
 * filtro recalculado: si entre medias el fichero pasó a oculto, `not_found`; si cambió su
 * contenido, se repite la lectura una vez (los bytes leídos son los del hash que se
 * comprobó, y un hash viejo podría ser el de un adjunto de una nota oculta) y, si vuelve a
 * cambiar, `file_unavailable`.
 *
 * Bytes: si este dispositivo no los tiene, los baja el ESCRITOR (`fetchFile` de
 * `writer.sock`, con el filtro de quien pide dentro del turno) y aquí se leen del disco
 * compartido. Sin sync o si el relé no los tiene, `file_unavailable`.
 *
 * La salida lleva `sha256` (el de los bytes devueltos): es la base que pide
 * `hebra_replace_file_text`. Es el hash de un fichero que se ve y cuyo contenido sale
 * entero, así que no dice nada que el contenido no diga; `hebra_list_files` sigue sin
 * darlo (D10).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { FileFilter } from '../../privacy/file-filter';
import { PrivacyFilter } from '../../privacy/filter';
import {
  detectFileType,
  FILE_READ_MAX_BYTES,
  FILE_TEXT_CHUNK_MAX_CHARS
} from '../../store/file-content';
import type { ToolContext } from '../context';
import { ToolContent, ToolError } from '../errors';
import { textChunk } from './attachments';
import { mapWriteError } from './write-errors';

function tooLarge(byteLength: number): ToolError {
  return new ToolError('file_too_large', { byteLength, maxBytes: FILE_READ_MAX_BYTES });
}

async function localBytes(ctx: ToolContext, sha256: string): Promise<Uint8Array | null> {
  try {
    return await ctx.port.blobRead(sha256);
  } catch {
    // En un lector, `blobRead` no puede marcar un fichero roto como ausente: «no está».
    return null;
  }
}

/** Pide al escritor que traiga los bytes. Un rechazo de privacidad, de tamaño o de
 *  escritor ocupado sale tal cual; cualquier otro fallo, `file_unavailable`. */
async function fetchBytes(ctx: ToolContext, id: string, knownLength: number | null): Promise<void> {
  if (!ctx.write?.fetchFile) throw new ToolError('file_unavailable');
  let available: boolean;
  try {
    ({ available } = await ctx.write.fetchFile({ id, privacy: ctx.privacyConfig }));
  } catch (error) {
    const mapped = mapWriteError(error);
    if (mapped.code === 'file_too_large' && knownLength !== null) throw tooLarge(knownLength);
    if (
      mapped.code === 'not_found' ||
      mapped.code === 'busy_other_instance' ||
      mapped.code === 'privacy_config_unresolved'
    ) {
      throw mapped;
    }
    throw new ToolError('file_unavailable');
  }
  if (!available) throw new ToolError('file_unavailable');
}

interface FileRead {
  bytes: Uint8Array;
  sha256: string;
  name: string;
  mime: string | null;
  folderPath: string;
  updatedAt: number;
}

/** Una lectura: comprobar, traer los bytes y volver a comprobar. `null` si el contenido
 *  cambió entre medias (quien llama la repite). */
async function readOnce(ctx: ToolContext, id: string): Promise<FileRead | null> {
  const before = (await FileFilter.build(ctx.port, ctx.privacy, ctx.privacyConfig)).contentOf(id);
  if (!before || before.file.trashedAt !== null) throw new ToolError('not_found');
  const knownLength = before.file.byteLength;
  if (knownLength !== null && knownLength > FILE_READ_MAX_BYTES) throw tooLarge(knownLength);

  let bytes = await localBytes(ctx, before.sha256);
  if (!bytes) {
    await fetchBytes(ctx, id, knownLength);
    bytes = await localBytes(ctx, before.sha256);
  }

  // Otra vez, con el almacén de ahora: el sync pudo cambiar algo mientras se leía.
  const live = await PrivacyFilter.build(ctx.port, ctx.privacyConfig);
  if (live.unresolved) throw new ToolError('privacy_config_unresolved');
  const after = (await FileFilter.build(ctx.port, live, ctx.privacyConfig)).contentOf(id);
  if (!after || after.file.trashedAt !== null) throw new ToolError('not_found');
  if (after.sha256 !== before.sha256) return null;
  if (!bytes) throw new ToolError('file_unavailable');
  if (bytes.length > FILE_READ_MAX_BYTES) throw tooLarge(bytes.length);
  return {
    bytes,
    sha256: after.sha256,
    name: after.file.name,
    mime: after.file.mime,
    folderPath: live.folderPath(after.file.folderId),
    updatedAt: after.file.updatedAt
  };
}

/** `hebra_read_file`: el contenido de un fichero suelto visible (ver la cabecera). */
export async function runReadFile(
  ctx: ToolContext,
  input: { id: string; offset?: number; maxChars?: number }
): Promise<ToolContent> {
  const offset = input.offset ?? 0;
  const maxChars = input.maxChars ?? FILE_TEXT_CHUNK_MAX_CHARS;
  if (!Number.isInteger(offset) || offset < 0) throw new ToolError('invalid_input');
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > FILE_TEXT_CHUNK_MAX_CHARS) {
    throw new ToolError('invalid_input');
  }
  const read = (await readOnce(ctx, input.id)) ?? (await readOnce(ctx, input.id));
  if (!read) throw new ToolError('file_unavailable');

  const detected = detectFileType(read.bytes, read.mime, read.name);
  if (!detected.allowed) {
    throw new ToolError(
      'file_type_not_allowed',
      detected.mimeType ? { mimeType: detected.mimeType } : undefined
    );
  }
  const meta = {
    id: input.id,
    name: read.name,
    folderPath: read.folderPath,
    mimeType: detected.mimeType,
    byteLength: read.bytes.length,
    sha256: read.sha256,
    updatedAt: new Date(read.updatedAt).toISOString()
  };
  if (detected.kind === 'text') {
    const chunk = textChunk(detected.text, offset, maxChars);
    return new ToolContent({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...meta,
            totalChars: detected.text.length,
            truncated: chunk.nextOffset !== null,
            nextOffset: chunk.nextOffset
          })
        },
        { type: 'text', text: chunk.text }
      ]
    });
  }
  const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(meta) }];
  const data = Buffer.from(read.bytes).toString('base64');
  if (detected.kind === 'image') {
    content.push({ type: 'image', data, mimeType: detected.mimeType });
  } else {
    content.push({
      type: 'resource',
      resource: { uri: `hebra-file:${read.sha256}`, mimeType: detected.mimeType, blob: data }
    });
  }
  return new ToolContent({ content });
}
