/**
 * `hebra_jd_audit` (D18, 19 oct 2026; SPEC.md §5): la auditoría del motor JD sobre lo
 * visible, en solo lectura. Lo que no se podía dar por hecho: que señale dos carpetas con el
 * mismo ID, también con el MISMO nombre (dos dispositivos que crean a la vez: el sync admite
 * hermanas homónimas aunque la app no deje crearlas).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startJd, type JdHarness } from '../fixtures/jd-library';
import { createNote } from '../fixtures/test-library';

type Finding = { kind: string; number?: string; paths: string[]; message: string; informative?: boolean };

describe('hebra_jd_audit (D18)', () => {
  let h: JdHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('una biblioteca en orden no tiene problemas; dice qué no comprueba', async () => {
    h = await startJd();
    const result = await h.call('hebra_jd_audit', {});
    expect(result.isError, JSON.stringify(result.value)).toBe(false);
    expect(result.value).toMatchObject({
      resolved: { jdex: { id: h.ids.jdex, name: '00.00 JDex' }, templates: { id: h.ids.templates, name: '00.03 Plantillas' } },
      notChecked: ['frontmatter-mismatch', 'missing-description', 'inbox-stale', 'missing-folder'],
      nextCursor: null
    });
    const findings = result.value.findings as Finding[];
    expect(result.value.problems, JSON.stringify(findings)).toBe(0);
    expect(findings.every((finding) => finding.informative === true), JSON.stringify(findings)).toBe(true);
  });

  it('señala dos carpetas con el mismo ID, con nombres distintos y con el mismo nombre', async () => {
    h = await startJd({
      prepare: async (engine, ids) => {
        await engine.folderCreate(ids.category21, '21.12 Dos bis');
        await engine.folderCreate(ids.category21, '21.11 Uno (otro dispositivo)');
      }
    });
    // Lo que deja el sync cuando dos dispositivos crean la misma carpeta a la vez: el motor
    // local no deja crear la homónima, así que se renombra por debajo.
    const twin = h.rawFolders().find((folder) => folder.name === '21.11 Uno (otro dispositivo)')!;
    h.exec('UPDATE folders SET name = ? WHERE id = ?', '21.11 Uno', twin.id);
    expect(h.rawFolders().filter((folder) => folder.name === '21.11 Uno')).toHaveLength(2);

    const result = await h.call('hebra_jd_audit', {});
    expect(result.isError, JSON.stringify(result.value)).toBe(false);
    const duplicates = (result.value.findings as Finding[]).filter((finding) => finding.kind === 'duplicate-id');
    expect(duplicates.map((finding) => finding.number).sort()).toEqual(['21.11', '21.12']);
    const same = duplicates.find((finding) => finding.number === '21.11')!;
    expect(same.paths).toEqual(['20-29 Trabajo/21 Productos/21.11 Uno', '20-29 Trabajo/21 Productos/21.11 Uno']);
    expect(result.value.problems).toBeGreaterThanOrEqual(2);
  });

  it('carpeta sin nota, nombre distinto y cabecera con ficheros; los hallazgos se paginan', async () => {
    h = await startJd({
      prepare: async (engine, ids) => {
        await engine.folderCreate(ids.category21, '21.14 Sin nota');
        await createNote(engine, ids.jdex, '# 21.11 Uno cambiado\n');
        const header = await engine.folderCreate(ids.category21, '21.20 ■ Cabecera');
        await createNote(engine, header.id, '# Algo dentro\n');
      }
    });
    const result = await h.call('hebra_jd_audit', {});
    expect(result.isError, JSON.stringify(result.value)).toBe(false);
    const kinds = new Set((result.value.findings as Finding[]).map((finding) => finding.kind));
    expect(kinds.has('folder-without-note')).toBe(true);
    expect(kinds.has('header-with-files')).toBe(true);
    const all = result.value.findings as Finding[];
    expect(all.length).toBeGreaterThan(1);

    const first = await h.call('hebra_jd_audit', { limit: 1 });
    expect((first.value.findings as Finding[])).toEqual([all[0]]);
    expect(typeof first.value.nextCursor).toBe('string');
    const second = await h.call('hebra_jd_audit', { limit: 1, cursor: first.value.nextCursor });
    expect((second.value.findings as Finding[])).toEqual([all[1]]);
    expect(await h.call('hebra_jd_audit', { cursor: 'n1.MA' })).toEqual({ isError: true, value: { error: 'invalid_input' } });
  });
});
