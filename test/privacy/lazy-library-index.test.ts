/**
 * Pieza A3 del plan de memoria (6 nov 2026): `PrivacyFilter.build` ya no carga todas las notas.
 * Las carga `ensure(ids)` (solo las pedidas) o `ensureAll()` (todas, el camino de transición de
 * `resolveToolContext`), y preguntar por una nota no cargada la trata como OCULTA y deja rastro
 * (`unloadedLookups`, `unloadedLookupsTotal()`).
 *
 * Lo que se comprueba aquí:
 * - sin `ensure`, falla cerrando: oculta, y el rastro sube (también `visibleNotes` y
 *   `hasHiddenLockedNote`, que recorren la biblioteca);
 * - `ensure` de una nota da la misma decisión que el filtro de la biblioteca entera
 *   (`fromSnapshot`, lo que hacía `build` antes de A3) en los casos de §6.3: pública, privada por
 *   carpeta, privada por etiqueta, bloqueada, bajo una carpeta borrada (privada y pública), y
 *   un id en la papelera o desconocido (oculto, sin contar como olvido);
 * - `ensureAll` da lo mismo que antes;
 * - `ensure` dos veces no vuelve a leer lo ya leído;
 * - las herramientas, por `resolveToolContext`, no dejan rastro (la transición las cubre).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivacyFilter } from '../../src/privacy/filter';
import { unloadedLookupsTotal } from '../../src/privacy/library-index';
import { resolveToolContext } from '../../src/server/context';
import { legacyFolderTombstone } from '../fixtures/test-library';
import { AUDIT_CONFIG, auditHarness, createNote, lockedBody, saveBody, type AuditHarness } from './audit-harness';

interface Ids {
  publicNote: string;
  folderPrivate: string;
  tagPrivate: string;
  locked: string;
  underDeletedPrivate: string;
  underDeletedPublic: string;
  trashed: string;
}

const UNKNOWN = '00000000-0000-4000-8000-00000000a3a3';

async function scenario(): Promise<AuditHarness<Ids>> {
  return auditHarness(async (engine, library) => {
    const publicNote = await createNote(engine, library.folders.proyectos, '# PublicaA3\n#trabajo\ncuerpo\n');
    const folderPrivate = await createNote(engine, library.folders.diario, '# CarpetaA3\ncuerpo\n');
    const tagPrivate = await createNote(engine, null, '# EtiquetaA3\n#secreto/hondo\ncuerpo\n');
    const locked = await createNote(engine, null, '# BloqueadaA3\n');
    await saveBody(engine, locked.id, lockedBody('BloqueadaA3', []));
    const privateSub = await engine.folderCreate(library.folders.diario, 'SubA3');
    const underDeletedPrivate = await createNote(engine, privateSub.id, '# LapidaPrivadaA3\n');
    await legacyFolderTombstone(engine, privateSub.id);
    const publicSub = await engine.folderCreate(library.folders.proyectos, 'SubPublicaA3');
    const underDeletedPublic = await createNote(engine, publicSub.id, '# LapidaPublicaA3\n');
    await legacyFolderTombstone(engine, publicSub.id);
    const trashed = await createNote(engine, null, '# PapeleraA3\n');
    await engine.noteTrash(trashed.id);
    return {
      publicNote: publicNote.id,
      folderPrivate: folderPrivate.id,
      tagPrivate: tagPrivate.id,
      locked: locked.id,
      underDeletedPrivate: underDeletedPrivate.id,
      underDeletedPublic: underDeletedPublic.id,
      trashed: trashed.id
    };
  });
}

/** El filtro de la biblioteca entera, como lo construía `build` antes de A3. */
async function fullFilter(h: AuditHarness<Ids>): Promise<PrivacyFilter> {
  return PrivacyFilter.fromSnapshot(await h.port.foldersList(), await h.port.notesVisibilityIndex(), AUDIT_CONFIG);
}

/** Lo que un filtro dice de una nota, por todos los métodos que la juzgan. */
function verdict(filter: PrivacyFilter, id: string) {
  return {
    hidden: filter.isHiddenNote(id),
    meta: filter.visibleMeta(id),
    tags: filter.visibleTagsOf(id),
    locked: filter.isLockedNote(id),
    seal: filter.sealOf(id)
  };
}

