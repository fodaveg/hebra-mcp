/**
 * Pieza A9a del plan de memoria (6 nov 2026): el JDex deja de cargar la biblioteca entera.
 * `hebra_jd_new_id`, `hebra_jd_move` y `hebra_jd_audit` se registran con `privacyLoad: 'lazy'`, el
 * puerto del motor (`src/store/jd-port.ts`) pide al filtro solo las notas que decide
 * (`JdView.filter(ids)`), los sitios del escritor del JDex usan `privacyInTurnFor` con esas notas
 * y `hasHidden` ya no recorre todas las notas vivas: lee las candidatas de sus carpetas (el árbol
 * de la categoría y el JDex, `titlesInFoldersRows`) y juzga solo las que llevan el prefijo.
 *
 * Tres comprobaciones, sobre la biblioteca de prueba más un sistema JD con cada caso de §6.3
 * (carpetas JD públicas, privadas por ruta, una subcarpeta privada dentro de un ID, notas privadas
 * por etiqueta y por etiqueta anidada, bloqueadas, en la papelera, bajo una carpeta borrada, una
 * carpeta recordada (A3), el JDex privado y un fichero suelto enlazado por una nota visible):
 * 1. `hasHidden` frente al recorrido entero: el ORÁCULO es el algoritmo de antes de A9a, copiado
 *    aquí, con el filtro de la biblioteca entera (`privacyInTurn`) y `notesVisibilityIndex()`. Para
 *    cada configuración, categoría y JDex (con y sin), la misma respuesta; y la nueva no lee nunca
 *    la visibilidad de todas las notas.
 * 2. Las herramientas en dos copias (`expectLazyWriteEquivalent`): con `'all'` en una y `'lazy'` en
 *    la otra, la misma respuesta, el mismo estado de notas, carpetas y ficheros, y ninguna pregunta
 *    por una nota no cargada: auditar, simular IDs nuevos (con y sin algo oculto), aplicar,
 *    repetir con el mismo `operationId`, y mover una nota, un fichero y una carpeta (simular,
 *    aplicar, repetir y deshacer). Las respuestas se comprueban además por su valor, porque el
 *    escritor es el mismo en las dos copias.
 * 3. Lo que carga: ni el escritor ni el filtro de la llamada perezosa leen la visibilidad de todas
 *    las notas vivas (con `'all'`, el mismo espía sí la ve: control de que el espía mira).
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractJdPrefix } from '../../src/jd';
import { ROOT_FOLDER_ID } from '../../src/hebra';
import type { PrivacyConfig } from '../../src/privacy';
import { FileFilter } from '../../src/privacy/file-filter';
import { turnView } from '../../src/store/jd-new-id';
import { JdLibraryPort } from '../../src/store/jd-port';
import type { NodeLibraryPort } from '../../src/store/node-port';
import { privacyInTurn, type NoteWriteStore } from '../../src/store/writes';
import { createNote, lockedBody, saveBody, type Scenario } from './audit-harness';
import { legacyFolderTombstone } from '../fixtures/test-library';
import { callToolWithLoad } from '../fixtures/privacy-load';
import { expectLazyWriteEquivalent, twinHarness, type TwinHarness, type TwinSide } from '../fixtures/privacy-load-writes';

interface Jd {
  jdex: string;
  cat21: string;
  cat23: string;
  id2111: string;
  id2311: string;
  sub2112: string;
  /** Una nota visible de `21.11 Uno`. */
  docNote: string;
  /** Una nota oculta por `#secreto` en `21.11 Uno`. */
  secretNote: string;
  /** La nota de `Sub privada` (oculta con `SUBFOLDER_PATH`). */
  subNote: string;
  /** Una nota visible en la raíz, para moverla. */
  looseNote: string;
  /** Un fichero suelto visible, enlazado por nombre desde una nota visible. */
  contract: string;
  /** Una carpeta visible de segundo nivel, para moverla. */
  inboxProject: string;
}

