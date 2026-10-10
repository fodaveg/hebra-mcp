/**
 * Núcleo de `hebra_replace_in_notes` (D14, SPEC.md §5): módulo puro, sin almacén ni
 * privacidad. Código propio de hebra-mcp.
 *
 * - **Patrón**: el de `hebra_grep` (`compileGrepPattern` de `./grep.ts`), con sus mismas
 *   reglas, topes y plegado: literal o expresión regular de JavaScript con la bandera `u`
 *   (e `i` sin distinguir mayúsculas), línea a línea con la convención de líneas de D11
 *   (`\n` y `\r\n`; la `\r` no es parte de la línea). Nada casa a través de un salto de
 *   línea, y `^`/`$` son el principio y el final de la LÍNEA. Aquí, con la bandera `g`: se
 *   sustituyen todas las coincidencias de cada línea.
 * - **Reemplazo** (`compileReplacement`): con un literal, el texto tal cual (un `$` es un
 *   `$`). Con una expresión regular, la sintaxis de `String.prototype.replace` acotada para
 *   que nada se interprete en silencio: `$$` es un `$`, `$&` la coincidencia entera, `$1`…
 *   `$99` un grupo (dos cifras si ese grupo existe; si no, una) y `$<nombre>` un grupo con
 *   nombre. Cualquier otro `$` (`` $` ``, `$'`, `$0`, un grupo que no existe, un `$` al final)
 *   no vale: `null` (`invalid_input`). Un grupo que no participó en la coincidencia pone
 *   texto vacío, como en JavaScript.
 * - **Sustitución** (`replaceBodyLines`): autocontenida A PROPÓSITO, como `scanBody`: el
 *   hilo de las expresiones regulares (`./replace-worker.ts`) recibe su código fuente, así
 *   que el hilo principal (literales) y el hilo (expresiones) sustituyen con el mismo código.
 */
import { createHash } from 'node:crypto';
import type { PrivacyConfig } from '../privacy/config';
import { GREP_LINE_MAX_CHARS, clipAround, type GrepPattern } from './grep';

/** Tope de notas por plan (D14: «unas 200»). También el valor por defecto de `maxNotes`. */
export const REPLACE_MAX_NOTES = 200;
/** Tope del texto de reemplazo, en unidades UTF-16. */
export const REPLACEMENT_MAX_CHARS = 10_000;
/** Tope de la SUMA de los cuerpos resultantes de un plan (se guardan enteros: lo que se
 *  aplica es exactamente lo simulado). Al llegar, el plan se corta (`cutoff: "size"`). */
export const PLAN_RESULT_MAX_CHARS = 5_000_000;
/** Cambios (líneas antes/después) que la simulación enseña por nota. */
export const PREVIEW_CHANGES_PER_NOTE = 3;
/** Ids de una lista explícita (`ids`) en el ámbito. */
export const REPLACE_SCOPE_MAX_IDS = REPLACE_MAX_NOTES;

/** Un trozo del texto de reemplazo ya analizado. `group` 0 es la coincidencia entera. */
export type ReplacementPart =
  | { kind: 'text'; text: string }
  | { kind: 'group'; index: number }
  | { kind: 'named'; name: string };

/** Número de grupos y nombres de los grupos con nombre de una expresión (ya compilada). */
function groupsOf(re: RegExp): { count: number; names: Set<string> } {
  // Una alternativa vacía casa siempre con '' y deja todos los grupos sin valor: así se ven
  // cuántos hay sin analizar la sintaxis. El grupo sin captura no cambia la numeración.
  const probe = new RegExp(`(?:${re.source})|`, re.flags.replace(/[gy]/g, '')).exec('');
  return {
    count: probe ? probe.length - 1 : 0,
    names: new Set(probe?.groups ? Object.keys(probe.groups) : [])
  };
}

/**
 * Analiza el texto de reemplazo (ver la cabecera). `null` si no vale: más largo que el
 * tope o, con una expresión regular, un `$` que no es de los admitidos.
 */
export function compileReplacement(template: string, pattern: GrepPattern): ReplacementPart[] | null {
  if (template.length > REPLACEMENT_MAX_CHARS) return null;
  if (pattern.literal) return template.length === 0 ? [] : [{ kind: 'text', text: template }];
  const { count, names } = groupsOf(pattern.re);
  const parts: ReplacementPart[] = [];
  let text = '';
  const flush = (): void => {
    if (text.length > 0) parts.push({ kind: 'text', text });
    text = '';
  };
  const isDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9';
  for (let index = 0; index < template.length; ) {
    const char = template[index]!;
    if (char !== '$') {
      text += char;
      index += 1;
      continue;
    }
    const next = template[index + 1];
    if (next === '$') {
      text += '$';
      index += 2;
      continue;
    }
    if (next === '&') {
      flush();
      parts.push({ kind: 'group', index: 0 });
      index += 2;
      continue;
    }
    if (next === '<') {
      const close = template.indexOf('>', index + 2);
      if (close < 0) return null;
      const name = template.slice(index + 2, close);
      if (!names.has(name)) return null;
      flush();
      parts.push({ kind: 'named', name });
      index = close + 1;
      continue;
    }
    if (isDigit(next)) {
      const second = template[index + 2];
      const two = isDigit(second) ? Number(`${next}${second}`) : -1;
      const one = Number(next);
      flush();
      if (two >= 1 && two <= count) {
        parts.push({ kind: 'group', index: two });
        index += 3;
        continue;
      }
      if (one >= 1 && one <= count) {
        parts.push({ kind: 'group', index: one });
        index += 2;
        continue;
      }
      return null;
    }
    return null;
  }
  flush();
  return parts;
}

