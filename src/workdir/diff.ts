/**
 * Diff por líneas propio (SPEC.md §13.5), sin depender de `diff` del sistema (en Windows
 * no está). Tres salidas:
 *
 * - `unifiedDiff`: el formato unificado de siempre (`---`/`+++`, `@@ -a,b +c,d @@` y 3
 *   líneas de contexto), con `\ No newline at end of file` cuando un lado no acaba en
 *   salto de línea. Es lo que guarda `lotes/<lote>/cambios.diff` y lo que imprime `diff`.
 * - `diffStat`: líneas añadidas y quitadas.
 * - `compactDiff`: solo las líneas cambiadas, cada una recortada alrededor de la primera
 *   diferencia con su pareja, para la salida de `apply` (con tope por nota).
 *
 * Las líneas se comparan byte a byte (un `\r` de fin de línea de Windows cuenta), porque
 * el `.md` es el cuerpo de la nota tal cual.
 *
 * Algoritmo: se quitan el prefijo y el sufijo comunes y lo que queda va por Myers (O(ND))
 * guardando por cada paso solo la franja `[-d, d]` del vector, en `Int32Array`. Con
 * `MAX_EDIT_DISTANCE` pasos sin terminar (unas 16 M de enteros, 64 MB), se da todo el
 * tramo central como quitado y añadido: el diff sigue siendo correcto, solo menos fino.
 */

/** Pasos de Myers antes de rendirse y dar el tramo central entero como cambiado. */
export const MAX_EDIT_DISTANCE = 4_000;
const CONTEXT_LINES = 3;

type Op = { kind: 'equal' | 'delete' | 'insert'; line: string };

interface SplitText {
  lines: string[];
  /** ¿Acaba el texto en `\n`? */
  newlineAtEnd: boolean;
}

function splitLines(text: string): SplitText {
  if (text.length === 0) return { lines: [], newlineAtEnd: true };
  const lines = text.split('\n');
  const newlineAtEnd = lines[lines.length - 1] === '';
  if (newlineAtEnd) lines.pop();
  return { lines, newlineAtEnd };
}

/** Script de edición de `a` a `b` sobre el tramo central (sin prefijo ni sufijo comunes). */
function myers(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ kind: 'insert', line }));
  if (m === 0) return a.map((line) => ({ kind: 'delete', line }));
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  // trace[d] guarda V[k] para k en [-d, d], en la posición k + d.
  const trace: Int32Array[] = [];
  let previous = new Int32Array(1);
  let found = -1;
  for (let d = 0; d <= max; d += 1) {
    const current = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      const at = (kk: number): number => previous[kk + (d - 1)];
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d || (k !== d && at(k - 1) < at(k + 1))) x = at(k + 1);
      else x = at(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      current[k + d] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(current);
    previous = current;
    if (found !== -1) break;
  }
  if (found === -1) {
    return [
      ...a.map((line): Op => ({ kind: 'delete', line })),
      ...b.map((line): Op => ({ kind: 'insert', line }))
    ];
  }
  // Vuelta atrás desde (n, m).
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d - 1];
    const k = x - y;
    const at = (kk: number): number => prev[kk + (d - 1)];
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: 'equal', line: a[x] });
    }
    if (down) {
      y -= 1;
      ops.push({ kind: 'insert', line: b[y] });
    } else {
      x -= 1;
      ops.push({ kind: 'delete', line: a[x] });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    ops.push({ kind: 'equal', line: a[x] });
  }
  return ops.reverse();
}

/** Script de edición completo, línea a línea. */
function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return [
    ...a.slice(0, start).map((line): Op => ({ kind: 'equal', line })),
    ...myers(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map((line): Op => ({ kind: 'equal', line }))
  ];
}

/** Ops con los números de línea de cada lado (1-based) y si es la última línea. */
interface NumberedOp extends Op {
  aLine: number;
  bLine: number;
}

function numbered(ops: readonly Op[]): NumberedOp[] {
  let aLine = 1;
  let bLine = 1;
  return ops.map((op) => {
    const out = { ...op, aLine, bLine };
    if (op.kind !== 'insert') aLine += 1;
    if (op.kind !== 'delete') bLine += 1;
    return out;
  });
}