const PREFIXED_TITLE = (id: string, rest: string) => `---\njd: "${id}"\ntipo: id\n---\n# ${id} ${rest}\n`;

/**
 * El sistema JD de la cabecera, con el motor de Hebra:
 * ```
 * 00-09 Sistema/00 Sistema/00.00 JDex       notas del JDex, «21.15 Privada» (#secreto) y
 *                                            «22.11 Cerrada» (bloqueada); «23.13 Tirada» en la papelera
 * 00-09 Sistema/00 Sistema/00.03 Plantillas «JDex - id»
 * 20-29 Trabajo/21 Productos/21.11 Uno      «21.11 Doc», «21.11 Secreta» (#secreto), «Sin prefijo»
 *                                            (#secreto), «21.16 Cerrada» (bloqueada), «21.17 Honda»
 *                                            (#secreto/hondo)
 * 20-29 Trabajo/21 Productos/21.12 Dos/Sub privada   «21.12 Sub»
 * 20-29 Trabajo/22 Vacía                     «22.12 Tirada» (#secreto, en la papelera)
 * 20-29 Trabajo/23 Otra/23.11 Tres           «23.11 Nota»
 * 20-29 Trabajo/23 Otra/23.12 Borrada        lápida, con «23.12 Lápida» (#secreto) viva dentro
 * 30-39 Aparte/31 Aparte
 * Diario/24.11 Escondida                     carpeta oculta con prefijo 24, fuera de todo árbol
 * Bandeja/Proyecto X                         carpeta para mover
 * Contrato.pdf (raíz) y «Enlaza contrato» (raíz), que lo incrusta por nombre
 * ```
 */
