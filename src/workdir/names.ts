/**
 * Nombres de los ficheros de trabajo (SPEC.md §13.3): de un título o una carpeta de Hebra
 * a un nombre que valga en macOS, Linux y Windows, y la clave con la que se comparan dos
 * rutas.
 *
 * - Todo en NFC: macOS guarda el nombre tal cual llega y lo encuentra en las dos formas,
 *   Linux compara bytes. Escribiendo y comparando siempre en NFC, una nota con «canción»
 *   compuesta y otra con la tilde descompuesta no dan dos ficheros que parecen el mismo.
 * - Caracteres que Windows no admite (`: * ? " < > | / \`) y los de control pasan a `-`.
 * - Sin espacios ni puntos al final (Windows los quita al crear y el fichero deja de
 *   encontrarse por su nombre) y sin punto al principio (un directorio oculto se lo
 *   saltan `rg` y los recorridos por defecto).
 * - Nombres de dispositivo de Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM0`-`COM9`,
 *   `LPT0`-`LPT9`, también con los dígitos volados `¹²³`), en cualquier caja y con
 *   cualquier extensión detrás (`con.txt` también lo es): se les antepone `_`.
 * - Un tope de bytes UTF-8 por segmento, sin partir un carácter.
 *
 * La clave de comparación (`pathKey`) es NFC y en minúsculas: dos notas cuyos nombres solo
 * difieren en mayúsculas serían el MISMO fichero en macOS y Windows, así que se tratan
 * como colisión en todas las plataformas (la carpeta de trabajo se puede copiar de una a
 * otra).
 */

/** Tope del título en el nombre del fichero, en bytes UTF-8 (sin el sufijo del id). */
export const TITLE_MAX_BYTES = 150;
/** Tope de cada carpeta de la ruta, en bytes UTF-8. */
export const FOLDER_MAX_BYTES = 150;
/** Nombre de una nota sin título. */
export const UNTITLED = 'Sin título';
/** Nombre de una carpeta que se queda vacía al sanear. */
export const UNNAMED_FOLDER = 'Sin nombre';

const FORBIDDEN_CHARS = /[:*?"<>|/\\\u0000-\u001f\u007f]/gu;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/u;

/** Corta `text` a `maxBytes` bytes UTF-8 sin partir un punto de código. */
export function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}

/** Quita espacios y puntos del final (los dos, en cualquier orden). */
function trimTrailing(text: string): string {
  return text.replace(/[\s.]+$/u, '');
}

/** ¿Es un nombre de dispositivo de Windows? Mira lo que hay antes del primer punto, sin
 *  los espacios del final, como hace Windows. */
export function isWindowsDeviceName(name: string): boolean {
  const stem = name.split('.')[0].replace(/\s+$/u, '').toLowerCase();
  return WINDOWS_DEVICE.test(stem);
}

/**
 * Un segmento de ruta válido en las tres plataformas, o `fallback` si no queda nada.
 * El recorte va antes de quitar lo del final, para que un corte no deje un espacio o
 * un punto colgando.
 */
export function sanitizeSegment(raw: string, maxBytes: number, fallback: string): string {
  let name = raw.normalize('NFC').replace(FORBIDDEN_CHARS, '-').trim();
  name = trimTrailing(truncateUtf8(name, maxBytes));
  if (name.startsWith('.')) name = `_${name.slice(1)}`;
  if (name.length === 0) return fallback;
  if (isWindowsDeviceName(name)) name = `_${name}`;
  return name;
}

/** Nombre del fichero de una nota: título saneado y el sufijo del id. `fullId` lo usa
 *  quien ya vio una colisión con el sufijo corto. */
export function noteFileName(title: string, id: string, fullId = false): string {
  const stem = sanitizeSegment(title, TITLE_MAX_BYTES, UNTITLED);
  const suffix = fullId ? id : id.slice(0, 8);
  return `${stem} (${sanitizeSegment(suffix, 200, 'x')}).md`;
}

/** Ruta relativa (con `/`) de las carpetas de Hebra, cada una saneada. */
export function folderDirPath(segments: readonly string[]): string {
  return segments.map((segment) => sanitizeSegment(segment, FOLDER_MAX_BYTES, UNNAMED_FOLDER)).join('/');
}

/**
 * Ruta nueva (con `/`) de una nota en la carpeta de trabajo, sin chocar con `used` (claves
 * de `pathKey`, que se actualiza): título y 8 primeros del id; si eso ya está (mismo
 * título y mismo principio de id, también solo por mayúsculas o NFC), el id entero.
 */
export function assignNotePath(
  used: Set<string>,
  folderSegments: readonly string[],
  title: string,
  id: string
): string {
  const dir = folderDirPath(folderSegments);
  const prefix = dir === '' ? '' : `${dir}/`;
  let ruta = `${prefix}${noteFileName(title, id)}`;
  if (used.has(pathKey(ruta))) ruta = `${prefix}${noteFileName(title, id, true)}`;
  used.add(pathKey(ruta));
  return ruta;
}

/** Clave para comparar dos rutas relativas: NFC y minúsculas. */
export function pathKey(relativePath: string): string {
  return relativePath.normalize('NFC').toLowerCase().normalize('NFC');
}

/** Ruta relativa con `/`, venga con el separador que venga (también `\` de Windows). */
export function toPosixRelative(relativePath: string): string {
  return relativePath.split(/[\\/]+/u).filter((part) => part.length > 0 && part !== '.').join('/');
}
