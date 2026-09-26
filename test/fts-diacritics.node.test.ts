import { describe, expect, it } from 'vitest';
import { SqliteLibraryEngine } from '../src/hebra';
import { MemoryBlobStore } from './hebra-testing';
import { openNodeSqliteConn } from '../src/store/sqlite-conn-node';

/**
 * `schema.sql` (línea ~225 del submódulo) declara el FTS5 de `notes_fts` con
 * `tokenize = 'unicode61 remove_diacritics 2'`. SPEC.md §4.1 dice que esto se probó a
 * mano contra `node:sqlite` de Node 24.19 (SQLite 3.53.3); este test lo deja medido y
 * repetible: una nota con «canción» aparece al buscar «cancion», sin tilde.
 */
describe('FTS5 con diacríticos (node:sqlite)', () => {
  it('busca "cancion" y encuentra una nota con "canción"', async () => {
    const { conn } = openNodeSqliteConn(':memory:');
    const engine = await SqliteLibraryEngine.open(conn, 'Mac', { blobs: new MemoryBlobStore() });

    const note = await engine.noteCreate(null);
    await engine.noteSave({
      id: note.id,
      body: 'Una canción de cuna',
      title: 'Una canción de cuna',
      titleNorm: 'una cancion de cuna',
      excerpt: 'Una canción de cuna',
      expectedLocalSeq: note.localSeq,
      baseBodySha256: note.bodySha256
    });

    const page = engine.search('cancion', null, 10, null);
    expect(page.items.map((item) => item.id)).toContain(note.id);
  });

  it('al revés también: busca "canción" y encuentra "cancion" sin tilde', async () => {
    const { conn } = openNodeSqliteConn(':memory:');
    const engine = await SqliteLibraryEngine.open(conn, 'Mac', { blobs: new MemoryBlobStore() });

    const note = await engine.noteCreate(null);
    await engine.noteSave({
      id: note.id,
      body: 'Sin tilde: cancion de cuna',
      title: 'Sin tilde: cancion de cuna',
      titleNorm: 'sin tilde: cancion de cuna',
      excerpt: 'Sin tilde: cancion de cuna',
      expectedLocalSeq: note.localSeq,
      baseBodySha256: note.bodySha256
    });

    const page = engine.search('canción', null, 10, null);
    expect(page.items.map((item) => item.id)).toContain(note.id);
  });
});