const jdScenario: Scenario<Jd> = async (engine, library) => {
  const area0 = await engine.folderCreate(null, '00-09 Sistema');
  const cat00 = await engine.folderCreate(area0.id, '00 Sistema');
  const jdex = await engine.folderCreate(cat00.id, '00.00 JDex');
  const templates = await engine.folderCreate(cat00.id, '00.03 Plantillas');
  const area2 = await engine.folderCreate(null, '20-29 Trabajo');
  const cat21 = await engine.folderCreate(area2.id, '21 Productos');
  const cat22 = await engine.folderCreate(area2.id, '22 Vacía');
  const cat23 = await engine.folderCreate(area2.id, '23 Otra');
  const id2111 = await engine.folderCreate(cat21.id, '21.11 Uno');
  const id2112 = await engine.folderCreate(cat21.id, '21.12 Dos');
  const sub2112 = await engine.folderCreate(id2112.id, 'Sub privada');
  const id2311 = await engine.folderCreate(cat23.id, '23.11 Tres');
  const tomb2312 = await engine.folderCreate(cat23.id, '23.12 Borrada');
  const area3 = await engine.folderCreate(null, '30-39 Aparte');
  await engine.folderCreate(area3.id, '31 Aparte');
  await engine.folderCreate(library.folders.diario, '24.11 Escondida');
  const bandeja = await engine.folderCreate(null, 'Bandeja');
  const inboxProject = await engine.folderCreate(bandeja.id, 'Proyecto X');

  for (const [id, rest] of [
    ['00.00', 'JDex'],
    ['00.03', 'Plantillas'],
    ['21', 'Productos'],
    ['21.11', 'Uno'],
    ['21.12', 'Dos'],
    ['22', 'Vacía'],
    ['23', 'Otra'],
    ['23.11', 'Tres'],
    ['31', 'Aparte']
  ] as const) {
    await createNote(engine, jdex.id, PREFIXED_TITLE(id, rest));
  }
  await createNote(engine, jdex.id, '# 21.15 Privada\n#secreto\n');
  const lockedJdex = await createNote(engine, jdex.id, '# 22.11 Cerrada\n');
  await saveBody(engine, lockedJdex.id, lockedBody('22.11 Cerrada', []));
  const trashedJdex = await createNote(engine, jdex.id, '# 23.13 Tirada\n#secreto\n');
  await engine.noteTrash(trashedJdex.id);
  await createNote(
    engine,
    templates.id,
    '---\ntitle: "JDex - id"\njd: "{{id}}"\ntipo: id\n---\n# {{id}} {{title}}\n\nPlantilla de {{categoryTitle}}.\n'
  );

  const docNote = await createNote(engine, id2111.id, '# 21.11 Doc\nPública.\n');
  const secretNote = await createNote(engine, id2111.id, '# 21.11 Secreta\n#secreto\n');
  await createNote(engine, id2111.id, '# Sin prefijo\n#secreto\n');
  const lockedInTree = await createNote(engine, id2111.id, '# 21.16 Cerrada\n');
  await saveBody(engine, lockedInTree.id, lockedBody('21.16 Cerrada', []));
  await createNote(engine, id2111.id, '# 21.17 Honda\n#secreto/hondo\n');
  const subNote = await createNote(engine, sub2112.id, '# 21.12 Sub\nDentro de la subcarpeta.\n');
  const trashedInTree = await createNote(engine, cat22.id, '# 22.12 Tirada\n#secreto\n');
  await engine.noteTrash(trashedInTree.id);
  await createNote(engine, id2311.id, '# 23.11 Nota\nPública.\n');
  await createNote(engine, tomb2312.id, '# 23.12 Lápida\n#secreto\n');
  await legacyFolderTombstone(engine, tomb2312.id);

  const looseNote = await createNote(engine, null, '# Factura luz\nImporte.\n');
  const blob = await engine.blobPut(new TextEncoder().encode('%PDF-1.4\n%contrato\n%%EOF\n'), { mime: 'application/pdf' });
  const contract = (await engine.fileCreate(null, 'Contrato.pdf', blob.sha256)).id;
  await createNote(engine, null, '# Enlaza contrato\n![[Contrato.pdf]]\n');
  // Un enlace a un nombre que aún no tiene fichero: el del contrato renombrado al moverlo. Sus
  // notas no salen del índice de ficheros, así que el escritor las carga aparte.
  await createNote(engine, null, '# Enlaza anexo\n![[Anexo.pdf]]\n');

  return {
    jdex: jdex.id,
    cat21: cat21.id,
    cat23: cat23.id,
    id2111: id2111.id,
    id2311: id2311.id,
    sub2112: sub2112.id,
    docNote: docNote.id,
    secretNote: secretNote.id,
    subNote: subNote.id,
    looseNote: looseNote.id,
    contract,
    inboxProject: inboxProject.id
  };
};

const SUBFOLDER_PATH = ['20-29 trabajo', '21 productos', '21.12 dos', 'sub privada'];

/** La de los movimientos: la subcarpeta privada y sin etiquetas privadas. */
const MOVE_CONFIG: PrivacyConfig = { privateFolders: [['diario'], SUBFOLDER_PATH], privateTags: [] };

/** Configuraciones de la comprobación 1 (`hasHidden`); `ids` para la carpeta recordada. */
function hasHiddenConfigs(ids: Jd): Array<[string, PrivacyConfig]> {
  return [
    ['carpeta y etiqueta privadas', { privateFolders: [['diario']], privateTags: ['secreto'] }],
    ['sin etiquetas privadas (las bloqueadas se ven)', { privateFolders: [['diario']], privateTags: [] }],
    ['subcarpeta privada dentro de un ID', { privateFolders: [['diario'], SUBFOLDER_PATH], privateTags: [] }],
    ['categoría privada', { privateFolders: [['diario'], ['20-29 trabajo', '23 otra']], privateTags: ['secreto'] }],
    [
      'carpeta recordada (A3)',
      { privateFolders: [['diario']], privateTags: [], knownPrivateFolderIds: [ids.id2311] }
    ],
    [
      'JDex privado',
      { privateFolders: [['diario'], ['00-09 sistema', '00 sistema', '00.00 jdex']], privateTags: ['secreto'] }
    ],
    ['etiqueta anidada', { privateFolders: [['diario']], privateTags: ['secreto/hondo'] }]
  ];
}

