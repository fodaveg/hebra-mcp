/**
 * Leer adjuntos (ampliación de D2, decisión de David del 30 sep 2026):
 * `hebra_list_attachments` y `hebra_read_attachment`. Nunca añaden, cambian ni borran un
 * adjunto: añadir es `hebra_add_attachment` (D9, `./add-attachment.ts`), y el único
 * `blobPut` fuera de la vista de sync del motor es el del escritor al añadir
 * (`test/store/surface.node.test.ts`). El tope y la detección de tipo son los mismos al
 * leer y al añadir (`../../store/attachment-content.ts`, reexportados aquí).
 *
 * Qué es un adjunto: lo que la nota adjunta con `![[sha256:H|nombre]]` (`note_blob_refs`
 * de Hebra, en el orden del cuerpo; así quedan también los de Obsidian, que el
 * importador reescribe a `sha256:`). `attachmentId` es ese SHA-256 en hexadecimal (lo
 * mismo que ya se ve en el cuerpo): ni rutas locales ni URLs. El nombre sale del alias
 * `|nombre` del propio cuerpo de la nota visible, o `null`.
 *
 * Privacidad: la nota tiene que ser visible (viva, ni oculta ni en la papelera) y el
 * adjunto, suyo; si no, `not_found`, igual que uno inexistente. Una nota bloqueada da
 * `note_locked` (sus adjuntos van cifrados con ella).
 *
 * Bytes: si este dispositivo no los tiene, los baja el ESCRITOR por la vía del motor
 * (`readBlob` de Blob V2: descifra, verifica el hash y los guarda en su almacén de
 * adjuntos, la única caché), y un lector se lo pide por `writer.sock`
 * (`WriteContext.fetchAttachment`). Los bytes no viajan por el socket: se leen del disco
 * compartido, aquí, con el filtro de ESTA llamada.
 *
 * Límites (decisión de David): como mucho `ATTACHMENT_MAX_BYTES` (5 MiB) descifrados; más,
 * `attachment_too_large` con el tamaño. Si el almacén ya sabe el tamaño (la fila de
 * `blobs` de un recurso recibido por sync) se decide antes de bajar nada; si no (un
 * `sha256:` de otro dispositivo: Blob V2 no guarda ni tamaño ni tipo), el motor baja el
 * objeto entero y se decide después. Tipos: solo `ALLOWED_ATTACHMENT_TYPES`, decididos
 * por el CONTENIDO (firma de los primeros bytes para imágenes y PDF; UTF-8 válido para
 * los de texto, con el tipo que declare el almacén o, si no declara ninguno, la
 * extensión del nombre); otro, `attachment_type_not_allowed`.
 *
 * Salida de `hebra_read_attachment`: un bloque de texto con `{id, attachmentId, name,
 * mimeType, byteLength}` y después el contenido: una imagen como contenido `image`
 * (base64 + `mimeType`), el texto como `text`, y el PDF como recurso embebido (`blob` en
 * base64) con la URI opaca `hebra-attachment:<sha256>`, que no se puede abrir ni apunta a
 * ningún sitio.
 *
 * Texto por tramos: un adjunto de texto sale como mucho en `maxChars` caracteres (1 a
 * `ATTACHMENT_TEXT_MAX_CHARS`, por defecto el máximo) a partir de `offset` (por defecto 0),
 * ambos en unidades de `string` (UTF-16). Su bloque de metadatos añade `totalChars`
 * (longitud del texto entero), `truncated` (queda texto tras este tramo) y `nextOffset`
 * (dónde seguir, o `null` si ya no queda). Un tramo nunca parte un par sustituto: si el
 * corte cae en medio de uno, se retrocede un carácter (o, si ni así cabe uno, se incluye el
 * par entero), y un `offset` que cae en medio de un par salta su mitad final. Con `offset`
 * mayor o igual que el total, el texto sale vacío, sin `truncated` ni `nextOffset`.
 * Imágenes y PDF no se trocean: `offset` y `maxChars` no cuentan con ellos, y su
 * bloque de metadatos no cambia.
 *
 * Logs (§6.4): los de `runTool` (herramienta y código) y `attachment.fetch` del motor
 * (resultado). Nunca nombres, hashes ni contenido.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolContent, ToolError } from '../errors';
import type { ToolContext } from '../context';
import { LIMITS, effectiveLimit, slicePage } from '../pagination';
import {
  ATTACHMENT_MAX_BYTES,
  detectAttachmentType,
  extensionOf,
  normalizedType,
  TEXT_TYPE_BY_EXTENSION
} from '../../store/attachment-content';
import type { NoteAttachmentRow } from '../../store/types';
import { LOCKED_BODY_PREFIX } from '../../store/writes';
import { requireVisibleNote } from './guards';
import { mapWriteError } from './write-errors';

export {
  ALLOWED_ATTACHMENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  detectAttachmentType,
  type DetectedAttachment
} from '../../store/attachment-content';

/** Tramo máximo (y por defecto) de un adjunto de TEXTO, en caracteres de `string`
 *  (unidades UTF-16): decisión de David, 30 sep 2026. */
