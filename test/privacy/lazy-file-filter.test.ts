/**
 * Ficheros sueltos, adjuntos y papelera sin la biblioteca entera (pieza A6 del plan de memoria,
 * 6 nov 2026). Tres cosas:
 *
 * 1. `PrivacyFilter.hasHiddenLockedNote` con `ensureLockedNotes` (los ids de las bloqueadas
 *    vivas por el puerto, juzgados con las mismas reglas) responde lo mismo que recorriendo la
 *    biblioteca entera, en todas las combinaciones de dónde está la bloqueada (raíz, carpeta
 *    pública, privada, subcarpeta privada, lápida pública, lápida privada, carpeta recordada
 *    como privada) y de configuración (carpetas y etiquetas, solo carpetas, solo etiquetas,
 *    nada, con memoria de carpetas), sin preguntar por notas no cargadas.
 * 2. `FileFilter` y `TrashFilter` sobre un filtro perezoso deciden lo mismo que sobre el
 *    entero, y las herramientas de lectura de ficheros, adjuntos y papelera, registradas con
 *    `privacyLoad: 'lazy'`, responden igual que con `'all'` (`expectLazyEquivalent`):
 *    ficheros enlazados desde notas públicas, privadas por carpeta y por etiqueta, bloqueadas
 *    visibles y ocultas (vivas y de la papelera), incrustados por nombre, adjuntos por SHA y
 *    papelera de notas y carpetas.
 * 3. Las de escritura de ficheros, sobre DOS copias de la misma biblioteca (una con `'all'`
 *    forzado y otra con la carga declarada), porque corren una sola vez cada una.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PrivacyFilter, type PrivacyConfig } from '../../src/privacy';
import { FileFilter } from '../../src/privacy/file-filter';
import { unloadedLookupsTotal } from '../../src/privacy/library-index';
import { TrashFilter } from '../../src/privacy/trash-filter';
import { deriveNote, type SqliteLibraryEngine } from '../../src/hebra';
import type { ServerContext } from '../../src/server/context';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store';
import { callToolWithLoad, expectLazyEquivalent } from '../fixtures/privacy-load';
import { testWriteContext } from '../fixtures/test-context';
import { buildTestLibrary, legacyFolderTombstone, type TestLibrary } from '../fixtures/test-library';
import {
  AUDIT_CONFIG,
  auditHarness,
  createNote,
  lockedBody,
  saveBody,
  withEngine,
  type AuditHarness
} from './audit-harness';

const FOLDERS_ONLY: PrivacyConfig = { privateFolders: [['diario']], privateTags: [] };
const TAGS_ONLY: PrivacyConfig = { privateFolders: [], privateTags: ['secreto'] };
const NOTHING: PrivacyConfig = { privateFolders: [], privateTags: [] };

/** Un fichero suelto con esos bytes, en `folderId` (`null`, la raíz). */
async function createFile(
  engine: SqliteLibraryEngine,
  folderId: string | null,
  name: string,
  content: string,
  mime = 'image/png'
): Promise<string> {
  const blob = await engine.blobPut(new TextEncoder().encode(content), { mime });
  return (await engine.fileCreate(folderId, name, blob.sha256)).id;
}

const unlockedBody = (title: string): string => `# ${title}\nSin bloquear.\n`;

/** Desbloquea una nota (texto en claro sobre el envoltorio): el motor lo exige explícito. */
async function unlock(engine: SqliteLibraryEngine, id: string, body: string): Promise<void> {
  const row = (await engine.noteRead(id))!;
  await engine.noteSave({
    ...deriveNote(body),
    id,
    body,
    expectedLocalSeq: row.localSeq,
    baseBodySha256: row.bodySha256,
    unlock: true
  });
}

// ---------------------------------------------------------------------------------------------
// 1. hasHiddenLockedNote
// ---------------------------------------------------------------------------------------------

/** Dónde puede estar una nota viva bloqueada. */
const PLACEMENTS = [
  'root',
  'publicFolder',
  'privateFolder',
  'privateSubfolder',
  'publicTombstone',
  'privateTombstone',
  'rememberedFolder'
] as const;
type Placement = (typeof PLACEMENTS)[number];

interface LockedExtra {
  notes: Record<Placement, string>;
  remembered: string;
}