const CATEGORIES = ['21', '22', '23', '24', '31', '99'];

/** La categoría (`"21"`) del prefijo JD de un nombre, como `categoryOfName` de `jd-port.ts`. */
function categoryOfName(name: string): string | null {
  const prefix = extractJdPrefix(name);
  if (!prefix) return null;
  const number = prefix.number;
  return number.kind === 'id' || number.kind === 'category' ? number.category : null;
}

/**
 * EL ORÁCULO: `JdLibraryPort.hasHidden` tal como era antes de A9a (5223421), con el filtro de la
 * biblioteca entera del turno y el recorrido de TODAS las notas vivas (`notesVisibilityIndex()`).
 * Los títulos, con `noteRead` (antes `noteTitles`, la misma columna).
 */
async function hasHiddenWholeLibrary(
  store: NoteWriteStore,
  config: PrivacyConfig,
  category: string,
  jdexFolderId: string | undefined
): Promise<boolean> {
  const list = store.foldersList();
  const filter = privacyInTurn(store, config);
  const hidden = (id: string): boolean => !filter.folderExists(id) || filter.isFolderHidden(id);
  const isJdexName = (name: string): boolean => {
    const prefix = extractJdPrefix(name);
    return prefix?.number.kind === 'id' && prefix.number.id === '00.00' && !prefix.number.extension;
  };
  if (jdexFolderId !== undefined) {
    if (hidden(jdexFolderId)) return true;
  } else if (list.folders.some((folder) => folder.id !== ROOT_FOLDER_ID && isJdexName(folder.name) && hidden(folder.id))) {
    return true;
  }
  const categoryTrees = new Set<string>();
  for (const folder of list.folders) {
    if (folder.id === ROOT_FOLDER_ID) continue;
    const own = categoryOfName(folder.name) === category;
    if (own && filter.isFolderHidden(folder.id)) return true;
    const prefix = extractJdPrefix(folder.name);
    if (own && prefix?.number.kind === 'category') {
      const tree = filter.folderSubtree(folder.id);
      if (tree.some((id) => filter.isFolderHidden(id))) return true;
      for (const id of tree) categoryTrees.add(id);
    }
  }
  const index = store.filesIndex();
  const files = FileFilter.fromSnapshot(filter, index, config);
  for (const file of index.files) {
    if (file.trashedAt !== null || !categoryTrees.has(file.folderId)) continue;
    if (!files.isVisible(file.id) && categoryOfName(file.name) === category) return true;
  }
  const candidates: string[] = [];
  for (const entry of store.notesVisibilityIndex()) {
    const inScope = categoryTrees.has(entry.folderId) || entry.folderId === jdexFolderId;
    if (inScope && filter.isHiddenNote(entry.id)) candidates.push(entry.id);
  }
  for (const id of candidates) {
    if (categoryOfName((await store.noteRead(id))?.title ?? '') === category) return true;
  }
  return false;
}

/** Cuenta las lecturas de la visibilidad de TODAS las notas vivas de un puerto: las del filtro de
 *  una llamada (`notesVisibilityIndex` del puerto) y las del escritor dentro de su turno. */