/** Lo que `replaceBodyLines` devuelve de un cuerpo. `changes`: `[línea, antes, después]` de
 *  las primeras líneas que cambiaron (la línea, 1-based, es la del cuerpo base; `antes` y
 *  `después` sin terminador; `después` puede llevar saltos de línea si el reemplazo los
 *  tiene). */
export interface ReplaceLinesResult {
  body: string;
  count: number;
  changes: Array<[number, string, string]>;
}

/**
 * Sustituye, línea a línea, todas las coincidencias de `re` (con la bandera `g`) por
 * `parts`. `count`: coincidencias sustituidas (también las vacías, como las de `^`). Los
 * terminadores de línea se conservan tal cual (`\r\n` incluido); un salto de línea al
 * final no abre una línea más, igual que en `scanBody`.
 *
 * Autocontenida A PROPÓSITO (sin nada de fuera de su cuerpo): ver la cabecera.
 */
export function replaceBodyLines(
  body: string,
  re: RegExp,
  parts: ReadonlyArray<ReplacementPart>,
  maxChanges: number
): ReplaceLinesResult {
  const changes: Array<[number, string, string]> = [];
  let out = '';
  let count = 0;
  const length = body.length;
  let from = 0;
  let line = 1;
  const build = (args: unknown[]): string => {
    const last = args[args.length - 1];
    const named = typeof last === 'object' && last !== null ? (last as Record<string, unknown>) : null;
    let piece = '';
    for (const part of parts) {
      if (part.kind === 'text') {
        piece += part.text;
      } else if (part.kind === 'group') {
        const value = args[part.index];
        if (typeof value === 'string') piece += value;
      } else {
        const value = named ? named[part.name] : undefined;
        if (typeof value === 'string') piece += value;
      }
    }
    return piece;
  };
  while (from < length) {
    const newline = body.indexOf('\n', from);
    let end = newline < 0 ? length : newline;
    if (newline > from && body.charCodeAt(newline - 1) === 13) end = newline - 1;
    const text = body.slice(from, end);
    let found = 0;
    re.lastIndex = 0;
    const replaced = text.replace(re, (...args: unknown[]) => {
      found += 1;
      return build(args);
    });
    out += replaced;
    out += body.slice(end, newline < 0 ? length : newline + 1);
    if (found > 0) {
      count += found;
      if (replaced !== text && changes.length < maxChanges) changes.push([line, text, replaced]);
    }
    if (newline < 0) break;
    from = newline + 1;
    line += 1;
  }
  return { body: out, count, changes };
}

/** La versión global (`g`) de la expresión de `compileGrepPattern`, para sustituir. */
export function globalPattern(pattern: GrepPattern): RegExp {
  return new RegExp(pattern.re.source, `${pattern.re.flags}g`);
}

/** Una línea cambiada, como la enseña la simulación: la línea (1-based, del cuerpo base),
 *  la columna (1-based) de la primera diferencia y el texto de antes y de después,
 *  recortados a `GREP_LINE_MAX_CHARS` alrededor de esa columna (como `hebra_grep`). */
export interface ReplaceChange {
  line: number;
  column: number;
  before: string;
  after: string;
}

/** `[línea, antes, después]` de `replaceBodyLines` como `ReplaceChange`. */
export function previewChange([line, before, after]: [number, string, string]): ReplaceChange {
  let column = 0;
  const shortest = Math.min(before.length, after.length);
  while (column < shortest && before.charCodeAt(column) === after.charCodeAt(column)) column += 1;
  // Sin partir un par suplente: la diferencia empieza en el carácter entero.
  if (column > 0 && column < before.length) {
    const code = before.charCodeAt(column);
    if (code >= 0xdc00 && code <= 0xdfff) column -= 1;
  }
  return {
    line,
    column: column + 1,
    before: before.length <= GREP_LINE_MAX_CHARS ? before : clipAround(before, column + 1).text,
    after: after.length <= GREP_LINE_MAX_CHARS ? after : clipAround(after, column + 1).text
  };
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Huella de una configuración de privados: un plan solo vale con la misma con la que se
 * calculó (D14). Ordenada, para que el orden de `config.json` no cuente.
 */
export function privacyFingerprint(config: PrivacyConfig): string {
  return sha256Hex(
    JSON.stringify([
      config.privateFolders.map((segments) => segments.join('\u0000')).sort(),
      [...config.privateTags].sort()
    ])
  );
}
