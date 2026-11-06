/**
 * Mide la memoria de N contextos de `serve-http` abiertos a la vez, con las mismas piezas que
 * `src/http/serve-http.ts` pasa a `AccountContexts`: `openServeContext({ writerOnly: true })`
 * por directorio, y las herramientas por `buildMcpServer` + cliente MCP en memoria (como cada
 * POST /mcp). Sin datos personales: bibliotecas sintéticas de `gen.ts`.
 *
 * Lo lanza `scripts/mem/run.mjs` dentro de un contenedor con `--memory`; a mano:
 *   node --expose-gc measure.mjs <raiz con ctx-0..ctx-N-1> <N> [--label L] [--concurrent 1,5]
 *        [--cache-kib K] [--cycles C] [--sync <plantilla>]
 * (sync: los N directorios están vacíos y bajan la plantilla de un relé en memoria, primera descarga).
 * Salida: una línea JSON por fase en stdout.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { openServeContext, type ServeContext } from '../../src/server/serve';
import { buildMcpServer } from '../../src/server/build-server';
import { readMemoryUsage } from '../../src/accounts/capacity';
import { SqliteLibraryEngine, LibrarySyncEngine } from '../../src/hebra';
import { InMemoryLibraryRelay, LocalLibraryPort } from '../../vendor/hebra/src/lib/library/node-testing';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const args = process.argv.slice(2);
const root = args[0];
const N = Number(args[1]);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const cacheKib = opt('--cache-kib') ? Number(opt('--cache-kib')) : null;
const cycles = Number(opt('--cycles') ?? 0);
const syncTemplate = opt('--sync');
const label = opt('--label') ?? '';


function smaps(): { anonKiB: number; lazyFreeKiB: number } | null {
  try { const t = readFileSync('/proc/self/smaps_rollup', 'utf8'); const g = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(t)?.[1] ?? NaN); return { anonKiB: g('Anonymous'), lazyFreeKiB: g('LazyFree') }; } catch { return null; }
}
const MiB = 1024 * 1024;
const gc = () => { for (let i = 0; i < 3; i += 1) (globalThis as { gc?: () => void }).gc?.(); };
const settle = () => new Promise((r) => setTimeout(r, 50));

function cgroupStat(): Record<string, number> | null {
  if (!existsSync('/sys/fs/cgroup/memory.stat')) return null;
  const out: Record<string, number> = {};
  for (const line of readFileSync('/sys/fs/cgroup/memory.stat', 'utf8').split('\n')) {
    const [k, v] = line.split(' ');
    if (['anon', 'file', 'active_file', 'inactive_file', 'shmem', 'file_mapped'].includes(k)) out[k] = +(Number(v) / MiB).toFixed(1);
  }
  return out;
}
function hwm(): number | null {
  try { const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8')); return m ? +(Number(m[1]) / 1024).toFixed(1) : null; } catch { return null; }
}
function resetHwm(): void { try { writeFileSync('/proc/self/clear_refs', '5'); } catch { /* sin /proc */ } }
function snap(phase: string, extra: Record<string, unknown> = {}) {
  const m = process.memoryUsage();
  const cg = readMemoryUsage();
  const row = { label, phase, N, cacheKib, rss: +(m.rss / MiB).toFixed(1), heapUsed: +(m.heapUsed / MiB).toFixed(1),
    heapTotal: +(m.heapTotal / MiB).toFixed(1), external: +(m.external / MiB).toFixed(1), arrayBuffers: +(m.arrayBuffers / MiB).toFixed(1),
    gateUsed: +(cg.usedBytes / MiB).toFixed(1), cgroup: cgroupStat(), smaps: smaps(), ...extra };
  console.log(JSON.stringify(row));
  return row;
}

const sampler = new Worker(fileURLToPath(new URL('./sampler.mjs', import.meta.url)));
sampler.unref();
function peakOf<T>(run: () => Promise<T>): Promise<{ value: T; peakRss: number; hwm: number | null; ms: number }> {
  return new Promise((resolve, reject) => {
    resetHwm();
    sampler.postMessage('start');
    const t0 = performance.now();
    setTimeout(() => {
      run().then((value) => {
        const ms = performance.now() - t0;
        sampler.once('message', (peak: number) => resolve({ value, peakRss: +(peak / MiB).toFixed(1), hwm: hwm(), ms: Math.round(ms) }));
        sampler.postMessage('stop');
      }, reject);
    }, 10);
  });
}