function spyWholeLibrary(port: NodeLibraryPort): { reader: number; writer: number; restore(): void } {
  const counts = { reader: 0, writer: 0, restore: () => {} };
  const target = port as unknown as {
    notesVisibilityIndex: NodeLibraryPort['notesVisibilityIndex'];
    writeExclusive: NodeLibraryPort['writeExclusive'];
  };
  const readerOriginal = target.notesVisibilityIndex;
  const writeOriginal = target.writeExclusive;
  target.notesVisibilityIndex = function (this: NodeLibraryPort) {
    counts.reader += 1;
    return readerOriginal.call(this);
  };
  target.writeExclusive = function <T>(this: NodeLibraryPort, operation: (store: NoteWriteStore) => Promise<T>) {
    return writeOriginal.call(this, (store) =>
      operation(
        new Proxy(store, {
          get(object, key, receiver) {
            const value = Reflect.get(object, key, receiver);
            if (key !== 'notesVisibilityIndex') return value;
            return () => {
              counts.writer += 1;
              return (value as () => unknown).call(object);
            };
          }
        })
      )
    ) as Promise<T>;
  };
  counts.restore = () => {
    target.notesVisibilityIndex = readerOriginal;
    target.writeExclusive = writeOriginal;
  };
  return counts;
}

describe('A9a: hasHidden sin recorrer la biblioteca, frente al recorrido entero', () => {
  let h: TwinHarness<Jd> | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('misma respuesta en cada configuración, categoría y JDex, sin leer la visibilidad de todas las notas', async () => {
    h = await twinHarness(jdScenario);
    const ids = h.extra;
    const spy = spyWholeLibrary(h.all.port);
    const answers = new Map<string, boolean>();
    try {
      for (const [label, config] of hasHiddenConfigs(ids)) {
        for (const category of CATEGORIES) {
          for (const jdexFolderId of [undefined, ids.jdex]) {
            const key = `${label} · ${category} · ${jdexFolderId === undefined ? 'sin JDex' : 'con JDex'}`;
            const { lazy, whole, wholeReads } = await h.all.port.writeExclusive(async (store) => {
              const before = spy.writer;
              const port = new JdLibraryPort(turnView(store, config), null, jdexFolderId === undefined ? {} : { jdexFolderId });
              const lazy = await port.hasHidden(category);
              expect(spy.writer, `${key}: hasHidden leyó la visibilidad de todas las notas`).toBe(before);
              const whole = await hasHiddenWholeLibrary(store, config, category, jdexFolderId);
              return { lazy, whole, wholeReads: spy.writer - before };
            });
            // Control del espía: el oráculo sí recorre la biblioteca entera.
            expect(wholeReads, `${key}: el espía no vio el recorrido del oráculo`).toBeGreaterThan(0);
            expect(lazy, key).toBe(whole);
            answers.set(key, lazy);
          }
        }
      }
    } finally {
      spy.restore();
    }
    // La matriz no es trivial: las notas deciden (mismo árbol, otra configuración de etiquetas).
    expect(answers.get('carpeta y etiqueta privadas · 21 · con JDex')).toBe(true); // «21.15 Privada» del JDex (c)
    expect(answers.get('carpeta y etiqueta privadas · 21 · sin JDex')).toBe(true); // «21.11 Secreta» del árbol (a)
    expect(answers.get('sin etiquetas privadas (las bloqueadas se ven) · 21 · con JDex')).toBe(false);
    expect(answers.get('carpeta y etiqueta privadas · 22 · con JDex')).toBe(true); // «22.11 Cerrada», bloqueada (A1)
    expect(answers.get('carpeta y etiqueta privadas · 22 · sin JDex')).toBe(false); // la de la papelera no cuenta
    expect(answers.get('carpeta y etiqueta privadas · 23 · con JDex')).toBe(false); // la lápida y la papelera, tampoco
    expect(answers.get('subcarpeta privada dentro de un ID · 21 · sin JDex')).toBe(true);
    expect(answers.get('categoría privada · 23 · sin JDex')).toBe(true);
    expect(answers.get('carpeta recordada (A3) · 23 · sin JDex')).toBe(true);
    expect(answers.get('JDex privado · 99 · sin JDex')).toBe(true);
    expect(answers.get('etiqueta anidada · 21 · sin JDex')).toBe(true); // «21.17 Honda»
    expect(answers.get('etiqueta anidada · 22 · con JDex')).toBe(true); // bloqueada con etiquetas privadas
    expect(answers.get('carpeta y etiqueta privadas · 24 · sin JDex')).toBe(true); // carpeta oculta (b)
    expect(answers.get('carpeta y etiqueta privadas · 31 · con JDex')).toBe(false);
  });
});

