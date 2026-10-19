/**
 * Privacidad de `hebra_jd_move` (D19, 19 oct 2026; SPEC.md §6.3): lo de D18 y además:
 * - lo que una carpeta tenga dentro no decide nada (revisión de seguridad del 19 oct 2026): una
 *   carpeta solo se rechaza por la configuración, con la regla y el error de
 *   `hebra_rename_folder` (`folder_unavailable`), y lo oculto por etiqueta, bloqueado o un
 *   fichero oculto viajan con ella y siguen ocultos (P1); dos homónimas no se distinguen (P6);
 * - una ruta privada configurada en el destino, `folder_unavailable`;
 * - lo que se mueve tiene que ser visible: uno oculto responde como uno que no existe;
 * - la respuesta no depende de lo oculto de OTRAS carpetas, y nada oculto aparece en ninguna
 *   respuesta ni en el log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteLibraryEngine } from '../../src/hebra';
import { startJd, type JdHarness } from '../fixtures/jd-library';
import { createNote, lockedBody } from '../fixtures/test-library';

const PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');

let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

function stderrText(): string {
  return (stderrSpy!.mock.calls as unknown as [string][]).map(([line]) => String(line)).join('');
}

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy?.mockRestore();
  stderrSpy = undefined;
});

describe('hebra_jd_move (D19): privacidad', () => {
  let h: JdHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  function expectHidden(result: unknown, secrets: string[]): void {
    const text = JSON.stringify(result) + stderrText();
    for (const secret of secrets) expect(text, secret).not.toContain(secret);
  }

  /** Una carpeta `Bandeja/Proyecto` (movible) con `prepare` para lo que haya dentro. */
  async function withProject(
    extra: { extraPrivateFolders?: string[][]; inside?: (engine: SqliteLibraryEngine, projectId: string) => Promise<void> } = {}
  ): Promise<string> {
    let projectId = '';
    h = await startJd({
      ...(extra.extraPrivateFolders ? { extraPrivateFolders: extra.extraPrivateFolders } : {}),
      prepare: async (engine) => {
        const inbox = await engine.folderCreate(null, 'Bandeja');
        projectId = (await engine.folderCreate(inbox.id, 'Proyecto')).id;
        await createNote(engine, projectId, '# Visible\n');
        if (extra.inside) await extra.inside(engine, projectId);
      }
    });
    return projectId;
  }

  /** La simulación sin lo que cambia por carpeta (ids, nombres, rutas, el plan): lo que tiene
   *  que salir IGUAL para cualquier carpeta, tenga lo que tenga dentro. */
  function shape(value: Record<string, unknown>): string {
    const { planId: _p, expiresAt: _e, move, ...rest } = value as Record<string, unknown> & {
      move: Record<string, unknown> & { from: Record<string, unknown>; to: Record<string, unknown> };
    };
    return JSON.stringify({
      ...rest,
      move: { ...move, id: 'x', name: 'x', from: { ...move.from, folderId: 'x', folderPath: 'x' }, to: { ...move.to, name: 'x' } }
    });
  }

  it('P1: nada de lo que una carpeta tenga dentro decide la respuesta (Limpia, ConEtiqueta, ConBloqueada, Hondo/N1/N2, Hermana)', async () => {
    const ids: Record<string, string> = {};
    h = await startJd({
      prepare: async (engine) => {
        const inbox = await engine.folderCreate(null, 'Bandeja');
        for (const name of ['Limpia', 'ConEtiqueta', 'ConBloqueada', 'ConFichero', 'Hondo']) {
          ids[name] = (await engine.folderCreate(inbox.id, name)).id;
        }
        ids.N1 = (await engine.folderCreate(ids.Hondo!, 'N1')).id;
        ids.N2 = (await engine.folderCreate(ids.N1, 'N2')).id;
        ids.Hermana = (await engine.folderCreate(ids.N1, 'Hermana')).id;
        await createNote(engine, ids.ConEtiqueta!, '# Nota secreta\n\n#secreto\n');
        await createNote(engine, ids.ConBloqueada!, lockedBody('Cerrojo', []));
        await createNote(engine, ids.N2, '# Muy honda\n\n#secreto\n');
        // Un fichero oculto por la regla (b) de D10: lo enlaza una nota oculta.
        const blob = await engine.blobPut(PDF, { mime: 'application/pdf' });
        await engine.fileCreate(ids.ConFichero!, 'informe-oculto.pdf', blob.sha256);
        await createNote(engine, null, '# Enlaza\n\n![[informe-oculto.pdf]]\n\n#secreto\n');
      }
    });
    const shapes = new Map<string, string>();
    for (const name of ['Limpia', 'ConEtiqueta', 'ConBloqueada', 'ConFichero', 'Hondo', 'N1', 'N2', 'Hermana']) {
      const result = await h.call('hebra_jd_move', { mode: 'simulate', kind: 'folder', id: ids[name], toId: '21.11' });
      expect(result.isError, `${name}: ${JSON.stringify(result.value)}`).toBe(false);
      expectHidden(result, ['Nota secreta', 'Muy honda', 'Cerrojo', 'secreto', 'informe-oculto']);
      shapes.set(name, shape(result.value));
    }
    expect(new Set(shapes.values()).size).toBe(1);

    // Aplicada en ConEtiqueta, la nota #secreto viaja con la carpeta y sigue oculta.
    const plan = await h.call('hebra_jd_move', { mode: 'simulate', kind: 'folder', id: ids.ConEtiqueta, toId: '21.11' });
    const applied = await h.call('hebra_jd_move', { mode: 'apply', planId: plan.value.planId, operationId: 'op-p1' });
    expect(applied.isError, JSON.stringify(applied.value)).toBe(false);
    expectHidden(applied, ['Nota secreta', 'secreto']);
    const secret = h.rawNotes().find((note) => note.title === 'Nota secreta')!;
    expect(secret.folderId).toBe(ids.ConEtiqueta);
    expect(h.rawFolders().find((folder) => folder.id === ids.ConEtiqueta)!.parentId).toBe(h.ids.id2111);
    expect(await h.call('hebra_read_note', { id: secret.id })).toEqual({ isError: true, value: { error: 'not_found' } });
    const listed = await h.call('hebra_list_notes', { folder: '20-29 Trabajo/21 Productos/21.11 Uno/ConEtiqueta' });
    expect(JSON.stringify(listed)).not.toContain(secret.id);
  });

  it('P6: dos carpetas homónimas, una con una ruta privada configurada debajo, responden igual que hebra_rename_folder', async () => {
    const ids: string[] = [];
    h = await startJd({
      extraPrivateFolders: [['bandeja', 'proj', 'sec']],
      prepare: async (engine) => {
        const inbox = await engine.folderCreate(null, 'Bandeja');
        const first = await engine.folderCreate(inbox.id, 'proj');
        const second = await engine.folderCreate(inbox.id, 'proj tmp');
        await engine.folderCreate(first.id, 'sec');
        ids.push(first.id, second.id);
      }
    });
    // La segunda pasa a llamarse igual, como la traería el sync de otro dispositivo.
    h.exec('UPDATE folders SET name = ? WHERE id = ?', 'proj', ids[1]!);
    const responses = [];
    for (const id of ids) {
      const moved = await h.call('hebra_jd_move', { mode: 'simulate', kind: 'folder', id, toId: '21.11' });
      const renamed = await h.call('hebra_rename_folder', { folderId: id, name: 'proj' });
      expect(moved).toEqual({ isError: true, value: { error: 'folder_unavailable' } });
      expect(renamed).toEqual(moved);
      responses.push(JSON.stringify(moved));
    }
    expect(responses[1]).toBe(responses[0]);
  });

  it('una ruta privada configurada en el destino responde folder_unavailable, como hebra_rename_folder', async () => {
    const projectId = await withProject({
      extraPrivateFolders: [['20-29 trabajo', '21 productos', '21.11 uno', 'reservado']],
      inside: async (engine) => {
        const uno = (await engine.foldersList()).folders.find((folder) => folder.name === '21.11 Uno')!;
        await engine.folderCreate(uno.id, 'Reservado');
      }
    });
    const foldersBefore = h!.rawFolders();
    // Con el mismo nombre que la oculta, como carpeta, como subcarpeta y como `as`.
    for (const args of [
      { kind: 'folder', id: projectId, toId: '21.11', as: 'Reservado' },
      { kind: 'folder', id: projectId, toId: '21.11', subfolder: 'Reservado' }
    ]) {
      const result = await h!.call('hebra_jd_move', { mode: 'simulate', ...args });
      expect(result, JSON.stringify(args)).toEqual({ isError: true, value: { error: 'folder_unavailable' } });
      expectHidden(result, ['Reservado', 'reservado']);
    }
    expect(h!.rawFolders()).toEqual(foldersBefore);
    // Con otro nombre, sí.
    const ok = await h!.call('hebra_jd_move', { mode: 'simulate', kind: 'folder', id: projectId, toId: '21.11' });
    expect(ok.isError, JSON.stringify(ok.value)).toBe(false);
  });

  it('lo que se mueve tiene que ser visible: una nota, un fichero o una carpeta ocultos, como inexistentes', async () => {
    h = await startJd({
      prepare: async (engine) => {
        await createNote(engine, null, '# Oculta por etiqueta\n\n#secreto\n');
      }
    });
    const hidden = h.rawNotes().find((note) => note.title === 'Oculta por etiqueta')!;
    const diario = h.rawFolders().find((folder) => folder.name === 'Diario')!;
    const missing = { isError: true, value: { error: 'source_not_found' } };
    expect(await h.call('hebra_jd_move', { mode: 'simulate', kind: 'note', id: hidden.id, toId: '21.11' })).toEqual(missing);
    expect(await h.call('hebra_jd_move', { mode: 'simulate', kind: 'note', id: 'no-existe', toId: '21.11' })).toEqual(missing);
    expect(await h.call('hebra_jd_move', { mode: 'simulate', kind: 'folder', id: diario.id, toId: '21.11' })).toEqual(missing);
    expect(
      await h.call('hebra_jd_move', { mode: 'simulate', kind: 'file', id: h.test.library.files.privateFolder, toId: '21.11' })
    ).toEqual(missing);
    expectHidden(missing, [hidden.id, 'Oculta por etiqueta']);
  });

  it('la respuesta no depende de lo oculto de otras carpetas', async () => {
    const shapes: string[] = [];
    for (const withHidden of [false, true]) {
      const projectId = await withProject({
        inside: async (engine) => {
          if (!withHidden) return;
          const dos = (await engine.foldersList()).folders.find((folder) => folder.name === '21.12 Dos')!;
          await createNote(engine, dos.id, '# Al lado\n\n#secreto\n');
          await createNote(engine, null, '# 21.11 Repetida\n\n#secreto\n');
        }
      });
      const result = await h!.call('hebra_jd_move', { mode: 'simulate', kind: 'folder', id: projectId, toId: '21.11' });
      expect(result.isError, JSON.stringify(result.value)).toBe(false);
      expectHidden(result, ['Al lado', 'Repetida']);
      const { planId: _planId, expiresAt: _expires, move, jdex: _jdex, ...rest } = result.value as Record<string, unknown> & {
        move: { id: string; from: { folderId: string }; to: { folderId: string } };
      };
      shapes.push(JSON.stringify({ ...rest, move: { ...move, id: 'x', from: { ...move.from, folderId: 'x' }, to: { ...move.to, folderId: 'x' } } }));
      const applied = await h!.call('hebra_jd_move', { mode: 'apply', planId: result.value.planId, operationId: 'op' });
      expect(applied.isError, JSON.stringify(applied.value)).toBe(false);
      expectHidden(applied, ['Al lado', 'Repetida']);
      await h!.close();
      h = undefined;
    }
    expect(shapes[1]).toBe(shapes[0]);
  });
});
