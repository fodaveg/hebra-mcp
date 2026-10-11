import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { deriveNote } from '../../src/hebra';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';

it('la época distingue un reset del sync y una reimportación en la misma conexión con sumas iguales', async () => {
  const port = await openNodeLibraryPort({ sqlitePath: ':memory:' });
  const sync = port.syncStorePort();
  const save = async (body: string) => {
    const note = await sync.noteCreate(null);
    await sync.noteSave({
      ...deriveNote(body),
      id: note.id,
      body,
      expectedLocalSeq: note.localSeq,
      baseBodySha256: note.bodySha256
    });
  };
  try {
    await save('# Pública\ncontenido\n');
    const before = await port.privacyEpoch();
    await sync.libraryReset();
    await save('# Privada\n#secreto\n');
    const after = await port.privacyEpoch();
    const sums = (epoch: string) => JSON.parse(epoch.slice(0, epoch.lastIndexOf(':'))).slice(0, 3);
    expect(sums(after)).toEqual(sums(before));
    expect((await port.notesVisibilityIndex())[0]?.tags).toContain('secreto');
    expect(after).not.toBe(before);
  } finally {
    port.close();
  }
});

it('las tres sumas de época leen índices de cobertura en la biblioteca abierta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex5-epoch-index-'));
  const sqlitePath = join(dir, 'library.sqlite');
  let port: Awaited<ReturnType<typeof openNodeLibraryPort>> | undefined;
  try {
    port = await openNodeLibraryPort({ sqlitePath });
    const { db } = openNodeSqliteConn(sqlitePath, 'readOnly');
    try {
      for (const table of ['notes', 'folders', 'files']) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT count(*), sum(local_seq) FROM ${table}`).all();
        expect(plan.some((row) => String(row.detail).includes(`USING COVERING INDEX hebra_mcp_epoch_${table}`))).toBe(true);
      }
    } finally {
      db.close();
    }
  } finally {
    port?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
