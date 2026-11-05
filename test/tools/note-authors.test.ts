import { describe, expect, it, vi } from 'vitest';
import type { DirectoryView } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import { runNoteAuthors } from '../../src/server/tools/note-authors';
import { createNote } from '../fixtures/test-library';
import { withOwnLibrary } from '../fixtures/own-library';

/**
 * `hebra_note_authors` (D23, 5 nov 2026) sobre una biblioteca propia: las columnas de autor
 * (`author_id`, `relay_author_id`, `relay_actor_kind`) las escribe el sync de un espacio
 * compartido, así que aquí se ponen con SQL. `Diario` es una carpeta privada y `#secreto` una
 * etiqueta privada.
 */

const SELF = 'a'.repeat(32);
const ANA = 'b'.repeat(32);
const BEA = 'c'.repeat(32);
const GONE = 'd'.repeat(32);
const BAIT = 'CEBO_AUTORES_9be4';
/** El espacio de la organizacion `1…` del directorio de prueba. */
const OWN_SPACE = '9'.repeat(32);

const DIRECTORY: DirectoryView = {
  selfAccountId: SELF,
  directory: {
    organizations: [
      {
        orgId: '1'.repeat(32),
        name: 'Org',
        members: [
          { accountId: SELF, role: 'admin', name: 'David' },
          { accountId: ANA, role: 'member', name: 'Ana' },
          { accountId: BEA, role: 'member', name: null }
        ],
        spaces: [{ spaceId: OWN_SPACE, name: null, granted: true }]
      },
      {
        orgId: '2'.repeat(32),
        name: 'Otra',
        members: [{ accountId: ANA, role: 'manager', name: null }],
        spaces: []
      }
    ],
    spaces: []
  }
};

async function build(
  engine: Parameters<Parameters<typeof withOwnLibrary>[0]>[0],
  db: Parameters<Parameters<typeof withOwnLibrary>[0]>[1]
) {
  const diario = await engine.folderCreate(null, 'Diario');
  const proyectos = await engine.folderCreate(null, 'Proyectos');
  const hijaPrivada = await engine.folderCreate(diario.id, 'Hija');
  const set = (id: string, author: string | null, relay: string | null, kind: string | null) =>
    db
      .prepare('UPDATE notes SET author_id = ?, relay_author_id = ?, relay_actor_kind = ? WHERE id = ?')
      .run(author, relay, kind, id);
  const make = async (folderId: string, body: string) => (await createNote(engine, folderId, body)).id;
  const ids = {
    member: await make(proyectos.id, '# Escrita por Ana\n'),
    self: await make(proyectos.id, '# Escrita por mí\n'),
    mismatch: await make(proyectos.id, '# Discrepa\n'),
    unknownName: await make(proyectos.id, '# Sin nombre\n'),
    gone: await make(proyectos.id, '# Cuenta que ya no es miembro\n'),
    personal: await make(proyectos.id, '# Sin autores\n'),
    privFolder: await make(diario.id, `# Privada\n${BAIT}\n`),
    privChild: await make(hijaPrivada.id, `# Privada en hija\n${BAIT}\n`),
    privTag: await make(proyectos.id, `# Privada por etiqueta\n#secreto\n${BAIT}\n`),
    trashed: await make(proyectos.id, '# Tirada\n')
  };
  set(ids.member, ANA, ANA, 'app');
  set(ids.self, SELF, SELF, 'agent');
  set(ids.mismatch, BEA, SELF, null);
  set(ids.unknownName, BEA, BEA, null);
  set(ids.gone, GONE, GONE, null);
  for (const id of [ids.privFolder, ids.privChild, ids.privTag, ids.trashed]) set(id, ANA, ANA, 'app');
  await engine.noteTrash(ids.trashed);
  return ids;
}

