/**
 * La carpeta de trabajo y sus metadatos (SPEC.md §13.2):
 *
 * ```
 * <carpeta>/
 *   <carpetas de Hebra saneadas>/<título saneado> (<8 primeros del id>).md   ← el cuerpo, byte a byte
 *   .hebra-d/
 *     checkout.json            { version: 1, biblioteca, sacadaEn, notas: [{ id, ruta }] }
 *     notas/<id>.json          { id, ruta, rev, sha, conflicto? }
 *     base/<id>.base           cuerpo base: el que se compara al devolver
 *     lotes/<lote>/diario.jsonl
 *     lotes/<lote>/base/<id>.base
 *     lotes/<lote>/cambios.diff
 * ```
 *
 * - Las bases NO terminan en `.md`: un script que recorre `**\/*.md` (el `rglob` de Python
 *   no se salta los directorios ocultos) las editaría junto a las notas.
 * - `sha` es el SHA-256 del cuerpo base; antes de usar una base se comprueba contra él, y
 *   una que no casa es una «base dañada».
 * - Los JSON se escriben con un temporal y `rename` (atómico en el mismo directorio). La
 *   base y su `sha` son dos ficheros: se escribe primero la base nueva como
 *   `<id>.base.next`, después los metadatos y por último el `rename`. Si el proceso muere
 *   entre los dos últimos pasos, la siguiente lectura ve que `<id>.base.next` casa con el
 *   `sha` nuevo y termina el cambio (`readBase`); si muere antes, el `.next` sobra y se
 *   pisa la próxima vez.
 * - `ruta` va siempre con `/` y en NFC, sea cual sea la plataforma.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathKey } from './names';

export const META_DIR = '.hebra-d';
export const CHECKOUT_FILE = 'checkout.json';
export const LAYOUT_VERSION = 1;

/** Marca de conflicto de una nota sacada: no se vuelve a devolver hasta otro `checkout`. */
export type ConflictMark =
  /** `apply --conflicto copia`: el texto editado quedó en `copyId`. */
  | { tipo: 'copia'; lote: string; copyId: string; sha: string }
  /** `apply --conflicto rechazar`: no se escribió nada; el texto sigue en el fichero. */
  | { tipo: 'rechazada'; lote: string; sha: string }
  /** `undo` restauró la nota pero el fichero ya tenía otra edición: no se devuelve. */
  | { tipo: 'deshecha'; lote: string };

export interface NoteMeta {
  id: string;
  ruta: string;
  /** `local_seq` de la base (informativo: la comprobación es por SHA). */
  rev: number;
  /** SHA-256 hex del cuerpo base. */
  sha: string;
  conflicto?: ConflictMark;
}

export interface CheckoutFile {
  version: typeof LAYOUT_VERSION;
  /** `library_id` de la biblioteca de la que se sacó: `apply` se niega con otra. */
  biblioteca: string;
  /** ISO 8601 del último `checkout`. */
  sacadaEn: string;
  notas: Array<{ id: string; ruta: string }>;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Escribe con un temporal en el mismo directorio y `rename`. */
export function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temp, content, 'utf8');
  renameSync(temp, file);
}

function readIfExists(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Nombre de fichero para un id de nota: tal cual si es un UUID o parecido; si no, en
 *  hexadecimal (un id raro nunca se convierte en una ruta). */
export function idFileName(id: string): string {
  return /^[A-Za-z0-9-]{1,100}$/u.test(id) ? id : `x${Buffer.from(id, 'utf8').toString('hex')}`;
}

export class WorkdirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkdirError';
  }
}

/** Una carpeta de trabajo en disco. */
export class Workdir {
  readonly metaDir: string;

  constructor(readonly root: string) {
    this.root = resolve(root);
    this.metaDir = join(this.root, META_DIR);
  }

  get checkoutPath(): string {
    return join(this.metaDir, CHECKOUT_FILE);
  }

  exists(): boolean {
    return existsSync(this.checkoutPath);
  }

