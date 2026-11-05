import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { LibraryInstance } from '../../src/sync/library-instance';

/**
 * D2 (SPEC.md §3, §5), ampliada el 28 sep 2026: el MCP edita notas y las organiza
 * (`noteMove`, favorita, archivar); ampliada otra vez el 30 sep 2026: manda notas a la
 * papelera y las saca (`noteTrash`/`noteRestore`) y lee y restaura versiones
 * (`noteVersionsList`, `noteVersionRead`, `noteVersionSnapshot`). Desde D9 (3 oct 2026)
 * crea y renombra carpetas y añade adjuntos: `folderCreate`, `folderRename` y `blobPut`
 * solo existen en el turno de escritura y solo los llama `NoteWriter` (penúltimo test).
 * Desde D10 (9 oct 2026) manda ficheros sueltos a la papelera y los saca: `fileTrash` y
 * `fileRestore`, con la misma regla, desde D15 (10 oct 2026) reemplaza el texto de uno:
 * `fileReplace`, igual, y desde D17 (12 oct 2026) los crea, renombra y mueve:
 * `fileCreate`, `fileRename` y `fileMove`, igual (último test).
 * Siguen fuera: purgar (`notePurge`), vaciar la papelera (`trashEmpty`), su recuento
 * (`trashCounts`, contaría las privadas), purgar versiones, todo lo demás de los recursos
 * sueltos (`file*`: purgar, `filePurge`), renombrar etiquetas, y
 * mover y borrar carpetas (`folderMove`, `folderTrash`).
 * Tres comprobaciones sobre lo que el servidor puede alcanzar de
 * `src/store`, `src/sync`, `src/lock`, `src/ipc`, `src/http` y `src/oauth`:
 * 1. Ningún módulo EXPORTA un nombre así.
 * 2. Ningún objeto que esos módulos entregan (el puerto, su vista de sync, la instancia y
 *    su `port`) TIENE un método así.
 * 3. Ninguna fuente LLAMA a uno (`.notePurge(`…) ni importa los módulos de Hebra que los
 *    implementan (`local-port`, `web-port`, `native-port`, `tag-rename`, `tags-reindex`).
 */

/**
 * `file[A-Z]…` sigue cerrado por defecto: cualquier método de recursos sueltos del motor,
 * de hoy o de mañana, está prohibido salvo los dos que D10 permite, `fileTrash` y
 * `fileRestore`, el que añade D15 (10 oct 2026), `fileReplace`, los tres que añade D17
 * (12 oct 2026), `fileCreate`, `fileRename` y `fileMove`, y el que añade D23 (5 nov 2026),
 * `fileRenameAndRelink`, nombrados uno a uno (`\b` para que `fileTrashEmpty`, `fileRestoreAll`,
 * `fileReplaceAll` o `fileMoveAll` NO pasen).
 * `filePurge` sigue prohibido. Que solo salgan del turno del escritor lo comprueban los
 * tres últimos tests.
 *
 * `noteClearConflict` salió de la lista con D23: su test, abajo, lo deja solo en el turno.
 */
const FILE_ALLOWED = 'Trash\\b|Restore\\b|Replace\\b|Create\\b|Rename\\b|RenameAndRelink\\b|Move\\b';
const FORBIDDEN_FILE = `file(?!${FILE_ALLOWED})[A-Z]\\w*`;
const FORBIDDEN = `notePurge|noteVersionsPurge\\w*|folderMove|folderTrash|${FORBIDDEN_FILE}|trashEmpty|trashCounts|tagRename`;
const FORBIDDEN_NAME = new RegExp(`^(${FORBIDDEN})$`);

/**
 * Las formas de alcanzar un método por su nombre en el texto de una fuente:
 * - la llamada `.nombre(` y la llamada opcional `.nombre?.(`;
 * - el acceso por corchetes con una cadena, se llame o no detrás: `['nombre']`,
 *   `["nombre"]` y con plantilla.
 * Antes solo se miraba `.nombre(`, y `engine['filePurge'](id)` pasaba. Sigue siendo
 * texto, no un análisis: un nombre montado a trozos o guardado en una variable no lo ve
 * este patrón. Para eso está la otra comprobación, sobre los métodos que los objetos
 * TIENEN.
 */
