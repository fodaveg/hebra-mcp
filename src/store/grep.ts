/**
 * Núcleo de `hebra_grep` y de la lectura por líneas (D13, SPEC.md §5): módulo puro, sin
 * almacén ni privacidad. Código propio de hebra-mcp.
 *
 * - **Líneas**: la misma convención que `./sections.ts` (y por tanto que `line` de
 *   `hebra_note_outline`): terminadores `\n` y `\r\n` (la `\r` de delante de un `\n` no es
 *   parte de la línea), y un salto de línea al final no abre una línea vacía de más. Un
 *   cuerpo vacío tiene 0 líneas. Posiciones y columnas en unidades UTF-16, 1-based.
 * - **Patrón**: literal (por defecto) o expresión regular de JavaScript, siempre con la
 *   bandera `u` (y `i` sin distinguir mayúsculas). Se busca línea a línea: nada casa a
 *   través de un salto de línea.
 * - **Prefiltro de subcadena** (`trigramMatch`): la consulta de `notes_trigram` (H5 de Hebra)
 *   que da un SUPERCONJUNTO de las notas con alguna coincidencia, o `null` si con este
 *   patrón el índice podría dejarse alguna (entonces se recorre todo). Ver su comentario.
 */

/** Tope del patrón, en unidades UTF-16. */
export const GREP_PATTERN_MAX_CHARS = 1_000;
/** Tope de las líneas de contexto antes y después de cada coincidencia. */
export const GREP_CONTEXT_MAX_LINES = 5;
/** Tope del texto de una línea en la salida (la coincidente se recorta alrededor de la
 *  coincidencia; las de contexto, por el final). */
export const GREP_LINE_MAX_CHARS = 300;
/** Lo que se lee de más por delante de la coincidencia al recortar una línea larga. */
const GREP_LINE_LEAD_CHARS = 100;
/** Tope de líneas de una lectura por rango (`hebra_read_note` con `lines`). */
export const READ_LINES_MAX = 2_000;
/** Lo mínimo que tiene que tener un literal para el índice de subcadena: el tokenizador
 *  `trigram` de FTS5 no encuentra nada con menos de tres caracteres. */
export const TRIGRAM_MIN_CHARS = 3;

/** Principio (offset) de cada línea del cuerpo; su longitud es el número de líneas. */
export function lineStarts(body: string): number[] {
  const starts: number[] = [];
  let from = 0;
  while (from < body.length) {
    starts.push(from);
    const newline = body.indexOf('\n', from);
    if (newline < 0) break;
    from = newline + 1;
  }
  return starts;
}

/** El texto de la línea `index` (0-based), sin su terminador. */
export function lineText(body: string, starts: readonly number[], index: number): string {
  const from = starts[index]!;
  const newline = body.indexOf('\n', from);
  if (newline < 0) return body.slice(from);
  const end = newline > from && body.charCodeAt(newline - 1) === 13 ? newline - 1 : newline;
  return body.slice(from, end);
}

/**
 * Las líneas `from`..`to` (1-based, inclusivas, ya dentro de rango) tal como están en el
 * cuerpo, con sus terminadores: desde el principio de `from` hasta el de la siguiente a
 * `to` (o el final).
 */
export function sliceLines(body: string, starts: readonly number[], from: number, to: number): string {
  const end = to < starts.length ? starts[to]! : body.length;
  return body.slice(starts[from - 1]!, end);
}

/**
 * Recorre las líneas de `body` desde la `fromLine` (1-based) y devuelve, aplanados, la
 * línea y la columna (1-based, UTF-16) de la primera coincidencia de `re` en cada línea
 * que casa, como mucho `maxHits` líneas. `next` es la línea por la que seguir si paró por
 * el tope (la que casa y no cupo), o 0 si llegó al final. Con `quickReject`, si `re` no
 * casa en el cuerpo entero no se parte en líneas: solo vale para un literal sin saltos de
 * línea (una expresión regular puede casar a través de uno y no en ninguna línea).
 *
 * Autocontenida A PROPÓSITO (sin nada de fuera de su cuerpo, ni importaciones ni
 * ayudantes): el trabajador de las expresiones regulares (`./regex-worker.ts`) recibe su
 * código fuente (`scanBody.toString()`), así que el hilo principal y el trabajador
 * recorren las líneas con el mismo código.
 */
