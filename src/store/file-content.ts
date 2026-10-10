/**
 * Qué se puede leer y reemplazar de un FICHERO SUELTO (D15, decidido por David el 10 oct
 * 2026, que amplía D10; SPEC.md §5): el tope de lectura, los tipos decididos por el
 * CONTENIDO y el tope del texto que `hebra_replace_file_text` escribe.
 *
 * Mismas reglas que los adjuntos (decisión 7 de D2, `./attachment-content.ts`): firma de
 * los primeros bytes para PNG, JPEG, GIF, WebP y PDF; texto solo si el almacén declara un
 * tipo de texto (o no declara ninguno y la extensión del nombre es de texto) Y los bytes
 * son UTF-8 válido sin NUL. Lo que cambia frente a los adjuntos es la lista de texto: un
 * fichero suelto de Obsidian es muchas veces un `.base` (YAML de Obsidian Bases) o un
 * `.yaml`, que como adjunto no se admite. El YAML sale como `text/yaml`, que es lo que
 * escribe Hebra al guardar un `.base` desde su editor (`writeObsidianBaseFile`); el
 * importador lo deja como `application/octet-stream`, y por eso cuenta la extensión.
 *
 * Vive en `src/store` porque lo comprueban dos capas: la herramienta
 * (`src/server/tools/read-file.ts`, `replace-file-text.ts`) y el escritor único
 * (`./file-writes.ts`), que lo vuelve a mirar dentro de su turno.
 */
import {
  ATTACHMENT_MAX_BYTES,
  extensionOf,
  normalizedType,
  typeBySignature,
  utf8Text
} from './attachment-content';

/** Bytes que se leen de un fichero suelto: los mismos 5 MiB que un adjunto. */
export const FILE_READ_MAX_BYTES = ATTACHMENT_MAX_BYTES;

/** Caracteres por tramo de un fichero de texto (`maxChars`, por defecto y máximo), como
 *  `hebra_read_attachment`. */
export const FILE_TEXT_CHUNK_MAX_CHARS = 100_000;

/**
 * Bytes UTF-8 que `hebra_replace_file_text` escribe como mucho, y tamaño máximo del
 * fichero que reemplaza (su contenido anterior se guarda entero para volver atrás). Un
 * `.base` real ocupa unos pocos KB. En unidades UTF-16 nunca pasa de estos mismos bytes,
 * así que con el peor escape JSON (6 bytes por unidad) son 6 000 000 en `writer.sock`,
 * igual que el cuerpo de los ficheros de trabajo (`REPLACE_BODY_MAX_LENGTH`).
 */
export const FILE_TEXT_REPLACE_MAX_BYTES = 1_000_000;

/** Tipos de texto de un fichero suelto, ya normalizados. */
const FILE_TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/yaml'
]);

/** Otros nombres del YAML (`normalizedType` ya resolvió los de los adjuntos). */
const YAML_ALIASES = new Set(['application/yaml', 'application/x-yaml', 'text/x-yaml']);

/** Extensión → tipo de texto, SOLO cuando el almacén no declara ningún tipo (o declara
 *  `application/octet-stream`, como deja el importador de Hebra lo que no reconoce). */
export const FILE_TEXT_TYPE_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  base: 'text/yaml',
  yaml: 'text/yaml',
  yml: 'text/yaml'
};

/** El tipo declarado, normalizado y con los alias del YAML resueltos. */
function declaredFileType(declared: string | null): string | null {
  const type = normalizedType(declared);
  return type && YAML_ALIASES.has(type) ? 'text/yaml' : type;
}

/** El tipo de texto que tocaría por lo declarado o, si no hay nada útil, por la extensión;
 *  `undefined` si no es de texto. */
function textTypeOf(declared: string | null, name: string | null): string | undefined {
  const type = declaredFileType(declared);
  if (type && FILE_TEXT_TYPES.has(type)) return type;
  if (type && type !== 'application/octet-stream') return undefined;
  return FILE_TEXT_TYPE_BY_EXTENSION[extensionOf(name) ?? ''];
}

export type DetectedFile =
  | { allowed: true; kind: 'image' | 'pdf'; mimeType: string }
  | { allowed: true; kind: 'text'; mimeType: string; text: string }
  | { allowed: false; mimeType: string | null };

/**
 * Tipo de un fichero suelto por su CONTENIDO, en este orden:
 * 1. Firma de imagen o PDF: ese tipo, diga lo que diga la fila o el nombre.
 * 2. Texto: el tipo declarado (o la extensión si no declara ninguno) es de texto y los
 *    bytes son UTF-8 válido sin NUL. Un JSON que no se puede leer como JSON pasa como
 *    `text/plain`, como en los adjuntos.
 * 3. Lo demás, no permitido (con el tipo declarado, si lo hay).
 */
export function detectFileType(
  bytes: Uint8Array,
  declared: string | null,
  name: string | null
): DetectedFile {
  const signed = typeBySignature(bytes);
  if (signed) {
    return { allowed: true, kind: signed === 'application/pdf' ? 'pdf' : 'image', mimeType: signed };
  }
  const textType = textTypeOf(declared, name);
  const type = declaredFileType(declared);
  if (!textType) return { allowed: false, mimeType: type };
  const text = utf8Text(bytes);
  if (text === null) return { allowed: false, mimeType: type };
  if (textType === 'application/json') {
    try {
      JSON.parse(text);
    } catch {
      return { allowed: true, kind: 'text', mimeType: 'text/plain', text };
    }
  }
  return { allowed: true, kind: 'text', mimeType: textType, text };
}

const LONE_SURROGATE = /\p{Cs}/u;

/** El texto nuevo de `hebra_replace_file_text`, en bytes, si se puede escribir: sin
 *  suplentes sueltos (`TextEncoder` los cambiaría por U+FFFD y lo guardado no sería lo
 *  pedido) y sin NUL (dejaría de leerse como texto). Si no, `null`. El tope lo mira quien
 *  llama, con el tamaño para el error. */
export function encodeFileText(text: string): Uint8Array | null {
  // Con la bandera `u`, un par suplente bien formado es UN carácter: `\p{Cs}` solo casa
  // con una mitad suelta (`isWellFormed` es de ES2024 y el proyecto compila con ES2023).
  if (LONE_SURROGATE.test(text) || text.includes('\u0000')) return null;
  return new TextEncoder().encode(text);
}
