/**
 * `scripts/check-no-hebra-code.mjs`, comprobación 2 (líneas compartidas con `vendor/hebra`): solo
 * cuentan los bloques de 3 o más líneas significativas seguidas. Cada prueba usa ficheros reales
 * de `vendor/hebra/src` y la función que usa el script (`scripts/shared-lines.mjs`).
 *
 * 1. Negativa: 30 líneas seguidas copiadas de un fichero de Hebra superan el umbral (rojo).
 * 2. Frases sueltas: 30 líneas de Hebra, cada una separada de la anterior por otra propia, no
 *    cuentan (verde).
 * 3. El fichero real `src/server/tools/sheet-opt.ts` queda por debajo del umbral (verde).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error módulo .mjs sin tipos
import { addVendorRuns, sharedLineCount, significantLines } from '../../scripts/shared-lines.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const vendorDir = join(root, 'vendor', 'hebra');
/** El umbral del script: se lee de su código para que esta prueba no lo copie. */
const MAX_SHARED_LINES = Number(/const MAX_SHARED_LINES = (\d+);/.exec(readFileSync(join(root, 'scripts', 'check-no-hebra-code.mjs'), 'utf8'))?.[1]);

/** Los bloques de los dos motores de Hebra, como los junta el script. */
function vendorRuns(): Set<string> {
  const runs = new Set<string>();
  const dirs = [join(vendorDir, 'src'), join(vendorDir, 'src-tauri', 'src')];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|rs|svelte|js|mjs)$/.test(name)) addVendorRuns(runs, readFileSync(path, 'utf8'));
    }
  };
  for (const dir of dirs) walk(dir);
  return runs;
}

const FICHERO_DE_HEBRA = join(vendorDir, 'src', 'lib', 'sheets', 'opt', 'tab', 'model.ts');
const deHebra: string[] = significantLines(readFileSync(FICHERO_DE_HEBRA, 'utf8'));

describe('check-no-hebra-code: líneas compartidas por bloques', () => {
  const runs = vendorRuns();

  it('el umbral se lee del script', () => {
    expect(MAX_SHARED_LINES).toBe(25);
    expect(deHebra.length).toBeGreaterThan(200);
  });

  it('prueba negativa: 30 líneas seguidas copiadas de Hebra pasan el umbral', () => {
    const copia = deHebra.slice(50, 80).join('\n');
    const shared: number = sharedLineCount(copia, runs);
    expect(shared).toBe(30);
    expect(shared).toBeGreaterThan(MAX_SHARED_LINES);
  });

  it('30 líneas de Hebra sueltas (ninguna junto a otra) no cuentan', () => {
    const sueltas: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      // Cada línea de Hebra, de tres en tres del fichero original, con otra propia detrás.
      sueltas.push(deHebra[50 + i * 3], `const propia${i} = algoQueSoloExisteEnElMcp(${i}, 'texto propio ${i}');`);
    }
    const shared: number = sharedLineCount(sueltas.join('\n'), runs);
    expect(shared).toBe(0);
  });

  it('src/server/tools/sheet-opt.ts queda por debajo del umbral', () => {
    const files = execFileSync('git', ['ls-files', 'src/server/tools/sheet-opt.ts'], { cwd: root, encoding: 'utf8' }).trim();
    expect(files).toBe('src/server/tools/sheet-opt.ts');
    const shared: number = sharedLineCount(readFileSync(join(root, files), 'utf8'), runs);
    expect(shared).toBeLessThanOrEqual(MAX_SHARED_LINES);
  });
});
