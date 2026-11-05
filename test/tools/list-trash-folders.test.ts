import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/server/errors';
import { runListTrash } from '../../src/server/tools/list-trash';
import { createNote } from '../fixtures/test-library';
import { withOwnLibrary } from '../fixtures/own-library';

/**
 * `hebra_list_trash` con `kind: "folders"` (D23, 5 nov 2026). Cada test monta su biblioteca
 * con el motor: `Diario` es privada (y lo de dentro), `#secreto` etiqueta privada.
 */

const BAIT = 'CEBO_CARPETA_PAPELERA_81d2';

/** Un respiro entre dos borrados para que `trashed_at` (ms) los distinga. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

async function expectInvalid(promise: Promise<unknown>): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ToolError);
  expect((error as ToolError).code).toBe('invalid_input');
}

describe('hebra_list_trash kind: folders', () => {
  it('lista las públicas con su ruta, la última en entrar primero, y oculta las privadas', async () => {
    await withOwnLibrary(
      async (engine) => {
        const proyectos = await engine.folderCreate(null, 'Proyectos');
        const diario = await engine.folderCreate(null, 'Diario');
        const antiguo = await engine.folderCreate(proyectos.id, 'Antiguo');
        const hijo = await engine.folderCreate(antiguo.id, 'Hijo');
        const sub = await engine.folderCreate(diario.id, `${BAIT} sub`);
        const hondo = await engine.folderCreate(sub.id, `${BAIT} hondo`);
        const viejo = await engine.folderCreate(diario.id, `${BAIT} viejo`);
        await createNote(engine, hondo.id, `# Oculta\n${BAIT}\n`);
        const raiz = await engine.folderCreate(null, 'Suelta');
        // Públicas: una de la raíz y una con hija (borrar la madre manda también a la hija).
        await engine.folderTrash(raiz.id);
        await tick();
        await engine.folderTrash(antiguo.id);
        await tick();
        // Privadas: la subcarpeta con su hija, y otra; las últimas en entrar.
        await engine.folderTrash(sub.id);
        await tick();
        await engine.folderTrash(viejo.id);
        return { raiz: raiz.id, antiguo: antiguo.id, hijo: hijo.id, hidden: [sub.id, hondo.id, viejo.id] };
      },
      async (fresh, built) => {
        const result = await runListTrash(await fresh(), { kind: 'folders', limit: 100 });
        expect(Object.keys(result).sort()).toEqual(['folders', 'nextCursor']);
        expect(result.nextCursor).toBeNull();
        const byId = new Map(result.folders.map((folder) => [folder.id, folder]));
        expect([...byId.keys()].sort()).toEqual([built.raiz, built.antiguo, built.hijo].sort());
        expect(byId.get(built.raiz)).toMatchObject({ name: 'Suelta', path: 'suelta' });
        expect(byId.get(built.antiguo)).toMatchObject({ name: 'Antiguo', path: 'proyectos/antiguo' });
        expect(byId.get(built.hijo)).toMatchObject({ name: 'Hijo', path: 'proyectos/antiguo/hijo' });
        for (const folder of result.folders) {
          expect(Number.isNaN(Date.parse(folder.trashedAt))).toBe(false);
        }
        // La última en entrar primero: `Antiguo` (y su hija, a la vez) antes que `Suelta`.
        expect(result.folders.at(-1)?.id).toBe(built.raiz);
        // Ni el nombre ni el id de ninguna oculta, ni hay recuento.
        const text = JSON.stringify(result);
        expect(text).not.toContain(BAIT);
        for (const id of built.hidden) expect(text).not.toContain(id);
      }
    );
  });

  it('una carpeta privada borrada y vuelta a crear con el mismo nombre sigue oculta', async () => {
    await withOwnLibrary(
      async (engine) => {
        const first = await engine.folderCreate(null, 'Diario');
        await engine.folderTrash(first.id);
        await engine.folderCreate(null, 'Diario');
        return first.id;
      },
      async (fresh, hiddenId) => {
        const result = await runListTrash(await fresh(), { kind: 'folders' });
        expect(result.folders).toEqual([]);
        expect(JSON.stringify(result)).not.toContain(hiddenId);
      }
    );
  });

  it('con solo ocultas en la papelera, la página está vacía y no delata cola: sin nextCursor', async () => {
    await withOwnLibrary(
      async (engine) => {
        const diario = await engine.folderCreate(null, 'Diario');
        const publica = await engine.folderCreate(null, 'Publica');
        await engine.folderTrash(publica.id);
        await tick();
        for (const name of ['uno', 'dos', 'tres']) {
          await engine.folderTrash((await engine.folderCreate(diario.id, name)).id);
          await tick();
        }
        return publica.id;
      },
      async (fresh, publicId) => {
        const page = await runListTrash(await fresh(), { kind: 'folders', limit: 1 });
        expect(page.folders.map((folder) => folder.id)).toEqual([publicId]);
        expect(page.nextCursor).toBeNull();
      }
    );
  });

  it('pagina por cursor sin saltarse ni repetir, y el cursor no vale entre notas y carpetas', async () => {
    await withOwnLibrary(
      async (engine) => {
        const ids: string[] = [];
        for (const name of ['a', 'b', 'c']) {
          const folder = await engine.folderCreate(null, name);
          await engine.folderTrash(folder.id);
          ids.push(folder.id);
          await tick();
        }
        await createNote(engine, null, '# Nota en la papelera\n').then((note) => engine.noteTrash(note.id));
        return ids.reverse();
      },
      async (fresh, expected) => {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page += 1) {
          const result = await runListTrash(await fresh(), { kind: 'folders', limit: 1, cursor });
          seen.push(...result.folders.map((folder) => folder.id));
          if (result.nextCursor === null) break;
          cursor = result.nextCursor;
        }
        expect(seen).toEqual(expected);

        const folders = await runListTrash(await fresh(), { kind: 'folders', limit: 1 });
        const notes = await runListTrash(await fresh(), { limit: 1 });
        expect(notes.notes).toHaveLength(1);
        // Un cursor de carpetas no es de notas, ni al revés, ni uno inventado.
        // (En modo notas lo rechaza el motor: `settle` de `register-tools.ts` lo vuelve `invalid_input`.)
        await expect(
          runListTrash(await fresh(), { limit: 1, cursor: folders.nextCursor! })
        ).rejects.toThrow();
        await expectInvalid(runListTrash(await fresh(), { kind: 'folders', cursor: 'r1.AAAA' }));
        await expectInvalid(runListTrash(await fresh(), { kind: 'folders', cursor: 'x1.AAAA' }));
        if (notes.nextCursor !== null) {
          await expectInvalid(
            runListTrash(await fresh(), { kind: 'folders', cursor: notes.nextCursor })
          );
        }
      }
    );
  });

  it('sin `kind`, o con `notes`, sigue listando notas', async () => {
    await withOwnLibrary(
      async (engine) => {
        const folder = await engine.folderCreate(null, 'Tirada');
        await engine.folderTrash(folder.id);
        const note = await createNote(engine, null, '# Nota tirada\n');
        await engine.noteTrash(note.id);
        return note.id;
      },
      async (fresh, noteId) => {
        for (const input of [{}, { kind: 'notes' as const }]) {
          const result = await runListTrash(await fresh(), input);
          expect(Object.keys(result).sort()).toEqual(['nextCursor', 'notes']);
          expect(result.notes.map((note) => note.id)).toEqual([noteId]);
        }
      }
    );
  });
});