// Conexiones SQLite de un contexto, para las sondas (campos privados, solo lectura en runtime).
function sqliteHandles(s: ServeContext): Array<{ name: string; db: { exec(sql: string): void; prepare(sql: string): { get(): unknown } } }> {
  const port = (s.instance as unknown as { current: Record<string, unknown> }).current;
  const out = [] as Array<{ name: string; db: any }>;
  for (const name of ['db', 'jdPlansDb', 'replacePlansDb']) if (port[name]) out.push({ name, db: port[name] });
  return out;
}

async function populateRelay(template: string): Promise<InMemoryLibraryRelay> {
  const relay = new InMemoryLibraryRelay();
  const { conn } = openNodeSqliteConn(join(template, 'library.sqlite'), 'readWrite');
  const engine = await SqliteLibraryEngine.open(conn, 'App', { journalMode: 'WAL' });
  const port = new LocalLibraryPort(engine);
  const sync = await LibrarySyncEngine.create({ port, transport: relay, identity: IDENTITY, vaultKey: VAULT_KEY, keyEpoch: 1, blobTransport: null, onEvent: () => undefined });
  for (let i = 0; i < 200; i += 1) {
    const r = await sync.runRound();
    if ((r as { pushed?: number }).pushed === 0 || r.result !== 'ok') break;
  }
  return relay;
}
const VAULT_KEY = new Uint8Array(32).fill(7);
const IDENTITY = { relayOrigin: 'https://relay.test', syncVaultId: 'bb'.repeat(16) };