  readCheckout(): CheckoutFile {
    const text = readIfExists(this.checkoutPath);
    if (text === null) throw new WorkdirError(`no hay carpeta de trabajo en ${this.root}`);
    const value = JSON.parse(text) as CheckoutFile;
    if (value.version !== LAYOUT_VERSION || !Array.isArray(value.notas)) {
      throw new WorkdirError(`${this.checkoutPath} no tiene la forma esperada`);
    }
    return value;
  }

  writeCheckout(file: CheckoutFile): void {
    writeAtomic(this.checkoutPath, `${JSON.stringify(file, null, 2)}\n`);
  }

  private metaPath(id: string): string {
    return join(this.metaDir, 'notas', `${idFileName(id)}.json`);
  }

  private basePath(id: string): string {
    return join(this.metaDir, 'base', `${idFileName(id)}.base`);
  }

  readMeta(id: string): NoteMeta | null {
    const text = readIfExists(this.metaPath(id));
    return text === null ? null : (JSON.parse(text) as NoteMeta);
  }

  writeMeta(meta: NoteMeta): void {
    writeAtomic(this.metaPath(meta.id), `${JSON.stringify(meta, null, 2)}\n`);
  }

  /**
   * La base de una nota si casa con su `sha`; `null` si falta o está dañada. Termina un
   * cambio de base cortado entre los metadatos y el `rename` (ver la cabecera).
   */
  readBase(meta: NoteMeta): string | null {
    const path = this.basePath(meta.id);
    const base = readIfExists(path);
    if (base !== null && sha256Hex(base) === meta.sha) return base;
    const next = readIfExists(`${path}.next`);
    if (next !== null && sha256Hex(next) === meta.sha) {
      renameSync(`${path}.next`, path);
      return next;
    }
    return null;
  }