export function scanBody(
  body: string,
  re: RegExp,
  fromLine: number,
  maxHits: number,
  quickReject: boolean
): { hits: number[]; next: number } {
  const hits: number[] = [];
  if (quickReject && !re.test(body)) return { hits, next: 0 };
  const length = body.length;
  let from = 0;
  let line = 1;
  while (from < length) {
    const newline = body.indexOf('\n', from);
    if (line >= fromLine) {
      let end = newline < 0 ? length : newline;
      if (newline > from && body.charCodeAt(newline - 1) === 13) end = newline - 1;
      const match = re.exec(body.slice(from, end));
      if (match !== null) {
        if (hits.length >= maxHits * 2) return { hits, next: line };
        hits.push(line, match.index + 1);
      }
    }
    if (newline < 0) break;
    from = newline + 1;
    line += 1;
  }
  return { hits, next: 0 };
}

/** Escapa un literal para `new RegExp(…, 'u')`: solo los caracteres de sintaxis (con `u`,
 *  escapar cualquier otro, como `-`, es un error de sintaxis). */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

export interface GrepPattern {
  /** Para `scanBody`: sin `g` ni `y` (cada `exec` empieza en el principio de la línea). */
  re: RegExp;
  /** Si es un literal (sin saltos de línea): admite `quickReject`. */
  literal: boolean;
  /** Un trozo que toda coincidencia contiene tal cual (con `i`, salvo mayúsculas), o
   *  `null` si no se sabe sacar: el del prefiltro de subcadena. */
  required: string | null;
}

/**
 * Compila el patrón. `null` si no vale: vacío, más largo que el tope, con un salto de
 * línea (nada casa a través de uno) o, si es una expresión regular, con la sintaxis
 * mal (con la bandera `u`, la estricta).
 */
export function compileGrepPattern(
  pattern: string,
  options: { regex: boolean; caseSensitive: boolean }
): GrepPattern | null {
  if (pattern.length === 0 || pattern.length > GREP_PATTERN_MAX_CHARS) return null;
  if (/[\r\n]/.test(pattern)) return null;
  const flags = options.caseSensitive ? 'u' : 'iu';
  if (!options.regex) {
    return { re: new RegExp(escapeRegExp(pattern), flags), literal: true, required: pattern };
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return null;
  }
  return { re, literal: false, required: requiredLiteral(pattern) };
}

/** Lo que no es un carácter literal en una expresión regular (fuera de una clase). */
const REGEX_SYNTAX = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|']);
/** Escapes de un solo carácter que son ese carácter tal cual (con `u`: los de sintaxis y `/`). */
const IDENTITY_ESCAPES = new Set([...REGEX_SYNTAX, '/']);

/**
 * El trozo literal más largo que TODA coincidencia de la expresión regular `source`
 * (ya compilada con `u`) contiene, o `null` si no hay ninguno (o si hay una alternancia
 * `|` fuera de los grupos, que deja todo opcional). Conservador a propósito: un grupo,
 * una clase, `.`, un ancla o un escape que no sea de un carácter de sintaxis cortan el
 * trozo; un carácter con cuantificador sale del trozo (con `*`, `?` o `{0,…}`) o lo
 * cierra (con `+` o `{n,…}`). Equivocarse aquí haría que el prefiltro se dejara notas, así
 * que ante la duda corta. Recorre el texto una vez: lineal en su longitud.
 */