describe('hebra_note_authors', () => {
  it('resuelve cuentas con el directorio: nombre, rol e isSelf', async () => {
    await withOwnLibrary(build, async (fresh, ids) => {
      const ctx = await fresh();
      const directory = vi.fn(async () => DIRECTORY);
      const member = await runNoteAuthors(ctx, { id: ids.member }, directory, OWN_SPACE);
      expect(member).toEqual({
        id: ids.member,
        lastEditor: { accountId: ANA, name: 'Ana', role: 'member', isSelf: false, actorKind: 'app' },
        declaredAuthorId: ANA,
        mismatch: false,
        namesResolved: true
      });
      const self = await runNoteAuthors(ctx, { id: ids.self }, directory, OWN_SPACE);
      expect(self.lastEditor).toEqual({
        accountId: SELF,
        name: 'David',
        role: 'admin',
        isSelf: true,
        actorKind: 'agent'
      });
      // Un miembro cuyo nombre no se conoce: el id y el rol, `name` null (no se inventa).
      const unnamed = await runNoteAuthors(ctx, { id: ids.unknownName }, directory, OWN_SPACE);
      expect(unnamed.lastEditor).toEqual({ accountId: BEA, name: null, role: 'member', isSelf: false });
      // Una cuenta que ya no está en ninguna organización: solo el id.
      const gone = await runNoteAuthors(ctx, { id: ids.gone }, directory, OWN_SPACE);
      expect(gone.lastEditor).toEqual({ accountId: GONE, name: null, role: null, isSelf: false });
    });
  });

  it('el sobre y el relé que discrepan se marcan, y manda el relé', async () => {
    await withOwnLibrary(build, async (fresh, ids) => {
      const result = await runNoteAuthors(await fresh(), { id: ids.mismatch }, async () => DIRECTORY, OWN_SPACE);
      expect(result.mismatch).toBe(true);
      expect(result.declaredAuthorId).toBe(BEA);
      expect(result.lastEditor?.accountId).toBe(SELF);
    });
  });

  it('sin directorio (no disponible o ausente) devuelve las cuentas tal cual y lo dice', async () => {
    await withOwnLibrary(build, async (fresh, ids) => {
      const ctx = await fresh();
      const unavailable = async (): Promise<DirectoryView> => {
        throw new ToolError('organizations_unavailable', { reason: 'not_available' });
      };
      for (const directory of [unavailable, undefined]) {
        const result = await runNoteAuthors(ctx, { id: ids.member }, directory, OWN_SPACE);
        expect(result).toEqual({
          id: ids.member,
          lastEditor: { accountId: ANA, name: null, role: null, isSelf: null, actorKind: 'app' },
          declaredAuthorId: ANA,
          mismatch: false,
          namesResolved: false
        });
      }
      // Un fallo que no es del directorio no se traga.
      const broken = async (): Promise<DirectoryView> => {
        throw new Error('boom');
      };
      await expect(runNoteAuthors(ctx, { id: ids.member }, broken)).rejects.toThrow('boom');
    });
  });

  it('una nota sin autores (biblioteca personal, sin subir) no pide el directorio', async () => {
    await withOwnLibrary(build, async (fresh, ids) => {
      const directory = vi.fn(async () => DIRECTORY);
      const result = await runNoteAuthors(await fresh(), { id: ids.personal }, directory);
      expect(result).toEqual({
        id: ids.personal,
        lastEditor: null,
        declaredAuthorId: null,
        mismatch: false,
        namesResolved: false
      });
      expect(directory).not.toHaveBeenCalled();
    });
  });

  it('nota privada (carpeta, subcarpeta o etiqueta), en la papelera o inexistente: el mismo not_found, sin pedir el directorio', async () => {
    await withOwnLibrary(build, async (fresh, ids) => {
      const ctx = await fresh();
      const directory = vi.fn(async () => DIRECTORY);
      const bodies: string[] = [];
      for (const id of [ids.privFolder, ids.privChild, ids.privTag, ids.trashed, 'no-existe']) {
        const error = await runNoteAuthors(ctx, { id }, directory).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ToolError);
        expect((error as ToolError).code).toBe('not_found');
        expect((error as ToolError).extra).toBeUndefined();
        bodies.push(JSON.stringify({ code: (error as ToolError).code, extra: (error as ToolError).extra }));
      }
      expect(new Set(bodies).size).toBe(1);
      expect(directory).not.toHaveBeenCalled();
      expect(bodies.join('')).not.toContain(BAIT);
    });
  });
});

describe('hebra_note_authors: el rol es el de la organizacion dueña del espacio', () => {
  const SPACE = 'e'.repeat(32);
  const OTHER_SPACE = 'f'.repeat(32);
  const org = (orgId: string, role: 'admin' | 'manager' | 'member', spaceId: string) => ({
    orgId,
    name: orgId,
    members: [{ accountId: ANA, role, name: 'Ana' }],
    spaces: [{ spaceId, name: null, granted: true }]
  });
  const view = (...organizations: ReturnType<typeof org>[]): DirectoryView => ({
    selfAccountId: SELF,
    directory: { organizations, spaces: [] }
  });

  it('con la misma cuenta en dos organizaciones, en los dos ordenes, manda la dueña del espacio', async () => {
    await withOwnLibrary(build, async (fresh, ids) => {
      const ctx = await fresh();
      const owner = org('1'.repeat(32), 'member', SPACE);
      const other = org('2'.repeat(32), 'admin', OTHER_SPACE);
      for (const organizations of [[owner, other], [other, owner]]) {
        const result = await runNoteAuthors(ctx, { id: ids.member }, async () => view(...organizations), SPACE);
        expect(result.lastEditor).toMatchObject({ name: 'Ana', role: 'member' });
      }
    });
  });

  it('role es null si la cuenta no es miembro de la dueña o no se sabe cual es', async () => {
    await withOwnLibrary(build, async (fresh, ids) => {
      const ctx = await fresh();
      const other = org('2'.repeat(32), 'admin', OTHER_SPACE);
      const ownerWithoutAna = { ...org('1'.repeat(32), 'member', SPACE), members: [] };
      // Dueña sin la cuenta: ser admin en otra no cuenta.
      const notMember = await runNoteAuthors(ctx, { id: ids.member }, async () => view(ownerWithoutAna, other), SPACE);
      expect(notMember.lastEditor).toMatchObject({ name: 'Ana', role: null });
      // Espacio desconocido (personal, o fuera del directorio) o sin id de espacio.
      for (const spaceId of [undefined, 'a1'.repeat(16)]) {
        const unknown = await runNoteAuthors(ctx, { id: ids.member }, async () => view(other), spaceId);
        expect(unknown.lastEditor).toMatchObject({ role: null });
      }
    });
  });
});
