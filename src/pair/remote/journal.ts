import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemotePairingJournal } from './types';

const JOURNAL_FILE = 'pairing.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function parseJournal(raw: string): RemotePairingJournal | null {
  try {
    const value = JSON.parse(raw) as Partial<RemotePairingJournal>;
    if (
      value.version !== 1 ||
      typeof value.id !== 'string' ||
      !UUID.test(value.id) ||
      typeof value.oauthRequestId !== 'string' ||
      typeof value.sub !== 'string' ||
      typeof value.cookieHash !== 'string' ||
      typeof value.csrfHash !== 'string' ||
      typeof value.createdAt !== 'string' ||
      typeof value.updatedAt !== 'string' ||
      typeof value.expiresAt !== 'string' ||
      typeof value.identityExpiresAt !== 'string' ||
      typeof value.deviceId !== 'string' ||
      typeof value.verifier !== 'string' ||
      typeof value.phase !== 'string' ||
      typeof value.cleanupRequired !== 'boolean'
    ) return null;
    return value as RemotePairingJournal;
  } catch {
    return null;
  }
}

export class RemotePairingJournalStore {
  constructor(readonly root: string) {}

  sessionDir(id: string): string {
    if (!UUID.test(id)) throw new Error('invalid_pairing_id');
    return join(this.root, id);
  }

  preparedDir(id: string): string {
    return join(this.sessionDir(id), 'account');
  }

  async write(journal: RemotePairingJournal): Promise<void> {
    const directory = this.sessionDir(journal.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = join(directory, JOURNAL_FILE);
    const temporary = join(directory, `.${JOURNAL_FILE}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify(journal));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); }
    finally { await directoryHandle.close(); }
  }

  async read(id: string): Promise<RemotePairingJournal | null> {
    try {
      const path = join(this.sessionDir(id), JOURNAL_FILE);
      const raw = await readFile(path, 'utf8');
      await chmod(path, 0o600);
      const journal = parseJournal(raw);
      if (!journal) throw new Error('invalid_pairing_journal');
      return journal;
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  async list(): Promise<RemotePairingJournal[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
    const journals = await Promise.all(
      entries.filter((entry) => UUID.test(entry)).map((entry) => this.read(entry))
    );
    return journals.filter((entry): entry is RemotePairingJournal => entry !== null);
  }

  async remove(id: string): Promise<void> {
    const directory = this.sessionDir(id);
    // La ruta está acotada por UUID y siempre cuelga de `root`.
    await rm(directory, { recursive: true, force: true });
    try {
      const rootHandle = await open(this.root, 'r');
      try { await rootHandle.sync(); }
      finally { await rootHandle.close(); }
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
}
