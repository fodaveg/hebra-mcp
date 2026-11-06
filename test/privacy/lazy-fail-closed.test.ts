/**
 * B1, B2 y B3 de la revisión de seguridad del candidato de memoria (6 nov 2026): tres sitios del
 * filtro perezoso (`src/privacy/filter.ts`) que, ante la duda, tienen que cerrar.
 *
 * - B1: la época de privacidad (`privacyEpochOf`, `src/store/privacy-sql.ts`) no veía dos
 *   escrituras de la PROPIA conexión que dejan número de filas y suma de `local_seq` como
 *   estaban (`data_version` solo ve las de otra conexión). Ahora lleva `total_changes()`. Y lo
 *   que anota la propia llamada en la memoria de carpetas privadas no la deja repitiéndose.
 * - B2: las carpetas se leen al construir el filtro y las notas después (`ensure`, o la consulta
 *   SQL de los recuentos). Una nota movida entretanto a una subcarpeta CREADA después dentro de
 *   una privada tiene una carpeta efectiva que el índice no conoce: se oculta, en JS
 *   (`isHiddenNote`) y en SQL (`notesScope`, `src/store/visible-sql.ts`).
 * - B3: `isLockedNote` de una nota no cargada decía `false`, y la puerta final tomaba el sello
 *   ausente de una nota no cargada como «sin sello». Ahora la primera cuenta como bloqueada (con
 *   rastro) y la segunda no pasa la comprobación de una lectura.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveToolContext } from '../../src/server/context';
import { gateStats, GateUsage, passGate } from '../../src/server/privacy-gate';
import { privacyEpochOf } from '../../src/store/privacy-sql';
import { visibleFolderCounts, visibleTagCounts } from '../../src/store/visible-sql';
import { AUDIT_CONFIG, auditHarness, createNote, lockedBody, saveBody, type AuditHarness } from './audit-harness';

interface Ids {
  /** Pública, en `Proyectos`, con la etiqueta `b2-marca` (solo ella la lleva). */
  movable: string;
  /** Pública, en la raíz. */
  rootNote: string;
  /** Bloqueada (la configuración de `B3` no tiene etiquetas privadas: se ve). */
  locked: string;
}

let open: AuditHarness<Ids> | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function scenario(config = AUDIT_CONFIG): Promise<AuditHarness<Ids>> {
  open = await auditHarness<Ids>(async (engine, library) => {
    const movable = await createNote(engine, library.folders.proyectos, '# MovibleB2\n#b2-marca\ncuerpo\n');
    const rootNote = await createNote(engine, null, '# RaizB2\ncuerpo\n');
    const locked = await createNote(engine, null, '# BloqueadaB3\n');
    await saveBody(engine, locked.id, lockedBody('BloqueadaB3', []));
    return { movable: movable.id, rootNote: rootNote.id, locked: locked.id };
  }, config);
  return open;
}

/** Número de filas y suma de `local_seq` de `notes`, la parte de la época que se quiere burlar. */
function notesSums(db: DatabaseSync): string {
  const row = db.prepare('SELECT count(*) AS n, coalesce(sum(local_seq), 0) AS s FROM notes').get() as {
    n: number;
    s: number;
  };
  return `${row.n}.${row.s}`;
}

describe('B1: la época ve las escrituras de la propia conexión', () => {
  it('dos escrituras de esta conexión que dejan número y suma iguales cambian la época', async () => {
    const h = await scenario();
    const db = new DatabaseSync(h.sqlitePath);
    try {
      const before = privacyEpochOf(db, []);
      const sums = notesSums(db);
      const dataVersion = db.prepare('PRAGMA data_version').get();
      // La nota pasa a la carpeta privada subiendo su `local_seq`, y otra lo baja lo mismo: ni el
      // número de filas ni la suma se mueven, y `data_version` no ve lo de esta conexión.
      db.prepare('UPDATE notes SET folder_id = ?, local_seq = local_seq + 1 WHERE id = ?').run(
        h.library.folders.diario,
        h.extra.movable
      );
      db.prepare('UPDATE notes SET local_seq = local_seq - 1 WHERE id = ?').run(h.extra.rootNote);
      expect(notesSums(db), 'el escenario tiene que dejar número y suma como estaban').toBe(sums);
      expect(db.prepare('PRAGMA data_version').get()).toEqual(dataVersion);
      expect(privacyEpochOf(db, []), 'dos escrituras propias con la misma suma no movieron la época').not.toBe(before);
    } finally {
      db.close();
    }
  });

  it('lo que anota la propia llamada en la memoria de carpetas privadas no la repite', async () => {
    const h = await scenario();
    // Nada anotado aún: la primera llamada resuelve `diario` y lo escribe en la tabla, con la
    // conexión del puerto (la que mira `total_changes()`).
    expect(await h.port.rememberedPrivateFolders()).toEqual([]);
    gateStats.reset();
    const call = await h.call('hebra_read_note', { id: h.extra.rootNote });
    expect(call.isError, JSON.stringify(call.json)).toBe(false);
    expect((await h.port.rememberedPrivateFolders()).length).toBeGreaterThan(0);
    expect(gateStats.repeats).toBe(0);
    expect(gateStats.fresh).toBe(0);
  });
});