export function requiredLiteral(source: string): string | null {
  const chars = [...source];
  let best: string[] = [];
  let run: string[] = [];
  let lastLiteral = false;
  const flush = (): void => {
    if (run.length > best.length) best = run;
    run = [];
  };
  /** Salta un grupo o una clase que empieza en `start`; devuelve el índice tras su cierre. */
  const skipGroup = (start: number): number => {
    let depth = 0;
    let inClass = false;
    for (let index = start; index < chars.length; index += 1) {
      const char = chars[index]!;
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (inClass) {
        if (char === ']') inClass = false;
        continue;
      }
      if (char === '[') inClass = true;
      else if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return chars.length;
  };
  const skipClass = (start: number): number => {
    for (let index = start + 1; index < chars.length; index += 1) {
      if (chars[index] === '\\') index += 1;
      else if (chars[index] === ']') return index + 1;
    }
    return chars.length;
  };
  /** Salta un escape que no es un carácter de sintaxis (`\d`, `\b`, `\p{L}`, `\u{1F600}`,
   *  `￿`, `\x41`, `\cJ`, `\k<nombre>`, `\12`…) que empieza en `start`. */
  const skipEscape = (start: number): number => {
    const escaped = chars[start + 1];
    const until = (close: string): number => {
      const end = chars.indexOf(close, start + 2);
      return end < 0 ? chars.length : end + 1;
    };
    if ((escaped === 'p' || escaped === 'P' || escaped === 'u') && chars[start + 2] === '{') {
      return until('}');
    }
    if (escaped === 'k' && chars[start + 2] === '<') return until('>');
    if (escaped === 'x') return start + 4;
    if (escaped === 'u') return start + 6;
    if (escaped === 'c') return start + 3;
    if (escaped !== undefined && /[0-9]/.test(escaped)) {
      let end = start + 2;
      while (end < chars.length && /[0-9]/.test(chars[end]!)) end += 1;
      return end;
    }
    return start + 2;
  };
  let index = 0;
  while (index < chars.length) {
    const char = chars[index]!;
    if (char === '|') return null;
    if (char === '(') {
      flush();
      index = skipGroup(index);
      lastLiteral = false;
      continue;
    }
    if (char === '[') {
      flush();
      index = skipClass(index);
      lastLiteral = false;
      continue;
    }
    if (char === '*' || char === '?' || char === '+' || char === '{') {
      let minimum = char === '+' ? 1 : 0;
      let end = index + 1;
      if (char === '{') {
        const quantifier = /^\{(\d+)(?:,\d*)?\}/.exec(chars.slice(index).join(''));
        if (!quantifier) return null;
        minimum = Number(quantifier[1]);
        end = index + [...quantifier[0]].length;
      }
      if (lastLiteral) {
        if (minimum === 0) run.pop();
        flush();
      }
      lastLiteral = false;
      index = end;
      continue;
    }
    if (char === '\\') {
      const escaped = chars[index + 1];
      if (escaped !== undefined && IDENTITY_ESCAPES.has(escaped)) {
        // `\.`, `\(`…: ese carácter tal cual, y el trozo sigue.
        run.push(escaped);
        lastLiteral = true;
        index += 2;
        continue;
      }
      flush();
      lastLiteral = false;
      index = skipEscape(index);
      continue;
    }
    if (REGEX_SYNTAX.has(char)) {
      // `^`, `$`, `.`, `)`, `]`, `}` sueltos: no son literales.
      flush();
      lastLiteral = false;
      index += 1;
      continue;
    }
    run.push(char);
    lastLiteral = true;
    index += 1;
  }
  flush();
  return best.length > 0 ? best.join('') : null;
}

/**
 * Tramos de caracteres (puntos de código, inclusivos) con los que el prefiltro de
 * subcadena es seguro: ASCII imprimible, latín (Latin-1, extendidos A, B y adicional, IPA
 * y modificadores), griego, cirílico, puntuación general y monedas. Fuera de ellos (otras
 * escrituras, marcas combinantes que el plegado de FTS5 quita, caracteres de control) no
 * se usa el índice: se recorre todo, que también está por debajo del tope.
 */
const TRIGRAM_SAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x20, 0x7e],
  [0xa0, 0x2ff],
  [0x370, 0x3ff],
  [0x400, 0x4ff],
  [0x1e00, 0x1eff],
  [0x2000, 0x206f],
  [0x20a0, 0x20bf]
];

/**
 * Dentro de esos tramos, los que SIN distinguir mayúsculas no valen: la bandera `iu` de
 * JavaScript (plegado simple de Unicode) los iguala con otro carácter que el plegado de
 * FTS5 (`trigram remove_diacritics 1`) deja distinto (la `В` cirílica con su variante
 * antigua U+1C80, `ΐ` con U+1FD3…). Medido con `node:sqlite` (SQLite 3.53) carácter a
 * carácter sobre todo el plano básico; lo vuelve a medir `test/store/grep.test.ts`, que
 * falla si SQLite o V8 cambian y esta lista se queda corta.
 */
const TRIGRAM_UNSAFE_IGNORING_CASE = new Set([
  0x19b, 0x25c, 0x261, 0x264, 0x26a, 0x26c, 0x282, 0x287, 0x29d, 0x29e, 0x37f, 0x390, 0x3b0,
  0x3f3, 0x412, 0x414, 0x41e, 0x421, 0x422, 0x42a, 0x432, 0x434, 0x43e, 0x441, 0x442, 0x44a,
  0x462, 0x463
]);