function reachPattern(names: string): RegExp {
  return new RegExp(
    `\\.\\s*(?:${names})\\s*(?:\\?\\.\\s*)?\\(|\\[\\s*['"\`](?:${names})['"\`]\\s*\\]`
  );
}

/** Cómo quedaría en una fuente cada forma de alcanzar `name` sobre `engine`. */
function reachForms(name: string): string[] {
  return [
    `engine.${name}(id)`,
    `engine?.${name}(id)`,
    `engine . ${name} (id)`,
    `engine.${name}?.(id)`,
    `engine['${name}'](id)`,
    `engine["${name}"](id)`,
    `engine[\`${name}\`](id)`,
    `engine?.['${name}']?.(id)`,
    `const call = engine[ '${name}' ];`
  ];
}

const FORBIDDEN_CALL = reachPattern(FORBIDDEN);
const FORBIDDEN_IMPORT =
  /from\s+['"]\$lib\/library\/(local-port|web-port|native-port|tag-rename|tags-reindex)['"]/;

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// `src/ipc`: el socket del escritor ejecuta lo que le pide otro proceso (SPEC.md §8).
// `src/http` y `src/oauth`: `serve-http` ejecuta lo que le pide claude.ai por la red
// (SPEC.md §12).
const SURFACE_DIRS = ['src/store', 'src/sync', 'src/lock', 'src/ipc', 'src/http', 'src/oauth'];

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const dir of SURFACE_DIRS) {
    for (const entry of readdirSync(join(root, dir))) {
      if (entry.endsWith('.ts')) out.push(join(root, dir, entry));
    }
  }
  return out;
}

/** Métodos propios y heredados (hasta `Object.prototype`) de un objeto. */
function methodNames(value: object): string[] {
  const names = new Set<string>();
  for (let proto: object | null = value; proto && proto !== Object.prototype; ) {
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
    proto = Object.getPrototypeOf(proto);
  }
  return [...names];
}

