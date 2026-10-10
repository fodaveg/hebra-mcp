/**
 * Analizador de apartados de una nota (D11, SPEC.md §5 «Notas por apartados»). Módulo
 * puro: trabaja con offsets sobre el cuerpo y devuelve cortes, nunca reserializa.
 *
 * Es código propio de hebra-mcp. La referencia de la semántica es `markdownHeadings` y
 * `resolveNoteFragment` de Hebra (`[[nota#Apartado]]`), que `node.ts` no exporta y que no
 * se importa de otro sitio; se copia solo el comportamiento:
 * - Encabezado ATX `^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$`, título sin los `#` de cierre.
 * - Títulos comparados como `normalizedHeading` (NFKC, recortado, espacios y tabuladores
 *   colapsados, minúsculas).
 * Diferencias deliberadas con Hebra: no cuentan las líneas del frontmatter inicial ni de
 * un bloque de código cercado (con las reglas de CommonMark), y los encabezados Setext
 * (subrayados con `===` o `---`) NO son apartados: menos falsos positivos al escribir.
 *
 * Tamaños y posiciones en unidades UTF-16 (`string.length`), como el resto de límites.
 */

/** Un encabezado de la nota, en orden de documento. */
export interface HeadingInfo {
  /** Título tal como está en la nota (sin `#` de apertura ni de cierre). */
  heading: string;
  level: number;
  /** Línea 1-based del encabezado. */
  line: number;
  /** Posición entre los encabezados con el mismo título normalizado (1-based). */
  occurrence: number;
  /** Cuántos encabezados de la nota comparten este título normalizado. */
  sameTitleCount: number;
  /** Offset del principio de la línea del encabezado. */
  start: number;
  /** Offset donde acaba el apartado (excluido): el del siguiente encabezado de nivel
   *  igual o menor, o el final del cuerpo. */
  end: number;
}

/** Lo que se enseña de un candidato de `ambiguous_heading` y del apartado leído. */
export interface SectionRef {
  heading: string;
  level: number;
  line: number;
  occurrence: number;
}

/** Máximo de candidatos que enseña `ambiguous_heading`. */
export const HEADING_CANDIDATES_MAX = 50;

/** Como `normalizedHeading` de Hebra. */
export function normalizedHeading(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/[ \t]+/g, ' ')
    .toLowerCase();
}

function headingTitle(raw: string): string {
  return raw
    .trim()
    .replace(/[ \t]+#+[ \t]*$/, '')
    .trim();
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;
const LIST_MARKER = /^(?:[-+*]|[0-9]{1,9}[.)])[ \t]/;

/**
 * Quita del principio de una línea espacios, tabuladores, marcadores de cita `>` y, con
 * `lists`, marcadores de lista (`-`, `+`, `*`, `1.`, `1)` con su espacio). Se peca de
 * detectar cercados de más y nunca de menos: un encabezado real no visto da
 * `heading_not_found` (seguro); uno falso escribiría donde no es.
 */
function stripContainers(text: string, lists: boolean): string {
  let rest = text;
  for (;;) {
    const trimmed = rest.replace(/^[ \t]+/, '');
    if (trimmed.startsWith('>')) rest = trimmed.slice(1);
    else if (lists && LIST_MARKER.test(trimmed)) rest = trimmed.replace(LIST_MARKER, '');
    else return trimmed;
  }
}

/** Tope del título que viaja por el socket y en la prueba de lo guardado. */
export const HEADING_PROOF_MAX_CHARS = 200;

/** Corta un título a `HEADING_PROOF_MAX_CHARS` sin partir un par suplente ni añadir `…`. */
export function capHeading(title: string): string {
  if (title.length <= HEADING_PROOF_MAX_CHARS) return title;
  const last = title.charCodeAt(HEADING_PROOF_MAX_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? HEADING_PROOF_MAX_CHARS - 1 : HEADING_PROOF_MAX_CHARS;
  return title.slice(0, end);
}

interface Line {
  from: number;
  /** Offset del final del texto de la línea, sin terminador. */
  textEnd: number;
  text: string;
}

function linesOf(body: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  while (from < body.length) {
    const newline = body.indexOf('\n', from);
    const next = newline < 0 ? body.length : newline + 1;
    let textEnd = newline < 0 ? body.length : newline;
    if (newline > from && body[newline - 1] === '\r') textEnd = newline - 1;
    lines.push({ from, textEnd, text: body.slice(from, textEnd) });
    from = next;
  }
  return lines;
}

/** Índice de la primera línea tras el frontmatter inicial (`---` … `---`), o 0 si no hay
 *  uno cerrado. */
function frontmatterEnd(lines: readonly Line[]): number {
  if (lines.length === 0 || !/^---[ \t]*$/.test(lines[0]!.text)) return 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[index]!.text)) return index + 1;
  }
  return 0;
}

