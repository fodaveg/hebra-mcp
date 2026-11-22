/**
 * Sonda de memoria de las hojas del MCP (H-95c), la que corre DENTRO del contenedor de
 * `scripts/mem/sheets-peak.mjs`. Se empaqueta junto a `dist/` (para que `import.meta.url` de las
 * herramientas encuentre `sheet-engine-worker.mjs`, `document-worker.mjs` y las fuentes) y se
 * lanza con `node --liftoff-only dist/sheets-probe.mjs <prep|run> <caso> <carpeta>`.
 *
 * - `prep`: crea en `<carpeta>/lib` una biblioteca con el `.ods` del caso (`/fx/<caso>.ods`) y
 *   escribe `<carpeta>/meta.json` con el id del fichero. Corre en un contenedor SIN límite de
 *   memoria, para que la caché de escritura no cuente en el cgroup medido.
 * - `run`: con 220 MiB de lastre tocado (el MCP vivo con dos cuentas, como H-95), hace UNA
 *   operación con las herramientas reales y escribe una línea JSON con el pico del cgroup
 *   (`memory.peak`), el RSS máximo del proceso y los máximos muestreados de `memory.current` y del
 *   heap de JS del hilo principal por fase.
 *
 * Casos: `read` (`runReadSheet`, página `A1:H250` con valores y fórmulas, por el hilo de
 * documentos), `edit` (`runEditSheet` de `A1` por el escritor real de `runDocumentRequest` y, a
 * continuación, el exportador de `.ods` del MCP, que es el guardado) y `render` (`runRenderSheet`
 * con el motor del hilo empaquetado y `@napi-rs/canvas`).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import v8 from 'node:v8';
import { PrivacyFilter } from '../../src/privacy/filter';
import type { ToolContext } from '../../src/server/context';
import { createSheetDocumentFormat, runEditSheet, type EditSheetWriter } from '../../src/server/tools/edit-sheet';
import { runReadSheet } from '../../src/server/tools/read-sheet';
import { renderSvgToPng } from '../../src/render/render';
import { bundledSheetRenderAssets, runRenderSheet } from '../../src/server/tools/render-sheet';
import { createSheetDocumentExporter } from '../../src/server/tools/sheet-export';
import { blobOf } from '../../src/server/tools/sheet-read';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { registerDocumentFormat, runDocumentRequest } from '../../src/store/document-service';
import { DOCUMENT_OPS_VERSION } from '../../src/store/document-types';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { SHEET_JOB_RESERVE_BYTES } from '../../src/store/sheet-limits';

const MIB = 1024 * 1024;
const [mode, caso, dir] = process.argv.slice(2) as [string, string, string];
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const CONFIG = { privateFolders: [['diario']], privateTags: [] as string[] };
const ODS = 'application/vnd.oasis.opendocument.spreadsheet';

const cgroup = (name: string): number | null => {
  try {
    const text = readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim();
    return text === 'max' ? null : Number(text);
  } catch {
    return null;
  }
};
const mib = (n: number | null): number | null => (n === null ? null : Math.round((n / MIB) * 10) / 10);
/** `anon`, `file` y `kernel` de `memory.stat` en MiB: qué parte de `memory.current` es memoria del proceso. */
const memoryStat = (): Record<string, number | null> => {
  try {
    const text = readFileSync('/sys/fs/cgroup/memory.stat', 'utf8');
    const of = (key: string) => mib(Number(new RegExp(`^${key} (\\d+)$`, 'm').exec(text)?.[1] ?? NaN));
    return { anon: of('anon'), file: of('file'), kernel: of('kernel') };
  } catch {
    return {};
  }
};

async function openLibrary() {
  return openNodeLibraryPort({ sqlitePath: join(dir, 'lib', 'library.sqlite'), dataDir: join(dir, 'lib') });
}

async function contextOf(port: Awaited<ReturnType<typeof openLibrary>>): Promise<ToolContext> {
  const privacy = await (await PrivacyFilter.build(port, CONFIG)).ensureAll();
  return { port, privacy, privacyConfig: CONFIG, status: new UnlinkedStatusSource() };
}

