/**
 * Privacidad de `hebra_jd_move` (D19, 19 oct 2026; SPEC.md §6.3): lo de D18 y además:
 * - una carpeta con algo oculto dentro (una nota por etiqueta privada, una subcarpeta privada,
 *   un fichero suelto oculto) no se mueve: `folder_has_hidden`, sin decir qué;
 * - un destino con un homónimo oculto (o una ruta privada) responde el error genérico
 *   `destination_unavailable`;
 * - lo que se mueve tiene que ser visible: uno oculto responde como uno que no existe;
 * - la respuesta no depende de lo oculto de OTRAS carpetas, y nada oculto aparece en ninguna
 *   respuesta ni en el log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteLibraryEngine } from '../../src/hebra';
import { startJd, type JdHarness } from '../fixtures/jd-library';
import { createNote } from '../fixtures/test-library';

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

  it('una carpeta con una nota privada dentro da folder_has_hidden, sin nombrarla', async () => {
    const projectId = await withProject({
      inside: async (engine, id) => {
        const sub = await engine.folderCreate(id, 'Sub');
        await createNote(engine, sub.id, '# Nota secreta\n\n#secreto\n');
      }
    });
    const result = await h!.call('hebra_jd_move', { mode: 'simulate', kind: 'folder', id: projectId, toId: '21.11' });
    expect(result).toEqual({ isError: true, value: { error: 'folder_has_hidden' } });
    expectHidden(result, ['Nota secreta', 'secreto']);
  });

  it('una carpeta con una subcarpeta privada o un fichero oculto dentro da lo mismo', async () => {
    let projectId = await withProject({
      extraPrivateFolders: [['bandeja', 'proyecto', 'oculta']],
      inside: async (engine, id) => {
        await engine.folderCreate(id, 'Oculta');
      }
    });
    expect(await h!.call('hebra_jd_move', { mode: 'simulate', kind: 'folder', id: projectId, toId: '21.11' })).toEqual({
      isError: true,
      value: { error: 'folder_has_hidden' }
    });
    await h!.close();

    projectId = await withProject({
      inside: async (engine, id) => {
        const blob = await engine.blobPut(PDF, { mime: 'application/pdf' });
        await engine.fileCreate(id, 'informe.pdf', blob.sha256);
        await createNote(engine, null, '# Enlaza\n\n![[informe.pdf]]\n\n#secreto\n');
      }
    });
    const result = await h!.call('hebra_jd_move', { mode: 'simulate', kind: 'folder', id: projectId, toId: '21.11' });
    expect(result).toEqual({ isError: true, value: { error: 'folder_has_hidden' } });
    expectHidden(result, ['informe']);
  });

  it('un destino con un homónimo oculto responde destination_unavailable, sin escribir', async () => {
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
      expect(result, JSON.stringify(args)).toEqual({ isError: true, value: { error: 'destination_unavailable' } });
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