async function main() {
  await settle(); gc();
  const base = snap('baseline', { heapLimitMiB: Math.round((await import('node:v8')).getHeapStatistics().heap_size_limit / MiB), nodeOptions: process.env.NODE_OPTIONS ?? '' });
  let relay: InMemoryLibraryRelay | null = null;
  if (syncTemplate) {
    relay = await populateRelay(syncTemplate);
    await settle(); gc();
    snap('relay_populated', { relayRecords: (relay as any).records?.size ?? null });
  }
  const dirs = Array.from({ length: N }, (_, i) => join(root, `ctx-${i}`));
  const opened: ServeContext[] = [];
  const openPeak = await peakOf(async () => {
    for (const dataDir of dirs) {
      const s = await openServeContext({ dataDir, secrets: null, writerOnly: true,
        instance: relay ? { sync: { transport: relay, blobTransport: null, identity: IDENTITY, vaultKey: VAULT_KEY, intervalMs: null, emit: () => undefined } } : undefined });
      opened.push(s);
      if (cacheKib !== null) for (const h of sqliteHandles(s)) h.db.exec(`PRAGMA cache_size=-${cacheKib}`);
    }
    for (const s of opened) { await s.instance.whenReady(); await s.instance.whenSubstringIndexSettled(); }
    if (relay) {
      for (const s of opened) {
        for (let i = 0; i < 400; i += 1) {
          const round = await s.instance.syncRunner!.requestRound();
          if (!round || (round as { pulled?: number }).pulled === 0) break;
        }
      }
    }
  });
  await settle(); gc();
  const probe = sqliteHandles(opened[0]).map((h) => ({ name: h.name,
    cache_size: Number((h.db.prepare('PRAGMA cache_size').get() as any)?.cache_size),
    mmap_size: Number((h.db.prepare('PRAGMA mmap_size').get() as any)?.mmap_size),
    page_size: Number((h.db.prepare('PRAGMA page_size').get() as any)?.page_size) }));
  const notes = await opened[0].ctx.port.libraryOpen();
  const afterOpen = snap('after_open', { openPeakRss: openPeak.peakRss, openHwm: openPeak.hwm, openMs: openPeak.ms,
    perCtxRss: +((0) || 0), sqlite: probe, notesCount: (notes as any).notesCount });
  console.log(JSON.stringify({ label, phase: 'delta_open', N, perCtxRssMiB: +((afterOpen.rss - base.rss) / N).toFixed(2),
    perCtxHeapMiB: +((afterOpen.heapUsed - base.heapUsed) / N).toFixed(2), perCtxGateMiB: +((afterOpen.gateUsed - base.gateUsed) / N).toFixed(2) }));

  // Peticiones: cada una como un POST /mcp de serve-http (un McpServer nuevo por petición).
  const requests: Array<[string, Record<string, unknown>]> = [
    ['hebra_list_notes', { limit: 50 }],
    ['hebra_search', { query: 'tango sierra' }],
    ['hebra_read_note', { title: undefined }],
    ['hebra_grep', { pattern: 'whisky xray' }],
    ['hebra_list_tags', {}]
  ];
  const big = (await opened[0].ctx.port.notesPage(null, 5, { kind: 'all' } as any)) as any;
  const bigTitle = (await opened[0].ctx.port.search('Nota 0', null, 1) as any)?.items?.[0]?.title ?? big.items[0].title;
  for (const [tool, input] of requests) {
    if (tool === 'hebra_read_note') input.title = bigTitle;
    const target = opened[opened.length - 1];
    gc(); await settle();
    const before = snap(`before_${tool}`);
    const r = await peakOf(async () => {
      const server = buildMcpServer(target.ctx, '0.0.0-mem');
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'mem', version: '0' });
      await Promise.all([server.connect(a), client.connect(b)]);
      const res = await client.callTool({ name: tool, arguments: input });
      const size = JSON.stringify(res).length;
      await client.close(); await server.close();
      return { size, isError: (res as { isError?: boolean }).isError === true };
    });
    const noGc = snap(`after_${tool}_nogc`);
    gc(); await settle();
    const after = snap(`after_${tool}`);
    console.log(JSON.stringify({ label, phase: 'request', N, cacheKib, tool, peakRss: r.peakRss, hwm: r.hwm, ms: r.ms, responseChars: r.value.size, isError: r.value.isError,
      peakOverBeforeRss: +(r.peakRss - before.rss).toFixed(1), garbageHeap: +(noGc.heapUsed - after.heapUsed).toFixed(1), retainedRss: +(after.rss - before.rss).toFixed(1), retainedHeap: +(after.heapUsed - before.heapUsed).toFixed(1) }));
  }
  // Concurrencia: K peticiones a la vez, cada una en un contexto distinto (como K personas).
  const conc = opt('--concurrent');
  if (conc) {
    for (const K of conc.split(',').map(Number)) {
      if (K > opened.length) continue;
      gc(); await settle();
      const before = snap(`before_concurrent_${K}`);
      const r = await peakOf(async () => Promise.all(opened.slice(0, K).map(async (target) => {
        const server = buildMcpServer(target.ctx, '0.0.0-mem');
        const [a, b] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'mem', version: '0' });
        await Promise.all([server.connect(a), client.connect(b)]);
        const res = await client.callTool({ name: 'hebra_search', arguments: { query: 'tango sierra' } });
        await client.close(); await server.close();
        return (res as { isError?: boolean }).isError === true;
      })));
      gc(); await settle();
      const after = snap(`after_concurrent_${K}`);
      console.log(JSON.stringify({ label, phase: 'concurrent', N, K, ms: r.ms, peakRss: r.peakRss, hwm: r.hwm, errors: r.value.filter(Boolean).length,
        peakOverBefore: +((r.hwm ?? r.peakRss) - before.rss).toFixed(1), retainedAnon: +((after.cgroup?.anon ?? 0) - (before.cgroup?.anon ?? 0)).toFixed(1) }));
    }
  }
  // ¿Cuánto es caché de páginas de SQLite? shrink_memory en todas las conexiones.
  for (const s of opened) for (const h of sqliteHandles(s)) h.db.exec('PRAGMA shrink_memory');
  gc(); await settle();
  snap('after_shrink_memory');

  const closePeak = await peakOf(async () => { for (const s of opened) await s.close(); });
  opened.length = 0;
  for (let i = 0; i < 5; i += 1) { gc(); await settle(); }
  const afterClose = snap('after_close', { closeMs: closePeak.ms });
  console.log(JSON.stringify({ label, phase: 'delta_close', N, notReturnedRssMiB: +(afterClose.rss - base.rss).toFixed(1), notReturnedHeapMiB: +(afterClose.heapUsed - base.heapUsed).toFixed(1) }));
  for (let c = 0; c < cycles; c += 1) {
    for (const dataDir of dirs) {
      const s = await openServeContext({ dataDir, secrets: null, writerOnly: true });
      await s.instance.whenReady();
      await s.ctx.port.search('alfa', null, 10);
      await s.close();
    }
    for (let i = 0; i < 3; i += 1) { gc(); await settle(); }
    snap(`after_cycle_${c + 1}`);
  }
  process.exit(0);
}
main().catch((error) => { console.error(error); process.exit(1); });
