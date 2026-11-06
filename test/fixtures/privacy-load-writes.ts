/**
 * Equivalencia de una herramienta perezosa (`privacyLoad: 'lazy'`) que ESCRIBE, o que puede
 * escribir, con la misma herramienta cargando la biblioteca entera (`'all'`). Pieza A5b del
 * plan de memoria (6 nov 2026).
 *
 * `expectLazyEquivalent` (`./privacy-load.ts`) corre la herramienta dos veces sobre el MISMO
 * almacén: la primera escritura cambia lo que ve la segunda (un `replayed: true`, una nota que
 * ya no está en la papelera…), así que no sirve para escrituras. Aquí hay DOS copias idénticas
 * de la biblioteca (`twinHarness`: la de prueba más el escenario, construida una vez y copiada
 * byte a byte antes de abrir ningún puerto, así que los ids, la biblioteca y las revisiones son
 * los mismos) y cada llamada va a las dos: con `forcePrivacyLoad: 'all'` a la copia `all` y con
 * la carga declarada a la copia `lazy`. `expectLazyWriteEquivalent` exige:
 * 1. que la herramienta esté registrada como `'lazy'`;
 * 2. que la llamada perezosa no suba `unloadedLookupsTotal()`;
 * 3. la MISMA respuesta (con `planId` y `expiresAt`, que no se pueden repetir entre copias,
 *    cambiados por un marcador);
 * 4. y el MISMO estado final de las notas y de sus versiones (`libraryState`, sin las fechas,
 *    que dependen del reloj, salvo si están o no).
 *
 * Nunca toca la biblioteca real: todo vive en dos directorios temporales que `close` borra.
 */
import { cpSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PrivacyConfig } from '../../src/privacy';
import type { ServerContext } from '../../src/server/context';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store';
import { AUDIT_CONFIG, withEngine, type Scenario } from '../privacy/audit-harness';
import { callToolWithLoad, type LoadedToolCall } from './privacy-load';
import { testWriteContext } from './test-context';
import { buildTestLibrary, type TestLibrary } from './test-library';

/** Las dos copias de la biblioteca. */
export type TwinSide = 'all' | 'lazy';

/** Una copia abierta como en producción (`openNodeLibraryPort`), con escritor sin sync. */
export interface Twin {
  dataDir: string;
  sqlitePath: string;
  port: NodeLibraryPort;
  serverContext: ServerContext;
}

export interface TwinHarness<T> {
  /** Los ids de la biblioteca de prueba, iguales en las dos copias. */
  library: TestLibrary;
  /** Lo que devolvió el escenario, igual en las dos copias. */
  extra: T;
  all: Twin;
  lazy: Twin;
  close(): Promise<void>;
}

/**
 * La biblioteca de prueba más `scenario` (con el motor de Hebra, como el arnés del audit),
 * construida UNA vez y copiada antes de abrir ningún puerto: dos copias idénticas con
 * `config` como configuración de privados.
 */
export async function twinHarness<T>(
  scenario: Scenario<T>,
  config: PrivacyConfig = AUDIT_CONFIG
): Promise<TwinHarness<T>> {
  const allDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-twin-all-'));
  const lazyDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-twin-lazy-'));
  const allSqlite = join(allDir, 'library.sqlite');
  const library = await buildTestLibrary(allSqlite);
  const extra = await withEngine(allSqlite, (engine, db) => scenario(engine, library, db));
  // Con el motor ya cerrado: la copia lleva el mismo fichero (y los blobs) byte a byte.
  cpSync(allDir, lazyDir, { recursive: true });

  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const open = async (dataDir: string): Promise<Twin> => {
    const sqlitePath = join(dataDir, 'library.sqlite');
    const port = await openNodeLibraryPort({ sqlitePath, dataDir });
    return {
      dataDir,
      sqlitePath,
      port,
      serverContext: {
        port,
        privacyConfig: config,
        status: new UnlinkedStatusSource(),
        write: testWriteContext(port)
      }
    };
  };
  const all = await open(allDir);
  const lazy = await open(lazyDir);
  return {
    library,
    extra,
    all,
    lazy,
    async close() {
      stderrSpy.mockRestore();
      all.port.close();
      lazy.port.close();
      await rm(allDir, { recursive: true, force: true });
      await rm(lazyDir, { recursive: true, force: true });
    }
  };
}