  /** Pone `body` como base de la nota y escribe sus metadatos, en el orden de la cabecera. */
  setBase(meta: NoteMeta, body: string): void {
    const path = this.basePath(meta.id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.next`, body, 'utf8');
    this.writeMeta(meta);
    renameSync(`${path}.next`, path);
  }

  /** Ruta absoluta del fichero de una nota (`ruta` con `/`). */
  filePath(ruta: string): string {
    return join(this.root, ...ruta.split('/'));
  }

  readNoteFile(ruta: string): string | null {
    return readIfExists(this.filePath(ruta));
  }

  writeNoteFile(ruta: string, body: string): void {
    writeAtomic(this.filePath(ruta), body);
  }

  /**
   * ¿Distingue mayúsculas el sistema de ficheros de esta carpeta? Se mira si
   * `.HEBRA-D` resuelve al `.hebra-d` que existe: en macOS y Windows (por defecto) sí.
   */
  caseInsensitive(): boolean {
    return existsSync(join(this.root, META_DIR.toUpperCase()));
  }

  /** Clave de comparación de una ruta en ESTA carpeta: NFC siempre; en minúsculas solo
   *  si el sistema de ficheros no las distingue. */
  keyOf(ruta: string): string {
    this.caseInsensitiveCache ??= this.caseInsensitive();
    return this.caseInsensitiveCache ? pathKey(ruta) : ruta.normalize('NFC');
  }

  private caseInsensitiveCache: boolean | undefined;

  /** Todos los `.md` bajo la carpeta, sin `.hebra-d`, como rutas relativas con `/` en NFC. */
  listMarkdown(): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const name = entry.name.normalize('NFC');
        if (prefix === '' && name === META_DIR) continue;
        const rel = prefix === '' ? name : `${prefix}/${name}`;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else if (entry.isFile() && name.toLowerCase().endsWith('.md')) out.push(rel);
      }
    };
    walk(this.root, '');
    return out.sort();
  }

  // ---- lotes ----

  loteDir(lote: string): string {
    return join(this.metaDir, 'lotes', lote);
  }

  hasLote(lote: string): boolean {
    return /^[A-Za-z0-9-]{1,64}$/u.test(lote) && existsSync(join(this.loteDir(lote), 'diario.jsonl'));
  }

  appendJournal(lote: string, entry: JournalEntry): void {
    mkdirSync(this.loteDir(lote), { recursive: true });
    appendFileSync(join(this.loteDir(lote), 'diario.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  }

  readJournal(lote: string): JournalEntry[] {
    const text = readIfExists(join(this.loteDir(lote), 'diario.jsonl')) ?? '';
    const entries: JournalEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch {
        // Una línea cortada por un `kill -9` a mitad de escribirla: se ignora.
      }
    }
    return entries;
  }

  writeLoteBase(lote: string, id: string, body: string): void {
    writeAtomic(join(this.loteDir(lote), 'base', `${idFileName(id)}.base`), body);
  }

  readLoteBase(lote: string, id: string): string | null {
    return readIfExists(join(this.loteDir(lote), 'base', `${idFileName(id)}.base`));
  }

  appendLoteDiff(lote: string, diff: string): void {
    mkdirSync(this.loteDir(lote), { recursive: true });
    appendFileSync(join(this.loteDir(lote), 'cambios.diff'), diff, 'utf8');
  }

  /** Lotes existentes, del más antiguo al más reciente (el nombre empieza por la fecha). */
  lotes(): string[] {
    const dir = join(this.metaDir, 'lotes');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => this.hasLote(name)).sort();
  }

  /** Quita una carpeta de lote vacía (un `apply` sin nada que devolver no deja rastro). */
  removeLoteIfEmpty(lote: string): void {
    const dir = this.loteDir(lote);
    if (existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true });
    }
  }
}

/** Una línea del diario de un lote. */
export type JournalEntry =
  | { paso: 'lote'; lote: string; conflicto: 'copia' | 'rechazar'; en: string }
  | { paso: 'intento'; id: string; ruta: string; shaBase: string; shaEditado: string; en: string }
  | {
      paso: 'hecho';
      id: string;
      resultado: ApplyOutcomeName;
      copyId?: string;
      en: string;
    }
  | { paso: 'deshacer'; id: string; resultado: UndoOutcomeName; en: string };

export type ApplyOutcomeName =
  | 'aplicada'
  | 'ya_estaba'
  | 'copia_de_conflicto'
  | 'rechazada_por_conflicto'
  | 'no_disponible'
  | 'bloqueada';

export type UndoOutcomeName =
  | 'restaurada'
  | 'ya_estaba'
  | 'cambiada_despues'
  | 'no_disponible'
  | 'bloqueada'
  | 'copia_a_la_papelera'
  | 'copia_cambiada';

/**
 * La carpeta de trabajo a usar: `--dir` si lo hay; si no, la primera que tenga `.hebra-d`
 * subiendo desde `cwd`; si no, la de un subdirectorio inmediato de `cwd`, cuando solo uno
 * la tiene.
 */
export function findWorkdir(cwd: string, dir: string | undefined): Workdir {
  if (dir !== undefined) {
    const workdir = new Workdir(resolve(cwd, dir));
    if (!workdir.exists()) throw new WorkdirError(`no hay carpeta de trabajo en ${workdir.root}`);
    return workdir;
  }
  for (let current = resolve(cwd); ; current = dirname(current)) {
    const workdir = new Workdir(current);
    if (workdir.exists()) return workdir;
    if (dirname(current) === current) break;
  }
  const found: Workdir[] = [];
  try {
    for (const entry of readdirSync(cwd, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workdir = new Workdir(join(cwd, entry.name));
      if (workdir.exists()) found.push(workdir);
    }
  } catch {
    // `cwd` ilegible: como si no hubiera ninguna.
  }
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    throw new WorkdirError('hay varias carpetas de trabajo aquí: elige una con --dir');
  }
  throw new WorkdirError('no se encuentra la carpeta de trabajo: usa --dir o haz antes checkout');
}