if (mode === 'prep') {
  const bytes = new Uint8Array(readFileSync(`/fx/${caso}.ods`));
  const port = await openLibrary();
  const fileId = await port.writeExclusive(async (store) => {
    const hojas = (await store.folderCreate('root', 'Hojas')).id;
    await store.folderCreate('root', 'Diario'); // la carpeta privada de CONFIG: sin ella, privacy_config_unresolved
    await store.blobPut(bytes, { mime: ODS, expectedSha256: sha(bytes) });
    return (await store.fileCreate(hojas, 'datos.ods', sha(bytes))).id;
  });
  await port.closeWhenIdle();
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ fileId, bytes: bytes.length, sha: sha(bytes) }));
  console.log(JSON.stringify({ prep: caso, bytes: bytes.length }));
  process.exit(0);
}

// ---- run ----
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { fileId: string; bytes: number };
const ballast = Buffer.alloc(220 * MIB, 1); // tocado: cuenta como RSS
await new Promise((r) => setTimeout(r, 200));
const port = await openLibrary();
const ctx = await contextOf(port);

// Muestreo: un hilo lee memory.current cada 2 ms; el heap del principal, con un temporizador.
const sampler = new Worker(
  `const { parentPort } = require('node:worker_threads'); const fs = require('node:fs');
   let max = 0, timer = null;
   const read = () => { try { return Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8')); } catch { return 0; } };
   parentPort.on('message', (m) => {
     if (m === 'start') { max = 0; timer = setInterval(() => { max = Math.max(max, read()); }, 2); }
     else { clearInterval(timer); parentPort.postMessage(Math.max(max, read())); }
   });`,
  { eval: true }
);
sampler.unref();
let heapMax = 0;
const heapTimer = setInterval(() => {
  heapMax = Math.max(heapMax, v8.getHeapStatistics().used_heap_size);
}, 3);
heapTimer.unref();

async function phase<T>(name: string, work: () => Promise<T>): Promise<{ value: T; row: Record<string, unknown> }> {
  heapMax = 0;
  const t0 = performance.now();
  sampler.postMessage('start');
  let value: T;
  let error: unknown = null;
  try {
    value = await work();
  } catch (caught) {
    error = caught;
    value = undefined as T;
  }
  const peak = await new Promise<number>((resolve) => {
    sampler.once('message', resolve);
    sampler.postMessage('stop');
  });
  return {
    value,
    row: {
      fase: name,
      ms: Math.round(performance.now() - t0),
      currentMaxMiB: mib(peak),
      heapMaxMiB: mib(heapMax),
      error: error ? String((error as { code?: string }).code ?? (error as Error).message) : null
    }
  };
}

const gate = {
  asked: [] as number[],
  admit: async (_signal?: AbortSignal, bytes?: number) => {
    gate.asked.push(bytes ?? 0);
    return { done: () => undefined };
  }
};
const capacity = { key: 'cuenta', gate };
const before = { currentMiB: mib(cgroup('memory.current')), rssMiB: mib(process.memoryUsage().rss) };
const phases: Array<Record<string, unknown>> = [];