let open: AuditHarness<Ids> | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe('PrivacyFilter perezoso (A3)', () => {
  it('sin ensure, una nota (pública) se trata como oculta y deja rastro', async () => {
    const h = (open = await scenario());
    const filter = await PrivacyFilter.build(h.port, AUDIT_CONFIG);
    const totalBefore = unloadedLookupsTotal();

    expect(filter.unresolved).toBe(false);
    expect(filter.isHiddenNote(h.extra.publicNote)).toBe(true);
    expect(filter.visibleMeta(h.extra.publicNote)).toBeUndefined();
    expect(filter.unloadedLookups).toBeGreaterThan(0);
    expect(unloadedLookupsTotal()).toBeGreaterThan(totalBefore);

    // Los recorridos de la biblioteca también fallan cerrando.
    const lookups = filter.unloadedLookups;
    expect(filter.visibleNotes().size).toBe(0);
    expect(filter.hasHiddenLockedNote()).toBe(true);
    expect(filter.unloadedLookups).toBe(lookups + 2);

    // Lo que solo depende de carpetas y configuración funciona sin cargar notas.
    expect(filter.isFolderHidden(h.library.folders.diario)).toBe(true);
    expect(filter.isFolderHidden(h.library.folders.proyectos)).toBe(false);
    expect(filter.hidesAnyTag(['secreto'])).toBe(true);
  });

  it('ensure de cada nota da la misma decisión que el filtro entero', async () => {
    const h = (open = await scenario());
    const full = await fullFilter(h);
    const expected: Record<keyof Ids, boolean> = {
      publicNote: false,
      folderPrivate: true,
      tagPrivate: true,
      locked: true,
      underDeletedPrivate: true,
      underDeletedPublic: false,
      trashed: true
    };
    for (const [name, id] of Object.entries(h.extra) as Array<[keyof Ids, string]>) {
      const lazy = await (await PrivacyFilter.build(h.port, AUDIT_CONFIG)).ensure([id]);
      expect(verdict(lazy, id), name).toEqual(verdict(full, id));
      expect(lazy.isHiddenNote(id), name).toBe(expected[name]);
      // Pedida (aunque no exista, como la de la papelera): no es un olvido.
      expect(lazy.unloadedLookups, name).toBe(0);
    }
    const unknown = await (await PrivacyFilter.build(h.port, AUDIT_CONFIG)).ensure([UNKNOWN]);
    expect(unknown.isHiddenNote(UNKNOWN)).toBe(true);
    expect(unknown.unloadedLookups).toBe(0);
  });

  it('una nota cargada no destapa a otra sin cargar', async () => {
    const h = (open = await scenario());
    const lazy = await (await PrivacyFilter.build(h.port, AUDIT_CONFIG)).ensure([h.extra.publicNote]);
    expect(lazy.isHiddenNote(h.extra.publicNote)).toBe(false);
    expect(lazy.isHiddenNote(h.extra.underDeletedPublic)).toBe(true);
    expect(lazy.unloadedLookups).toBe(1);
  });

  it('ensureAll da lo mismo que el filtro de antes de A3', async () => {
    const h = (open = await scenario());
    const full = await fullFilter(h);
    const lazy = await (await PrivacyFilter.build(h.port, AUDIT_CONFIG)).ensureAll();
    expect(lazy.visibleNotes()).toEqual(full.visibleNotes());
    expect(lazy.hasHiddenLockedNote()).toBe(full.hasHiddenLockedNote());
    for (const row of await h.port.notesVisibilityIndex()) {
      expect(verdict(lazy, row.id)).toEqual(verdict(full, row.id));
    }
    expect(lazy.visibleNotes().has(h.extra.publicNote)).toBe(true);
    expect(lazy.visibleNotes().has(h.extra.underDeletedPublic)).toBe(true);
    expect(lazy.unloadedLookups).toBe(0);

    // Tras ensure parcial, ensureAll también deja el filtro entero.
    const mixed = await (await PrivacyFilter.build(h.port, AUDIT_CONFIG)).ensure([h.extra.locked]);
    await mixed.ensureAll();
    expect(mixed.visibleNotes()).toEqual(full.visibleNotes());
    expect(mixed.unloadedLookups).toBe(0);
  });

  it('ensure dos veces no vuelve a leer lo ya leído', async () => {
    const h = (open = await scenario());
    const forIds = vi.spyOn(h.port, 'notesVisibilityIndexFor');
    const all = vi.spyOn(h.port, 'notesVisibilityIndex');
    const filter = await PrivacyFilter.build(h.port, AUDIT_CONFIG);
    expect(all).not.toHaveBeenCalled();

    await filter.ensure([h.extra.publicNote, h.extra.tagPrivate, h.extra.publicNote]);
    expect(forIds).toHaveBeenCalledTimes(1);
    await filter.ensure([h.extra.tagPrivate, h.extra.publicNote]);
    expect(forIds).toHaveBeenCalledTimes(1);
    await filter.ensure([UNKNOWN]);
    await filter.ensure([UNKNOWN]);
    expect(forIds).toHaveBeenCalledTimes(2);
    await filter.ensure([h.extra.publicNote, h.extra.locked]);
    expect(forIds).toHaveBeenCalledTimes(3);
    expect(forIds.mock.calls[2]![0]).toEqual([h.extra.locked]);
    await filter.ensure([]);
    expect(forIds).toHaveBeenCalledTimes(3);

    await filter.ensureAll();
    await filter.ensureAll();
    await filter.ensure([h.extra.underDeletedPublic]);
    expect(all).toHaveBeenCalledTimes(1);
    expect(forIds).toHaveBeenCalledTimes(3);
    forIds.mockRestore();
    all.mockRestore();
  });

  it('las herramientas, con la transición de resolveToolContext, no dejan rastro', async () => {
    const h = (open = await scenario());
    const ctx = await resolveToolContext(h.serverContext);
    expect(ctx.privacy.visibleNotes().has(h.extra.publicNote)).toBe(true);
    expect(ctx.privacy.unloadedLookups).toBe(0);

    const before = unloadedLookupsTotal();
    expect((await h.call('hebra_read_note', { id: h.extra.publicNote })).isError).toBe(false);
    await h.call('hebra_list_notes', { limit: 100 });
    await h.call('hebra_search', { query: 'A3' });
    await h.call('hebra_list_tags', {});
    await h.call('hebra_list_folders', {});
    await h.call('hebra_list_files', {});
    expect(unloadedLookupsTotal()).toBe(before);
  });
});