describe('superficie de src/store, src/sync y src/lock (D2)', () => {
  it('la lista prohíbe purgar y vaciar la papelera y deja mandar, sacar y las versiones', () => {
    for (const name of [
      'notePurge',
      'trashEmpty',
      'trashCounts',
      'noteVersionsPurgeExpired',
      'folderTrash',
      'folderMove',
      'filePurge',
      // Cerrado por defecto: ni un `file*` que no exista hoy, ni uno que solo EMPIECE
      // como los permitidos.
      'fileDirty',
      'fileAlgoNuevo',
      'fileTrashEmpty',
      'fileTrashed',
      'fileRestoreAll',
      'fileReplaceAll',
      'fileReplaced',
      'fileCreateMany',
      'fileRenameAll',
      'fileRenameAndRelinkAll',
      'fileMoveAll'
    ]) {
      expect(FORBIDDEN_NAME.test(name), name).toBe(true);
      for (const form of reachForms(name)) expect(FORBIDDEN_CALL.test(form), form).toBe(true);
    }
    for (const name of [
      'noteTrash',
      'noteRestore',
      'noteVersionsList',
      'noteVersionRead',
      'noteVersionSnapshot',
      // D10, D15, D17 y D23: los siete únicos `file*` que pasan.
      'fileTrash',
      'fileRestore',
      'fileReplace',
      'fileCreate',
      'fileRename',
      'fileRenameAndRelink',
      'fileMove'
    ]) {
      expect(FORBIDDEN_NAME.test(name), name).toBe(false);
      for (const form of reachForms(name)) expect(FORBIDDEN_CALL.test(form), form).toBe(false);
    }
    // Lo que no es alcanzar un método no cuenta: una clave de objeto, un texto, un tipo.
    for (const text of [
      'filePurge: (id) => undefined,',
      'ni `filePurge`, ni vaciar la papelera',
      "throw new LibraryError('file_not_found')",
      'const filePurge = 1;'
    ]) {
      expect(FORBIDDEN_CALL.test(text), text).toBe(false);
    }
  });

  it('ningún módulo exporta una mutación prohibida', async () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      if (file.endsWith('.d.ts')) continue;
      const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
      const bad = Object.keys(mod).filter((name) => FORBIDDEN_NAME.test(name));
      expect(bad, relative(root, file)).toEqual([]);
    }
  });

  it('ni el puerto, ni su vista de sync, ni la instancia tienen métodos prohibidos', async () => {
    const port = await openNodeLibraryPort({ sqlitePath: ':memory:' });
    const dataDir = mkdtempSync(join(tmpdir(), 'hebra-mcp-surface-'));
    const instance = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false }
    });
    try {
      const objects: Array<[string, object]> = [
        ['NodeLibraryPort', port],
        ['SyncStorePort', port.syncStorePort()],
        ['LibraryInstance', instance],
        ['LibraryInstance.port', instance.port]
      ];
      for (const [label, value] of objects) {
        expect(methodNames(value).filter((name) => FORBIDDEN_NAME.test(name)), label).toEqual(
          []
        );
      }
    } finally {
      port.close();
      await instance.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('ninguna fuente llama ni importa las mutaciones prohibidas', () => {
    // En TODO `src` (también `src/server` y `src/privacy`), no solo en `SURFACE_DIRS`: desde D19
    // `folderMove` a secas es la vía que sigue cerrada, y mover a un ID tiene su propio test.
    const files = allSourceFiles();
    expect(files.length).toBeGreaterThan(60);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(FORBIDDEN_CALL.exec(text)?.[0] ?? null, relative(root, file)).toBeNull();
      expect(FORBIDDEN_IMPORT.exec(text)?.[0] ?? null, relative(root, file)).toBeNull();
    }
  });

  /**
   * Carpetas y adjuntos (D9, 3 oct 2026): `folderCreate`, `folderRename` y `blobPut` solo
   * los tiene el turno de escritura del almacén (`NodeLibraryPort.writeExclusive`) y solo
   * los llama `NoteWriter` (`src/store/writes.ts`), que antes aplica el filtro de privados
   * dentro del turno. `blobPut` lo tiene además la vista de sync (`src/store/sync-port.ts`),
   * que el motor usa para guardar lo que baja del relé. Ni el puerto de las herramientas,
   * ni la instancia, ni su `port` tienen ninguno, y ninguna otra fuente (servidor incluido)
   * los llama. Del turno no sale nada más de blobs, recursos sueltos ni carpetas.
   */
  it('carpetas y adjuntos (D9): folderCreate, folderRename y blobPut solo en el turno del escritor', async () => {
    const calls: Array<[RegExp, string[]]> = [
      [
        /\.\s*(folderCreate|folderRename)\s*\(/,
        // D18: la carpeta de un ID nuevo del JDex, con el plan de `folders.ts` rehecho en el
        // turno (`jd-port.ts`, sobre el almacén del turno que le da `jd-new-id.ts`).
        ['src/store/node-port.ts', 'src/store/writes.ts', 'src/store/jd-port.ts', 'src/store/jd-new-id.ts']
      ],
      [
        /\.\s*(blobPut|blobPutFromPath)\s*\(/,
        // D15: `file-writes.ts` guarda en el mismo turno el texto nuevo de un fichero suelto
        // antes de `fileReplace`, con el filtro de los ficheros ya aplicado; D17:
        // `file-verbs.ts`, el texto de un fichero que crea, antes de `fileCreate`.
        [
          'src/store/node-port.ts',
          'src/store/writes.ts',
          'src/store/sync-port.ts',
          'src/store/file-writes.ts',
          'src/store/file-verbs.ts'
        ]
      ]
    ];
    for (const file of [...sourceFiles(), ...serverFiles()]) {
      const path = relative(root, file).split(sep).join('/');
      const text = readFileSync(file, 'utf8');
      for (const [pattern, allowed] of calls) {
        if (allowed.includes(path)) continue;
        expect(pattern.exec(text)?.[0] ?? null, path).toBeNull();
      }
    }
    const port = await openNodeLibraryPort({ sqlitePath: ':memory:' });
    const dataDir = mkdtempSync(join(tmpdir(), 'hebra-mcp-surface-d9-'));
    const instance = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false }
    });
    try {
      for (const [label, value] of [
        ['NodeLibraryPort', port],
        ['LibraryInstance', instance],
        ['LibraryInstance.port', instance.port]
      ] as Array<[string, object]>) {
        const names = methodNames(value);
        for (const name of ['folderCreate', 'folderRename', 'blobPut']) {
          expect(names, `${label}.${name}`).not.toContain(name);
        }
      }
      expect(methodNames(port.syncStorePort())).not.toContain('folderCreate');
      expect(methodNames(port.syncStorePort())).not.toContain('folderRename');
      const storeKeys = await port.writeExclusive(async (store) => Object.keys(store));
      // De ficheros sueltos (D10, D15 y D17), lo de los tests de abajo: `fileCreate`,
      // `fileMove`, `fileRename`, `fileReplace`, `fileRestore`, `fileTrash` y la lectura
      // `filesIndex`; y `blobRead`, que el reemplazo y el duplicado usan para leer el
      // contenido actual y la prueba de lo guardado (solo lee).
      expect(storeKeys.filter((key) => /^(blob|file|folder[A-Z])/.test(key)).sort()).toEqual([
        'blobPut',
        'blobRead',
        'fileCreate',
        'fileMove',
        'fileRename',
        // D23: renombrar con las notas que lo incrustan (test de abajo).
        'fileRenameAndRelink',
        'fileReplace',
        'fileRestore',
        'fileTrash',
        'filesIndex',
        'folderCreate',
        // D19: mover a un ID, con guarda (test de abajo). D23 no añade ningún `folder*`.
        'folderMoveIfUnchanged',
        'folderRename',
        'folderRenameIfUnchanged'
      ]);
    } finally {
      port.close();
      await instance.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  /**
   * Ficheros sueltos (D10, 9 oct 2026): `fileTrash` y `fileRestore` solo los tiene el
   * turno de escritura del almacén (`NodeLibraryPort.writeExclusive`) y solo los llama
   * `NoteWriter` (`src/store/writes.ts`), que antes aplica el filtro de los ficheros
   * dentro del turno. Ni el puerto de las herramientas, ni su vista de sync, ni la
   * instancia, ni su `port` tienen ninguno, y ninguna otra fuente los llama. En TODO
   * `src` (también `src/server` y `src/privacy`, que las comprobaciones de arriba no
   * recorren) no hay ninguna llamada a otro `file*` del motor: ni purgar (reemplazar, D15,
   * y crear, renombrar y mover, D17, tienen sus propios tests, abajo). Tampoco a sus listas de ficheros (`filesPage`,
   * `filesFindByName`…), cuyo aviso de que quedan más delataría los ocultos: la lista
   * sale de `filesIndex`, propia. Del turno no sale nada más de ficheros.
   */
  it('ficheros sueltos (D10): fileTrash y fileRestore solo en el turno del escritor, y ningún otro file* en src', async () => {
    const allowed = ['src/store/node-port.ts', 'src/store/writes.ts'];
    // Con todas las formas de alcanzarlos (`reachPattern`), no solo `.nombre(`.
    const otherFile = reachPattern(FORBIDDEN_FILE);
    const engineLists = reachPattern(
      'files(?:Page|List|TrashPage|FindByName|FindBySuffix)|trashEmpty|trashCounts'
    );
    const allowedFile = reachPattern('fileTrash|fileRestore');
    for (const form of [...reachForms('fileTrash'), ...reachForms('fileRestore')]) {
      expect(allowedFile.test(form), form).toBe(true);
      expect(otherFile.test(form), form).toBe(false);
    }
    for (const form of reachForms('filesPage')) expect(engineLists.test(form), form).toBe(true);
    const files = allSourceFiles();
    expect(files.length).toBeGreaterThan(60);
    let callers = 0;
    for (const file of files) {
      const path = relative(root, file).split(sep).join('/');
      const text = readFileSync(file, 'utf8');
      expect(otherFile.exec(text)?.[0] ?? null, path).toBeNull();
      expect(engineLists.exec(text)?.[0] ?? null, path).toBeNull();
      const calls = allowedFile.test(text);
      if (calls) callers += 1;
      if (!allowed.includes(path)) expect(calls, path).toBe(false);
    }
    // Las dos fuentes permitidas los llaman de verdad (si no, este test no mediría nada).
    expect(callers).toBe(allowed.length);

    const port = await openNodeLibraryPort({ sqlitePath: ':memory:' });
    const dataDir = mkdtempSync(join(tmpdir(), 'hebra-mcp-surface-d10-'));
    const instance = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false }
    });
    try {
      for (const [label, value] of [
        ['NodeLibraryPort', port],
        ['SyncStorePort', port.syncStorePort()],
        ['LibraryInstance', instance],
        ['LibraryInstance.port', instance.port]
      ] as Array<[string, object]>) {
        // Ni los dos permitidos ni ningún otro: fuera del turno, ningún método `file*`.
        expect(methodNames(value).filter((name) => /^file[A-Z]/.test(name)), label).toEqual([]);
      }
      const storeKeys = await port.writeExclusive(async (store) => Object.keys(store));
      expect(storeKeys.filter((key) => /^file/.test(key)).sort()).toEqual([
        'fileCreate',
        'fileMove',
        'fileRename',
        'fileRenameAndRelink',
        'fileReplace',
        'fileRestore',
        'fileTrash',
        'filesIndex'
      ]);
    } finally {
      port.close();
      await instance.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  /**
   * Reemplazar el contenido de un fichero suelto (D15, 10 oct 2026): `fileReplace` solo lo
   * tiene el turno de escritura (arriba) y solo lo llaman el puerto, que lo pone en el
   * turno, y `src/store/file-writes.ts`, que antes aplica el filtro de los ficheros, la
   * base y el tipo dentro del turno. Ninguna otra fuente de `src` (herramientas incluidas).
   */
  it('reemplazar un fichero suelto (D15): fileReplace solo en el turno del escritor y en file-writes.ts', () => {
    const allowed = ['src/store/node-port.ts', 'src/store/file-writes.ts'];
    const replaceCall = reachPattern('fileReplace');
    for (const form of reachForms('fileReplace')) expect(replaceCall.test(form), form).toBe(true);
    let callers = 0;
    for (const file of allSourceFiles()) {
      const path = relative(root, file).split(sep).join('/');
      const calls = replaceCall.test(readFileSync(file, 'utf8'));
      if (calls) callers += 1;
      if (!allowed.includes(path)) expect(calls, path).toBe(false);
    }
    expect(callers).toBe(allowed.length);
  });

  /**
   * Crear, renombrar y mover un fichero suelto (D17, 12 oct 2026): `fileCreate`,
   * `fileRename` y `fileMove` solo los tiene el turno de escritura (arriba) y solo los
   * llaman el puerto, que los pone en el turno, y `src/store/file-verbs.ts`, que antes
   * aplica el filtro de los ficheros, el choque de nombres y que el resultado no quede
   * oculto, dentro del turno. Ninguna otra fuente de `src` (herramientas incluidas).
   */
  it('crear, renombrar y mover un fichero suelto (D17): solo en el turno del escritor y en file-verbs.ts', () => {
    // D19: mover a un ID renombra y mueve ficheros sueltos con el filtro del turno. Renombrar con
    // los enlaces (D23), con su propio test.
    const allowed = ['src/store/node-port.ts', 'src/store/file-verbs.ts', 'src/store/jd-move-port.ts'];
    const verbCall = reachPattern('fileCreate|fileRename|fileMove');
    for (const name of ['fileCreate', 'fileRename', 'fileMove']) {
      for (const form of reachForms(name)) expect(verbCall.test(form), form).toBe(true);
    }
    let callers = 0;
    for (const file of allSourceFiles()) {
      const path = relative(root, file).split(sep).join('/');
      const calls = verbCall.test(readFileSync(file, 'utf8'));
      if (calls) callers += 1;
      if (!allowed.includes(path)) expect(calls, path).toBe(false);
    }
    expect(callers).toBe(allowed.length);
  });

  /**
   * Mover a un ID del JDex (D19, decisión de David del 19 oct 2026): la ÚNICA vía del MCP para
   * mover carpetas. `noteMoveIfUnchanged`, `folderMoveIfUnchanged` y `folderRenameIfUnchanged`
   * (las versiones con guarda del motor) solo los tiene el turno de escritura y solo los llaman
   * el puerto, que los pone en el turno, y `src/store/jd-move-port.ts`, que antes aplica el
   * filtro y la regla de las rutas privadas configuradas de D9. `folderMove` a secas sigue
   * prohibido en todo `src` (lista de arriba), y fuera del turno nadie los tiene.
   */
  it('mover a un ID (D19): las mutaciones con guarda solo en el turno del escritor y en jd-move-port.ts', async () => {
    // D23: `hebra_move_note` con `expectedRevision` usa la de notas (`note-state.ts`), nunca la de
    // carpetas: mover carpetas sigue sin otra vía.
    const allowed = ['src/store/node-port.ts', 'src/store/jd-move-port.ts', 'src/store/note-state.ts'];
    expect(
      reachPattern('folderMoveIfUnchanged|folderRenameIfUnchanged').test(
        readFileSync(join(root, 'src/store/note-state.ts'), 'utf8')
      )
    ).toBe(false);
    const guarded = reachPattern('noteMoveIfUnchanged|folderMoveIfUnchanged|folderRenameIfUnchanged');
    for (const name of ['noteMoveIfUnchanged', 'folderMoveIfUnchanged', 'folderRenameIfUnchanged']) {
      for (const form of reachForms(name)) expect(guarded.test(form), form).toBe(true);
    }
    let callers = 0;
    for (const file of allSourceFiles()) {
      const path = relative(root, file).split(sep).join('/');
      const calls = guarded.test(readFileSync(file, 'utf8'));
      if (calls) callers += 1;
      if (!allowed.includes(path)) expect(calls, path).toBe(false);
    }
    expect(callers).toBe(allowed.length);
    const port = await openNodeLibraryPort({ sqlitePath: ':memory:' });
    try {
      for (const [label, value] of [
        ['NodeLibraryPort', port],
        ['SyncStorePort', port.syncStorePort()]
      ] as Array<[string, object]>) {
        const names = methodNames(value);
        for (const name of ['noteMoveIfUnchanged', 'folderMoveIfUnchanged', 'folderRenameIfUnchanged']) {
          expect(names, `${label}.${name}`).not.toContain(name);
        }
      }
    } finally {
      port.close();
    }
  });

  /**
   * Las escrituras de D23 (5 nov 2026), función por función: solo las tiene el turno de
   * escritura, las pone ahí `src/store/note-state-engine.ts` y las llama quien aplica antes el
   * filtro en el turno. `noteMoveIfUnchanged` ya estaba (D19), y desde D23 también la llama
   * `note-state.ts`. Y todas pasan por la guarda de cada mutación de un espacio
   * (`assertSpaceUserWrite`, la lista `mutations` de `node-port.ts`): una que faltara escribiría
   * en un espacio tras revocarlo.
   */
  it('las escrituras de D23: solo en el turno del escritor y desde quien aplica el filtro', async () => {
    const reach: Array<[string, string[]]> = [
      ['noteHide', ['src/store/note-state-engine.ts', 'src/store/note-state.ts']],
      ['noteUnhide', ['src/store/note-state-engine.ts', 'src/store/note-state.ts']],
      ['noteClearConflict', ['src/store/note-state-engine.ts', 'src/store/note-state.ts']],
      ['noteTrashIfUnchanged', ['src/store/note-state-engine.ts', 'src/store/note-state.ts']],
      ['noteRestoreRowIfUnchanged', ['src/store/note-state-engine.ts', 'src/store/note-state.ts']],
      ['fileRenameAndRelink', ['src/store/note-state-engine.ts', 'src/store/file-verbs.ts']],
      ['noteMoveIfUnchanged', ['src/store/node-port.ts', 'src/store/jd-move-port.ts', 'src/store/note-state.ts']]
    ];
    const sources = allSourceFiles().map((file) => [
      relative(root, file).split(sep).join('/'),
      readFileSync(file, 'utf8')
    ] as const);
    for (const [name, allowed] of reach) {
      const pattern = reachPattern(name);
      for (const form of reachForms(name)) expect(pattern.test(form), form).toBe(true);
      const callers = sources.filter(([, text]) => pattern.test(text)).map(([path]) => path).sort();
      expect(callers, name).toEqual([...allowed].sort());
    }
    // Ni `noteRestoreIfUnchanged` (otra forma de la misma guarda), ni otra vía sin filtro de
    // reescribir notas en lote o de deshacer metadatos.
    const closed = reachPattern('noteRestoreIfUnchanged|notesRewriteBatch|noteUndoMetadata');
    for (const [path, text] of sources) expect(closed.exec(text)?.[0] ?? null, path).toBeNull();

    const nodePort = readFileSync(join(root, 'src/store/node-port.ts'), 'utf8');
    const mutations = /const mutations = new Set\(\[([\s\S]*?)\]\)/.exec(nodePort)?.[1] ?? '';
    for (const [name] of reach) expect(mutations, name).toContain(`'${name}'`);

    const port = await openNodeLibraryPort({ sqlitePath: ':memory:' });
    try {
      for (const [label, value] of [
        ['NodeLibraryPort', port],
        ['SyncStorePort', port.syncStorePort()]
      ] as Array<[string, object]>) {
        const names = methodNames(value);
        for (const [name] of reach) expect(names, `${label}.${name}`).not.toContain(name);
      }
      const storeKeys = await port.writeExclusive(async (store) => Object.keys(store));
      for (const [name] of reach) expect(storeKeys, name).toContain(name);
      // Y lo que sigue fuera, también del turno.
      for (const name of ['notePurge', 'trashEmpty', 'filePurge', 'tagRename', 'folderMove', 'folderTrash']) {
        expect(storeKeys, name).not.toContain(name);
      }
    } finally {
      port.close();
    }
  });
});