if (caso.startsWith('read')) {
  const r = await phase('read', () =>
    runReadSheet(ctx, { id: meta.fileId, sheet: 'Datos', range: 'A1:H250', include: ['values', 'formulas'] }, { capacity })
  );
  phases.push(r.row);
} else if (caso.startsWith('render')) {
  // H-95d: el pintado se parte en dos fases en la frontera entre la lectura (hasta el SVG) y el
  // pintado del PNG, envolviendo `render` del cableado. `GC=1` (con `--expose-gc`) recoge la
  // basura en esa frontera, para ver cuánto de lo que deja la lectura es basura sin recoger.
  const assets = bundledSheetRenderAssets();
  let frontier: Record<string, unknown> | null = null;
  const render: typeof renderSvgToPng = async (input) => {
    const readPeak = await new Promise<number>((resolve) => {
      sampler.once('message', resolve);
      sampler.postMessage('stop');
    });
    const atFrontier = cgroup('memory.current');
    const statAtFrontier = memoryStat();
    const gc = (globalThis as { gc?: () => void }).gc;
    if (process.env.GC === '1' && gc) gc();
    // `ESPERA_MS`: cuánto se espera en la frontera antes de pintar (lo que tarda en irse el hilo del motor).
    const wait = Number(process.env.ESPERA_MS ?? 0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    frontier = {
      lecturaPicoMiB: mib(readPeak),
      fronteraMiB: mib(atFrontier),
      statFrontera: statAtFrontier,
      fronteraTrasGcMiB: process.env.GC === '1' && gc ? mib(cgroup('memory.current')) : null,
      fronteraTrasEsperaMiB: wait > 0 ? mib(cgroup('memory.current')) : null,
      statTrasEspera: wait > 0 ? memoryStat() : null,
      rssFronteraMiB: mib(process.memoryUsage().rss),
      heapFronteraMiB: mib(v8.getHeapStatistics().used_heap_size),
      svgBytes: input.svg.byteLength,
      anchoPedido: input.widthPx
    };
    sampler.postMessage('start');
    const out = await renderSvgToPng(input);
    frontier.png = { width: out.width, height: out.height, bytes: out.png.byteLength };
    return out;
  };
  const r = await phase('render', () =>
    runRenderSheet(
      ctx,
      { id: meta.fileId, sheet: 'Datos', range: process.env.RANGO ?? 'A1:BH200', width: Number(process.env.ANCHO ?? 1568) },
      { documents: port.documentSource(), capacity, ...assets, render }
    )
  );
  phases.push({ ...r.row, ...(frontier ?? {}) });
} else {
  registerDocumentFormat('ods', createSheetDocumentFormat());
  const writer: EditSheetWriter = async (request) => {
    const outcome = await runDocumentRequest(
      { port, writeExclusive: (operation) => port.writeExclusive(operation) },
      { opsVersion: DOCUMENT_OPS_VERSION, ...request },
      { afterCommit: async () => ({ sync: 'not_linked' }) }
    );
    if ('created' in outcome) throw new Error('documentOps devolvió una creación');
    return outcome;
  };
  const edit = await phase('edit', () =>
    runEditSheet(
      ctx,
      { id: meta.fileId, operationId: 'op-95c-1', ops: [{ type: 'setCells', sheet: 'Datos', start: 'A1', rows: [[42]], expect: { A1: caso === 'foto' ? 1 : 0 } }] } as never,
      writer,
      { capacity }
    )
  );
  phases.push({ ...edit.row, salida: (edit.value as { outcome?: string } | undefined)?.outcome ?? null });
  // El guardado: el exportador que registra el escritor, sobre el estado que dejó la edición.
  const source = port.documentSource();
  const state = await source.port.docRead(meta.fileId);
  if (state.head) {
    const exporter = createSheetDocumentExporter();
    const saved = await phase('guardar', async () => {
      const out = await exporter(
        { libraryId: source.libraryId, store: source.port, blobRead: (hash) => blobOf(source, hash) },
        meta.fileId,
        state.head!
      );
      return out.bytes.length;
    });
    phases.push({ ...saved.row, bytesGuardados: saved.value });
  } else {
    phases.push({ fase: 'guardar', error: 'sin cabecera tras la edicion' });
  }
}

const result = {
  caso,
  node: process.version,
  execArgv: process.execArgv,
  ficheroBytes: meta.bytes,
  lastreMiB: ballast.length / MIB,
  antes: before,
  fases: phases,
  reservaPedidaMiB: gate.asked.map((b) => b / MIB),
  reservaEsperadaMiB: SHEET_JOB_RESERVE_BYTES / MIB,
  cgroupPicoMiB: mib(cgroup('memory.peak')),
  cgroupMaxMiB: mib(cgroup('memory.max')),
  maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024)
};
console.log(JSON.stringify(result));
process.exit(0);
