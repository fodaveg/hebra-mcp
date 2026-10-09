import { describe, expect, it } from 'vitest';
import {
  insertAtEnd,
  insertIntoSection,
  lineAt,
  normalizedHeading,
  parseHeadings,
  sectionText,
  selectSection
} from '../../src/store/sections';

function titles(body: string): string[] {
  return parseHeadings(body).map((entry) => entry.heading);
}

describe('parseHeadings (D11)', () => {
  it('nota sin encabezados: ninguno', () => {
    expect(parseHeadings('solo texto\nmás texto\n')).toEqual([]);
    expect(parseHeadings('')).toEqual([]);
  });

  it('niveles, líneas y finales de apartado (subapartados incluidos)', () => {
    const body = '# Nota\nintro\n## A\ntexto A\n### A1\nhijo\n## B\ntexto B\n';
    const headings = parseHeadings(body);
    expect(headings.map(({ heading, level, line }) => ({ heading, level, line }))).toEqual([
      { heading: 'Nota', level: 1, line: 1 },
      { heading: 'A', level: 2, line: 3 },
      { heading: 'A1', level: 3, line: 5 },
      { heading: 'B', level: 2, line: 7 }
    ]);
    const [nota, a, a1, b] = headings;
    expect(sectionText(body, a!)).toBe('## A\ntexto A\n### A1\nhijo\n');
    expect(sectionText(body, a1!)).toBe('### A1\nhijo\n');
    expect(sectionText(body, b!)).toBe('## B\ntexto B\n');
    expect(sectionText(body, nota!)).toBe(body);
  });

  it('el título pierde los # de cierre y los espacios', () => {
    expect(titles('## Título ##\n#   Otro   \n###\n')).toEqual(['Título', 'Otro', '']);
  });

  it('un # sin espacio es una etiqueta, no un encabezado', () => {
    expect(titles('#etiqueta\n##tambien\n# Real\n')).toEqual(['Real']);
  });

  it('cuatro espacios de sangría ya no es encabezado', () => {
    expect(titles('    # código\n   # sí\n')).toEqual(['sí']);
  });

  it('no cuentan las líneas del frontmatter inicial', () => {
    const body = '---\ntitle: X\n# no\n---\n# Sí\n';
    expect(titles(body)).toEqual(['Sí']);
    expect(parseHeadings(body)[0]!.line).toBe(5);
  });

  it('un --- que no está al principio no abre frontmatter; uno sin cerrar tampoco', () => {
    expect(titles('texto\n---\n# Sí\n---\n')).toEqual(['Sí']);
    expect(titles('---\n# Sí\n')).toEqual(['Sí']);
  });

  it('no cuentan las líneas de un cercado ``` ni ~~~', () => {
    expect(titles('# A\n```\n# no\n```\n## B\n~~~\n## no\n~~~\n')).toEqual(['A', 'B']);
  });

  it('un cercado sin cerrar llega hasta el final', () => {
    expect(titles('# A\n```js\n# no\n## no\n')).toEqual(['A']);
  });

  it('el cierre necesita el mismo carácter y al menos tantos como la apertura', () => {
    // Abre con 4 acentos: tres no lo cierran, ~~~~ tampoco; cuatro sí.
    expect(titles('# A\n````\n```\n# no\n~~~~\n# no\n````\n## B\n')).toEqual(['A', 'B']);
    // Un cercado de ~~~ no lo cierra ```.
    expect(titles('~~~\n```\n# no\n~~~\n# sí\n')).toEqual(['sí']);
  });

  it('un cierre con texto detrás no cierra', () => {
    expect(titles('```\n``` fin\n# no\n```\n# sí\n')).toEqual(['sí']);
  });

  it('los encabezados Setext no cuentan', () => {
    expect(titles('Título\n======\n\nOtro\n-----\n# Real\n')).toEqual(['Real']);
  });

  it('tolera \\r\\n y las líneas siguen contando bien', () => {
    const body = '# A\r\ntexto\r\n## B\r\nmás\r\n';
    const headings = parseHeadings(body);
    expect(headings.map((entry) => [entry.heading, entry.line])).toEqual([
      ['A', 1],
      ['B', 3]
    ]);
    expect(sectionText(body, headings[1]!)).toBe('## B\r\nmás\r\n');
  });

  it('títulos repetidos: aparición en orden de documento, sea cual sea el nivel', () => {
    const headings = parseHeadings('# Notas\n## Notas\n### notas\n## Otro\n');
    expect(headings.map((entry) => [entry.occurrence, entry.sameTitleCount])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
      [1, 1]
    ]);
  });

  it('un encabezado vacío es un apartado de título vacío', () => {
    const body = '#\ntexto\n';
    const [empty] = parseHeadings(body);
    expect(empty).toMatchObject({ heading: '', level: 1, line: 1 });
  });
});