/** Una nota viva (sin bloquear aún) en cada sitio de `PLACEMENTS`. Las de las lápidas, como
 *  las deja un cliente antiguo (`legacyFolderTombstone`): nota viva, carpeta borrada. */
async function lockedPlacements(engine: SqliteLibraryEngine, library: TestLibrary): Promise<LockedExtra> {
  const publicTomb = await engine.folderCreate(library.folders.proyectos, 'Lápida pública');
  const privateTomb = await engine.folderCreate(library.folders.diario, 'Lápida privada');
  const remembered = await engine.folderCreate(null, 'Recordada');
  const folderOf: Record<Placement, string | null> = {
    root: null,
    publicFolder: library.folders.proyectos,
    privateFolder: library.folders.diario,
    privateSubfolder: library.folders.diario2026,
    publicTombstone: publicTomb.id,
    privateTombstone: privateTomb.id,
    rememberedFolder: remembered.id
  };
  const notes = {} as Record<Placement, string>;
  for (const placement of PLACEMENTS) {
    notes[placement] = (await createNote(engine, folderOf[placement], unlockedBody(placement))).id;
  }
  await legacyFolderTombstone(engine, publicTomb.id);
  await legacyFolderTombstone(engine, privateTomb.id);
  return { notes, remembered: remembered.id };
}

/** Deja bloqueadas exactamente las notas de `locked`, y sin bloquear las demás. */
async function lockOnly(h: AuditHarness<LockedExtra>, locked: readonly Placement[]): Promise<void> {
  await h.mutate(async (engine) => {
    for (const placement of PLACEMENTS) {
      const id = h.extra.notes[placement];
      const isLocked = (await engine.noteRead(id))!.body.startsWith('hebra-locked:');
      if (locked.includes(placement) && !isLocked) await saveBody(engine, id, lockedBody(placement, []));
      if (!locked.includes(placement) && isLocked) await unlock(engine, id, unlockedBody(placement));
    }
  });
}

/** `hasHiddenLockedNote` con la biblioteca entera y con `ensureLockedNotes`, y el rastro de la
 *  segunda. */
async function bothWays(port: NodeLibraryPort, config: PrivacyConfig) {
  const full = (await (await PrivacyFilter.build(port, config)).ensureAll()).hasHiddenLockedNote();
  const lazyFilter = await (await PrivacyFilter.build(port, config)).ensureLockedNotes(port);
  const before = unloadedLookupsTotal();
  const lazy = lazyFilter.hasHiddenLockedNote();
  return { full, lazy, unloaded: unloadedLookupsTotal() - before, filter: lazyFilter };
}

