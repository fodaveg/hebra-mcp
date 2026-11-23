/**
 * Cómputo de líneas compartidas de `check-no-hebra-code.mjs` (§2 de su cabecera), aparte para que
 * `test/scripts/check-no-hebra-code.test.ts` lo pruebe sin tocar git. Sin dependencias.
 */

/** Más de esta longitud (tras recortar espacios) para contar como línea significativa. */
export const SIGNIFICANT_LINE_LEN = 30;
/** Líneas significativas SEGUIDAS que forman un bloque (una frase suelta de 1 o 2 no cuenta). */
export const MIN_RUN = 3;

/** Líneas recortadas de más de `SIGNIFICANT_LINE_LEN` caracteres, en su orden. */
export function significantLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > SIGNIFICANT_LINE_LEN);
}

const runKey = (lines, at) => lines.slice(at, at + MIN_RUN).join('\n');

/**
 * Los bloques de `MIN_RUN` líneas significativas seguidas de un fichero de Hebra. Un bloque solo
 * casa con otro del MISMO fichero, y como cada fichero aporta los suyos, basta un set común.
 */
export function addVendorRuns(runs, vendorText) {
  const lines = significantLines(vendorText);
  for (let at = 0; at + MIN_RUN <= lines.length; at += 1) runs.add(runKey(lines, at));
}

/**
 * Líneas significativas de `text` que forman parte de un bloque de `MIN_RUN` o más líneas
 * significativas seguidas que también están seguidas en un fichero de Hebra (`runs`).
 */
export function sharedLineCount(text, runs) {
  const lines = significantLines(text);
  const covered = new Set();
  for (let at = 0; at + MIN_RUN <= lines.length; at += 1) {
    if (!runs.has(runKey(lines, at))) continue;
    for (let i = at; i < at + MIN_RUN; i += 1) covered.add(i);
  }
  return covered.size;
}
