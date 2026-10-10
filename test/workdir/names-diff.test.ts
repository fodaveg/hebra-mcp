/**
 * Nombres de fichero y diff propio de los ficheros de trabajo (SPEC.md §13.3, §13.5).
 */
import { describe, expect, it } from 'vitest';
import { compactDiff, diffStat, unifiedDiff } from '../../src/workdir/diff';
import {
  assignNotePath,
  isWindowsDeviceName,
  noteFileName,
  pathKey,
  sanitizeSegment,
  toPosixRelative,
  truncateUtf8
} from '../../src/workdir/names';

const ID = '0123abcd-4567-89ef-0123-456789abcdef';

describe('nombres de fichero en las tres plataformas', () => {
  it('cambia por - los caracteres que Windows no admite y los de control', () => {
    expect(noteFileName('a:b*c?d"e<f>g|h/i\\j\tk', ID)).toBe('a-b-c-d-e-f-g-h-i-j-k (0123abcd).md');
  });

  it('quita espacios y puntos del final y el punto del principio', () => {
    expect(noteFileName('Fin. . ', ID)).toBe('Fin (0123abcd).md');
    expect(sanitizeSegment('.oculta', 150, 'x')).toBe('_oculta');
    expect(sanitizeSegment(' .. ', 150, 'Sin nombre')).toBe('Sin nombre');
  });

  it('antepone _ a los nombres de dispositivo de Windows, con extensión y en cualquier caja', () => {
    for (const name of ['CON', 'con', 'Aux', 'nul.txt', 'COM1', 'lpt9', 'COM¹', 'PRN .md']) {
      expect(isWindowsDeviceName(name)).toBe(true);
      expect(sanitizeSegment(name, 150, 'x').startsWith('_')).toBe(true);
    }
    for (const name of ['CONSOLA', 'COM10', 'auxiliar', 'Con queso']) {
      expect(isWindowsDeviceName(name)).toBe(false);
    }
    // El título «CON.txt» haría un fichero «CON.txt (…).md», que Windows lee como CON.
    expect(noteFileName('CON.txt', ID)).toBe('_CON.txt (0123abcd).md');
  });

  it('sin título, «Sin título»; recorta a 150 bytes UTF-8 sin partir un carácter', () => {
    expect(noteFileName('   ', ID)).toBe('Sin título (0123abcd).md');
    const long = 'ñ'.repeat(100); // 200 bytes
    const cut = sanitizeSegment(long, 150, 'x');
    expect(Buffer.byteLength(cut, 'utf8')).toBe(150);
    expect(truncateUtf8('a🎉b', 3)).toBe('a');
  });

  it('escribe en NFC y compara en NFC y sin mayúsculas', () => {
    const nfd = 'Canción';
    expect(noteFileName(nfd, ID)).toBe('Canción (0123abcd).md');
    expect(pathKey('Carpeta/Canción.md')).toBe(pathKey('carpeta/CANCIÓN.md'));
  });

  it('dos notas con el mismo título y el mismo principio de id no chocan', () => {
    const used = new Set<string>();
    const other = '0123abcd-ffff-ffff-ffff-ffffffffffff';
    const first = assignNotePath(used, ['Proyectos'], 'Plan', ID);
    const second = assignNotePath(used, ['proyectos'], 'PLAN', other);
    expect(first).toBe('Proyectos/Plan (0123abcd).md');
    // Solo difieren en mayúsculas: en macOS y Windows serían el mismo fichero.
    expect(second).toBe(`proyectos/PLAN (${other}).md`);
    const nfd = assignNotePath(new Set([pathKey('Canción (0123abcd).md')]), [], 'Canción', ID);
    expect(nfd).toBe(`Canción (${ID}).md`);
  });

  it('carpetas saneadas igual, y una ruta con \\ de Windows se lee con /', () => {
    expect(assignNotePath(new Set(), ['AUX', 'a:b', 'fin.'], 'x', ID)).toBe('_AUX/a-b/fin/x (0123abcd).md');
    expect(toPosixRelative('Proyectos\\Sub\\Nota.md')).toBe('Proyectos/Sub/Nota.md');
    expect(toPosixRelative('./Proyectos//Nota.md')).toBe('Proyectos/Nota.md');
  });
});