/**
 * Lecturas de estado (D23, 5 nov 2026): `noteSummary`, `foldersTrashList` y `noteAuthors` del
 * motor son LECTURAS y solo las alcanza `src/store/state-reads.ts`, que el puerto
 * (`node-port.ts`) llama por métodos propios (`noteStates`, `foldersTrash`, `noteAuthors`).
 * Ninguna herramienta ni otro módulo las toca; y siguen cerradas las que purgan una carpeta
 * de la papelera o la restauran (`folderPurge`, `folderRestore`, `folderUndoTrash`).
 */
describe('lecturas de estado (D23)', () => {
  it('el motor se alcanza solo desde state-reads.ts', () => {
    const reach = reachPattern('noteSummary|foldersTrashList|noteAuthors(?:Many)?');
    for (const form of reachForms('foldersTrashList')) expect(reach.test(form), form).toBe(true);
    const callers: string[] = [];
    for (const file of allSourceFiles()) {
      if (reach.test(readFileSync(file, 'utf8'))) callers.push(relative(root, file).split(sep).join('/'));
    }
    // `node-port.ts` y `library-instance.ts` llaman a `port.noteAuthors(id)` (el método del
    // puerto, no el del motor); `noteAuthors(` en las herramientas es también el del puerto.
    const engineCallers = callers.filter(
      (path) => !['src/store/node-port.ts', 'src/sync/library-instance.ts', 'src/server/tools/note-authors.ts'].includes(path)
    );
    expect(engineCallers).toEqual(['src/store/state-reads.ts']);
  });

  it('purgar o restaurar una carpeta de la papelera sigue fuera', () => {
    const reach = reachPattern('folderPurge|folderRestore|folderUndoTrash|folderTrashEmpty');
    for (const file of allSourceFiles()) {
      const path = relative(root, file).split(sep).join('/');
      expect(reach.exec(readFileSync(file, 'utf8'))?.[0] ?? null, path).toBeNull();
    }
  });
});

