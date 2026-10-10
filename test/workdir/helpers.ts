/**
 * Ayudantes de los tests de ficheros de trabajo (SPEC.md §13). Todo sobre directorios
 * temporales de `os.tmpdir()` (cortos: la ruta de `writer.sock` no puede pasar de 104
 * bytes en macOS), con `secrets: null`: nunca el llavero ni la biblioteca real.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PrivacyConfig } from '../../src/privacy/config';
import { LIBRARY_SQLITE_FILE, LibraryInstance, type OpenLibraryInstanceOptions } from '../../src/sync/library-instance';
import type { CommandIo, OpenLibrary } from '../../src/workdir/commands';
import { openWorkdirLibrary } from '../../src/workdir/library';
import type { ReplaceBodyTestHooks } from '../../src/store/body-writes';

export const OPEN: PrivacyConfig = { privateFolders: [], privateTags: [] };

const dirs: string[] = [];

export function tempDir(prefix = 'hw-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Lo que imprime una orden. */
export function capture(cwd: string): { io: CommandIo & { err(line: string): void }; lines: string[]; text(): string } {
  const lines: string[] = [];
  return {
    io: { cwd, out: (line) => lines.push(line), err: (line) => lines.push(`ERR ${line}`) },
    lines,
    text: () => lines.join('\n')
  };
}

type InstanceOptions = Pick<OpenLibraryInstanceOptions, 'lock' | 'checkIntervalMs' | 'sync'>;

/** La biblioteca de `dataDir` como la abre `hebra-mcp` (sin secretos). */
export function opener(
  dataDir: string,
  instance: InstanceOptions = {},
  hooks?: ReplaceBodyTestHooks
): OpenLibrary {
  return () =>
    openWorkdirLibrary({
      dataDir,
      secrets: null,
      instance: { checkIntervalMs: null, lock: { releaseOnExit: false }, ...instance },
      ...(hooks ? { hooks } : {})
    });
}

/** Abre la biblioteca como escritor (otro escritor, o para sembrar) y la cierra al acabar. */
export async function withWriter<T>(dataDir: string, run: (instance: LibraryInstance) => Promise<T>): Promise<T> {
  const instance = await LibraryInstance.open({ dataDir, checkIntervalMs: null, lock: { releaseOnExit: false } });
  try {
    return await run(instance);
  } finally {
    await instance.close();
  }
}

export async function createFolder(instance: LibraryInstance, name: string, parentId = 'root'): Promise<string> {
  return (await instance.createFolderLocal({ parentId, name, privacy: OPEN })).result.id;
}

export async function createNote(instance: LibraryInstance, body: string, folderId: string | null = null): Promise<string> {
  return (await instance.createNote({ body, folderId, privacy: OPEN })).id;
}

/** Deja una nota «bloqueada» escribiendo su cuerpo en la SQLite (con la biblioteca cerrada). */
export function lockNote(dataDir: string, id: string): void {
  const db = new DatabaseSync(join(dataDir, LIBRARY_SQLITE_FILE));
  try {
    db.prepare('UPDATE notes SET body = ? WHERE id = ?').run('hebra-locked:v1:x', id);
  } finally {
    db.close();
  }
}

export function writePrivacy(dataDir: string, config: { privateFolders?: string[]; privateTags?: string[] }): void {
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config));
}
