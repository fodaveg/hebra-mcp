import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemotePairingJournalStore } from '../../src/pair/remote/journal';
import type { RemotePairingJournal } from '../../src/pair/remote/types';

describe('RemotePairingJournalStore', () => {
  let root: string;
  let store: RemotePairingJournalStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hebra-remote-pair-'));
    store = new RemotePairingJournalStore(join(root, 'journals'));
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('persiste atómicamente con directorio 0700 y fichero 0600', async () => {
    const journal = sampleJournal();
    await store.write(journal);
    expect((await stat(store.sessionDir(journal.id))).mode & 0o777).toBe(0o700);
    expect((await stat(join(store.sessionDir(journal.id), 'pairing.json'))).mode & 0o777).toBe(0o600);
    expect(await store.read(journal.id)).toEqual(journal);
    expect(await store.list()).toEqual([journal]);
  });

  it('no materializa títulos y elimina solo el UUID solicitado', async () => {
    const journal = sampleJournal();
    await store.write(journal);
    const raw = await readFile(join(store.sessionDir(journal.id), 'pairing.json'), 'utf8');
    expect(raw).not.toContain('Nota privada');
    await store.remove(journal.id);
    expect(await store.read(journal.id)).toBeNull();
  });

  it('falla cerrado ante un diario corrupto en vez de olvidar su cleanup', async () => {
    const id = sampleJournal().id;
    await mkdir(store.sessionDir(id), { recursive: true });
    await writeFile(join(store.sessionDir(id), 'pairing.json'), '{roto');
    await expect(store.list()).rejects.toThrow('invalid_pairing_journal');
  });
});

function sampleJournal(): RemotePairingJournal {
  return {
    version: 1,
    id: '11111111-1111-4111-8111-111111111111',
    oauthRequestId: 'oauth-1',
    sub: 'sumego|david',
    cookieHash: 'a'.repeat(64),
    csrfHash: 'b'.repeat(64),
    phase: 'credential',
    createdAt: '2026-11-03T08:00:00.000Z',
    updatedAt: '2026-11-03T08:00:00.000Z',
    expiresAt: '2026-11-03T08:10:00.000Z',
    identityExpiresAt: '2026-11-03T08:05:00.000Z',
    deviceId: '22222222-2222-4222-8222-222222222222',
    verifier: 'verifier',
    cleanupRequired: false
  };
}
