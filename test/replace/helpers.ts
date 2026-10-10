/**
 * Ayudantes de los tests de `hebra_replace_in_notes` (D14). Bibliotecas temporales en
 * `os.tmpdir()` (rutas cortas: `writer.sock` no puede pasar de 104 bytes en macOS), con
 * `secrets: null` y sin sync: nunca el llavero ni la biblioteca real.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PrivacyConfig } from '../../src/privacy/config';
import { resolveToolContext, type ServerContext } from '../../src/server/context';
import { localWriteContext } from '../../src/server/serve';
import { runReplaceInNotes, type ReplaceInNotesInput } from '../../src/server/tools/replace-in-notes';
import type { ReplaceOutcome } from '../../src/server/write-context';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { LIBRARY_SQLITE_FILE, LibraryInstance } from '../../src/sync/library-instance';

export const OPEN: PrivacyConfig = { privateFolders: [], privateTags: [] };

const dirs: string[] = [];

export function tempDir(prefix = 'hr-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** El escritor de `dataDir` como lo monta `serve` (sin sync), y la herramienta llamada con
 *  la configuración de privados que se pida. */
export async function openWriter(dataDir: string): Promise<{
  instance: LibraryInstance;
  call(input: ReplaceInNotesInput, privacy?: PrivacyConfig): Promise<ReplaceOutcome>;
}> {
  const instance = await LibraryInstance.open({ dataDir, checkIntervalMs: null, lock: { releaseOnExit: false } });
  const write = localWriteContext(instance);
  return {
    instance,
    async call(input, privacy = OPEN) {
      const server: ServerContext = {
        port: instance.port,
        privacyConfig: privacy,
        status: new UnlinkedStatusSource(),
        write
      };
      return runReplaceInNotes(await resolveToolContext(server), input);
    }
  };
}

export async function createNote(instance: LibraryInstance, body: string, folderId: string | null = null): Promise<string> {
  return (await instance.createNote({ body, folderId, privacy: OPEN })).id;
}

export async function createFolder(instance: LibraryInstance, name: string, parentId = 'root'): Promise<string> {
  return (await instance.createFolderLocal({ parentId, name, privacy: OPEN })).result.id;
}

/** Lectura directa de la SQLite (en solo lectura), para mirar lo que de verdad quedó. */
export function query<T>(dataDir: string, sql: string, ...params: Array<string | number>): T[] {
  const db = new DatabaseSync(join(dataDir, LIBRARY_SQLITE_FILE), { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/** Escritura directa en la SQLite (con el escritor de este proceso abierto: WAL). */
export function exec(dataDir: string, sql: string, ...params: Array<string | number>): void {
  const db = new DatabaseSync(join(dataDir, LIBRARY_SQLITE_FILE));
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

export interface NoteState {
  id: string;
  body: string;
  local_seq: number;
  trashed_at: number | null;
  conflict_of: string | null;
}

export function noteState(dataDir: string, id: string): NoteState {
  return query<NoteState>(
    dataDir,
    'SELECT id, body, local_seq, trashed_at, conflict_of FROM notes WHERE id = ?',
    id
  )[0]!;
}

/** Todas las notas vivas (no lápidas), en la papelera o no. */
export function allNotes(dataDir: string): NoteState[] {
  return query<NoteState>(
    dataDir,
    'SELECT id, body, local_seq, trashed_at, conflict_of FROM notes WHERE deleted = 0 ORDER BY id'
  );
}

export function versionBodies(dataDir: string, id: string): string[] {
  return query<{ body: string }>(dataDir, 'SELECT body FROM note_versions WHERE note_id = ? ORDER BY id', id).map(
    (row) => row.body
  );
}

/** El código de un `ToolError` (o `ok`). */
export async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return String((error as { code?: unknown }).code ?? (error as Error).message);
  }
}
