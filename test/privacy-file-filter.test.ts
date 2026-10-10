/**
 * `FileFilter` (D10, 9 oct 2026; SPEC.md §6.3, «Ficheros sueltos») sobre datos escritos
 * aquí, sin almacén: las dos reglas una a una. (a) Por carpeta, con la subida por
 * lápidas de la papelera de notas; (b) por referencia desde una nota que no se ve, viva o
 * de la papelera. Y cerrado ante la duda en las dos.
 */
import { describe, expect, it } from 'vitest';
import type { FoldersList } from '../src/hebra';
import { FileFilter, PrivacyFilter, type PrivacyConfig } from '../src/privacy';
import type { FileEntry, FileNoteRef, FolderRowFact, NoteVisibilityEntry } from '../src/store/types';

type LiveFolder = FoldersList['folders'][number];

const ROOT: LiveFolder = {
  id: 'root',
  parentId: null,
  parentState: 'ok',
  name: '',
  createdAt: 0,
  updatedAt: 0,
  noteCount: 0
};

function folder(id: string, name: string, parentId = 'root'): LiveFolder {
  return { ...ROOT, id, parentId, name };
}

function file(id: string, folderId: string, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    id,
    folderId,
    name: `${id}.pdf`,
    sha256: '0'.repeat(64),
    byteLength: 10,
    mime: 'application/pdf',
    updatedAt: 1,
    trashedAt: null,
    ...extra
  };
}

interface Snapshot {
  folders: LiveFolder[];
  rows?: FolderRowFact[];
  notes?: NoteVisibilityEntry[];
  trashedNotes?: Array<{ id: string; folderId: string; tags?: string[] }>;
  files: FileEntry[];
  refs?: FileNoteRef[];
}

function filterFor(snapshot: Snapshot, config: PrivacyConfig): FileFilter {
  const live = PrivacyFilter.fromSnapshot({ folders: snapshot.folders }, snapshot.notes ?? [], config);
  return FileFilter.fromSnapshot(
    live,
    {
      files: snapshot.files,
      refs: snapshot.refs ?? [],
      trash: {
        notes: (snapshot.trashedNotes ?? []).map((note) => ({ tags: [], trashedAt: 1, ...note })),
        folders: snapshot.rows ?? []
      }
    },
    config
  );
}

const DIARIO_PRIVATE: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };

