/**
 * Coherencia de la skill pública `skills/hebra/` con el servidor. Determinista: lee
 * ficheros y compara, sin red ni servidor. Si la skill se desincroniza (una herramienta
 * nueva sin documentar, un código de error que no aparece, un recuento escrito a mano
 * que ya no cuadra, una descripción que no cabe en el formato), este test lo dice.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_TOOLS } from '../src/server/capabilities';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = join(ROOT, 'skills', 'hebra');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const REFERENCES_DIR = join(SKILL_DIR, 'references');
const LOGGER_SRC = join(ROOT, 'src', 'log', 'logger.ts');

/** Máximo de caracteres de la `description` del frontmatter que admite el formato de skills. */
const MAX_DESCRIPTION = 1024;

/** Todos los `.md` de `dir`, recursivo, como rutas absolutas ordenadas. */
function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found.sort();
}

const FILES = markdownFiles(SKILL_DIR);
const TEXTS = new Map(FILES.map((file) => [file, readFileSync(file, 'utf8')]));
const ALL_TEXT = [...TEXTS.values()].join('\n');

/** Los literales de `export type ToolErrorCode = | 'a' | 'b' ...;` leídos del fuente (no hay lista en ejecución). */
function toolErrorCodes(): string[] {
  const source = readFileSync(LOGGER_SRC, 'utf8');
  const start = source.indexOf('export type ToolErrorCode');
  expect(start, 'no encuentro `export type ToolErrorCode` en src/log/logger.ts').toBeGreaterThanOrEqual(0);
  // Primero se quitan los comentarios: llevan `;` y comillas que no son parte del tipo.
  const tail = source
    .slice(start)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const body = tail.slice(0, tail.indexOf(';'));
  return [...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] as string);
}

/** El valor de una clave de una línea del frontmatter (admite plegado `>-` y `|` en líneas con sangría). */
function frontmatterField(text: string, key: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (block === undefined) return undefined;
  const lines = block.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index < 0) return undefined;
  const inline = (lines[index] as string).slice(key.length + 1).trim();
  if (!/^[>|][+-]?$/.test(inline)) return inline.replace(/^(["'])([\s\S]*)\1$/, '$2');
  const folded: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (line.length > 0 && !/^\s/.test(line)) break;
    folded.push(line.trim());
  }
  return folded.join(' ').trim();
}

describe('coherencia de la skill con el servidor', () => {
  it('hay ficheros de skill que comprobar', () => {
    expect(FILES).toContain(SKILL_MD);
  });

  it('nombra exactamente las herramientas de CAPABILITY_TOOLS', () => {
    const mentioned = new Set(
      [...ALL_TEXT.matchAll(/hebra_[a-z_]+/g)].map((match) => match[0]).filter((name) => !name.endsWith('_'))
    );
    const real = new Set<string>(CAPABILITY_TOOLS);
    const missing = [...real].filter((name) => !mentioned.has(name)).sort();
    const unknown = [...mentioned].filter((name) => !real.has(name)).sort();
    expect({ sinDocumentar: missing, noExisten: unknown }).toEqual({ sinDocumentar: [], noExisten: [] });
  });

  it('cada código de ToolErrorCode aparece entre acentos graves', () => {
    const codes = toolErrorCodes();
    expect(codes.length, 'el parser de ToolErrorCode no debe pasar vacío').toBeGreaterThanOrEqual(30);
    const undocumented = codes.filter((code) => !ALL_TEXT.includes(`\`${code}\``));
    expect(undocumented).toEqual([]);
  });

  it('los recuentos de herramientas escritos a mano coinciden con CAPABILITY_TOOLS', () => {
    const total = CAPABILITY_TOOLS.length;
    const counts: Array<{ fichero: string; texto: string; n: number }> = [];
    for (const [file, text] of TEXTS) {
      const patterns = [/Herramientas \((\d{2})\)/g, /\b(\d{2})\s+(?:tools|herramientas)\b/gi];
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          counts.push({ fichero: relative(SKILL_DIR, file), texto: match[0], n: Number(match[1]) });
        }
      }
    }
    const wrong = counts.filter((count) => count.n !== total);
    expect({ esperado: total, erroneos: wrong }).toEqual({ esperado: total, erroneos: [] });
  });

  it('el frontmatter de SKILL.md: name `hebra` y description de 1 024 caracteres como máximo', () => {
    const text = TEXTS.get(SKILL_MD) as string;
    expect(frontmatterField(text, 'name')).toBe('hebra');
    const description = frontmatterField(text, 'description');
    expect(description, 'SKILL.md no tiene description en el frontmatter').toBeDefined();
    expect((description as string).length).toBeLessThanOrEqual(MAX_DESCRIPTION);
  });

  it('SKILL.md enlaza solo a references/ que existen y enlaza todas las que hay', () => {
    const text = TEXTS.get(SKILL_MD) as string;
    const linked = [...text.matchAll(/\]\((references\/[^)#\s]+)/g)].map((match) => match[1] as string);
    const broken = linked.filter((link) => !existsSync(join(SKILL_DIR, link)));
    const onDisk = existsSync(REFERENCES_DIR)
      ? markdownFiles(REFERENCES_DIR).map((file) => relative(SKILL_DIR, file).split('\\').join('/'))
      : [];
    const orphans = onDisk.filter((file) => !linked.includes(file));
    expect({ enlacesRotos: broken, sinEnlazar: orphans }).toEqual({ enlacesRotos: [], sinEnlazar: [] });
  });
});
