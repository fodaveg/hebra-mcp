/**
 * Núcleo de `hebra_grep` y de la lectura por líneas (D13, `src/store/grep.ts`): líneas,
 * recorrido, el trozo obligatorio de una expresión regular y la seguridad del prefiltro
 * de subcadena, medida contra el SQLite de verdad.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  clipAround,
  clipContext,
  compileGrepPattern,
  GREP_LINE_MAX_CHARS,
  lineStarts,
  lineText,
  requiredLiteral,
  scanBody,
  sliceLines,
  trigramMatch,
  trigramSafeChar
} from '../../src/store/grep';
import { headingAtLine, parseHeadings } from '../../src/store/sections';

describe('líneas', () => {
  it('la misma convención que los apartados: \\n y \\r\\n, sin línea de más al final', () => {
    expect(lineStarts('')).toEqual([]);
    expect(lineStarts('a')).toEqual([0]);
    expect(lineStarts('a\n')).toEqual([0]);
    expect(lineStarts('a\n\nb')).toEqual([0, 2, 3]);
    const body = '# T\r\nuno\r\n\r\ndos\rtres\n';
    const starts = lineStarts(body);
    expect(starts.map((_, index) => lineText(body, starts, index))).toEqual([
      '# T',
      'uno',
      '',
      'dos\rtres'
    ]);
    expect(sliceLines(body, starts, 2, 3)).toBe('uno\r\n\r\n');
    expect(sliceLines(body, starts, 4, 4)).toBe('dos\rtres\n');
    // La línea de un encabezado es la de `parseHeadings`.
    const headings = parseHeadings('intro\n# Uno\ntexto\n## Dos\nmás\n# Tres\n');
    expect(headings.map((heading) => heading.line)).toEqual([2, 4, 6]);
    expect([1, 2, 3, 4, 5, 6].map((line) => headingAtLine(headings, line)?.heading ?? null)).toEqual([
      null,
      'Uno',
      'Uno',
      'Dos',
      'Dos',
      'Tres'
    ]);
  });

  it('scanBody: desde una línea, con tope y sabiendo por dónde seguir', () => {
    const body = 'aXa\nb\nXX\r\nc\nX';
    const re = /X/u;
    expect(scanBody(body, re, 1, 10, false)).toEqual({ hits: [1, 2, 3, 1, 5, 1], next: 0 });
    expect(scanBody(body, re, 2, 10, false)).toEqual({ hits: [3, 1, 5, 1], next: 0 });
    expect(scanBody(body, re, 1, 2, false)).toEqual({ hits: [1, 2, 3, 1], next: 5 });
    expect(scanBody(body, /Z/u, 1, 10, true)).toEqual({ hits: [], next: 0 });
    // `$` casa al final de la línea, no antes del `\r` de un `\r\n`.
    expect(scanBody(body, /X$/u, 1, 10, false).hits).toEqual([3, 2, 5, 1]);
  });
});

describe('patrón', () => {
  it('un literal se escapa; con `u`, la sintaxis estricta', () => {
    const literal = compileGrepPattern('a.b(c)[d]/e-f', { regex: false, caseSensitive: true })!;
    expect(literal.re.test('xa.b(c)[d]/e-fx')).toBe(true);
    expect(literal.re.test('aXb(c)[d]/e-f')).toBe(false);
    expect(literal.required).toBe('a.b(c)[d]/e-f');
    expect(compileGrepPattern('a\\-b', { regex: true, caseSensitive: true })).toBeNull();
    expect(compileGrepPattern('ok\n', { regex: false, caseSensitive: true })).toBeNull();
  });

  it('requiredLiteral: el trozo que toda coincidencia contiene', () => {
    const cases: Array<[string, string | null]> = [
      ['abc', 'abc'],
      ['ab+c', 'ab'],
      ['abc?', 'ab'],
      ['abc*def', 'def'],
      ['a|bcd', null],
      ['(foo|x)bar', 'bar'],
      ['foo\\.bar', 'foo.bar'],
      ['\\d+abc', 'abc'],
      ['x{0,2}yz', 'yz'],
      ['xx{2}yz', 'xx'],
      ['\\p{L}abc', 'abc'],
      ['\\u{1F600}abc', 'abc'],
      ['[abc]def', 'def'],
      ['garbanzo \\d+$', 'garbanzo '],
      ['^- ', '- '],
      ['(?<=a)bcd', 'bcd'],
      ['abc+?d', 'abc'],
      ['\\bwordy\\b', 'wordy']
    ];
    for (const [source, expected] of cases) {
      expect(new RegExp(source, 'u'), source).toBeInstanceOf(RegExp);
      expect(requiredLiteral(source), source).toBe(expected);
    }
  });

  it('requiredLiteral nunca promete de más: toda coincidencia lo contiene', () => {
    const atoms = ['a', 'b', 'ab', '.', '\\.', '[ab]', '(a|b)', '\\d', 'á'];
    const quantifiers = ['', '?', '*', '+', '{0,2}', '{2}', '+?'];
    const subjects = ['', 'a', 'b', 'ab', 'ba', 'aab', 'abab', 'a.b', 'xáb', 'a1b', 'bba.', 'aaaa'];
    let checked = 0;
    for (const first of atoms) {
      for (const q1 of quantifiers) {
        for (const second of atoms) {
          for (const q2 of quantifiers) {
            const source = `${first}${q1}${second}${q2}c`;
            const re = new RegExp(source, 'u');
            const required = requiredLiteral(source);
            for (const subject of subjects) {
              for (const tail of ['c', 'xc', 'cc']) {
                const text = subject + tail;
                const found = re.exec(text);
                if (!found) continue;
                checked += 1;
                if (required !== null) expect(found[0], `${source} en ${text}`).toContain(required);
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1_000);
  });
});

describe('prefiltro de subcadena', () => {
  it('trigramMatch: solo con lo que el índice no se puede dejar', () => {
    expect(trigramMatch('ab', false)).toBeNull();
    expect(trigramMatch(null, false)).toBeNull();
    expect(trigramMatch('a[[b', false)).toBeNull();
    expect(trigramMatch('a|bc', false)).toBeNull();
    expect(trigramMatch('hola!', false)).toBeNull();
    expect(trigramMatch('café', true)).toBeNull();
    expect(trigramMatch('водка', false)).toBeNull(); // la `д` cirílica, sin mayúsculas
    expect(trigramMatch('водка', true)).toBe('body : "водка"');
    expect(trigramMatch('dice "sí"', false)).toBe('body : "dice ""sí"""');
    expect(trigramMatch('Canción', false)).toBe('body : "Canción"');
  });

  it('cada carácter seguro casa en el índice con todo lo que JavaScript iguala a él', () => {
    // Medido como en el comentario de `TRIGRAM_UNSAFE_IGNORING_CASE`: una fila por
    // carácter del plano básico, «q·x·q», y para cada carácter seguro `c`, la consulta
    // «q·c·q» tiene que traer todos los `x` que la bandera (`u` o `iu`) iguala a `c`.
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(
        "CREATE VIRTUAL TABLE t USING fts5(body, content='', contentless_delete=1, tokenize='trigram remove_diacritics 1')"
      );
      const insert = db.prepare('INSERT INTO t(rowid, body) VALUES (?, ?)');
      let all = '';
      db.exec('BEGIN');
      for (let codePoint = 0x20; codePoint <= 0xffff; codePoint += 1) {
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
        const char = String.fromCharCode(codePoint);
        insert.run(codePoint, `q${char}q`);
        all += char;
      }
      db.exec('COMMIT');
      const query = db.prepare('SELECT rowid FROM t WHERE t MATCH ?');
      let safe = 0;
      for (const caseSensitive of [true, false]) {
        for (let codePoint = 0x20; codePoint <= 0x20bf; codePoint += 1) {
          if (!trigramSafeChar(codePoint, caseSensitive)) continue;
          safe += 1;
          const char = String.fromCharCode(codePoint);
          const found = new Set(
            (query.all(`"q${char.replace(/"/g, '""')}q"`) as Array<{ rowid: number | bigint }>).map(
              (row) => Number(row.rowid)
            )
          );
          const same = new RegExp(char.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
          for (const match of all.matchAll(same)) {
            expect(found.has(all.charCodeAt(match.index!)), `${codePoint.toString(16)} ~ ${all.charCodeAt(match.index!).toString(16)}`).toBe(true);
          }
        }
      }
      expect(safe).toBeGreaterThan(2_900);
    } finally {
      db.close();
    }
  });
});

describe('recortes', () => {
  it('clipAround: alrededor de la columna, sin partir un par suplente', () => {
    const short = 'línea corta';
    expect(clipAround(short, 3)).toEqual({ text: short, start: 1 });
    const long = `${'a'.repeat(400)}X${'b'.repeat(400)}`;
    const clipped = clipAround(long, 401);
    expect(clipped.text.length).toBe(GREP_LINE_MAX_CHARS);
    expect(clipped.start).toBe(301);
    expect(clipped.text[401 - clipped.start]).toBe('X');
    // Al final de la línea, el trozo acaba en el final.
    expect(clipAround(long, 801).text.endsWith('b')).toBe(true);
    expect(clipAround(long, 801).start).toBe(long.length - GREP_LINE_MAX_CHARS + 1);
    const emoji = `${'😀'.repeat(300)}`;
    const piece = clipAround(emoji, 201).text;
    expect(piece.length).toBeLessThanOrEqual(GREP_LINE_MAX_CHARS);
    expect([...piece].every((char) => char === '😀')).toBe(true);
  });

  it('clipContext: por el final, con `…`', () => {
    expect(clipContext('corta')).toBe('corta');
    const cut = clipContext('😀'.repeat(200));
    expect(cut.endsWith('…')).toBe(true);
    expect([...cut.slice(0, -1)].every((char) => char === '😀')).toBe(true);
  });
});