describe('FileFilter (a): por carpeta', () => {
  it('carpeta viva privada o subcarpeta, oculto; visible o la raíz, visible con ESA carpeta', () => {
    const filter = filterFor(
      {
        folders: [
          ROOT,
          folder('diario', 'Diario'),
          folder('diario-2026', '2026', 'diario'),
          folder('proyectos', 'Proyectos')
        ],
        files: [
          file('f-diario', 'diario'),
          file('f-sub', 'diario-2026'),
          file('f-proyectos', 'proyectos'),
          file('f-raiz', 'root'),
          file('f-tirado', 'proyectos', { trashedAt: 5 }),
          file('f-diario-tirado', 'diario', { trashedAt: 5 })
        ]
      },
      DIARIO_PRIVATE
    );
    expect(filter.isVisible('f-diario')).toBe(false);
    expect(filter.isVisible('f-sub')).toBe(false);
    expect(filter.isVisible('f-diario-tirado')).toBe(false);
    expect(filter.visibleMeta('f-proyectos')).toEqual({
      id: 'f-proyectos',
      name: 'f-proyectos.pdf',
      folderId: 'proyectos',
      mime: 'application/pdf',
      byteLength: 10,
      updatedAt: 1,
      trashedAt: null
    });
    expect(filter.visibleMeta('f-raiz')?.folderId).toBe('root');
    // La misma regla en la papelera: la carpeta a la que volvería.
    expect(filter.visibleMeta('f-tirado')).toMatchObject({ folderId: 'proyectos', trashedAt: 5 });
    expect(filter.visibleFiles().map((entry) => entry.id).sort()).toEqual([
      'f-proyectos',
      'f-raiz',
      'f-tirado'
    ]);
  });

  it('una carpeta privada borrada y vuelta a crear con el mismo nombre no destapa los ficheros de la vieja', () => {
    const filter = filterFor(
      {
        folders: [ROOT, folder('nueva', 'Diario')],
        rows: [
          { id: 'root', parentId: null, name: '', deleted: false },
          { id: 'nueva', parentId: 'root', name: 'Diario', deleted: false },
          { id: 'vieja', parentId: 'root', name: 'Diario', deleted: true },
          { id: 'vieja-sub', parentId: 'vieja', name: '2025', deleted: true },
          { id: 'otra', parentId: 'root', name: 'Recetas', deleted: true }
        ],
        files: [
          file('f-vieja', 'vieja', { trashedAt: 3 }),
          file('f-vieja-sub', 'vieja-sub', { trashedAt: 3 }),
          // Vivo en una carpeta borrada (no pasó por `folderTrash` de este dispositivo):
          // misma regla, sin mirar si está en la papelera.
          file('f-vieja-vivo', 'vieja'),
          file('f-otra', 'otra', { trashedAt: 3 }),
          file('f-otra-vivo', 'otra')
        ]
      },
      DIARIO_PRIVATE
    );
    expect(filter.isVisible('f-vieja')).toBe(false);
    expect(filter.isVisible('f-vieja-sub')).toBe(false);
    expect(filter.isVisible('f-vieja-vivo')).toBe(false);
    // Una carpeta pública borrada: se ve, y la única carpeta que se enseña es la raíz.
    expect(filter.visibleMeta('f-otra')?.folderId).toBe('root');
    expect(filter.visibleMeta('f-otra-vivo')?.folderId).toBe('root');
  });

  it('cerrado ante la duda: carpeta sin fila, sin nombre o en ciclo, oculto', () => {
    const filter = filterFor(
      {
        folders: [ROOT],
        rows: [
          { id: 'sin-nombre', parentId: 'root', name: null, deleted: true },
          { id: 'a', parentId: 'b', name: 'A', deleted: true },
          { id: 'b', parentId: 'a', name: 'B', deleted: true }
        ],
        files: [
          file('f-fantasma', 'no-hay-fila'),
          file('f-sin-nombre', 'sin-nombre'),
          file('f-ciclo', 'a', { trashedAt: 2 }),
          file('f-raiz', 'root')
        ]
      },
      { privateFolders: [], privateTags: [] }
    );
    expect(filter.isVisible('f-fantasma')).toBe(false);
    expect(filter.isVisible('f-sin-nombre')).toBe(false);
    expect(filter.isVisible('f-ciclo')).toBe(false);
    expect(filter.isVisible('f-raiz')).toBe(true);
    expect(filter.visibleFiles().map((entry) => entry.id)).toEqual(['f-raiz']);
  });

  it('un id que no es de un fichero (una nota, una carpeta, un hash, nada) no es visible', () => {
    const filter = filterFor(
      {
        folders: [ROOT, folder('proyectos', 'Proyectos')],
        notes: [{ id: 'nota', folderId: 'root', tags: [] }],
        files: [file('f-raiz', 'root')]
      },
      { privateFolders: [], privateTags: [] }
    );
    for (const id of ['nota', 'proyectos', 'root', 'a'.repeat(64), 'no-existe', '']) {
      expect(filter.visibleMeta(id), id).toBeUndefined();
    }
    expect(filter.isVisible('f-raiz')).toBe(true);
  });
});

