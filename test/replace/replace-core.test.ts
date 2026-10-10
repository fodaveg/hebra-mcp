/**
 * Núcleo puro de `hebra_replace_in_notes` (D14, `src/store/replace.ts`): el texto de
 * reemplazo (qué `$` valen) y la sustitución línea a línea, con la misma convención de
 * líneas que `hebra_grep`.
 */
import { describe, expect, it } from 'vitest';
import { compileGrepPattern } from '../../src/store/grep';
import {
  compileReplacement,
  globalPattern,
  previewChange,
  privacyFingerprint,
  replaceBodyLines,
  REPLACEMENT_MAX_CHARS
} from '../../src/store/replace';

function run(body: string, pattern: string, replacement: string, options: { regex?: boolean; caseSensitive?: boolean } = {}) {
  const compiled = compileGrepPattern(pattern, { regex: options.regex === true, caseSensitive: options.caseSensitive === true });
  if (!compiled) throw new Error('patrón inválido');
  const parts = compileReplacement(replacement, compiled);
  if (!parts) throw new Error('reemplazo inválido');
  return replaceBodyLines(body, globalPattern(compiled), parts, 3);
}

describe('compileReplacement', () => {
  const regex = compileGrepPattern('(a)(?<b>b)', { regex: true, caseSensitive: true })!;
  const literal = compileGrepPattern('a', { regex: false, caseSensitive: true })!;

  it('con un literal, el reemplazo es texto tal cual: un `$` es un `$`', () => {
    expect(compileReplacement('$1 $& $$ $', literal)).toEqual([{ kind: 'text', text: '$1 $& $$ $' }]);
    expect(compileReplacement('', literal)).toEqual([]);
  });

  it('con una expresión: $$, $&, $n (dos cifras si existe el grupo) y $<nombre>', () => {
    expect(compileReplacement('x$1y$2$&$$z$<b>', regex)).toEqual([
      { kind: 'text', text: 'x' },
      { kind: 'group', index: 1 },
      { kind: 'text', text: 'y' },
      { kind: 'group', index: 2 },
      { kind: 'group', index: 0 },
      { kind: 'text', text: '$z' },
      { kind: 'named', name: 'b' }
    ]);
    // `$12` con dos grupos: el 1 y un «2» literal.
    expect(compileReplacement('$12', regex)).toEqual([
      { kind: 'group', index: 1 },
      { kind: 'text', text: '2' }
    ]);
  });

  it('cualquier otro `$` no vale: nada se interpreta en silencio', () => {
    for (const bad of ['$`', "$'", '$0', '$3', '$<c>', '$<b', 'fin$', '$x']) {
      expect(compileReplacement(bad, regex), bad).toBeNull();
    }
    expect(compileReplacement('x'.repeat(REPLACEMENT_MAX_CHARS + 1), literal)).toBeNull();
  });
});

describe('replaceBodyLines', () => {
  it('sustituye todas las coincidencias de cada línea y cuenta todas', () => {
    const result = run('# T\nuno uno\ndos\nuno\n', 'uno', '1');
    expect(result.body).toBe('# T\n1 1\ndos\n1\n');
    expect(result.count).toBe(3);
    expect(result.changes).toEqual([
      [2, 'uno uno', '1 1'],
      [4, 'uno', '1']
    ]);
  });

  it('conserva `\\r\\n` y el final sin salto; nada casa a través de un salto de línea', () => {
    expect(run('a\r\nb\r\na', 'a', 'x').body).toBe('x\r\nb\r\nx');
    expect(run('a\nb\n', 'a\\s*b', 'x', { regex: true }).count).toBe(0);
    // `$` es el final de la LÍNEA, no del cuerpo, y la `\r` no es parte de la línea.
    expect(run('fin\r\nfin\r\n', 'n$', 'N', { regex: true }).body).toBe('fiN\r\nfiN\r\n');
  });

  it('^ añade al principio de cada línea (coincidencia vacía) y los grupos con nombre', () => {
    expect(run('a\n\nb\n', '^', '> ', { regex: true }).body).toBe('> a\n> \n> b\n');
    expect(run('2026-10-10\n', '(?<y>\\d{4})-(?<m>\\d\\d)-(?<d>\\d\\d)', '$<d>/$<m>/$<y>', { regex: true }).body).toBe(
      '10/10/2026\n'
    );
    // Un grupo que no participó pone texto vacío, como en JavaScript.
    expect(run('ab\n', '(x)?b', '[$1]', { regex: true }).body).toBe('a[]\n');
  });

  it('sin distinguir mayúsculas con el plegado de hebra_grep; las tildes cuentan', () => {
    expect(run('Canción CANCIÓN cancion\n', 'canción', 'X').body).toBe('X X cancion\n');
  });

  it('un cuerpo vacío no tiene líneas', () => {
    expect(run('', '^', 'x', { regex: true })).toEqual({ body: '', count: 0, changes: [] });
  });
});

describe('previewChange y privacyFingerprint', () => {
  it('la columna es la de la primera diferencia y una línea larga se recorta a su alrededor', () => {
    expect(previewChange([3, 'hola mundo', 'hola Mundo'])).toEqual({ line: 3, column: 6, before: 'hola mundo', after: 'hola Mundo' });
    const long = `${'x'.repeat(1_000)}A${'y'.repeat(1_000)}`;
    const change = previewChange([1, long, long.replace('A', 'B')]);
    expect(change.column).toBe(1_001);
    expect(change.before.length).toBeLessThanOrEqual(300);
    expect(change.before).toContain('A');
    expect(change.after).toContain('B');
  });

  it('la huella de privados no depende del orden de config.json', () => {
    expect(privacyFingerprint({ privateFolders: [['a'], ['b', 'c']], privateTags: ['x', 'y'] })).toBe(
      privacyFingerprint({ privateFolders: [['b', 'c'], ['a']], privateTags: ['y', 'x'] })
    );
    expect(privacyFingerprint({ privateFolders: [], privateTags: [] })).not.toBe(
      privacyFingerprint({ privateFolders: [], privateTags: ['x'] })
    );
  });
});