/** Todos los encabezados de la nota, en orden de documento, con el final de su apartado. */
export function parseHeadings(body: string): HeadingInfo[] {
  const lines = linesOf(body);
  const found: Array<Omit<HeadingInfo, 'occurrence' | 'sameTitleCount' | 'end'>> = [];
  let fence: { char: string; length: number } | null = null;
  for (let index = frontmatterEnd(lines); index < lines.length; index += 1) {
    const line = lines[index]!;
    if (fence) {
      const close = FENCE_CLOSE.exec(stripContainers(line.text, false));
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(stripContainers(line.text, true));
    // Un cercado de acentos graves no admite acentos graves en su información.
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      continue;
    }
    const atx = ATX.exec(line.text);
    if (atx) {
      found.push({
        heading: headingTitle(atx[2] ?? ''),
        level: atx[1]!.length,
        line: index + 1,
        start: line.from
      });
    }
  }

  const counts = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const entry of found) {
    const key = normalizedHeading(entry.heading);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const headings: HeadingInfo[] = found.map((entry, position) => {
    const key = normalizedHeading(entry.heading);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    let end = body.length;
    for (let next = position + 1; next < found.length; next += 1) {
      if (found[next]!.level <= entry.level) {
        end = found[next]!.start;
        break;
      }
    }
    return { ...entry, occurrence, sameTitleCount: counts.get(key)!, end };
  });
  return headings;
}

export type HeadingSelection =
  | { ok: true; section: HeadingInfo }
  | { ok: false; code: 'heading_not_found' }
  | { ok: false; code: 'ambiguous_heading'; candidates: SectionRef[] };

export function sectionRef(section: HeadingInfo, capped = false): SectionRef {
  return {
    heading: capped ? capHeading(section.heading) : section.heading,
    level: section.level,
    line: section.line,
    occurrence: section.occurrence
  };
}

/**
 * Elige un apartado por título y, si hace falta, por su aparición. Sin `occurrence`,
 * un título repetido no se adivina: `ambiguous_heading` con los candidatos (como mucho
 * `HEADING_CANDIDATES_MAX`). Con `occurrence`, la n-ésima o `heading_not_found`.
 */
export function selectSection(
  headings: readonly HeadingInfo[],
  heading: string,
  occurrence?: number
): HeadingSelection {
  const key = normalizedHeading(heading);
  const matches = headings.filter((entry) => normalizedHeading(entry.heading) === key);
  if (occurrence !== undefined) {
    const chosen = matches[occurrence - 1];
    return chosen ? { ok: true, section: chosen } : { ok: false, code: 'heading_not_found' };
  }
  if (matches.length === 0) return { ok: false, code: 'heading_not_found' };
  if (matches.length > 1) {
    return {
      ok: false,
      code: 'ambiguous_heading',
      candidates: matches.slice(0, HEADING_CANDIDATES_MAX).map((entry) => sectionRef(entry, true))
    };
  }
  return { ok: true, section: matches[0]! };
}

/** El apartado tal como lo devuelve la lectura: desde su línea de encabezado hasta su final. */
export function sectionText(body: string, section: HeadingInfo): string {
  return body.slice(section.start, section.end);
}

/** Línea 1-based en la que cae el offset `offset` del cuerpo. */
export function lineAt(body: string, offset: number): number {
  let line = 1;
  let index = body.indexOf('\n');
  while (index !== -1 && index < offset) {
    line += 1;
    index = body.indexOf('\n', index + 1);
  }
  return line;
}

/** Terminador de línea de la nota en `offset` o, si ahí no hay, el primero que aparezca;
 *  `\n` si la nota no tiene ninguno. */
function eolNear(body: string, offset: number): string {
  if (body.startsWith('\r\n', offset)) return '\r\n';
  if (body[offset] === '\n') return '\n';
  const first = body.indexOf('\n');
  return first > 0 && body[first - 1] === '\r' ? '\r\n' : '\n';
}

export interface Insertion {
  body: string;
  /** Offset, en el cuerpo NUEVO, donde empieza el texto insertado. */
  start: number;
  /** Offset, en el cuerpo NUEVO, donde acaba (excluido). */
  end: number;
}

/**
 * Inserta `text` al final del apartado `section` (subapartados incluidos): una línea en
 * blanco exacta entre el último contenido no en blanco y el texto, y al menos una entre
 * el texto y el encabezado siguiente. Nada más cambia: lo que había entre el último
 * contenido y el final del apartado (el terminador y los blancos de más) queda detrás del
 * texto, y en el último apartado se conserva el final que tuviera la nota.
 */