/** ¿Es `codePoint` seguro para el prefiltro con esa sensibilidad a las mayúsculas? */
export function trigramSafeChar(codePoint: number, caseSensitive: boolean): boolean {
  if (!caseSensitive && TRIGRAM_UNSAFE_IGNORING_CASE.has(codePoint)) return false;
  return TRIGRAM_SAFE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/** Lo que el índice de subcadena no indexa tal cual (`substringIndexText` de Hebra quita
 *  los destinos de enlaces y adjuntos): un literal con alguno de estos puede casar en el
 *  cuerpo y no en el índice. */
const TRIGRAM_HIDDEN_DELIMITERS = /[[\]|!]/;

/**
 * La consulta `MATCH` de `notes_trigram` (columna `body`) que da un SUPERCONJUNTO de las
 * notas en cuyo cuerpo casa un patrón que contiene `required` tal cual (o, sin distinguir
 * mayúsculas, salvo ellas), o `null` si con él el índice podría dejarse alguna.
 *
 * Por qué es un superconjunto: el índice guarda el texto VISIBLE del cuerpo
 * (`substringIndexText` de Hebra: el cuerpo con los destinos de enlaces y adjuntos, los
 * `hebra://…` y los `sha256:…` sustituidos por un espacio) plegado carácter a carácter
 * (sin mayúsculas ni tildes). Un literal que aparece en el cuerpo sin tocar ninguno de
 * esos trozos aparece en el texto visible, y su plegado en el plegado del índice. Las
 * excepciones, cada una cerrada aquí o en quien llama:
 * - El literal toca un trozo oculto: sin `[`, `]`, `|` ni `!` solo puede caer DENTRO del
 *   destino de un enlace con alias, de un `[[id:…]]`, de un `sha256:…` o de un
 *   `hebra://…` (o empezar en uno). Quien llama suma siempre las notas cuyo cuerpo tiene
 *   alguno (`grepSubstringCandidates`); con esos caracteres en el literal, `null`.
 * - Sin distinguir mayúsculas, JavaScript iguala caracteres que FTS5 no: solo dentro de
 *   `TRIGRAM_SAFE_RANGES` y fuera de `TRIGRAM_UNSAFE_IGNORING_CASE`.
 * - Menos de `TRIGRAM_MIN_CHARS` caracteres: el índice no encuentra nada.
 * - Una nota aún en la cola del índice (`notes_trigram_pending`): quien llama la suma.
 * - El índice sin terminar de rellenar: quien llama no lo usa.
 */
export function trigramMatch(required: string | null, caseSensitive: boolean): string | null {
  if (required === null || TRIGRAM_HIDDEN_DELIMITERS.test(required)) return null;
  const codePoints = [...required].map((char) => char.codePointAt(0)!);
  if (codePoints.length < TRIGRAM_MIN_CHARS) return null;
  if (!codePoints.every((codePoint) => trigramSafeChar(codePoint, caseSensitive))) return null;
  return `body : "${required.replace(/"/g, '""')}"`;
}

/** ¿Es `index` la segunda mitad de un par suplente? Para no cortar un carácter. */
function isLowSurrogateAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Una línea larga, recortada a `GREP_LINE_MAX_CHARS` alrededor de la columna `column`
 * (1-based): unos `GREP_LINE_LEAD_CHARS` antes y el resto después, sin partir un par
 * suplente. `start` es la columna (1-based) donde empieza el recorte; si la línea cabe,
 * va entera y `start` es 1.
 */
export function clipAround(line: string, column: number): { text: string; start: number } {
  if (line.length <= GREP_LINE_MAX_CHARS) return { text: line, start: 1 };
  let from = Math.max(0, Math.min(column - 1 - GREP_LINE_LEAD_CHARS, line.length - GREP_LINE_MAX_CHARS));
  if (from > 0 && isLowSurrogateAt(line, from)) from -= 1;
  let to = Math.min(line.length, from + GREP_LINE_MAX_CHARS);
  if (to < line.length && isLowSurrogateAt(line, to)) to -= 1;
  return { text: line.slice(from, to), start: from + 1 };
}

/** Una línea de contexto: entera si cabe; si no, sus primeros `GREP_LINE_MAX_CHARS`
 *  caracteres (sin partir un par suplente) y `…`. */
export function clipContext(line: string): string {
  if (line.length <= GREP_LINE_MAX_CHARS) return line;
  let to = GREP_LINE_MAX_CHARS;
  if (isLowSurrogateAt(line, to)) to -= 1;
  return `${line.slice(0, to)}…`;
}
