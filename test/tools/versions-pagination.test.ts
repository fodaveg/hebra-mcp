import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { ToolError } from '../../src/server/errors';
import { LIMITS } from '../../src/server/pagination';
import { runListVersions } from '../../src/server/tools/versions';

/**
 * `hebra_list_versions` paginada (R4.3/C5): `limit` 1-200 (50 por defecto), cursor `v1.…`,
 * salida `{id, versions, nextCursor}`; la página se llena con versiones VISIBLES y el cursor
 * solo existe si hay otra visible detrás. Se inserta a mano una tanda de versiones sobre
 * `versionedNoteId` (el motor solo guarda una cada 5 minutos): cada tercera lleva la
 * etiqueta privada `secreto/personal` y cada décima («5») es el cuerpo de una nota bloqueada.
 */
const EXTRA = 30;
const isPrivate = (index: number): boolean => index % 3 === 0;
const isLocked = (index: number): boolean => index % 10 === 5;

function seedVersions(sqlitePath: string, noteId: string): void {
  const db = new DatabaseSync(sqlitePath);
  const insert = db.prepare(
    `INSERT INTO note_versions (note_id, created_at, body, body_sha256, byte_length, cause)
     VALUES (?, ?, ?, ?, ?, NULL)`
  );
  const base = Date.now() + 60_000;
  for (let index = 0; index < EXTRA; index += 1) {
    const body = isLocked(index)
      ? `hebra-locked:${'x'.repeat(40)}`
      : isPrivate(index)
        ? `# V${index}\n#secreto/personal\ntexto\n`
        : `# V${index}\ntexto ${index}\n`;
    insert.run(noteId, base + index * 1000, body, `sha-${index}`, Buffer.byteLength(body));
  }
  db.close();
}

describe('hebra_list_versions paginada', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await test?.close();
    test = undefined;
  });

  async function build(privateTags: string[]): Promise<{ id: string }> {
    test = await buildTestContext({ privateFolders: [['diario']], privateTags });
    seedVersions(test.sqlitePath, test.library.versionedNoteId);
    return { id: test.library.versionedNoteId };
  }

  async function walk(limit: number): Promise<{ ids: number[]; pages: number }> {
    const ids: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const page = await runListVersions(test!.ctx, {
        id: test!.library.versionedNoteId,
        limit,
        cursor
      });
      pages += 1;
      ids.push(...page.versions.map((version) => version.versionId));
      if (page.nextCursor === null) break;
      expect(page.versions).toHaveLength(limit);
      cursor = page.nextCursor;
    }
    return { ids, pages };
  }

  it('recorrer por páginas da lo mismo que una sola, con las ocultas fuera', async () => {
    await build(['secreto']);
    const all = await runListVersions(test!.ctx, {
      id: test!.library.versionedNoteId,
      limit: 200
    });
    expect(all.nextCursor).toBeNull();
    const visibleExtras = Array.from({ length: EXTRA }, (_, i) => i).filter(
      (i) => !isPrivate(i) && !isLocked(i)
    ).length;
    expect(all.versions).toHaveLength(visibleExtras + 1); // + la versión original
    for (const limit of [1, 4, 7]) {
      const { ids } = await walk(limit);
      expect(ids).toEqual(all.versions.map((version) => version.versionId));
    }
  });

  it('por defecto 50, y limit se acota a 1-200', () => {
    expect(LIMITS.listVersions).toEqual({ default: 50, max: 200 });
  });

  it('el nextCursor no delata las ocultas: límite exacto da null, uno menos da cursor', async () => {
    await build(['secreto']);
    const all = await runListVersions(test!.ctx, { id: test!.library.versionedNoteId });
    const total = all.versions.length;
    const exact = await runListVersions(test!.ctx, { id: test!.library.versionedNoteId, limit: total });
    expect(exact.versions).toHaveLength(total);
    expect(exact.nextCursor).toBeNull();
    const shorter = await runListVersions(test!.ctx, {
      id: test!.library.versionedNoteId,
      limit: total - 1
    });
    expect(shorter.versions).toHaveLength(total - 1);
    expect(shorter.nextCursor).not.toBeNull();
    const last = await runListVersions(test!.ctx, {
      id: test!.library.versionedNoteId,
      limit: total - 1,
      cursor: shorter.nextCursor!
    });
    expect(last.versions).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
  });

  it('sin etiquetas privadas no lee ni analiza ningún cuerpo, y las bloqueadas siguen fuera', async () => {
    await build([]);
    const readOne = vi.spyOn(test!.ctx.port, 'noteVersionRead');
    const readMany = vi.spyOn(test!.ctx.port, 'noteVersionsRead');
    const { ids } = await walk(6);
    expect(readOne).not.toHaveBeenCalled();
    expect(readMany).not.toHaveBeenCalled();
    const lockedFree = Array.from({ length: EXTRA }, (_, i) => i).filter((i) => !isLocked(i)).length;
    expect(ids).toHaveLength(lockedFree + 1);
  });

  it('solo se leen las versiones necesarias para la página (más la de mirar por delante)', async () => {
    await build(['secreto']);
    const readMany = vi.spyOn(test!.ctx.port, 'noteVersionsRead');
    const page = await runListVersions(test!.ctx, { id: test!.library.versionedNoteId, limit: 3 });
    expect(page.versions).toHaveLength(3);
    const read = readMany.mock.calls.flatMap(([ids]) => [...ids]);
    expect(read.length).toBeLessThan(EXTRA / 2);
  });

  it('un cursor de otra herramienta o una versión desconocida: invalid_input', async () => {
    await build(['secreto']);
    const id = test!.library.versionedNoteId;
    await expect(runListVersions(test!.ctx, { id, cursor: 'n1.abc' })).rejects.toBeInstanceOf(ToolError);
    await expect(
      runListVersions(test!.ctx, { id, cursor: `v1.${Buffer.from('999999').toString('base64url')}` })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      runListVersions(test!.ctx, { id, cursor: `v1.${Buffer.from('x').toString('base64url')}` })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