export function insertIntoSection(body: string, section: HeadingInfo, text: string): Insertion {
  // Fin del último contenido no en blanco del apartado (sin su terminador). Al menos la
  // línea del encabezado cuenta como contenido.
  let contentEnd = section.end;
  const lines = linesOf(body.slice(section.start, section.end));
  let lastContent = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.text.trim() !== '') lastContent = index;
  }
  if (lines.length > 0) contentEnd = section.start + lines[lastContent]!.textEnd;

  const eol = eolNear(body, contentEnd);
  const before = body.slice(0, contentEnd);
  const trailing = body.slice(contentEnd, section.end);
  const after = body.slice(section.end);
  const start = before.length + eol.length * 2;
  let tail = trailing;
  if (after.length > 0) {
    // Hay un encabezado detrás: al menos una línea en blanco entre el texto y él.
    const breaks = trailing.split('\n').length - 1;
    if (breaks === 0) tail = eol + eol;
    else if (breaks === 1) tail = trailing + eol;
  }
  return {
    body: `${before}${eol}${eol}${text}${tail}${after}`,
    start,
    end: start + text.length
  };
}

/** Insertar `text` al final de la nota, como siempre (`body + "\n\n" + text`). */
export function insertAtEnd(body: string, text: string, separator: string): Insertion {
  const start = body.length + separator.length;
  return { body: `${body}${separator}${text}`, start, end: start + text.length };
}

/** Marcas de coincidencia del `snippet` de la búsqueda (`SEARCH_MARK_START`/`_END` de
 *  `types.ts` de Hebra, que `node.ts` no exporta): caracteres de control. */
const SNIPPET_MARK_START = '\u0002';
const SNIPPET_MARK_END = '\u0003';
/** Un tramo del `snippet` más corto que esto no localiza nada con fiabilidad. */
const SNIPPET_PIECE_MIN_CHARS = 4;

/**
 * El título del apartado MÁS INTERNO que contiene el fragmento que enseña `snippet`
 * (D11, `hebra_search`), o `null` si cae antes del primer encabezado o no se localiza.
 *
 * El `snippet` no es un corte literal del cuerpo: FTS5 lo recorta, le pone marcas y
 * `cleanSearchPage` lo limpia (enlaces, `#`, marcadores de lista). Por eso se busca el
 * tramo literal MÁS LARGO sin marcas ni `…` que aparezca en el cuerpo; si ninguno de
 * longitud razonable aparece, la primera aparición del primer término marcado, sin
 * distinguir mayúsculas. El apartado más interno es el del último encabezado que empieza
 * antes (o en) esa posición: entre él y la posición no hay otro, así que la contiene.
 */
export function headingOfSnippet(body: string, snippet: string): string | null {
  const headings = parseHeadings(body);
  if (headings.length === 0) return null;
  const position = locateSnippet(body, snippet);
  if (position === null) return null;
  let found: HeadingInfo | null = null;
  for (const heading of headings) {
    if (heading.start > position) break;
    found = heading;
  }
  return found ? found.heading : null;
}

/**
 * El apartado MÁS INTERNO que contiene la línea `line` (1-based) de una nota cuyos
 * encabezados son `headings` (`parseHeadings`), o `null` si cae antes del primero (D13,
 * `hebra_grep`). Es el del último encabezado que empieza en esa línea o antes: entre él y
 * la línea no hay otro, así que su apartado llega al menos hasta ella (la misma regla que
 * `headingOfSnippet`). Una línea de encabezado es de su propio apartado.
 */
export function headingAtLine(headings: readonly HeadingInfo[], line: number): HeadingInfo | null {
  let found: HeadingInfo | null = null;
  for (const heading of headings) {
    if (heading.line > line) break;
    found = heading;
  }
  return found;
}

function locateSnippet(body: string, snippet: string): number | null {
  const pieces = snippet
    .split(new RegExp(`[${SNIPPET_MARK_START}${SNIPPET_MARK_END}…]`, 'u'))
    .filter((piece) => piece.trim().length >= SNIPPET_PIECE_MIN_CHARS)
    .sort((a, b) => b.length - a.length);
  for (const piece of pieces) {
    const index = body.indexOf(piece);
    if (index !== -1) return index;
  }
  const start = snippet.indexOf(SNIPPET_MARK_START);
  if (start === -1) return null;
  const end = snippet.indexOf(SNIPPET_MARK_END, start + 1);
  const term = snippet.slice(start + 1, end === -1 ? undefined : end);
  if (term.length === 0) return null;
  const index = body.toLowerCase().indexOf(term.toLowerCase());
  return index === -1 ? null : index;
}
