/**
 * Qué se puede leer y añadir como adjunto (decisión 7 de D2, 30 sep 2026, y D9, 3 oct
 * 2026): el tope de 5 MiB, los tipos permitidos decididos por el CONTENIDO, y, para
 * `hebra_add_attachment`, el base64 de entrada y el nombre que va en la referencia
 * `![[sha256:H|nombre]]`.
 *
 * Vive en `src/store` y no en la herramienta porque lo comprueban DOS capas: la
 * herramienta (`src/server/tools/attachments.ts` al leer, `add-attachment.ts` al añadir)
 * y el escritor único (`./writes.ts`, `NoteWriter.addAttachment`), que vuelve a
 * comprobarlo todo dentro de su turno aunque se lo pida un lector por `writer.sock`. Una
 * sola detección para leer y escribir: lo que se puede añadir es exactamente lo que se
 * puede leer.
 */

/** 5 MiB descifrados por adjunto (decisión de David, 30 sep 2026; D9 lo mantiene para
 *  añadir). */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** Caracteres del base64 estándar de un adjunto de `ATTACHMENT_MAX_BYTES` (con relleno):
 *  lo que tiene que caber en `writer.sock` y en `POST /mcp` (`./writes.ts`,
 *  `MAX_WRITE_MESSAGE_BYTES`). */
export const ATTACHMENT_BASE64_MAX_CHARS = 4 * Math.ceil(ATTACHMENT_MAX_BYTES / 3);

/** Longitud máxima del nombre de un adjunto añadido, tras recortar (como el corte de
 *  nombres de `hebra_list_attachments`). */
export const ATTACHMENT_NAME_MAX_LENGTH = 255;

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
export const TEXT_TYPE_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json'
};

/** Tipo de imagen o PDF por su firma (los primeros bytes), o `null`. También lo usa la
 *  lectura de ficheros sueltos (D15, `./file-content.ts`). */
export function typeBySignature(bytes: Uint8Array): string | null {
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
export function normalizedType(raw: string | null): string | null {
  if (!raw) return null;
  const base = raw.split(';')[0]!.trim().toLowerCase();
  if (!base) return null;
  return TYPE_ALIASES[base] ?? base;
}

export function extensionOf(name: string | null): string | null {
  if (!name) return null;
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match ? match[1]!.toLowerCase() : null;
}

/** El texto, si los bytes son UTF-8 válido sin NUL; si no, `null`. */
export function utf8Text(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  return text.includes('\u0000') ? null : text;
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
 * Al añadir (D9), `declared` es el `mimeType` que trae el agente: decide solo entre los
 * tipos de texto, nunca convierte en imagen unos bytes que no lo son.
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

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type DecodedAttachment =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: 'invalid_input' }
  | { ok: false; code: 'attachment_too_large'; byteLength: number };

/**
 * Los bytes de `dataBase64` de `hebra_add_attachment` (D9). Base64 ESTÁNDAR y estricto
 * una vez quitados los espacios y saltos de línea (un `base64` de terminal parte las
 * líneas a 76 caracteres): longitud múltiplo de 4, solo su alfabeto, relleno solo al
 * final y en forma canónica (lo que vuelve a codificar es lo mismo que llegó). Vacío o
 * mal formado, `invalid_input`. Más de `ATTACHMENT_MAX_BYTES`, `attachment_too_large`
 * con el tamaño, sabido por la longitud ANTES de decodificar nada.
 */
export function decodeAttachmentBase64(text: string): DecodedAttachment {
  const clean = text.replace(/[\t\n\v\f\r ]+/g, '');
  if (clean.length === 0 || clean.length % 4 !== 0 || !BASE64.test(clean)) {
    return { ok: false, code: 'invalid_input' };
  }
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const byteLength = (clean.length / 4) * 3 - padding;
  if (byteLength > ATTACHMENT_MAX_BYTES) {
    return { ok: false, code: 'attachment_too_large', byteLength };
  }
  const buffer = Buffer.from(clean, 'base64');
  if (buffer.length !== byteLength || buffer.toString('base64') !== clean) {
    return { ok: false, code: 'invalid_input' };
  }
  return { ok: true, bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
}

/** Lo que no puede ir en el nombre de un adjunto: rompería `![[sha256:H|nombre]]` (`|`,
 *  `[`, `]`), Hebra lo escapa en sus alias (`\`, `#`, `escapeAlias` de
 *  `notes/attachments.ts`), parte la línea (controles, U+2028 y U+2029) o es un carácter
 *  de formato invisible de Unicode (categoría Cf: U+200B, U+202E…). */
const ATTACHMENT_NAME_FORBIDDEN = /[|[\]\\#\u0000-\u001f\u007f]|\p{Cf}/u;

/** U+2028 y U+2029, separadores de línea de Unicode: fuera de la expresión regular para
 *  que ningún editor los convierta en el carácter literal, que la rompería. */
const LINE_SEPARATORS = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];

function hasLineSeparator(text: string): boolean {
  return LINE_SEPARATORS.some((separator) => text.includes(separator));
}

/** El nombre recortado si vale para `![[sha256:H|nombre]]`; si no, `null`. Se rechaza
 *  en vez de sanear: el agente sabe así qué nombre quedó, sin sorpresas. */
export function validAttachmentName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0 || name.length > ATTACHMENT_NAME_MAX_LENGTH) return null;
  return ATTACHMENT_NAME_FORBIDDEN.test(name) || hasLineSeparator(name) ? null : name;
}

/** La referencia que `hebra_add_attachment` añade al final del cuerpo: la misma forma que
 *  escribe Hebra al adjuntar (`attachmentEmbedMarkdown`), con un nombre ya validado por
 *  `validAttachmentName`, que no necesita escapes. */
export function attachmentMarkdown(sha256: string, name: string): string {
  return `![[sha256:${sha256}|${name}]]`;
}