/**
 * Diff unificado de `before` a `after`, con `label` en las cabeceras (`a/` y `b/`). Cadena
 * vacía si son iguales.
 */
export function unifiedDiff(before: string, after: string, label: string): string {
  if (before === after) return '';
  const a = splitLines(before);
  const b = splitLines(after);
  // Si solo cambia el salto final, la última línea cuenta como distinta.
  const aLines = [...a.lines];
  const bLines = [...b.lines];
  const NO_EOL = '\u0000';
  if (!a.newlineAtEnd && aLines.length > 0) aLines[aLines.length - 1] += NO_EOL;
  if (!b.newlineAtEnd && bLines.length > 0) bLines[bLines.length - 1] += NO_EOL;
  const ops = numbered(diffOps(aLines, bLines));
  const changed = ops.map((op, index) => (op.kind === 'equal' ? -1 : index)).filter((i) => i >= 0);
  if (changed.length === 0) return '';
  // Agrupar los cambios en tramos con su contexto.
  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, index + CONTEXT_LINES);
    const last = hunks[hunks.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }
  const out = [`--- a/${label}`, `+++ b/${label}`];
  for (const [from, to] of hunks) {
    const slice = ops.slice(from, to + 1);
    const aCount = slice.filter((op) => op.kind !== 'insert').length;
    const bCount = slice.filter((op) => op.kind !== 'delete').length;
    const aStart = aCount === 0 ? slice[0].aLine - 1 : slice[0].aLine;
    const bStart = bCount === 0 ? slice[0].bLine - 1 : slice[0].bLine;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of slice) {
      const mark = op.kind === 'equal' ? ' ' : op.kind === 'delete' ? '-' : '+';
      if (op.line.endsWith(NO_EOL)) {
        out.push(`${mark}${op.line.slice(0, -1)}`);
        out.push('\\ No newline at end of file');
      } else {
        out.push(`${mark}${op.line}`);
      }
    }
  }
  return `${out.join('\n')}\n`;
}

/** Líneas añadidas y quitadas de `before` a `after`. */
export function diffStat(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 };
  const ops = diffOps(splitLines(before).lines, splitLines(after).lines);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === 'insert') added += 1;
    else if (op.kind === 'delete') removed += 1;
  }
  // Solo cambió el salto final: una línea distinta.
  if (added === 0 && removed === 0) return { added: 1, removed: 1 };
  return { added, removed };
}

function firstDifference(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) if (a[index] !== b[index]) return index;
  return length;
}

/** Un trozo de `line` alrededor de `at`, con `…` donde se corta. */
function around(line: string, at: number, before = 40, after = 80): string {
  const start = Math.max(0, at - before);
  const end = Math.min(line.length, at + after);
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

/**
 * Las líneas cambiadas, `- ` y `+ ` (cada quitada con la añadida que la sustituye, si la
 * hay), recortadas alrededor de la primera diferencia. Como mucho `maxLines`; si hay más,
 * una línea final dice cuántas faltan.
 */
export function compactDiff(before: string, after: string, maxLines = 6): string[] {
  const ops = diffOps(splitLines(before).lines, splitLines(after).lines);
  const pairs: string[] = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].kind === 'equal') {
      index += 1;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (index < ops.length && ops[index].kind !== 'equal') {
      if (ops[index].kind === 'delete') removed.push(ops[index].line);
      else added.push(ops[index].line);
      index += 1;
    }
    const count = Math.max(removed.length, added.length);
    for (let i = 0; i < count; i += 1) {
      const minus = removed[i];
      const plus = added[i];
      const at = minus !== undefined && plus !== undefined ? firstDifference(minus, plus) : 0;
      if (minus !== undefined) pairs.push(`- ${around(minus, at)}`);
      if (plus !== undefined) pairs.push(`+ ${around(plus, at)}`);
    }
  }
  if (pairs.length === 0 && before !== after) pairs.push('(solo cambia el salto de línea final)');
  if (pairs.length <= maxLines) return pairs;
  return [...pairs.slice(0, maxLines), `(… ${pairs.length - maxLines} líneas cambiadas más)`];
}
