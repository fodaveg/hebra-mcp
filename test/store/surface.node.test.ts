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
 * `fileRestore`, con la misma regla (último test).
 * Siguen fuera: purgar (`notePurge`), vaciar la papelera (`trashEmpty`), su recuento
 * (`trashCounts`, contaría las privadas), purgar versiones, todo lo demás de los recursos
 * sueltos (`file*`: purgar, crear, renombrar, mover, reemplazar), renombrar etiquetas, y
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
 * `fileRestore`, nombrados uno a uno (`\b` para que `fileTrashEmpty` o `fileRestoreAll`
 * NO pasen). Que esos dos solo salgan del turno del escritor lo comprueba el último test.
 */
const FILE_ALLOWED = 'Trash\\b|Restore\\b';
const FORBIDDEN_FILE = `file(?!${FILE_ALLOWED})[A-Z]\\w*`;
const FORBIDDEN = `notePurge|noteClearConflict|noteVersionsPurge\\w*|folderMove|folderTrash|${FORBIDDEN_FILE}|trashEmpty|trashCounts|tagRename`;
const FORBIDDEN_NAME = new RegExp(`^(${FORBIDDEN})$`);
const FORBIDDEN_CALL = new RegExp(`\\.\\s*(${FORBIDDEN})\\s*\\(`);
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
      'fileCreate',
      'fileRename',
      'fileMove',
      'fileReplace',
      // Cerrado por defecto: ni un `file*` que no exista hoy, ni uno que solo EMPIECE
      // como los dos permitidos.
      'fileDirty',
      'fileAlgoNuevo',
      'fileTrashEmpty',
      'fileTrashed',
      'fileRestoreAll'
    ]) {
      expect(FORBIDDEN_NAME.test(name), name).toBe(true);
      expect(FORBIDDEN_CALL.test(`engine.${name}(id)`), name).toBe(true);
    }
    for (const name of [
      'noteTrash',
      'noteRestore',
      'noteVersionsList',
      'noteVersionRead',
      'noteVersionSnapshot',
      // D10: los dos únicos `file*` que pasan.
      'fileTrash',
      'fileRestore'
    ]) {
      expect(FORBIDDEN_NAME.test(name), name).toBe(false);
      expect(FORBIDDEN_CALL.test(`engine.${name}(id)`), name).toBe(false);
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
    for (const file of sourceFiles()) {
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
      [/\.\s*(folderCreate|folderRename)\s*\(/, ['src/store/node-port.ts', 'src/store/writes.ts']],
      [
        /\.\s*(blobPut|blobPutFromPath)\s*\(/,
        ['src/store/node-port.ts', 'src/store/writes.ts', 'src/store/sync-port.ts']
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
      // De ficheros sueltos (D10), lo del test de abajo: `fileRestore`, `fileTrash` y la
      // lectura `filesIndex`.
      expect(storeKeys.filter((key) => /^(blob|file|folder[A-Z])/.test(key)).sort()).toEqual([
        'blobPut',
        'fileRestore',
        'fileTrash',
        'filesIndex',
        'folderCreate',
        'folderRename'
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
   * recorren) no hay ninguna llamada a otro `file*` del motor: ni purgar, ni crear,
   * renombrar, mover o reemplazar. Tampoco a sus listas de ficheros (`filesPage`,
   * `filesFindByName`…), cuyo aviso de que quedan más delataría los ocultos: la lista
   * sale de `filesIndex`, propia. Del turno no sale nada más de ficheros.
   */
  it('ficheros sueltos (D10): fileTrash y fileRestore solo en el turno del escritor, y ningún otro file* en src', async () => {
    const allowed = ['src/store/node-port.ts', 'src/store/writes.ts'];
    const files = allSourceFiles();
    expect(files.length).toBeGreaterThan(60);
    let callers = 0;
    for (const file of files) {
      const path = relative(root, file).split(sep).join('/');
      const text = readFileSync(file, 'utf8');
      expect(new RegExp(`\\.\\s*(${FORBIDDEN_FILE})\\s*\\(`).exec(text)?.[0] ?? null, path).toBeNull();
      expect(
        /\.\s*(files(?:Page|List|TrashPage|FindByName|FindBySuffix)|trashEmpty|trashCounts)\s*\(/.exec(text)?.[0] ??
          null,
        path
      ).toBeNull();
      const calls = /\.\s*(fileTrash|fileRestore)\s*\(/.test(text);
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
