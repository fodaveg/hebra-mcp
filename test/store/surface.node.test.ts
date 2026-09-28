import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { LibraryInstance } from '../../src/sync/library-instance';

/**
 * D2 (SPEC.md §3, §5), ampliada el 28 sep 2026: el MCP edita notas y las organiza
 * (`noteMove`, favorita, archivar), pero papelera, purga, versiones, adjuntos, renombrar
 * etiquetas y gestionar carpetas (`folder*`: opción A de David, 28 sep 2026, sus errores
 * revelaban carpetas privadas) siguen fuera. Tres comprobaciones sobre lo que el servidor
 * puede alcanzar de
 * `src/store`, `src/sync`, `src/lock`, `src/ipc`, `src/http` y `src/oauth`:
 * 1. Ningún módulo EXPORTA un nombre así.
 * 2. Ningún objeto que esos módulos entregan (el puerto, su vista de sync, la instancia y
 *    su `port`) TIENE un método así.
 * 3. Ninguna fuente LLAMA a uno (`.noteTrash(`…) ni importa los módulos de Hebra que los
 *    implementan (`local-port`, `web-port`, `native-port`, `tag-rename`, `tags-reindex`).
 */

const FORBIDDEN =
  'noteTrash|noteRestore|notePurge|noteClearConflict|noteVersion\\w*|folderCreate|folderRename|folderMove|folderTrash|file[A-Z]\\w*|trashEmpty|tagRename';
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
});
