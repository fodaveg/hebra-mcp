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
 *     cerrojo                  { pid, token, en } mientras corre checkout, apply o undo
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
 * - `ruta` va siempre con `/` y en NFC, sea cual sea la plataforma. Al leer los JSON se
 *   normaliza, y una que saldría de la carpeta o caería en `.hebra-d` no se usa (`safeRuta`).
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
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathKey } from './names';

export const META_DIR = '.hebra-d';
export const CHECKOUT_FILE = 'checkout.json';
export const LAYOUT_VERSION = 1;
export const LOCK_FILE = 'cerrojo';

/** ¿Vive el proceso? `EPERM` es que vive y es de otro usuario. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

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
  /** ISO 8601 de cuando la base se tomó de la biblioteca (`checkout`, o el `apply`/`undo`
   *  que la puso al día). El aviso de 24 h de `status` mira la más antigua. Ausente en
   *  metadatos anteriores: vale `CheckoutFile.sacadaEn`. */
  sacadaEn?: string;
  conflicto?: ConflictMark;
}

export interface CheckoutFile {
  version: typeof LAYOUT_VERSION;
  /** `library_id` de la biblioteca de la que se sacó: `apply` se niega con otra. */
  biblioteca: string;
  /** ISO 8601 de la base MÁS ANTIGUA de las notas sacadas (no la del último `checkout`:
   *  una sacada parcial no rejuvenece las demás). */
  sacadaEn: string;
  notas: Array<{ id: string; ruta: string }>;
}

/**
 * Una `ruta` de los metadatos, normalizada (`/`, NFC), o `null` si no es una ruta de nota de
 * esta carpeta: absoluta (también `C:` o `\\servidor`), con `..`, dentro de `.hebra-d` o sin
 * `.md`. Los JSON se pueden tocar a mano o con un script: nunca se lee ni se escribe fuera.
 */
export function safeRuta(ruta: unknown): string | null {
  if (typeof ruta !== 'string' || ruta.length === 0) return null;
  if (isAbsolute(ruta) || /^[A-Za-z]:/u.test(ruta) || /^[\\/]/u.test(ruta)) return null;
  const segments = ruta.normalize('NFC').split(/[\\/]+/u).filter((part) => part.length > 0 && part !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  if (pathKey(segments[0]) === pathKey(META_DIR)) return null;
  const normalized = segments.join('/');
  return normalized.toLowerCase().endsWith('.md') ? normalized : null;
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
    // Rutas normalizadas (`\` de Windows → `/`, NFC). Una que no vale (`safeRuta`) se queda
    // tal cual: quien la usa la ve con `safeRuta` y la trata como base dañada.
    const notas = value.notas
      .filter((entry) => typeof entry?.id === 'string')
      .map((entry) => ({ id: entry.id, ruta: safeRuta(entry.ruta) ?? String(entry.ruta) }));
    return { ...value, notas };
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

  /** Metadatos de una nota, con la `ruta` normalizada como en `readCheckout`. */
  readMeta(id: string): NoteMeta | null {
    const text = readIfExists(this.metaPath(id));
    if (text === null) return null;
    const meta = JSON.parse(text) as NoteMeta;
    return { ...meta, ruta: safeRuta(meta.ruta) ?? String(meta.ruta) };
  }

  /** Retira una nota de la carpeta: su fichero (si lo hay), su base y sus metadatos. */
  removeNote(id: string, ruta: string): void {
    if (safeRuta(ruta) !== null) rmSync(this.notePath(ruta), { force: true });
    const base = this.basePath(id);
    rmSync(base, { force: true });
    rmSync(`${base}.next`, { force: true });
    rmSync(this.metaPath(id), { force: true });
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

  /** Ruta absoluta del fichero de una nota. Lanza con una `ruta` que no vale (`safeRuta`):
   *  ninguna orden lee ni escribe fuera de la carpeta de trabajo. */
  notePath(ruta: string): string {
    const safe = safeRuta(ruta);
    const path = safe === null ? null : join(this.root, ...safe.split('/'));
    const rel = path === null ? '..' : relative(this.root, path);
    if (path === null || rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkdirError('una ruta de los metadatos queda fuera de la carpeta de trabajo');
    }
    return path;
  }

  // ---- cerrojo ----

  private get lockPath(): string {
    return join(this.metaDir, LOCK_FILE);
  }

  /**
   * Cerrojo de la carpeta de trabajo (`.hebra-d/cerrojo`): `checkout`, `apply` y `undo`
   * escriben en ella y no pueden ir a la vez. Se crea en exclusiva (`wx`) con el PID; uno
   * de un proceso que ya no vive se retira. Devuelve con qué soltarlo (también se suelta
   * al salir el proceso).
   */
  acquireLock(): () => void {
    mkdirSync(this.metaDir, { recursive: true });
    const token = randomBytes(8).toString('hex');
    const content = JSON.stringify({ pid: process.pid, token, en: new Date().toISOString() });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        writeFileSync(this.lockPath, content, { encoding: 'utf8', flag: 'wx' });
        const release = (): void => {
          process.removeListener('exit', release);
          if (readIfExists(this.lockPath) === content) rmSync(this.lockPath, { force: true });
        };
        process.once('exit', release);
        return release;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const held = readIfExists(this.lockPath);
      let pid: number | null = null;
      try {
        const parsed = JSON.parse(held ?? 'null') as { pid?: unknown } | null;
        pid = typeof parsed?.pid === 'number' ? parsed.pid : null;
      } catch {
        pid = null;
      }
      if (pid !== null && processAlive(pid)) {
        throw new WorkdirError(
          `otra orden está usando esta carpeta de trabajo (proceso ${pid}): espera a que termine y repite`
        );
      }
      // De un proceso muerto (o ilegible): se retira y se vuelve a intentar una vez.
      rmSync(this.lockPath, { force: true });
    }
    throw new WorkdirError('no se pudo tomar el cerrojo de la carpeta de trabajo: repite la orden');
  }

  readNoteFile(ruta: string): string | null {
    return readIfExists(this.notePath(ruta));
  }

  writeNoteFile(ruta: string, body: string): void {
    writeAtomic(this.notePath(ruta), body);
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
