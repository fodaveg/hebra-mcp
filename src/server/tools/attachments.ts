/**
 * Adjuntos en SOLO LECTURA (ampliación de D2, decisión de David del 30 sep 2026):
 * `hebra_list_attachments` y `hebra_read_attachment`. Nunca añaden, cambian ni borran un
 * adjunto: en todo hebra-mcp no hay ninguna llamada a `blobPut`, `file*` ni a nada que
 * escriba adjuntos salvo la caché del propio motor al bajarlos
 * (`test/store/surface.node.test.ts`).
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
 * Logs (§6.4): los de `runTool` (herramienta y código) y `attachment.fetch` del motor
 * (resultado). Nunca nombres, hashes ni contenido.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolContent, ToolError } from '../errors';
import type { ToolContext } from '../context';
import type { NoteAttachmentRow } from '../../store/types';
import { mapWriteError } from './write-errors';

/** 5 MiB descifrados por adjunto (decisión de David, 30 sep 2026). */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export const ALLOWED_ATTACHMENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json'
];

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

/** Tipos que se escriben de otra forma y son el mismo. */
const TYPE_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'text/x-markdown': 'text/markdown',
  'text/md': 'text/markdown',
  'application/csv': 'text/csv',
  'text/json': 'application/json'
};

/** Extensión → tipo de texto, SOLO cuando el almacén no declara ningún tipo. */
const TEXT_TYPE_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json'
};

/** Tipo de imagen o PDF por su firma (los primeros bytes), o `null`. */
function typeBySignature(bytes: Uint8Array): string | null {
  const startsWith = (...prefix: number[]): boolean =>
    bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    bytes.length >= 12 &&
    String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  return null;
}

/** `type/subtype` en minúsculas, sin parámetros (`; charset=…`) y con alias resueltos. */
function normalizedType(raw: string | null): string | null {
  if (!raw) return null;
  const base = raw.split(';')[0]!.trim().toLowerCase();
  if (!base) return null;
  return TYPE_ALIASES[base] ?? base;
}

function extensionOf(name: string | null): string | null {
  if (!name) return null;
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match ? match[1]!.toLowerCase() : null;
}

/** El texto, si los bytes son UTF-8 válido sin NUL; si no, `null`. */
function utf8Text(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  return text.includes('\u0000') ? null : text;
}

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

export type DetectedAttachment =
  | { allowed: true; mimeType: string; text?: string }
  | { allowed: false; mimeType: string | null };

/**
 * Tipo de un adjunto decidido por su CONTENIDO:
 * 1. Firma de imagen o PDF: ese tipo, diga lo que diga la fila o el nombre.
 * 2. Si no, texto: solo si el almacén declara uno de los tipos de texto permitidos (o no
 *    declara ninguno y la extensión del nombre es de texto) Y los bytes son UTF-8 válido.
 *    Un JSON que no se puede leer como JSON pasa como `text/plain`.
 * 3. Lo demás (un tipo declarado fuera de la lista, un binario sin firma conocida, una
 *    imagen declarada cuyos bytes no lo son), no permitido.
 */
export function detectAttachmentType(
  bytes: Uint8Array,
  declared: string | null,
  name: string | null
): DetectedAttachment {
  const signed = typeBySignature(bytes);
  if (signed) return { allowed: true, mimeType: signed };
  const type = normalizedType(declared);
  const textType =
    type && TEXT_TYPES.has(type)
      ? type
      : !type || type === 'application/octet-stream'
        ? TEXT_TYPE_BY_EXTENSION[extensionOf(name) ?? '']
        : undefined;
  if (!textType) return { allowed: false, mimeType: type };
  const text = utf8Text(bytes);
  if (text === null) return { allowed: false, mimeType: type };
  if (textType === 'application/json') {
    try {
      JSON.parse(text);
    } catch {
      return { allowed: true, mimeType: 'text/plain', text };
    }
  }
  return { allowed: true, mimeType: textType, text };
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

const LOCKED_BODY_PREFIX = 'hebra-locked:';
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** La nota visible (si no, `not_found`) y no bloqueada (si no, `note_locked`), con sus
 *  adjuntos y los nombres de su cuerpo. */
async function visibleNoteAttachments(
  ctx: ToolContext,
  id: string
): Promise<{ rows: NoteAttachmentRow[]; names: Map<string, string> }> {
  if (!ctx.privacy.visibleMeta(id)) throw new ToolError('not_found');
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

/** `hebra_list_attachments`: los adjuntos de una nota visible, en el orden del cuerpo. */
export async function runListAttachments(
  ctx: ToolContext,
  input: { id: string }
): Promise<{ id: string; attachments: ListedAttachment[] }> {
  const { rows, names } = await visibleNoteAttachments(ctx, input.id);
  return {
    id: input.id,
    attachments: rows.map((row) => {
      const name = names.get(row.sha256) ?? null;
      return {
        attachmentId: row.sha256,
        name,
        mimeType: listedType(row.mime, name),
        byteLength: row.byteLength
      };
    })
  };
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

function tooLarge(byteLength: number): ToolError {
  return new ToolError('attachment_too_large', { byteLength, maxBytes: ATTACHMENT_MAX_BYTES });
}

/** `hebra_read_attachment`: el contenido de un adjunto de una nota visible. */
export async function runReadAttachment(
  ctx: ToolContext,
  input: { id: string; attachmentId: string }
): Promise<ToolContent> {
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
  const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(meta) }];
  if (detected.text !== undefined) {
    content.push({ type: 'text', text: detected.text });
  } else if (detected.mimeType.startsWith('image/')) {
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