describe('B2: una carpeta efectiva que el filtro no conoce oculta la nota', () => {
  it('JS: subcarpeta creada después dentro de una privada y nota movida ahí antes de ensure', async () => {
    const h = await scenario();
    const ctx = await resolveToolContext(h.serverContext, { loadAll: false });
    await h.mutate(async (engine, library) => {
      const sub = await engine.folderCreate(library.folders.diario, 'B2 nueva');
      await engine.noteMove(h.extra.movable, sub.id);
    });
    await ctx.privacy.ensure([h.extra.movable, h.extra.rootNote]);
    expect(ctx.privacy.isHiddenNote(h.extra.movable), 'la subcarpeta nueva de Diario quedó visible').toBe(true);
    expect(ctx.privacy.visibleMeta(h.extra.movable)).toBeUndefined();
    expect(ctx.privacy.hasTag(h.extra.movable, 'b2-marca')).toBe(false);
    // Control: la raíz siempre se conoce, y la de la raíz se sigue viendo.
    expect(ctx.privacy.isHiddenNote(h.extra.rootNote)).toBe(false);
    // Y un filtro nuevo la oculta por la regla de siempre (la subcarpeta ya está en su índice).
    const fresh = await resolveToolContext(h.serverContext, { loadAll: false });
    await fresh.privacy.ensure([h.extra.movable]);
    expect(fresh.privacy.isHiddenNote(h.extra.movable)).toBe(true);
  });

  it('JS: una subcarpeta nueva de una carpeta pública también cierra dentro de la llamada', async () => {
    const h = await scenario();
    const ctx = await resolveToolContext(h.serverContext, { loadAll: false });
    await h.mutate(async (engine, library) => {
      const sub = await engine.folderCreate(library.folders.proyectos, 'B2 pública nueva');
      await engine.noteMove(h.extra.movable, sub.id);
    });
    await ctx.privacy.ensure([h.extra.movable]);
    expect(ctx.privacy.isHiddenNote(h.extra.movable)).toBe(true);
    // La llamada siguiente, con la carpeta ya en su índice, la ve.
    const fresh = await resolveToolContext(h.serverContext, { loadAll: false });
    await fresh.privacy.ensure([h.extra.movable]);
    expect(fresh.privacy.isHiddenNote(h.extra.movable)).toBe(false);
  });

  it('SQL: la misma nota no cuenta en los recuentos sobre visibles del filtro de antes', async () => {
    const h = await scenario();
    const ctx = await resolveToolContext(h.serverContext, { loadAll: false });
    const db = new DatabaseSync(h.sqlitePath, { readOnly: true });
    try {
      // Control: antes de moverla, cuenta.
      expect(visibleTagCounts(db, ctx.privacy.notesScope()).get('b2-marca')).toBe(1);
      let subId = '';
      await h.mutate(async (engine, library) => {
        const sub = await engine.folderCreate(library.folders.diario, 'B2 nueva SQL');
        subId = sub.id;
        await engine.noteMove(h.extra.movable, sub.id);
      });
      const scope = ctx.privacy.notesScope();
      expect(visibleTagCounts(db, scope).get('b2-marca'), 'la subcarpeta nueva de Diario contó en SQL').toBeUndefined();
      expect(visibleFolderCounts(db, scope).has(subId)).toBe(false);
      // Control: la raíz (carpeta nula guardada como `root`) sigue contando.
      expect(visibleFolderCounts(db, scope).get('root')).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe('B3: una nota no cargada no se toma por desbloqueada ni por «sin sello»', () => {
  const NO_TAGS = { privateFolders: [['diario']], privateTags: [] };

  it('isLockedNote de una nota no cargada es true y deja rastro; cargada, lo de su fila', async () => {
    const h = await scenario(NO_TAGS);
    const ctx = await resolveToolContext(h.serverContext, { loadAll: false });
    const before = ctx.privacy.unloadedLookups;
    expect(ctx.privacy.isLockedNote(h.extra.rootNote)).toBe(true);
    expect(ctx.privacy.unloadedLookups).toBe(before + 1);
    await ctx.privacy.ensure([h.extra.rootNote, h.extra.locked]);
    const loaded = ctx.privacy.unloadedLookups;
    expect(ctx.privacy.isLockedNote(h.extra.rootNote)).toBe(false);
    expect(ctx.privacy.isLockedNote(h.extra.locked)).toBe(true);
    // Sin etiquetas privadas, la bloqueada se ve: isLockedNote no oculta lo que se ve.
    expect(ctx.privacy.isHiddenNote(h.extra.locked)).toBe(false);
    expect(ctx.privacy.unloadedLookups).toBe(loaded);
  });

  it('una nota declarada a la puerta sin cargar no pasa una lectura; cargada, sí', async () => {
    const h = await scenario();
    const ctx = await resolveToolContext(h.serverContext, { loadAll: false });
    const unloaded = new GateUsage(ctx.privacy);
    unloaded.note(h.extra.rootNote);
    const read = await passGate(h.port, ctx.privacyConfig, unloaded, { seals: true, epoch: ctx.epoch });
    expect(read.passed, 'una nota sin cargar pasó la puerta como «sin sello»').toBe(false);
    expect(read.failedNotes.has(h.extra.rootNote)).toBe(true);
    // Una escritura no mira sellos (lo que acaba de crear no está en su filtro): solo visibilidad.
    const write = await passGate(h.port, ctx.privacyConfig, unloaded, { seals: false, epoch: ctx.epoch });
    expect(write.declaredPassed).toBe(true);
    // Control: cargada, con su sello, pasa.
    await ctx.privacy.ensure([h.extra.rootNote]);
    const loaded = new GateUsage(ctx.privacy);
    loaded.note(h.extra.rootNote);
    const ok = await passGate(h.port, ctx.privacyConfig, loaded, { seals: true, epoch: ctx.epoch });
    expect(ok.passed).toBe(true);
  });
});