export const ATTACHMENT_TEXT_MAX_CHARS = 100_000;

/** Tipo que se puede anunciar SIN leer los bytes (lista): el declarado o, si no hay, el de
 *  la extensión del nombre. Orientativo: lo que decide es `detectAttachmentType`. */
function listedType(declared: string | null, name: string | null): string | null {
  const type = normalizedType(declared);
  if (type && type !== 'application/octet-stream') return type;
  const extension = extensionOf(name);
  if (!extension) return null;
  const byImageExtension: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf'
  };
  return byImageExtension[extension] ?? TEXT_TYPE_BY_EXTENSION[extension] ?? null;
}

/** Nombre de cada adjunto según el alias `|nombre` de `![[sha256:H|nombre]]` en el
 *  cuerpo (el primero que aparezca). */
function attachmentNames(body: string): Map<string, string> {
  const names = new Map<string, string>();
  const pattern = /\[\[\s*sha256:([0-9a-fA-F]{64})[^|\]\n]*\|([^\]\n]*)\]\]/g;
  for (const match of body.matchAll(pattern)) {
    const sha256 = match[1]!.toLowerCase();
    const name = match[2]!.trim().slice(0, 255);
    if (name && !names.has(sha256)) names.set(sha256, name);
  }
  return names;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** La nota visible (si no, `not_found`) y no bloqueada (si no, `note_locked`), con sus
 *  adjuntos y los nombres de su cuerpo. */
async function visibleNoteAttachments(
  ctx: ToolContext,
  id: string
): Promise<{ rows: NoteAttachmentRow[]; names: Map<string, string> }> {
  requireVisibleNote(ctx, id);
  const note = await ctx.port.noteRead(id);
  if (!note || note.trashedAt !== null) throw new ToolError('not_found');
  if (note.body.startsWith(LOCKED_BODY_PREFIX)) throw new ToolError('note_locked');
  return { rows: await ctx.port.noteAttachments(id), names: attachmentNames(note.body) };
}

export interface ListedAttachment {
  attachmentId: string;
  name: string | null;
  /** Orientativo (el declarado o por la extensión); `null` si no se sabe sin leerlo. */
  mimeType: string | null;
  /** `null` si no se sabe sin bajarlo. */
  byteLength: number | null;
}

/** `hebra_list_attachments`: los adjuntos de una nota visible, en el orden del cuerpo.
 *  Sin `limit`, todos (como etiquetas y carpetas); con él (1-200) y `cursor`, por páginas
 *  (`a1.…`, con el `attachmentId` del último devuelto). `nextCursor` es `null` al final. */
export async function runListAttachments(
  ctx: ToolContext,
  input: { id: string; limit?: number; cursor?: string }
): Promise<{ id: string; attachments: ListedAttachment[]; nextCursor: string | null }> {
  const limit = effectiveLimit(input.limit, LIMITS.listAttachments);
  const { rows, names } = await visibleNoteAttachments(ctx, input.id);
  const all: ListedAttachment[] = rows.map((row) => {
    const name = names.get(row.sha256) ?? null;
    return {
      attachmentId: row.sha256,
      name,
      mimeType: listedType(row.mime, name),
      byteLength: row.byteLength
    };
  });
  const page = slicePage(all, 'a1', {
    limit,
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    keyOf: (item) => item.attachmentId
  });
  return { id: input.id, attachments: page.items, nextCursor: page.nextCursor };
}

async function localBytes(ctx: ToolContext, sha256: string): Promise<Uint8Array | null> {
  try {
    return await ctx.port.blobRead(sha256);
  } catch {
    // En un lector, `blobRead` no puede marcar un fichero roto como ausente: «no está».
    return null;
  }
}