describe('hasHiddenLockedNote con ensureLockedNotes: igual que con la biblioteca entera', () => {
  let h: AuditHarness<LockedExtra> | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('cada sitio de la bloqueada (y ninguna, y dos) con cada configuración', async () => {
    h = await auditHarness(lockedPlacements);
    const configs: Array<[string, PrivacyConfig]> = [
      ['carpetas y etiquetas', AUDIT_CONFIG],
      ['solo carpetas', FOLDERS_ONLY],
      ['solo etiquetas', TAGS_ONLY],
      ['nada', NOTHING],
      ['carpetas y memoria', { ...FOLDERS_ONLY, knownPrivateFolderIds: [h.extra.remembered] }]
    ];
    const cases: Array<readonly Placement[]> = [
      [],
      ...PLACEMENTS.map((placement) => [placement] as const),
      ['root', 'privateFolder'],
      ['publicFolder', 'publicTombstone']
    ];
    // Lo esperado, para que la equivalencia no pase con las dos ramas mal a la vez: con
    // etiquetas privadas, cualquier bloqueada (A1); sin ellas, solo las de carpeta privada,
    // lápida privada o carpeta recordada (si la memoria está en la configuración).
    const hiddenWithoutTags: Record<string, readonly Placement[]> = {
      'solo carpetas': ['privateFolder', 'privateSubfolder', 'privateTombstone'],
      nada: [],
      'carpetas y memoria': ['privateFolder', 'privateSubfolder', 'privateTombstone', 'rememberedFolder']
    };
    const seen = new Set<boolean>();
    for (const locked of cases) {
      await lockOnly(h, locked);
      for (const [label, config] of configs) {
        const result = await bothWays(h.port, config);
        const where = `${label}, bloqueadas: [${locked.join(', ')}]`;
        const expected =
          config.privateTags.length > 0
            ? locked.length > 0
            : locked.some((placement) => hiddenWithoutTags[label]!.includes(placement));
        expect(result.full, where).toBe(expected);
        expect(result.lazy, where).toBe(result.full);
        expect(result.unloaded, where).toBe(0);
        seen.add(result.lazy);
      }
    }
    expect([...seen].sort()).toEqual([false, true]);
  });

  it('no carga la biblioteca entera, y sin ensureLockedNotes falla cerrando con rastro', async () => {
    h = await auditHarness(lockedPlacements);
    await lockOnly(h, ['root']);
    const { filter } = await bothWays(h.port, FOLDERS_ONLY);
    // Perezoso de verdad: una nota que no es bloqueada no está cargada.
    const before = filter.unloadedLookups;
    expect(filter.isHiddenNote(h.library.publicNoteId)).toBe(true);
    expect(filter.unloadedLookups).toBe(before + 1);

    const bare = await PrivacyFilter.build(h.port, FOLDERS_ONLY);
    const total = unloadedLookupsTotal();
    expect(bare.hasHiddenLockedNote()).toBe(true);
    expect(unloadedLookupsTotal()).toBe(total + 1);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. FileFilter, TrashFilter y las herramientas de lectura
// ---------------------------------------------------------------------------------------------

/** Dónde va la nota bloqueada del escenario de ficheros. */
type LockedIn = 'none' | 'root' | 'private' | 'trash';

interface FilesExtra {
  /** Incrustado por nombre (`![[…]]`) desde una nota de `Proyectos`. */
  publicByName: string;
  /** Incrustado por nombre desde una nota de `Diario/2026`. */
  privateFolderByName: string;
  /** Nota visible que vuelve a adjuntar los bytes del adjunto privado (M6). */
  reattachNoteId: string;
  lockedNoteId: string | null;
}

const PUBLIC_DRAWING = 'publico-dibujo.png';
const PRIVATE_DRAWING = 'diario-dibujo.png';

function filesScenario(lockedIn: LockedIn) {
  return async (engine: SqliteLibraryEngine, library: TestLibrary): Promise<FilesExtra> => {
    const publicByName = await createFile(engine, null, PUBLIC_DRAWING, 'dibujo público');
    const privateFolderByName = await createFile(engine, null, PRIVATE_DRAWING, 'dibujo del diario');
    await createNote(engine, library.folders.proyectos, `# Con dibujo\n\n![[${PUBLIC_DRAWING}]]\n`);
    await createNote(engine, library.folders.diario2026, `# Diario con dibujo\n\n![[${PRIVATE_DRAWING}]]\n`);
    const reattach = await createNote(
      engine,
      null,
      `# Reenlaza\n\n![[sha256:${library.privateAttachmentSha}|copia.txt]]\n`
    );
    // Otras notas que enlazan los bytes de los adjuntos de la nota de adjuntos (por SHA): una
    // pública y una con etiqueta privada. No son la nota pedida ni enlazan ningún fichero
    // suelto, así que solo las carga el `ensure` de `notesLinkingBlobs`.
    await createNote(engine, library.folders.proyectos, `# Comparte\n\n![[sha256:${library.attachments.png}|otra.png]]\n`);
    await createNote(engine, null, `# Comparte en secreto\n#secreto\n\n![[sha256:${library.attachments.text}|t.txt]]\n`);
    let lockedNoteId: string | null = null;
    if (lockedIn !== 'none') {
      const folder = lockedIn === 'private' ? library.folders.diario : null;
      const note = await createNote(engine, folder, unlockedBody('Bloqueada'));
      await saveBody(engine, note.id, lockedBody('Bloqueada', [library.attachments.pdf]));
      if (lockedIn === 'trash') await engine.noteTrash(note.id);
      lockedNoteId = note.id;
    }
    return { publicByName, privateFolderByName, reattachNoteId: reattach.id, lockedNoteId };
  };
}

/** Todos los ficheros del escenario, visibles y ocultos, vivos, de la papelera y la lápida. */
function allFileIds(h: AuditHarness<FilesExtra>): string[] {
  return [...Object.values(h.library.files), h.extra.publicByName, h.extra.privateFolderByName];
}

/** Lo que los dos filtros deciden de los ficheros y de la papelera, para compararlo. */
async function decisions(h: AuditHarness<FilesExtra>, privacy: PrivacyFilter) {
  const files = await FileFilter.build(h.port, privacy, h.serverContext.privacyConfig);
  const trash = await TrashFilter.build(h.port, privacy, h.serverContext.privacyConfig);
  const trashIndex = await h.port.trashIndex();
  const shas = [...new Set((await h.port.filesIndex()).files.map((file) => file.sha256.toLowerCase()))].sort();
  return {
    visibleFiles: files.visibleFiles().sort((a, b) => a.id.localeCompare(b.id)),
    contents: allFileIds(h).map((id) => files.contentOf(id) ?? null),
    hidesContent: shas.map((sha) => files.hidesContent(sha)),
    trashNotes: trashIndex.notes.map((note) => trash.visibleMeta(note.id) ?? null),
    trashFolders: trashIndex.folders.map((row) => trash.restoreFolderOf(row.id) ?? null),
    trashLocked: trash.hasHiddenLockedNote()
  };
}

const HARNESSES: Array<[string, PrivacyConfig, LockedIn]> = [
  ['carpetas y etiquetas, sin bloqueadas', AUDIT_CONFIG, 'none'],
  ['carpetas y etiquetas, bloqueada en la raíz (oculta, A1)', AUDIT_CONFIG, 'root'],
  ['solo carpetas, bloqueada en la raíz (visible)', FOLDERS_ONLY, 'root'],
  ['solo carpetas, bloqueada en carpeta privada (oculta)', FOLDERS_ONLY, 'private'],
  ['solo carpetas, bloqueada en la papelera (visible)', FOLDERS_ONLY, 'trash'],
  ['carpetas y etiquetas, bloqueada en la papelera (oculta)', AUDIT_CONFIG, 'trash']
];

/** ¿Se ven los ficheros que se incrustan por nombre? Solo si no hay bloqueada oculta. */
function linkableVisible(config: PrivacyConfig, lockedIn: LockedIn): boolean {
  if (lockedIn === 'none') return true;
  if (config.privateTags.length > 0) return false;
  return lockedIn !== 'private';
}

describe.each(HARNESSES)('ficheros, adjuntos y papelera perezosos: %s', (_label, config, lockedIn) => {
  let h: AuditHarness<FilesExtra> | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('FileFilter y TrashFilter deciden lo mismo sobre un filtro perezoso', async () => {
    h = await auditHarness(filesScenario(lockedIn), config);
    const full = await decisions(h, await (await PrivacyFilter.build(h.port, config)).ensureAll());
    const before = unloadedLookupsTotal();
    const lazy = await decisions(h, await PrivacyFilter.build(h.port, config));
    expect(unloadedLookupsTotal() - before).toBe(0);
    expect(lazy).toEqual(full);
    const names = lazy.visibleFiles.map((file) => file.name);
    expect(names.includes(PUBLIC_DRAWING)).toBe(linkableVisible(config, lockedIn));
    expect(names).not.toContain(PRIVATE_DRAWING);
  });

  it('las herramientas de lectura responden igual con lazy que con all', async () => {
    h = await auditHarness(filesScenario(lockedIn), config);
    const { library, extra } = h;
    const calls: Array<[string, Record<string, unknown>]> = [
      ['hebra_list_files', {}],
      ['hebra_list_files', { trashed: true }],
      ['hebra_list_files', { name: 'png' }],
      ['hebra_list_files', { folder: 'Proyectos', subfolders: true }],
      ['hebra_list_files', { limit: 2 }],
      ...allFileIds(h).map((id): [string, Record<string, unknown>] => ['hebra_read_file', { id }]),
      ['hebra_list_attachments', { id: library.attachmentsNoteId }],
      ['hebra_list_attachments', { id: library.privateAttachmentNoteId }],
      ['hebra_list_attachments', { id: extra.reattachNoteId }],
      ['hebra_read_attachment', { id: library.attachmentsNoteId, attachmentId: library.attachments.png }],
      ['hebra_read_attachment', { id: library.attachmentsNoteId, attachmentId: library.attachments.text }],
      ['hebra_read_attachment', { id: library.attachmentsNoteId, attachmentId: library.attachments.missing }],
      ['hebra_read_attachment', { id: extra.reattachNoteId, attachmentId: library.privateAttachmentSha }],
      ['hebra_read_attachment', { id: library.privateAttachmentNoteId, attachmentId: library.privateAttachmentSha }],
      ['hebra_list_trash', {}],
      ['hebra_list_trash', { kind: 'folders' }]
    ];
    if (extra.lockedNoteId) {
      calls.push(['hebra_list_attachments', { id: extra.lockedNoteId }]);
      calls.push(['hebra_read_attachment', { id: extra.lockedNoteId, attachmentId: library.attachments.pdf }]);
    }
    const out = new Map<string, any>();
    for (const [name, args] of calls) {
      const call = await expectLazyEquivalent(h.serverContext, name, args);
      out.set(`${name} ${JSON.stringify(args)}`, call.json);
    }
    // Y QUÉ responden (las dos podrían estar mal a la vez).
    const listed = (out.get('hebra_list_files {}').files as Array<{ name: string }>).map((file) => file.name);
    expect(listed.includes(PUBLIC_DRAWING)).toBe(linkableVisible(config, lockedIn));
    expect(listed).not.toContain(PRIVATE_DRAWING);
    expect(out.get(`hebra_read_file ${JSON.stringify({ id: extra.privateFolderByName })}`)).toEqual({ error: 'not_found' });
    expect(out.get(`hebra_list_attachments ${JSON.stringify({ id: library.privateAttachmentNoteId })}`)).toEqual({
      error: 'not_found'
    });
    const reattached = out.get(`hebra_list_attachments ${JSON.stringify({ id: extra.reattachNoteId })}`);
    expect(reattached.attachments).toEqual([
      { attachmentId: library.privateAttachmentSha, name: 'copia.txt', mimeType: 'text/plain', byteLength: null }
    ]);
    const trashed = out.get('hebra_list_trash {}').notes as Array<{ id: string }>;
    expect(trashed.map((note) => note.id)).toContain(library.trashedNoteId);
    expect(trashed.map((note) => note.id)).not.toContain(library.trashedPrivateFolderNoteId);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Las herramientas de escritura, sobre dos copias
// ---------------------------------------------------------------------------------------------

interface Copy {
  port: NodeLibraryPort;
  serverContext: ServerContext;
}

interface TwoCopies {
  library: TestLibrary;
  extra: FilesExtra;
  all: Copy;
  lazy: Copy;
  close(): Promise<void>;
}

/** La misma biblioteca (con el escenario de ficheros) en dos directorios: mismos ids. */
async function twoCopies(config: PrivacyConfig, lockedIn: LockedIn): Promise<TwoCopies> {
  const dirA = await mkdtemp(join(tmpdir(), 'hebra-mcp-a6-all-'));
  const dirB = await mkdtemp(join(tmpdir(), 'hebra-mcp-a6-lazy-'));
  const sqliteA = join(dirA, 'library.sqlite');
  const library = await buildTestLibrary(sqliteA);
  const extra = await withEngine(sqliteA, (engine) => filesScenario(lockedIn)(engine, library));
  await cp(dirA, dirB, { recursive: true });
  const open = async (dataDir: string): Promise<Copy> => {
    const port = await openNodeLibraryPort({ sqlitePath: join(dataDir, 'library.sqlite'), dataDir });
    return {
      port,
      serverContext: { port, privacyConfig: config, status: new UnlinkedStatusSource(), write: testWriteContext(port) }
    };
  };
  const all = await open(dirA);
  const lazy = await open(dirB);
  return {
    library,
    extra,
    all,
    lazy,
    async close() {
      all.port.close();
      lazy.port.close();
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  };
}

/** El resultado con el id de un fichero NUEVO (crear, duplicar) cambiado por un marcador: cada
 *  copia le da uno distinto. */
function withoutNewId(json: any, created: boolean): any {
  return created && json && typeof json.id === 'string' ? { ...json, id: '<nuevo>' } : json;
}

describe.each([
  ['carpetas y etiquetas, sin bloqueadas', AUDIT_CONFIG, 'none' as LockedIn],
  ['solo carpetas, bloqueada en la raíz (visible)', FOLDERS_ONLY, 'root' as LockedIn],
  ['carpetas y etiquetas, bloqueada en la raíz (oculta)', AUDIT_CONFIG, 'root' as LockedIn]
])('escrituras de ficheros perezosas sobre dos copias: %s', (_label, config, lockedIn) => {
  let copies: TwoCopies | undefined;

  afterEach(async () => {
    await copies?.close();
    copies = undefined;
  });

  it('mandar a la papelera, restaurar, reemplazar, crear, renombrar, mover y duplicar', async () => {
    copies = await twoCopies(config, lockedIn);
    const { library, extra } = copies;
    const files = library.files;
    const sha = async (copy: Copy, id: string): Promise<string> =>
      (await callToolWithLoad(copy.serverContext, 'hebra_read_file', { id }, 'all')).json.sha256 ?? '0'.repeat(64);
    const inventorySha = await sha(copies.all, files.inventario);
    expect(await sha(copies.lazy, files.inventario)).toBe(inventorySha);
    let op = 0;
    const opId = (): string => `a6-lazy-${String((op += 1)).padStart(4, '0')}-0000-4000-8000-000000000000`;
    const writes: Array<[string, Record<string, unknown>, boolean]> = [
      ['hebra_trash_file', { id: files.acta }, false],
      ['hebra_trash_file', { id: files.privateFolder }, false],
      ['hebra_trash_file', { id: files.referencedByName }, false],
      ['hebra_trash_file', { id: extra.publicByName }, false],
      ['hebra_restore_file', { id: files.acta }, false],
      ['hebra_restore_file', { id: files.trashedPrivateFolder }, false],
      ['hebra_restore_file', { id: files.trashed }, false],
      [
        'hebra_replace_file_text',
        { id: files.inventario, expectedSha256: inventorySha, text: 'views: []\n', operationId: opId() },
        false
      ],
      [
        'hebra_replace_file_text',
        { id: files.privateFolder, expectedSha256: '0'.repeat(64), text: 'x\n', operationId: opId() },
        false
      ],
      ['hebra_create_file', { name: 'nuevo.txt', text: 'hola\n', operationId: opId() }, true],
      ['hebra_create_file', { folder: 'Diario', name: 'secreto.txt', text: 'x\n', operationId: opId() }, true],
      ['hebra_rename_file', { id: files.plano, name: 'plano nuevo.pdf', operationId: opId() }, false],
      ['hebra_rename_file', { id: extra.privateFolderByName, name: 'otro.png', operationId: opId() }, false],
      ['hebra_move_file', { id: files.acta, folder: 'Proyectos', operationId: opId() }, false],
      ['hebra_move_file', { id: files.privateFolder, folderId: 'root', operationId: opId() }, false],
      ['hebra_duplicate_file', { id: files.inventario, name: 'Inventario copia.base', operationId: opId() }, true],
      ['hebra_duplicate_file', { id: files.referencedByHash, name: 'copia.txt', operationId: opId() }, true]
    ];
    const answered = new Set<string>();
    for (const [name, args, created] of writes) {
      const all = await callToolWithLoad(copies.all.serverContext, name, args, 'all');
      const lazy = await callToolWithLoad(copies.lazy.serverContext, name, args);
      const where = `${name} ${JSON.stringify(args)}`;
      expect(lazy.declared, where).toBe('lazy');
      expect(lazy.unloadedLookups, where).toBe(0);
      expect(lazy.isError, where).toBe(all.isError);
      expect(withoutNewId(lazy.json, created), where).toEqual(withoutNewId(all.json, created));
      answered.add(lazy.isError ? String(lazy.json?.error) : 'ok');
    }
    // Rechazos por privacidad siempre; escrituras hechas, salvo con una bloqueada oculta, que
    // oculta todo lo que se incrusta por nombre (y los de este escenario lo son casi todos).
    expect(answered.has('not_found'), [...answered].join(', ')).toBe(true);
    expect(answered.has('ok'), [...answered].join(', ')).toBe(linkableVisible(config, lockedIn));
    // Y las dos copias quedaron con los mismos ficheros visibles.
    const listAll = await callToolWithLoad(copies.all.serverContext, 'hebra_list_files', { limit: 100 }, 'all');
    const listLazy = await callToolWithLoad(copies.lazy.serverContext, 'hebra_list_files', { limit: 100 }, 'all');
    const shape = (json: any) =>
      (json.files as Array<{ name: string; folderPath: string }>).map((file) => `${file.folderPath}/${file.name}`).sort();
    expect(shape(listLazy.json)).toEqual(shape(listAll.json));
  });
});
