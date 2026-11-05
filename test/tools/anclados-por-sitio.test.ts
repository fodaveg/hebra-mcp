import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { resolveToolContext } from '../../src/server/context';
import { runListNotes } from '../../src/server/tools/list-notes';
import { runListFolders } from '../../src/server/tools/list-folders';
import { runMoveNote, runSetFavorite } from '../../src/server/tools/organize';
import { runRenameFolder } from '../../src/server/tools/folders';

/**
 * Anclados por sitio (Hebra §26, L7). Los sitios (`notes.pinned_in`) y el icono de carpeta
 * (`folders.icon`) solo los escribe el motor desde la interfaz de Hebra; aquí se fijan con
 * SQL sobre el mismo fichero para probar lo que hebra-mcp hace con ellos: paginar sin
 * repetidos ni huecos y conservarlos al mover, renombrar o marcar favorita.
 */
describe('anclados por sitio', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  function sql(run: (db: DatabaseSync) => void): void {
    const db = new DatabaseSync(test!.sqlitePath);
    try {
      run(db);
    } finally {
      db.close();
    }
  }

  function pinnedInOf(id: string): string | null {
    let value: string | null = null;
    sql((db) => {
      const row = db.prepare('SELECT pinned_in FROM notes WHERE id = ?').get(id) as { pinned_in: string | null };
      value = row.pinned_in;
    });
    return value;
  }

  it('paginar con ancladas aquí, en otro sitio y en legado no repite ni deja huecos', async () => {
    test = await buildTestContext();
    const all = await runListNotes(test.ctx, { limit: 100 });
    const ids = all.notes.map((note) => note.id);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    // La más reciente se ancla SOLO en otra carpeta (no sube en Notas); una antigua en Notas
    // y otra del medio en legado (favorita sin sitios).
    const elsewhere = ids[0]!;
    const hereOld = ids[ids.length - 1]!;
    const legacy = ids[Math.floor(ids.length / 2)]!;
    sql((db) => {
      db.prepare('UPDATE notes SET favorite = 1, pinned_in = ? WHERE id = ?').run(
        JSON.stringify([test!.library.folders.historial]),
        elsewhere
      );
      db.prepare('UPDATE notes SET favorite = 1, pinned_in = ? WHERE id = ?').run('["@notes"]', hereOld);
      db.prepare('UPDATE notes SET favorite = 1, pinned_in = NULL WHERE id = ?').run(legacy);
    });
    const ctx = await resolveToolContext(test.serverContext);

    const full = (await runListNotes(ctx, { limit: 100 })).notes.map((note) => note.id);
    // Anclada aquí (Notas = `@notes`): la explícita y la legado, antes que el resto; la de
    // otro sitio no sube.
    expect(new Set(full.slice(0, 2))).toEqual(new Set([hereOld, legacy]));
    expect(full.indexOf(elsewhere)).toBeGreaterThanOrEqual(2);
    expect(full).toHaveLength(ids.length);

    for (const limit of [1, 2, 3]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 100; guard += 1) {
        const page = await runListNotes(ctx, { limit, ...(cursor === undefined ? {} : { cursor }) });
        seen.push(...page.notes.map((note) => note.id));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(seen, `limit ${limit}`).toEqual(full);
    }
  });

  it('mover, renombrar la carpeta y marcar favorita conservan sitios e icono', async () => {
    test = await buildTestContext();
    const { folders, publicNote2Id: id } = test.library;
    const places = JSON.stringify([folders.proyectos, '@notes'].sort());
    sql((db) => {
      db.prepare('UPDATE notes SET favorite = 1, pinned_in = ? WHERE id = ?').run(places, id);
      db.prepare('UPDATE folders SET icon = ? WHERE id = ?').run('🔥', folders.proyectos);
    });
    const ctx = await resolveToolContext(test.serverContext);

    const before = pinnedInOf(id);
    expect(before).toBe(places);

    // Mover poda en la misma transacción (§26.7): conserva `@notes` y el destino o sus ancestros.
    // `Proyectos` es ancestro de `Proyectos/Lumbre`, así que no se pierde ningún sitio.
    await runMoveNote(ctx, { id, folderId: folders.lumbre });
    expect(pinnedInOf(id)).toBe(places);

    await runRenameFolder(await resolveToolContext(test.serverContext), {
      folderId: folders.proyectos,
      name: 'Proyectos nuevos'
    });
    expect(pinnedInOf(id)).toBe(places);
    sql((db) => {
      const row = db.prepare('SELECT icon FROM folders WHERE id = ?').get(folders.proyectos) as { icon: string };
      expect(row.icon).toBe('🔥');
    });

    // `hebra_set_favorite(true)` sobre una nota que ya tiene sitios no los toca.
    await runSetFavorite(await resolveToolContext(test.serverContext), { id, favorite: true });
    expect(pinnedInOf(id)).toBe(places);
    // A una carpeta que no cuelga de `Proyectos`, el sitio de `Proyectos` se poda y `@notes` queda.
    await runMoveNote(await resolveToolContext(test.serverContext), { id, folderId: folders.historial });
    expect(pinnedInOf(id)).toBe('["@notes"]');
    // `false` los limpia todos (§26.2).
    await runSetFavorite(await resolveToolContext(test.serverContext), { id, favorite: false });
    expect(pinnedInOf(id)).toBeNull();
  });

  it('hebra_list_folders no se rompe con carpetas con icono', async () => {
    test = await buildTestContext();
    sql((db) => {
      db.prepare('UPDATE folders SET icon = ? WHERE id = ?').run('🔥', test!.library.folders.proyectos);
    });
    const { folders } = await runListFolders(await resolveToolContext(test.serverContext));
    const entry = folders.find((folder) => folder.id === test!.library.folders.proyectos);
    expect(entry).toBeDefined();
    expect(Object.keys(entry!).sort()).toEqual(['count', 'id', 'path']);
  });
});