describe('normalizedHeading y selectSection', () => {
  it('NFKC, mayúsculas y espacios colapsados', () => {
    expect(normalizedHeading('  Ｄecisiones \t  de   Hoy ')).toBe('decisiones de hoy');
    expect(normalizedHeading('Ångström')).toBe(normalizedHeading('Ångström'));
  });

  it('encuentra por el título normalizado', () => {
    const headings = parseHeadings('## Ｄecisiones   de hoy\ntexto\n');
    const picked = selectSection(headings, 'decisiones DE HOY');
    expect(picked).toMatchObject({ ok: true, section: { heading: 'Ｄecisiones   de hoy' } });
  });

  it('0 coincidencias: heading_not_found; con occurrence fuera de rango también', () => {
    const headings = parseHeadings('# A\n# A\n');
    expect(selectSection(headings, 'B')).toEqual({ ok: false, code: 'heading_not_found' });
    expect(selectSection(headings, 'A', 3)).toEqual({ ok: false, code: 'heading_not_found' });
  });

  it('varias sin occurrence: ambiguous_heading con candidatos; con occurrence, la n-ésima', () => {
    const headings = parseHeadings('# A\n## Dup\nx\n## Dup\ny\n');
    const ambiguous = selectSection(headings, 'dup');
    expect(ambiguous).toEqual({
      ok: false,
      code: 'ambiguous_heading',
      candidates: [
        { heading: 'Dup', level: 2, line: 2, occurrence: 1 },
        { heading: 'Dup', level: 2, line: 4, occurrence: 2 }
      ]
    });
    const second = selectSection(headings, 'dup', 2);
    expect(second).toMatchObject({ ok: true, section: { line: 4 } });
  });

  it('los candidatos se acotan a 50', () => {
    const body = Array.from({ length: 60 }, () => '## Dup\n').join('');
    const result = selectSection(parseHeadings(body), 'Dup');
    expect(result.ok === false && result.code === 'ambiguous_heading' && result.candidates.length).toBe(50);
  });
});

describe('lineAt', () => {
  it('cuenta líneas 1-based', () => {
    expect(lineAt('a\nb\nc', 0)).toBe(1);
    expect(lineAt('a\nb\nc', 2)).toBe(2);
    expect(lineAt('a\nb\nc', 4)).toBe(3);
  });
});

describe('insertIntoSection', () => {
  function insert(body: string, heading: string, text: string, occurrence?: number) {
    const picked = selectSection(parseHeadings(body), heading, occurrence);
    if (!picked.ok) throw new Error(picked.code);
    return insertIntoSection(body, picked.section, text);
  }

  it('apartado intermedio: línea en blanco antes y después', () => {
    const result = insert('# A\nuno\n\n# B\ndos\n', 'A', 'nuevo');
    expect(result.body).toBe('# A\nuno\n\nnuevo\n\n# B\ndos\n');
    expect(result.body.slice(result.start, result.end)).toBe('nuevo');
  });

  it('el encabezado siguiente pegado: se le añade la línea en blanco', () => {
    const result = insert('# A\nuno\n# B\ndos\n', 'A', 'nuevo');
    expect(result.body).toBe('# A\nuno\n\nnuevo\n\n# B\ndos\n');
  });

  it('último apartado: conserva el final de la nota', () => {
    expect(insert('# A\nuno\n# B\ndos\n', 'B', 'nuevo').body).toBe('# A\nuno\n# B\ndos\n\nnuevo\n');
    expect(insert('# A\nuno\n# B\ndos', 'B', 'nuevo').body).toBe('# A\nuno\n# B\ndos\n\nnuevo');
    expect(insert('# A\nuno\n# B\ndos\n\n\n', 'B', 'nuevo').body).toBe(
      '# A\nuno\n# B\ndos\n\nnuevo\n\n\n'
    );
  });

  it('apartado con subapartados: va tras el último subapartado', () => {
    const result = insert('## A\nuno\n### A1\nhijo\n## B\n', 'A', 'nuevo');
    expect(result.body).toBe('## A\nuno\n### A1\nhijo\n\nnuevo\n\n## B\n');
  });

  it('blancos de más al final del apartado: una línea exacta antes, el resto detrás', () => {
    const result = insert('# A\nuno\n\n\n\n# B\n', 'A', 'nuevo');
    expect(result.body).toBe('# A\nuno\n\nnuevo\n\n\n\n# B\n');
  });

  it('apartado solo con encabezado', () => {
    expect(insert('# A\n# B\n', 'A', 'nuevo').body).toBe('# A\n\nnuevo\n\n# B\n');
    expect(insert('# A\n', 'A', 'nuevo').body).toBe('# A\n\nnuevo\n');
  });

  it('un texto que parece encabezado dentro de un cercado no cuenta; el cercado entero va dentro', () => {
    const body = '# A\n```\n# no\n```\n# B\nx\n';
    expect(titles(body)).toEqual(['A', 'B']);
    const result = insert(body, 'A', 'nuevo');
    expect(result.body).toBe('# A\n```\n# no\n```\n\nnuevo\n\n# B\nx\n');
  });

  it('respeta \\r\\n', () => {
    const result = insert('# A\r\nuno\r\n# B\r\n', 'A', 'nuevo');
    expect(result.body).toBe('# A\r\nuno\r\n\r\nnuevo\r\n\r\n# B\r\n');
    expect(result.body.slice(result.start, result.end)).toBe('nuevo');
  });

  it('con frontmatter, lo anterior no cambia', () => {
    const body = '---\ntitle: X\n---\n# A\nuno\n';
    const result = insert(body, 'A', 'nuevo');
    expect(result.body).toBe('---\ntitle: X\n---\n# A\nuno\n\nnuevo\n');
  });

  it('el texto se inserta tal cual, sin recortar', () => {
    const result = insert('# A\nuno\n# B\n', 'A', 'a\n\nb\n');
    expect(result.body).toBe('# A\nuno\n\na\n\nb\n\n\n# B\n');
  });
});

describe('insertAtEnd', () => {
  it('es body + separador + texto', () => {
    const result = insertAtEnd('hola', 'mundo', '\n\n');
    expect(result.body).toBe('hola\n\nmundo');
    expect(result.body.slice(result.start, result.end)).toBe('mundo');
  });
});