/**
 * Las propiedades del frontmatter (D23, 5 nov 2026) solo LEEN: `src/store/props-sql.ts` es SQL
 * propio de `SELECT` y lo que toma del motor es `propsFilterSql`, que solo arma un `WHERE`. Ni
 * renombrar una propiedad ni reescribir notas en lote están alcanzables desde el puerto.
 */
describe('propiedades del frontmatter (D23)', () => {
  it('props-sql.ts no escribe', () => {
    const text = readFileSync(join(root, 'src/store/props-sql.ts'), 'utf8');
    const statements = [...text.matchAll(/(?:prepare\(\s*)[`'](\s*\w+)/g)].map((match) => match[1]!.trim());
    expect(statements.length).toBeGreaterThanOrEqual(3);
    expect(new Set(statements)).toEqual(new Set(['SELECT']));
  });

  it('el puerto no alcanza ninguna mutación de propiedades', async () => {
    const port = await openNodeLibraryPort({ sqlitePath: ':memory:' });
    try {
      expect(methodNames(port).filter((name) => /^(propRename|prop_rename|notesRewriteBatch)$/.test(name))).toEqual([]);
    } finally {
      port.close();
    }
  });
});

/** Todas las fuentes de `src`, recorriendo sus carpetas. */
function allSourceFiles(dir = join(root, 'src')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSourceFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Todo `src/server` (herramientas incluidas), que no está en `SURFACE_DIRS`. */
function serverFiles(): string[] {
  const out: string[] = [];
  for (const dir of ['src/server', 'src/server/tools']) {
    for (const entry of readdirSync(join(root, dir))) {
      if (entry.endsWith('.ts')) out.push(join(root, dir, entry));
    }
  }
  return out;
}