describe('FileFilter (b): por referencia', () => {
  const folders = [ROOT, folder('diario', 'Diario'), folder('proyectos', 'Proyectos')];

  it('oculto si lo enlaza una nota viva oculta, por carpeta o por etiqueta', () => {
    const filter = filterFor(
      {
        folders,
        notes: [
          { id: 'n-diario', folderId: 'diario', tags: [] },
          { id: 'n-secreta', folderId: 'root', tags: ['secreto', 'secreto/personal'] },
          { id: 'n-publica', folderId: 'proyectos', tags: ['trabajo'] }
        ],
        // Los tres ficheros están en carpetas VISIBLES: solo la referencia decide.
        files: [
          file('f-de-diario', 'root'),
          file('f-de-secreta', 'proyectos'),
          file('f-de-publica', 'root'),
          file('f-de-las-dos', 'root'),
          file('f-de-nadie', 'root')
        ],
        refs: [
          { fileId: 'f-de-diario', noteId: 'n-diario', noteTrashed: false },
          { fileId: 'f-de-secreta', noteId: 'n-secreta', noteTrashed: false },
          { fileId: 'f-de-publica', noteId: 'n-publica', noteTrashed: false },
          // Basta UNA nota oculta entre las que lo enlazan.
          { fileId: 'f-de-las-dos', noteId: 'n-publica', noteTrashed: false },
          { fileId: 'f-de-las-dos', noteId: 'n-secreta', noteTrashed: false }
        ]
      },
      DIARIO_PRIVATE
    );
    expect(filter.isVisible('f-de-diario')).toBe(false);
    expect(filter.isVisible('f-de-secreta')).toBe(false);
    expect(filter.isVisible('f-de-las-dos')).toBe(false);
    expect(filter.isVisible('f-de-publica')).toBe(true);
    expect(filter.isVisible('f-de-nadie')).toBe(true);
    expect(filter.visibleFiles().map((entry) => entry.id).sort()).toEqual([
      'f-de-nadie',
      'f-de-publica'
    ]);
  });

  it('oculto si lo enlaza una nota de la papelera que su filtro no deja ver', () => {
    const filter = filterFor(
      {
        folders,
        rows: [
          { id: 'root', parentId: null, name: '', deleted: false },
          { id: 'diario', parentId: 'root', name: 'Diario', deleted: false },
          { id: 'proyectos', parentId: 'root', name: 'Proyectos', deleted: false },
          { id: 'diario-viejo', parentId: 'diario', name: 'Viejo', deleted: true }
        ],
        trashedNotes: [
          { id: 't-diario', folderId: 'diario' },
          { id: 't-diario-viejo', folderId: 'diario-viejo' },
          { id: 't-secreta', folderId: 'root', tags: ['secreto'] },
          { id: 't-publica', folderId: 'proyectos' }
        ],
        files: [
          file('f-t-diario', 'root'),
          file('f-t-diario-viejo', 'root'),
          file('f-t-secreta', 'root', { trashedAt: 9 }),
          file('f-t-publica', 'root')
        ],
        refs: [
          { fileId: 'f-t-diario', noteId: 't-diario', noteTrashed: true },
          { fileId: 'f-t-diario-viejo', noteId: 't-diario-viejo', noteTrashed: true },
          { fileId: 'f-t-secreta', noteId: 't-secreta', noteTrashed: true },
          { fileId: 'f-t-publica', noteId: 't-publica', noteTrashed: true }
        ]
      },
      DIARIO_PRIVATE
    );
    expect(filter.isVisible('f-t-diario')).toBe(false);
    expect(filter.isVisible('f-t-diario-viejo')).toBe(false);
    expect(filter.isVisible('f-t-secreta')).toBe(false);
    // Una nota de la papelera que SÍ se ve no oculta nada.
    expect(filter.isVisible('f-t-publica')).toBe(true);
  });

  it('cerrado ante la duda: una nota que el filtro de su estado no conoce cuenta como oculta', () => {
    const filter = filterFor(
      {
        folders,
        notes: [{ id: 'n-viva', folderId: 'root', tags: [] }],
        trashedNotes: [{ id: 't-tirada', folderId: 'root' }],
        files: [
          file('f-desconocida', 'root'),
          file('f-desconocida-tirada', 'root'),
          // Instantáneas que no casan: el índice dice que está en la papelera y allí no
          // está (o al revés).
          file('f-viva-como-tirada', 'root'),
          file('f-tirada-como-viva', 'root'),
          file('f-bien', 'root')
        ],
        refs: [
          { fileId: 'f-desconocida', noteId: 'n-fantasma', noteTrashed: false },
          { fileId: 'f-desconocida-tirada', noteId: 't-fantasma', noteTrashed: true },
          { fileId: 'f-viva-como-tirada', noteId: 'n-viva', noteTrashed: true },
          { fileId: 'f-tirada-como-viva', noteId: 't-tirada', noteTrashed: false },
          { fileId: 'f-bien', noteId: 'n-viva', noteTrashed: false },
          { fileId: 'f-bien', noteId: 't-tirada', noteTrashed: true }
        ]
      },
      { privateFolders: [], privateTags: [] }
    );
    expect(filter.isVisible('f-desconocida')).toBe(false);
    expect(filter.isVisible('f-desconocida-tirada')).toBe(false);
    expect(filter.isVisible('f-viva-como-tirada')).toBe(false);
    expect(filter.isVisible('f-tirada-como-viva')).toBe(false);
    expect(filter.isVisible('f-bien')).toBe(true);
  });

  it('las dos reglas se suman: carpeta visible y referencia oculta, o al revés, oculto', () => {
    const filter = filterFor(
      {
        folders,
        notes: [
          { id: 'n-publica', folderId: 'root', tags: [] },
          { id: 'n-diario', folderId: 'diario', tags: [] }
        ],
        files: [file('f-carpeta', 'diario'), file('f-referencia', 'proyectos')],
        refs: [
          { fileId: 'f-carpeta', noteId: 'n-publica', noteTrashed: false },
          { fileId: 'f-referencia', noteId: 'n-diario', noteTrashed: false }
        ]
      },
      DIARIO_PRIVATE
    );
    expect(filter.isVisible('f-carpeta')).toBe(false);
    expect(filter.isVisible('f-referencia')).toBe(false);
    expect(filter.visibleFiles()).toEqual([]);
  });
});