/** Pide al escritor que traiga los bytes. Un rechazo de privacidad o de escritor ocupado
 *  sale tal cual; cualquier otro fallo, `attachment_unavailable`. */
async function fetchBytes(ctx: ToolContext, noteId: string, sha256: string): Promise<void> {
  if (!ctx.write) throw new ToolError('attachment_unavailable');
  let available: boolean;
  try {
    ({ available } = await ctx.write.fetchAttachment({
      noteId,
      sha256,
      privacy: ctx.privacyConfig
    }));
  } catch (error) {
    const mapped = mapWriteError(error);
    if (
      mapped.code === 'not_found' ||
      mapped.code === 'note_locked' ||
      mapped.code === 'busy_other_instance' ||
      mapped.code === 'privacy_config_unresolved'
    ) {
      throw mapped;
    }
    throw new ToolError('attachment_unavailable');
  }
  if (!available) throw new ToolError('attachment_unavailable');
}

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** El tramo `[offset, offset + maxChars)` de `text` sin partir un par sustituto, y dónde
 *  seguir (`null` si no queda texto). Ver la cabecera del fichero. */
export function textChunk(
  text: string,
  offset: number,
  maxChars: number
): { text: string; nextOffset: number | null } {
  const total = text.length;
  if (offset >= total) return { text: '', nextOffset: null };
  let start = offset;
  if (start > 0 && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
    start += 1;
  }
  let end = Math.min(start + maxChars, total);
  if (
    end < total &&
    end > start &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    // El corte cae dentro de un par: se retrocede, o se incluye entero si no cabría nada.
    end = end - 1 > start ? end - 1 : end + 1;
  }
  return { text: text.slice(start, end), nextOffset: end < total ? end : null };
}

function tooLarge(byteLength: number): ToolError {
  return new ToolError('attachment_too_large', { byteLength, maxBytes: ATTACHMENT_MAX_BYTES });
}

/** `hebra_read_attachment`: el contenido de un adjunto de una nota visible. */
export async function runReadAttachment(
  ctx: ToolContext,
  input: { id: string; attachmentId: string; offset?: number; maxChars?: number }
): Promise<ToolContent> {
  const offset = input.offset ?? 0;
  const maxChars = input.maxChars ?? ATTACHMENT_TEXT_MAX_CHARS;
  if (!Number.isInteger(offset) || offset < 0) throw new ToolError('invalid_input');
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > ATTACHMENT_TEXT_MAX_CHARS) {
    throw new ToolError('invalid_input');
  }
  const raw = input.attachmentId.trim().toLowerCase();
  const sha256 = raw.startsWith('sha256:') ? raw.slice('sha256:'.length) : raw;
  if (!SHA256_HEX.test(sha256)) throw new ToolError('not_found');
  const { rows, names } = await visibleNoteAttachments(ctx, input.id);
  const row = rows.find((entry) => entry.sha256 === sha256);
  if (!row) throw new ToolError('not_found');
  if (row.byteLength !== null && row.byteLength > ATTACHMENT_MAX_BYTES) {
    throw tooLarge(row.byteLength);
  }

  let bytes = await localBytes(ctx, sha256);
  if (!bytes) {
    await fetchBytes(ctx, input.id, sha256);
    bytes = await localBytes(ctx, sha256);
    if (!bytes) throw new ToolError('attachment_unavailable');
  }
  if (bytes.length > ATTACHMENT_MAX_BYTES) throw tooLarge(bytes.length);

  const name = names.get(sha256) ?? null;
  const detected = detectAttachmentType(bytes, row.mime, name);
  if (!detected.allowed) {
    throw new ToolError(
      'attachment_type_not_allowed',
      detected.mimeType ? { mimeType: detected.mimeType } : undefined
    );
  }
  const meta = {
    id: input.id,
    attachmentId: sha256,
    name,
    mimeType: detected.mimeType,
    byteLength: bytes.length
  };
  if (detected.text !== undefined) {
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
  if (detected.mimeType.startsWith('image/')) {
    content.push({
      type: 'image',
      data: Buffer.from(bytes).toString('base64'),
      mimeType: detected.mimeType
    });
  } else {
    content.push({
      type: 'resource',
      resource: {
        uri: `hebra-attachment:${sha256}`,
        mimeType: detected.mimeType,
        blob: Buffer.from(bytes).toString('base64')
      }
    });
  }
  return new ToolContent({ content });
}
