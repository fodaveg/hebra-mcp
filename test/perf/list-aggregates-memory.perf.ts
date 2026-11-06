/**
 * Memoria por llamada de los recuentos y listados de la pieza A7 del plan de memoria (6 nov
 * 2026): `hebra_list_tags`, `hebra_list_folders`, `hebra_list_properties` y
 * `hebra_query_properties`, con el filtro cargando la biblioteca entera (`'all'`, lo de antes) y
 * perezoso (`'lazy'`, lo de ahora), a 5 000 y a 10 000 notas. Fuera de la suite normal, porque crea
 * 15 000 notas:
 * `npx vitest run --config vitest.perf.config.ts test/perf/list-aggregates-memory.perf.ts --maxWorkers=1`.
 *
 * Qué se mide: la memoria de JS que RETIENE una llamada (el contexto de la herramienta con su
 * filtro y la respuesta), tras forzar la recolección, y lo que la llamada deja asignado sin
 * recoger justo al acabar (cota baja del pico: entre medias puede recoger). Y el tiempo. Imprime en
 * stderr una línea JSON por tamaño (`listAggregates.perf`). Que no crezca con las notas, sin
 * reloj ni montón, lo comprueba el test normal `test/tools/list-aggregates-lazy.test.ts` (ni
 * `notesVisibilityIndex` ni más notas que las de la página).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, expect, it } from 'vitest';
import { SqliteLibraryEngine } from '../../src/hebra';
import type { PrivacyConfig } from '../../src/privacy';
import { resolveToolContext, type ServerContext } from '../../src/server/context';
import { runListFolders } from '../../src/server/tools/list-folders';
import { runListProperties } from '../../src/server/tools/list-properties';
import { runListTags } from '../../src/server/tools/list-tags';
import { runQueryProperties } from '../../src/server/tools/query-properties';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { createNote } from '../fixtures/test-library';

setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc') as () => void;

const CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };
const MIB = 1024 * 1024;
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** `notes` notas en 20 carpetas (una, `Diario`, privada), con dos etiquetas y tres propiedades
 *  cada una, y `#secreto` en una de cada diez. */
async function createLibrary(sqlitePath: string, notes: number): Promise<number> {
  const { db, conn } = openNodeSqliteConn(sqlitePath);
  const engine = await SqliteLibraryEngine.open(conn, 'perf-a7');
  const folders: string[] = [(await engine.folderCreate(null, 'Diario')).id];
  for (let i = 1; i < 20; i += 1) folders.push((await engine.folderCreate(null, `Carpeta ${i}`)).id);
  const start = Date.now();
  for (let i = 0; i < notes; i += 1) {
    const tags = [`tag${i % 30}`, `tag${(i + 1) % 30}`, ...(i % 10 === 0 ? ['secreto'] : [])];
    const body =
      `---\nestado: e${i % 7}\nprioridad: ${i % 100}\nclave${i % 40}: v${i}\n---\n` +
      `# Nota ${i}\n${tags.map((tag) => `#${tag}`).join(' ')}\ncuerpo sintético ${i}\n`;
    await createNote(engine, folders[i % folders.length]!, body);
  }
  const createMs = Date.now() - start;
  db.close();
  return createMs;
}

type Tool = (ctx: Awaited<ReturnType<typeof resolveToolContext>>) => Promise<unknown>;
const TOOLS: Record<string, Tool> = {
  hebra_list_tags: (ctx) => runListTags(ctx, {}),
  hebra_list_folders: (ctx) => runListFolders(ctx, {}),
  hebra_list_properties: (ctx) => runListProperties(ctx, {}),
  hebra_list_properties_estado: (ctx) => runListProperties(ctx, { key: 'estado' }),
  hebra_query_properties: (ctx) =>
    runQueryProperties(ctx, { filters: [{ key: 'estado', op: 'equals', value: 'e3' }], sort: { key: 'prioridad' }, limit: 20 })
};

interface Sample {
  retainedMiB: number;
  leftAfterCallMiB: number;
  ms: number;
}

async function measure(server: ServerContext, tool: Tool, loadAll: boolean): Promise<Sample> {
  // Una vuelta antes, para que las sentencias preparadas y las cachés no cuenten como de la llamada.
  await tool(await resolveToolContext(server, { loadAll }));
  gc();
  const before = process.memoryUsage().heapUsed;
  const start = performance.now();
  const ctx = await resolveToolContext(server, { loadAll });
  const result = await tool(ctx);
  const ms = performance.now() - start;
  const leftAfterCall = process.memoryUsage().heapUsed - before;
  gc();
  const retained = process.memoryUsage().heapUsed - before;
  // Vivos hasta aquí: lo que retiene la llamada es su contexto y su respuesta.
  expect(ctx.privacy).toBeDefined();
  expect(result).toBeDefined();
  return { retainedMiB: retained / MIB, leftAfterCallMiB: leftAfterCall / MIB, ms };
}

const round = (value: number): number => Math.round(value * 100) / 100;

it('A7: memoria por llamada con 5 000 y 10 000 notas, \'all\' frente a \'lazy\'', async () => {
  const report: Record<string, unknown> = {};
  const lazyRetained: Record<string, number[]> = {};
  const allRetained: Record<string, number[]> = {};
  for (const notes of [5000, 10_000]) {
    const dataDir = mkdtempSync(join(tmpdir(), 'hebra-mcp-a7-perf-'));
    dirs.push(dataDir);
    const sqlitePath = join(dataDir, 'library.sqlite');
    const createMs = await createLibrary(sqlitePath, notes);
    const port = await openNodeLibraryPort({ sqlitePath, dataDir });
    try {
      const server: ServerContext = { port, privacyConfig: CONFIG, status: new UnlinkedStatusSource() };
      const perTool: Record<string, unknown> = {};
      for (const [name, tool] of Object.entries(TOOLS)) {
        const all = await measure(server, tool, true);
        const lazy = await measure(server, tool, false);
        (allRetained[name] ??= []).push(all.retainedMiB);
        (lazyRetained[name] ??= []).push(lazy.retainedMiB);
        perTool[name] = {
          all: { retainedMiB: round(all.retainedMiB), leftAfterCallMiB: round(all.leftAfterCallMiB), ms: round(all.ms) },
          lazy: { retainedMiB: round(lazy.retainedMiB), leftAfterCallMiB: round(lazy.leftAfterCallMiB), ms: round(lazy.ms) }
        };
      }
      report[String(notes)] = { createMs, tools: perTool };
    } finally {
      port.close();
    }
  }
  process.stderr.write(`listAggregates.perf ${JSON.stringify(report)}\n`);
  for (const name of Object.keys(TOOLS)) {
    const [lazySmall, lazyBig] = lazyRetained[name]!;
    const [allSmall, allBig] = allRetained[name]!;
    // Perezosa: lo retenido no depende de las notas (holgura de 1 MiB por el ruido del montón).
    expect(lazyBig! - lazySmall!, name).toBeLessThan(1);
    expect(lazyBig!, name).toBeLessThan(1);
    // Control: con la biblioteca entera sí crece (si no, la medida no mide nada).
    expect(allBig! - allSmall!, name).toBeGreaterThan(1);
  }
}, 900_000);