/** Aplica un diff unificado propio a `before` (solo para comprobar que es correcto). */
function applyUnified(before: string, diff: string): string {
  const source = before.split('\n');
  const endsWithNewline = before.endsWith('\n');
  if (endsWithNewline) source.pop();
  const out: string[] = [];
  let cursor = 0;
  let resultEndsWithNewline = endsWithNewline;
  const lines = diff.split('\n');
  for (let i = 2; i < lines.length; i += 1) {
    const line = lines[i];
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/u.exec(line);
    if (header) {
      const start = Number(header[2]) === 0 ? Number(header[1]) : Number(header[1]) - 1;
      while (cursor < start) out.push(source[cursor++]);
      continue;
    }
    if (line === '\\ No newline at end of file') {
      if (lines[i - 1].startsWith('+')) resultEndsWithNewline = false;
      continue;
    }
    if (line.startsWith(' ')) {
      out.push(source[cursor++]);
    } else if (line.startsWith('-')) {
      cursor += 1;
    } else if (line.startsWith('+')) {
      out.push(line.slice(1));
      if (lines[i + 1] !== '\\ No newline at end of file') resultEndsWithNewline = true;
    }
  }
  while (cursor < source.length) out.push(source[cursor++]);
  const text = out.join('\n');
  return resultEndsWithNewline && out.length > 0 ? `${text}\n` : text;
}

describe('diff unificado propio', () => {
  it('formato de siempre, con contexto de 3 líneas', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\n';
    const after = 'a\nb\nc\nD\ne\nf\ng\n';
    expect(unifiedDiff(before, after, 'n.md')).toBe(
      ['--- a/n.md', '+++ b/n.md', '@@ -1,7 +1,7 @@', ' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g', ''].join('\n')
    );
    expect(unifiedDiff(before, before, 'n.md')).toBe('');
    expect(diffStat(before, after)).toEqual({ added: 1, removed: 1 });
  });

  it('marca el fichero sin salto final y cuenta el \\r de Windows como cambio', () => {
    const diff = unifiedDiff('a\nb\n', 'a\nb', 'n.md');
    expect(diff).toContain('\\ No newline at end of file');
    expect(diffStat('a\nb\n', 'a\nb')).toEqual({ added: 1, removed: 1 });
    expect(unifiedDiff('a\nb\n', 'a\r\nb\n', 'n.md')).toContain('+a\r');
  });

  it('el diff reconstruye el texto nuevo (muestras con varios tramos)', () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 60; round += 1) {
      const base = Array.from({ length: 5 + Math.floor(random() * 40) }, (_, i) => `línea ${i % 7}`);
      const edited = base.flatMap((line) => {
        const roll = random();
        if (roll < 0.1) return [];
        if (roll < 0.2) return [line, `nueva ${round}`];
        if (roll < 0.3) return [`${line}!`];
        return [line];
      });
      const before = `${base.join('\n')}\n`;
      const after = random() < 0.2 ? edited.join('\n') : `${edited.join('\n')}\n`;
      const diff = unifiedDiff(before, after, 'x.md');
      if (before === after) expect(diff).toBe('');
      else expect(applyUnified(before, diff)).toBe(after);
    }
  });

  it('diff compacto: solo lo cambiado, recortado y con tope', () => {
    const base = `# T\n\n${'x'.repeat(200)} viejo final\n`;
    const edited = `# T\n\n${'x'.repeat(200)} nuevo final\n`;
    const lines = compactDiff(base, edited);
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('- …')).toBe(true);
    expect(lines[0]).toContain('viejo final');
    expect(lines[1]).toContain('nuevo final');
    const many = compactDiff('a\nb\nc\nd\n', 'A\nB\nC\nD\n', 4);
    expect(many).toHaveLength(5);
    expect(many[4]).toContain('4 líneas cambiadas más');
  });

  it('un tramo central enorme y distinto no se come la memoria', () => {
    const before = Array.from({ length: 20_000 }, (_, i) => `a${i}`).join('\n');
    const after = Array.from({ length: 20_000 }, (_, i) => `b${i}`).join('\n');
    const started = Date.now();
    expect(diffStat(before, after)).toEqual({ added: 20_000, removed: 20_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