/** Las carpetas y los ficheros sueltos de una copia (`libraryState` mira las notas), sin fechas. */
function foldersAndFiles(sqlitePath: string): unknown {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    return {
      folders: db.prepare('SELECT id, parent_id, name, deleted FROM folders ORDER BY id').all(),
      files: db.prepare('SELECT id, folder_id, name, trashed_at IS NULL AS live FROM files ORDER BY id').all()
    };
  } finally {
    db.close();
  }
}

/** Ids de los motores de las dos copias en el mismo orden: cada llamada vuelve a empezar la serie
 *  (`crypto.randomUUID` del motor de Hebra, al crear notas y carpetas). */
function deterministicIds(): { reset(): void; restore(): void } {
  let next = 0;
  const spy = vi
    .spyOn(globalThis.crypto, 'randomUUID')
    .mockImplementation(() => `00000000-0000-4000-8000-${String((next += 1)).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`);
  return {
    reset: () => {
      next = 0;
    },
    restore: () => spy.mockRestore()
  };
}

/** `expectLazyWriteEquivalent` más las carpetas y los ficheros, con los ids de la serie. */
async function twinCall(
  h: TwinHarness<Jd>,
  ids: { reset(): void },
  name: string,
  args: Record<string, unknown> | ((side: TwinSide) => Record<string, unknown>)
): Promise<{ all: any; lazy: any }> {
  const argsFor = typeof args === 'function' ? args : () => args;
  const calls = await expectLazyWriteEquivalent(h, name, (side) => {
    ids.reset();
    return argsFor(side);
  });
  expect(foldersAndFiles(h.lazy.sqlitePath), `${name} deja carpetas o ficheros distintos`).toEqual(
    foldersAndFiles(h.all.sqlitePath)
  );
  return { all: calls.all.json, lazy: calls.lazy.json };
}