/** Campos de una respuesta que no se pueden repetir entre dos copias (aleatorios o del
 *  reloj): se comparan solo por estar o no. */
const UNREPEATABLE_KEYS = new Set(['planId', 'expiresAt']);

/** El cursor de página de un plan (`rp1.`, `[planId, posición]` en base64url,
 *  `src/store/replace-batch.ts`) lleva el `planId`: se compara abierto, con el marcador. */
function planCursor(value: string, planId: string | undefined): unknown {
  if (planId === undefined || !value.startsWith('rp1.')) return value;
  const payload = JSON.parse(Buffer.from(value.slice(4), 'base64url').toString('utf8')) as unknown[];
  return { rp1: payload.map((part) => (part === planId ? '<planId>' : part)) };
}

function withoutUnrepeatable(value: unknown, planId: string | undefined): unknown {
  if (typeof value === 'string') return planCursor(value, planId);
  if (Array.isArray(value)) return value.map((inner) => withoutUnrepeatable(inner, planId));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      UNREPEATABLE_KEYS.has(key) && typeof inner === 'string' ? `<${key}>` : withoutUnrepeatable(inner, planId)
    ])
  );
}

/** La respuesta MCP con cada bloque de texto JSON ya analizado y sin lo irrepetible. */
function comparable(result: CallToolResult): unknown {
  return {
    isError: result.isError === true,
    content: result.content.map((block) => {
      if (block.type !== 'text') return block;
      let json: unknown;
      try {
        json = JSON.parse(block.text);
      } catch {
        return block;
      }
      const planId = (json as { planId?: unknown } | null)?.planId;
      return { type: 'text', json: withoutUnrepeatable(json, typeof planId === 'string' ? planId : undefined) };
    })
  };
}

/** Una fila con sus fechas reducidas a si están (`'<fecha>'`) o no (`null`): dependen del
 *  reloj de cada escritura, no de lo que se escribió. */
function withoutDates(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key.endsWith('_at') && value !== null ? '<fecha>' : value
    ])
  );
}

/**
 * El estado de las notas de una copia: todas las filas de `notes` (vivas, en la papelera y
 * copias de conflicto) y de `note_versions`, por id, sin las fechas. Una conexión de solo
 * lectura aparte, en WAL junto al puerto abierto.
 */
export function libraryState(sqlitePath: string): unknown {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const rows = (sql: string) =>
      (db.prepare(sql).all() as Record<string, unknown>[]).map((row) => withoutDates({ ...row }));
    return {
      notes: rows('SELECT * FROM notes ORDER BY id'),
      versions: rows('SELECT * FROM note_versions ORDER BY id')
    };
  } finally {
    db.close();
  }
}

/** La llamada a cada copia, para el test que quiera mirar más. */
export interface TwinCalls {
  all: LoadedToolCall;
  lazy: LoadedToolCall;
}

/**
 * Llama a `name` en las dos copias (la `all` con la biblioteca entera forzada, la `lazy` con la
 * carga que declaró) y exige lo de la cabecera: registrada `'lazy'`, sin preguntas por notas no
 * cargadas, la misma respuesta y el mismo estado final. `args` puede depender de la copia (el
 * `planId` de cada una). Devuelve las dos llamadas.
 */
export async function expectLazyWriteEquivalent<T>(
  h: TwinHarness<T>,
  name: string,
  args: Record<string, unknown> | ((side: TwinSide) => Record<string, unknown>)
): Promise<TwinCalls> {
  const argsFor = typeof args === 'function' ? args : () => args;
  const all = await callToolWithLoad(h.all.serverContext, name, argsFor('all'), 'all');
  const lazy = await callToolWithLoad(h.lazy.serverContext, name, argsFor('lazy'));
  expect(lazy.declared, `${name} no está registrada con privacyLoad: 'lazy'`).toBe('lazy');
  expect(lazy.unloadedLookups, `${name} preguntó por notas que no cargó con ensure`).toBe(0);
  expect(comparable(lazy.result), `${name} responde distinto con 'lazy' que con 'all'`).toEqual(
    comparable(all.result)
  );
  expect(libraryState(h.lazy.sqlitePath), `${name} deja las notas distintas con 'lazy' que con 'all'`).toEqual(
    libraryState(h.all.sqlitePath)
  );
  return { all, lazy };
}
