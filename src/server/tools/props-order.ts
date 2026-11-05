/**
 * El orden de `hebra_query_properties` (SPEC.md §5, §6.3): el de `props_query` del motor, con una
 * diferencia a propósito, que es la razón de que esté aquí: si una clave ordena como número se
 * decide mirando solo los valores de notas VISIBLES. El motor mira toda la biblioteca, y un valor
 * no numérico en una nota oculta cambiaría el orden de las visibles (`src/store/props-sql.ts`).
 *
 * Las reglas, las de `PropsQuerySort`:
 * - Sin clave: por `title_norm` e id, en el sentido pedido (fase `t`).
 * - Con clave: las notas con valor (fase `v`) y las que no lo tienen (fase `m`, por título y id,
 *   siempre ascendente); primero las de valor, o al revés con `empty: 'first'`.
 * - En la fase `v`, una nota con varios valores ordena por el menor si asciende y por el mayor si
 *   desciende; el empate, por id en el mismo sentido. Si TODOS los valores visibles de la clave
 *   empiezan por un número, se comparan como número; si no, como texto, sin distinguir mayúsculas
 *   ASCII y por bytes UTF-8, como `COLLATE NOCASE`.
 * - `null`, `~` y el valor vacío de YAML cuentan como que no hay valor.
 *
 * La clave de orden es también el cursor (`sliceAfterKey`): reanuda en su sitio aunque la última
 * nota devuelta ya no esté en la lista (listar y editar esa propiedad es el uso previsto). El
 * texto se corta a `SORT_TEXT_MAX_CHARS` puntos de código, también al comparar, para que el cursor
 * quepa en su tope con cualquier valor: dos valores con esos mismos primeros caracteres ordenan
 * por id. Como `hebra_list_files` con los nombres.
 */
import { ToolError } from '../errors';

/** Puntos de código de un valor o un título que entran en la clave de orden y en el cursor. */
export const SORT_TEXT_MAX_CHARS = 128;

export interface PropsSort {
  /** Ya en minúsculas, como las guarda `note_props`. `null`: por título. */
  key: string | null;
  direction: 'ascending' | 'descending';
  empty: 'first' | 'last';
}

type Phase = 'v' | 'm' | 't';

export interface SortKey {
  phase: Phase;
  /** Solo si la clave se compara como número. */
  number: number | null;
  text: string;
  id: string;
  /** `text` como se compara. No viaja en el cursor: sale de los otros campos. */
  bytes: Buffer;
}

function clip(text: string): string {
  if (text.length <= SORT_TEXT_MAX_CHARS) return text;
  return Array.from(text).slice(0, SORT_TEXT_MAX_CHARS).join('');
}

function makeKey(phase: Phase, number: number | null, text: string, id: string): SortKey {
  const clipped = clip(text);
  // Solo el valor pliega mayúsculas: `title_norm` ya viene plegado y el motor lo compara tal cual.
  const compared = phase === 'v' ? clipped.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : clipped;
  return { phase, number, text: clipped, id, bytes: Buffer.from(compared, 'utf8') };
}

/** ¿Cuenta como valor? `null` y `~` de YAML llegan como texto, y `''` es una clave sin valor. */
export function isPresentValue(value: string): boolean {
  const lowered = value.toLowerCase();
  return lowered !== '' && lowered !== 'null' && lowered !== '~';
}

/** El valor sin las comillas de los extremos que Obsidian añade a un número (`'31.11'`). */
function unquoted(value: string): string {
  return value.replace(/^['"]+|['"]+$/g, '');
}

/** ¿Empieza por un número, sin ser una fecha ISO (que como número sería solo su año)? */
function hasNumericPrefix(value: string): boolean {
  const text = unquoted(value);
  return /^[+-]?[0-9]/.test(text) && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(text);
}

/** El número del principio del valor; acotado, porque el cursor es JSON y no lleva infinitos. */
function numericPrefix(value: string): number {
  const number = Number.parseFloat(unquoted(value));
  return Math.min(Math.max(number, -Number.MAX_VALUE), Number.MAX_VALUE);
}

function comparePhases(sort: PropsSort, left: Phase, right: Phase): number {
  if (left === right) return 0;
  const missingFirst = sort.empty === 'first';
  return (left === 'm') === missingFirst ? -1 : 1;
}

/** El orden total de dos claves, con el mismo sentido en la página y en el cursor. */
export function compareSortKeys(sort: PropsSort, left: SortKey, right: SortKey): number {
  const phases = comparePhases(sort, left.phase, right.phase);
  if (phases !== 0) return phases;
  const sign = left.phase !== 'm' && sort.direction === 'descending' ? -1 : 1;
  let result =
    left.number !== null && right.number !== null
      ? left.number - right.number
      : Buffer.compare(left.bytes, right.bytes);
  if (result === 0) result = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  return sign * result;
}

/**
 * Cómo se saca la clave de orden de cada nota. `visibleValues`: los valores, por nota, de la
 * clave de orden en TODAS las notas visibles (no solo las que cumplen los filtros: el modo no
 * depende del filtro, como en el motor), y solo en ellas.
 */
export function buildSortKeys(
  sort: PropsSort,
  visibleValues: ReadonlyMap<string, readonly string[]>
): (note: { id: string; titleNorm: string }) => SortKey {
  if (sort.key === null) return (note) => makeKey('t', null, note.titleNorm, note.id);
  const present = new Map<string, string[]>();
  let numeric = true;
  for (const [noteId, values] of visibleValues) {
    const usable = values.filter(isPresentValue);
    if (usable.length === 0) continue;
    present.set(noteId, usable);
    numeric &&= usable.every(hasNumericPrefix);
  }
  const descending = sort.direction === 'descending';
  return (note) => {
    const values = present.get(note.id);
    if (!values) return makeKey('m', null, note.titleNorm, note.id);
    const keys = values.map((value) =>
      makeKey('v', numeric ? numericPrefix(value) : null, value, note.id)
    );
    return keys.reduce((best, key) => {
      const order = key.number !== null && best.number !== null
        ? key.number - best.number
        : Buffer.compare(key.bytes, best.bytes);
      return (descending ? order > 0 : order < 0) ? key : best;
    });
  };
}

export function encodeSortKey(key: SortKey): string {
  return JSON.stringify([key.phase, key.number, key.text, key.id]);
}

/** Deshace `encodeSortKey`. Un cursor ilegible o de otro orden (con clave o sin ella), `invalid_input`. */
export function decodeSortKey(sort: PropsSort, raw: string): SortKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError('invalid_input');
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) throw new ToolError('invalid_input');
  const [phase, number, text, id] = parsed as unknown[];
  const phaseFits = sort.key === null ? phase === 't' : phase === 'v' || phase === 'm';
  if (
    !phaseFits ||
    (number !== null && (typeof number !== 'number' || !Number.isFinite(number))) ||
    typeof text !== 'string' ||
    typeof id !== 'string' ||
    id === ''
  ) {
    throw new ToolError('invalid_input');
  }
  return makeKey(phase as Phase, number as number | null, text, id);
}