describe('A9a: las herramientas del JDex con privacyLoad lazy, en dos copias', () => {
  let h: TwinHarness<Jd> | undefined;
  let ids: ReturnType<typeof deterministicIds> | undefined;
  afterEach(async () => {
    ids?.restore();
    ids = undefined;
    await h?.close();
    h = undefined;
  });

  const TWIN_CONFIGS: Array<[string, PrivacyConfig]> = [
    ['carpeta y etiqueta privadas', { privateFolders: [['diario']], privateTags: ['secreto'] }],
    ['subcarpeta privada, sin etiquetas', { privateFolders: [['diario'], SUBFOLDER_PATH], privateTags: [] }]
  ];

  for (const [label, config] of TWIN_CONFIGS) {
    it(`hebra_jd_audit y hebra_jd_new_id: simular, aplicar y repetir (${label})`, async () => {
      h = await twinHarness(jdScenario, config);
      ids = deterministicIds();
      const audit = await twinCall(h, ids, 'hebra_jd_audit', {});
      expect(audit.lazy.resolved.jdex.id).toBe(h.extra.jdex);
      await twinCall(h, ids, 'hebra_jd_audit', { jdexFolderId: h.extra.jdex, limit: 2 });

      // 24 no tiene nota de categoría en el JDex: no existe para el motor, haya o no algo oculto.
      const hidden = label === 'carpeta y etiqueta privadas' ? ['21', '22'] : ['21'];
      for (const category of ['21', '22', '23', '24', '31']) {
        const simulated = await twinCall(h, ids, 'hebra_jd_new_id', { mode: 'simulate', category, title: `Nuevo ${category}` });
        if (category === '24') expect(simulated.lazy, category).toEqual({ error: 'category_not_found' });
        else if (hidden.includes(category)) expect(simulated.lazy, category).toEqual({ error: 'category_has_hidden' });
        else expect(simulated.lazy, category).toMatchObject({ mode: 'simulate' });
      }

      // Aplicar con la plantilla de 00.03 (su sello lo juzga el escritor con esa nota) y repetir.
      const plans: Record<TwinSide, string> = { all: '', lazy: '' };
      const simulated = await twinCall(h, ids, 'hebra_jd_new_id', { mode: 'simulate', category: '23', title: 'Tercero' });
      expect(simulated.lazy).toMatchObject({ mode: 'simulate', id: '23.12', template: { source: 'templates-folder' } });
      plans.all = simulated.all.planId;
      plans.lazy = simulated.lazy.planId;
      const applied = await twinCall(h, ids, 'hebra_jd_new_id', (side) => ({ mode: 'apply', planId: plans[side], operationId: 'a9a-nuevo' }));
      expect(applied.lazy).toMatchObject({ mode: 'apply', id: '23.12' });
      expect((applied.lazy.created as unknown[]).length).toBe(2);
      const replayed = await twinCall(h, ids, 'hebra_jd_new_id', (side) => ({ mode: 'apply', planId: plans[side], operationId: 'a9a-nuevo' }));
      expect(replayed.lazy).toMatchObject({ mode: 'apply', replayed: true });
    });
  }

  it('hebra_jd_move: una nota, un fichero enlazado y una carpeta; aplicar, repetir y deshacer', async () => {
    // Sin etiquetas privadas: con ellas, las bloqueadas ocultan todo fichero que se incrusta por
    // nombre (variante de A1), y el contrato no se podría mover.
    h = await twinHarness(jdScenario, MOVE_CONFIG);
    ids = deterministicIds();
    const x = h.extra;

    // Una oculta, como una que no existe.
    const hiddenSource = await twinCall(h, ids, 'hebra_jd_move', { mode: 'simulate', kind: 'note', id: x.subNote, toId: '23.11' });
    expect(hiddenSource.lazy).toEqual({ error: 'source_not_found' });

    const plans: Record<TwinSide, string> = { all: '', lazy: '' };
    const keep = (result: { all: any; lazy: any }) => {
      plans.all = result.all.planId;
      plans.lazy = result.lazy.planId;
    };

    // Una nota con `as`: simular, aplicar, repetir y deshacer.
    const note = await twinCall(h, ids, 'hebra_jd_move', { mode: 'simulate', kind: 'note', id: x.looseNote, toId: '23.11', as: 'Factura de la luz' });
    expect(note.lazy).toMatchObject({ mode: 'simulate', move: { kind: 'note', id: x.looseNote, to: { folderId: x.id2311 } } });
    keep(note);
    const noteApplied = await twinCall(h, ids, 'hebra_jd_move', (side) => ({ mode: 'apply', planId: plans[side], operationId: 'a9a-nota' }));
    expect(noteApplied.lazy).toMatchObject({ mode: 'apply', moved: [{ kind: 'note', id: x.looseNote, toName: 'Factura de la luz' }] });
    const noteReplayed = await twinCall(h, ids, 'hebra_jd_move', (side) => ({ mode: 'apply', planId: plans[side], operationId: 'a9a-nota' }));
    expect(noteReplayed.lazy).toMatchObject({ mode: 'apply', replayed: true });
    const noteUndone = await twinCall(h, ids, 'hebra_jd_move', (side) => ({ mode: 'undo', planId: plans[side], operationId: 'a9a-nota-deshacer' }));
    expect(noteUndone.lazy).toMatchObject({ mode: 'undo', restored: [{ kind: 'note', id: x.looseNote }] });

    // Un fichero que incrusta una nota visible, renombrado a un nombre que enlaza otra nota
    // visible, a una subcarpeta que se crea.
    const file = await twinCall(h, ids, 'hebra_jd_move', {
      mode: 'simulate',
      kind: 'file',
      id: x.contract,
      toId: '23.11',
      subfolder: 'Contratos',
      as: 'Anexo.pdf'
    });
    expect(file.lazy).toMatchObject({ mode: 'simulate', move: { kind: 'file', id: x.contract, to: { name: 'Anexo.pdf' } } });
    keep(file);
    const fileApplied = await twinCall(h, ids, 'hebra_jd_move', (side) => ({ mode: 'apply', planId: plans[side], operationId: 'a9a-fichero' }));
    expect(fileApplied.lazy).toMatchObject({ mode: 'apply', moved: [{ kind: 'file', id: x.contract, toName: 'Anexo.pdf' }] });
    const fileReplayed = await twinCall(h, ids, 'hebra_jd_move', (side) => ({ mode: 'apply', planId: plans[side], operationId: 'a9a-fichero' }));
    expect(fileReplayed.lazy).toMatchObject({ mode: 'apply', replayed: true, moved: [{ kind: 'file', id: x.contract }] });

    // Una carpeta entera.
    const folder = await twinCall(h, ids, 'hebra_jd_move', { mode: 'simulate', kind: 'folder', id: x.inboxProject, toId: '21.11' });
    expect(folder.lazy).toMatchObject({ mode: 'simulate', move: { kind: 'folder', id: x.inboxProject } });
    keep(folder);
    const folderApplied = await twinCall(h, ids, 'hebra_jd_move', (side) => ({ mode: 'apply', planId: plans[side], operationId: 'a9a-carpeta' }));
    expect(folderApplied.lazy).toMatchObject({ mode: 'apply', moved: [{ kind: 'folder', id: x.inboxProject }] });
  });

  it('lo que carga: con lazy nadie lee la visibilidad de todas las notas; con all, el filtro de la llamada sí', async () => {
    h = await twinHarness(jdScenario, MOVE_CONFIG);
    const calls: Array<[string, Record<string, unknown>]> = [
      ['hebra_jd_audit', {}],
      ['hebra_jd_new_id', { mode: 'simulate', category: '23', title: 'Carga' }],
      ['hebra_jd_new_id', { mode: 'simulate', category: '21', title: 'Carga' }],
      ['hebra_jd_move', { mode: 'simulate', kind: 'note', id: h.extra.docNote, toId: '23.11' }],
      ['hebra_jd_move', { mode: 'simulate', kind: 'file', id: h.extra.contract, toId: '23.11' }]
    ];
    for (const [name, args] of calls) {
      const spy = spyWholeLibrary(h.lazy.port);
      try {
        const lazy = await callToolWithLoad(h.lazy.serverContext, name, args);
        expect(lazy.isError, `${name} ${JSON.stringify(lazy.json)}`).toBe(name === 'hebra_jd_new_id' && args.category === '21');
        expect(spy, `${name} con lazy`).toMatchObject({ reader: 0, writer: 0 });
        const all = await callToolWithLoad(h.lazy.serverContext, name, args, 'all');
        expect(all.isError, `${name} con all`).toBe(lazy.isError);
        expect(spy.reader, `${name} con all: el espía no vio la carga entera`).toBeGreaterThan(0);
        expect(spy.writer, `${name} con all: el escritor tampoco recorre`).toBe(0);
      } finally {
        spy.restore();
      }
    }
    // Control del espía del escritor: `privacyInTurn` dentro del turno sí cuenta.
    const spy = spyWholeLibrary(h.lazy.port);
    try {
      await h.lazy.port.writeExclusive(async (store) => privacyInTurn(store, { privateFolders: [['diario']], privateTags: ['secreto'] }));
      expect(spy.writer).toBe(1);
    } finally {
      spy.restore();
    }
  });
});
