/**
 * H-81: `hebra_render_sheet` con las piezas reales, sin registrarla (la alta es de H-177). SQLite en
 * fichero y `NodeLibraryPort` (su `documentSource()` y sus blobs), el adaptador de hojas de
 * `vendor/hebra`, `createEditorData`, la lista de dibujo y su SVG con las fuentes empaquetadas de
 * verdad, el motor IronCalc (en el mismo proceso: el hilo de `dist/` lo prueba `check:bundle`) y
 * `renderSvgToPng` con `@napi-rs/canvas`. Solo la compuerta es un doble, para contar lo que aparta.
 *
 * Pruebas negativas hechas a mano al escribirlo (se rompe, el test cae, se restaura):
 * - `renderRangeTooLarge` sin sumar las inmovilizadas: cae «las filas inmovilizadas cuentan»;
 * - `runRenderSheet` sin la comprobación del tope antes de leer: cae «rango excesivo» (llega a la
 *   compuerta) y el de 61 columnas pinta;
 * - `visibleDocumentOf` cambiado por `filter.isVisible` (que admite la papelera): cae «id oculto»
 *   por el fichero de la papelera;
 * - `fitRenderWidth` devolviendo el ancho pedido: cae «el rango máximo» (2,46 Mpx);
 * - sin `ticket.done()` en la fase de lectura: cae «suelta todo lo que aparta».
 * - sin `withSpilledValues` (la hoja del modelo tal cual a la lista de dibujo): cae «pinta las
 *   celdas que rellena una matriz que se derrama» (H-SPILL).
 * - H-95b: `admitRead` con la compuerta directa (sin `admitSheetJob`): cae «con la cola de hojas
 *   ocupada»; el tope de tamaño con `DOCUMENT_MAX_BYTES`: cae «más de 4 MiB»;
 *   `renderSheetReadReserveBytes` con `documentReserveBytes`: cae «pinta un rango como PNG».
 * - H-TOPES-MCP: `createEditorData` sin `limits`: cae «una imagen que pasa del tope» (pinta, sale
 *   `null`); con `limits` y sin `isSheetLimitError`: cae igual, con el `Error` de `readSafeZip`.
 * - H-TOPES-MCP, tests aislados: con un plazo de 300 ms forzado en «el rango máximo», si `cleanUp`
 *   no espera las llamadas en marcha, «id oculto» pasa de 80 ms a 4.583 ms (espera el hueco de la
 *   cola que dejó el que venció, al borde de los 5 s); esperándolas, se queda en 80 ms.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initSync, Model } from '@ironcalc/wasm';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ContextUnavailableError, type AdmissionTicket } from '../../src/accounts/capacity';
import type { PrivacyConfig } from '../../src/privacy/config';
import { PrivacyFilter } from '../../src/privacy/filter';
import { renderReserveBytes, renderSvgToPng } from '../../src/render/render';
import type { ToolContext } from '../../src/server/context';
import { ToolContent, ToolError } from '../../src/server/errors';
import {
  formatRenderRange,
  loadDocumentFonts,
  parseRenderRange,
  RENDER_SHEET_MAX_PIXELS,
  renderRangeTooLarge,
  renderSheetReadReserveBytes,
  runRenderSheet,
  type RenderSheetInput,
  type RenderSheetWiring
} from '../../src/server/tools/render-sheet';
import { scopeOf } from '../../src/server/tools/sheet-read';
import { createFormulaLocale, type FormulaEngineWithValues } from '../../src/sheets';
import { isFormulaParseError } from '../../vendor/hebra/src/lib/sheets/contracts/locale';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import { sheetJobSlot } from '../../src/store/sheet-jobs';
import { SHEET_DOCUMENT_MAX_BYTES, SHEET_JOB_RESERVE_BYTES, SHEET_ODS_READ_LIMITS } from '../../src/store/sheet-limits';
import type { SheetOp } from '../../vendor/hebra/src/lib/sheets/contracts/ops';
import { IronCalcEngine } from '../../vendor/hebra/src/lib/sheets/engine/ironcalc-engine';
import { createSheetAdapter, prepareSheetBase } from '../../vendor/hebra/src/lib/sheets/adapter/sheet-adapter';
import { bigContent, buildOds, ctxOf } from '../../vendor/hebra/src/lib/sheets/adapter/sheet-adapter.fixture';
import { newDocumentHead } from '../../vendor/hebra/src/lib/documents/sync/lifecycle';

const CONFIG: PrivacyConfig = { privateFolders: [['privada']], privateTags: [] };
const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';
const FONTS = pathToFileURL(join(process.cwd(), 'vendor', 'hebra', 'static', 'fonts', 'documents') + '/');
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Plazo del calentamiento de `beforeAll`. Lo que cuesta en frío, medido en este Mac el 22 nov 2026
 * con una carga media de 9 en 15 núcleos (sonda de una vez, no versionada): el primer PNG 167 y
 * 195 ms (el segundo, 32 y 40: el hilo del render carga `@napi-rs/canvas` la primera vez), las
 * fuentes 70 y 77 ms (`loadDocumentFonts` las guarda), el primer libro en IronCalc 50 y 53 ms (el
 * segundo, 2: el wasm se compila al primer uso, no en `initSync`) y los primeros datos de pintado
 * 19 y 21 ms (el tercero, 3). Unos 0,3 s que pagaba el primer test del fichero. Con 60 s caben
 * más de cien veces: si vence, el fallo es del calentamiento, con su nombre, y no de un test.
 */
const WARM_UP_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  const wasm = createRequire(import.meta.url).resolve('@ironcalc/wasm/wasm_bg.wasm');
  initSync({ module: readFileSync(wasm) });
  // Un pintado entero, con las piezas reales, para que el coste en frío no lo pague ningún test.
  const h = await harness();
  const id = await addDocument(h, 'calentar.ods', buildOds());
  await render(h, { id, sheet: 'Datos', range: 'A1:C5' });
  await cleanUp();
}, WARM_UP_TIMEOUT_MS);

const ports: NodeLibraryPort[] = [];
const directories: string[] = [];

/**
 * Las llamadas a `runRenderSheet` de este fichero que siguen en marcha. Un test que vence su plazo
 * no para la suya, que sigue con el hueco de la cola de hojas (uno por proceso) y el de la cola del
 * render: el test siguiente esperaría ese hueco y vencería también, sin ser el lento. `afterEach`
 * las espera antes de cerrar nada, así que un test lento cae solo y con su nombre.
 */
const inflight = new Set<Promise<unknown>>();

/** `runRenderSheet`, apuntada en `inflight` hasta que acaba. */
function runTracked(...args: Parameters<typeof runRenderSheet>): ReturnType<typeof runRenderSheet> {
  const call = runRenderSheet(...args);
  inflight.add(call);
  call.then(
    () => inflight.delete(call),
    () => inflight.delete(call)
  );
  return call;
}

/** Espera las llamadas en marcha y cierra bibliotecas y carpetas temporales. */
async function cleanUp(): Promise<void> {
  await Promise.allSettled([...inflight]);
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}

afterEach(cleanUp);

/** El motor de la app en este mismo proceso, con la interfaz del de `dist/` (que va en un hilo). */
function inProcessEngine(log: { loads: number; disposed: number }): FormulaEngineWithValues {
  const engine = new IronCalcEngine({ Model });
  return {
    load: async (book, opts, signal) => {
      signal.throwIfAborted();
      log.loads += 1;
      engine.load(book, opts);
    },
    apply: async (edits) => engine.apply(edits),
    read: async (sheet, range) => engine.read(sheet, range),
    readValues: async (sheet, range) => engine.readValues(sheet, range),
    dispose: () => {
      log.disposed += 1;
      engine.dispose();
    }
  };
}

/** Compuerta de pruebas: apunta cada reserva y cuántas siguen sin soltar. */
function fakeGate(refuse = false) {
  const asked: number[] = [];
  let pending = 0;
  return {
    asked,
    get pending(): number {
      return pending;
    },
    admit: async (_signal?: AbortSignal, bytes?: number): Promise<AdmissionTicket> => {
      if (refuse) throw new ContextUnavailableError('capacity_wait_timeout', 1);
      asked.push(bytes ?? 0);
      pending += 1;
      let released = false;
      return {
        done: () => {
          if (released) return;
          released = true;
          pending -= 1;
        }
      } as AdmissionTicket;
    }
  };
}

interface Harness {
  port: NodeLibraryPort;
  ctx: ToolContext;
  folders: { hojas: string; privada: string };
  gate: ReturnType<typeof fakeGate>;
  engineLog: { loads: number; disposed: number };
  svgs: string[];
  wiring(extra?: Partial<RenderSheetWiring>): RenderSheetWiring;
}

async function harness(refuse = false): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-render-sheet-'));
  directories.push(directory);
  const port = await openNodeLibraryPort({ sqlitePath: join(directory, 'library.sqlite'), dataDir: directory });
  ports.push(port);
  const folders = await port.writeExclusive(async (store) => ({
    hojas: (await store.folderCreate('root', 'Hojas')).id,
    privada: (await store.folderCreate('root', 'Privada')).id
  }));
  const gate = fakeGate(refuse);
  const engineLog = { loads: 0, disposed: 0 };
  const svgs: string[] = [];
  const h: Harness = {
    port,
    ctx: undefined as unknown as ToolContext,
    folders,
    gate,
    engineLog,
    svgs,
    wiring: (extra = {}) => ({
      documents: port.documentSource(),
      capacity: { gate, key: 'cuenta' },
      fonts: () => loadDocumentFonts(FONTS),
      engine: () => inProcessEngine(engineLog),
      // El servicio real, y el SVG que recibe, para mirar qué se pintó.
      render: (input, options) => {
        svgs.push(new TextDecoder().decode(input.svg));
        return renderSvgToPng(input, options);
      },
      ...extra
    })
  };
  await refreshContext(h);
  return h;
}

/** Filtro de privados recién construido, como el de cada llamada (`resolveToolContext`). */
async function refreshContext(h: Harness): Promise<void> {
  const privacy = await (await PrivacyFilter.build(h.port, CONFIG)).ensureAll();
  h.ctx = { port: h.port, privacy, privacyConfig: CONFIG, status: new UnlinkedStatusSource() };
}

/** Un fichero en `folder` con esos bytes. Sin cabecera de documento: como uno recién sincronizado. */
async function addFile(h: Harness, folder: string, name: string, bytes: Uint8Array): Promise<string> {
  const id = await h.port.writeExclusive(async (store) => {
    await store.blobPut(bytes, { mime: ODS_MIME, expectedSha256: sha(bytes) });
    return (await store.fileCreate(folder, name, sha(bytes))).id;
  });
  await refreshContext(h);
  return id;
}

/**
 * Un `.ods` abierto como documento: cabecera, andamio y, si se dan, operaciones ya aplicadas en el
 * `Y.Doc`, como las deja la edición (los updates en el almacén, sin punto de control).
 */
async function addDocument(h: Harness, name: string, bytes: Uint8Array, ops: SheetOp[] = []): Promise<string> {
  const id = await addFile(h, h.folders.hojas, name, bytes);
  const adapter = createSheetAdapter(await prepareSheetBase(bytes));
  const generation = `g-${id}`;
  const source = h.port.documentSource().port;
  await source.docSetHead(id, newDocumentHead('ods', generation, sha(bytes)), [sha(bytes)]);
  const doc = new Y.Doc();
  adapter.scaffold(bytes, doc);
  await source.docAppend(id, generation, Y.encodeStateAsUpdateV2(doc));
  ops.forEach((op, i) => adapter.applyOp(doc, op, ctxOf(`op${i}-`)));
  if (ops.length > 0) {
    // Una edición posterior, en su propio update.
    const state = await source.docRead(id);
    const stored = new Y.Doc();
    for (const piece of [...state.segments, ...state.pending]) Y.applyUpdateV2(stored, piece);
    await source.docAppend(id, generation, Y.encodeStateAsUpdateV2(doc, Y.encodeStateVector(stored)));
    stored.destroy();
  }
  doc.destroy();
  return id;
}

type Rendered = { meta: Record<string, unknown>; png: Uint8Array };

async function render(h: Harness, input: RenderSheetInput, extra?: Partial<RenderSheetWiring>): Promise<Rendered> {
  const out = await runTracked(h.ctx, input, h.wiring(extra));
  expect(out).toBeInstanceOf(ToolContent);
  const [text, image] = out.result.content;
  expect(text?.type).toBe('text');
  expect(image?.type).toBe('image');
  if (text?.type !== 'text' || image?.type !== 'image') throw new Error('salida inesperada');
  expect(image.mimeType).toBe('image/png');
  return { meta: JSON.parse(text.text) as Record<string, unknown>, png: Buffer.from(image.data, 'base64') };
}

/** El código del `ToolError` con que rechaza la llamada, o `null` si no rechaza. */
async function refusal(h: Harness, input: RenderSheetInput, extra?: Partial<RenderSheetWiring>): Promise<string | null> {
  try {
    await runTracked(h.ctx, input, h.wiring(extra));
    return null;
  } catch (error) {
    if (error instanceof ToolError) return error.code;
    throw error;
  }
}

function pngSize(png: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(png);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Glifos pintados en el SVG: cada uno es un `<use>` de su contorno. */
const glyphsIn = (svg: string): number => svg.split('<use ').length - 1;

const MIB = 1024 * 1024;

/** Espacios de nombres de un `content.xml` con una imagen flotante. */
const IMAGE_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.3"';

/**
 * Un `.ods` con la hoja `Datos` (un número en A1) y una imagen flotante que cita
 * `Pictures/foto.png`, guardada con `level` (0, sin comprimir, por defecto).
 */
function bookWithImage(image: Uint8Array, level: 0 | 9 = 0): Uint8Array {
  const content =
    `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${IMAGE_NS}><office:body><office:spreadsheet>` +
    '<table:table table:name="Datos"><table:shapes>' +
    '<draw:frame draw:name="Foto" svg:x="1cm" svg:y="1cm" svg:width="2cm" svg:height="1cm">' +
    '<draw:image xlink:href="Pictures/foto.png" xlink:type="simple"/></draw:frame>' +
    '</table:shapes><table:table-column/><table:table-row>' +
    '<table:table-cell office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell>' +
    '</table:table-row></table:table></office:spreadsheet></office:body></office:document-content>';
  const entries: Zippable = {};
  for (const [path, data] of Object.entries(unzipSync(buildOds(content)))) {
    entries[path] = [data, { level: path === 'mimetype' ? 0 : 9 }];
  }
  entries['Pictures/foto.png'] = [image, { level }];
  return zipSync(entries);
}

const setCell = (row: string, col: string, value: number | string): SheetOp => ({
  type: 'cell.set',
  sheet: 's0',
  row,
  col,
  value,
  replaces: []
});

describe('rango de render', () => {
  it('lee A1, A1:D20, columnas y filas, en cualquier orden', () => {
    expect(parseRenderRange('B2')).toEqual({ from: { row: 1, col: 1 }, to: { row: 1, col: 1 } });
    expect(parseRenderRange('d20:a1')).toEqual({ from: { row: 0, col: 0 }, to: { row: 19, col: 3 } });
    expect(parseRenderRange('$A$1:$B$2')).toEqual({ from: { row: 0, col: 0 }, to: { row: 1, col: 1 } });
    expect(parseRenderRange('A:C')?.to).toEqual({ row: 1_048_575, col: 2 });
    expect(parseRenderRange('2:5')).toEqual({ from: { row: 1, col: 0 }, to: { row: 4, col: 16_383 } });
    for (const bad of ['', 'A', '1', 'A1:B', 'Hoja!A1', 'A0', 'A1:B2:C3', 'XFE1', 'A1048577']) {
      expect(parseRenderRange(bad), bad).toBeNull();
    }
    expect(formatRenderRange(parseRenderRange('c3:a1')!)).toBe('A1:C3');
    expect(formatRenderRange(parseRenderRange('AB7')!)).toBe('AB7');
  });

  it('el tope es de 60 columnas por 200 filas, con las inmovilizadas que se pintan delante', () => {
    expect(renderRangeTooLarge(parseRenderRange('A1:BH200')!)).toBe(false);
    expect(renderRangeTooLarge(parseRenderRange('A1:BI200')!)).toBe(true);
    expect(renderRangeTooLarge(parseRenderRange('A1:BH201')!)).toBe(true);
    expect(renderRangeTooLarge(parseRenderRange('A:A')!)).toBe(true);
    // Diez filas inmovilizadas y el rango empieza después: se pintan delante y cuentan.
    expect(renderRangeTooLarge(parseRenderRange('A20:A209')!, { rows: 10, cols: 0 })).toBe(false);
    expect(renderRangeTooLarge(parseRenderRange('A20:A210')!, { rows: 10, cols: 0 })).toBe(true);
    // Si el rango las incluye, se pintan como parte de él y no cuentan dos veces.
    expect(renderRangeTooLarge(parseRenderRange('A1:A200')!, { rows: 10, cols: 0 })).toBe(false);
  });
});

describe('hebra_render_sheet', () => {
  it('pinta un rango como PNG con los valores de las fórmulas y suelta todo lo que aparta', async () => {
    const h = await harness();
    const id = await addDocument(h, 'cuentas.ods', buildOds());
    const { meta, png } = await render(h, { id, sheet: 'Datos', range: 'A1:C5' });

    expect([...png.subarray(0, 8)]).toEqual(PNG_MAGIC);
    expect(meta).toMatchObject({
      id,
      name: 'cuentas.ods',
      sheet: 'Datos',
      range: 'A1:C5',
      renderer: '@napi-rs/canvas 1.2.0',
      formulas: 'calculated',
      untrustedContent: true
    });
    expect(typeof meta.revision).toBe('string');
    expect(meta.byteLength).toBe(buildOds().byteLength);
    expect(pngSize(png)).toEqual({ width: meta.width, height: meta.height });
    expect(meta.width).toBe(960);
    expect(meta).not.toHaveProperty('missingGlyphs');

    // Dos reservas: la de leer el libro (la de hojas, H-95b) y la del pintado. Las dos se sueltan.
    expect(h.gate.asked).toHaveLength(2);
    expect(h.gate.asked[0]).toBe(renderSheetReadReserveBytes(buildOds().byteLength));
    expect(h.gate.asked[0]).toBe(SHEET_JOB_RESERVE_BYTES);
    expect(h.gate.asked[1]).toBe(renderReserveBytes(0, meta.width as number, meta.height as number));
    expect(h.gate.pending).toBe(0);
    expect(h.engineLog).toEqual({ loads: 1, disposed: 1 });
  });

  it('pinta lo que hay ahora: las ediciones del Y.Doc y el valor recalculado', async () => {
    const h = await harness();
    const plain = await addDocument(h, 'antes.ods', buildOds());
    // A1 pasa de 1 a 1000: cuatro glifos en A1 y el total de B1 (6 a 1005) gana tres.
    const edited = await addDocument(h, 'despues.ods', buildOds(), [setCell('b0', 'b0', 1000)]);
    await render(h, { id: plain, sheet: 'Datos', range: 'A1:C5' });
    await render(h, { id: edited, sheet: 'Datos', range: 'A1:C5' });
    const [before, after] = h.svgs;
    expect(glyphsIn(after!) - glyphsIn(before!)).toBe(3 + 3);
  });

  it('pinta las celdas que rellena una matriz que se derrama, como la rejilla (H-SPILL)', async () => {
    const h = await harness();
    const bytes = buildOds();
    const model = (await prepareSheetBase(bytes)).model;
    const f = createFormulaLocale().toCanon('=SEQUENCE(3)', scopeOf(model, 's0'), { row: 0, col: 3 }, 'en');
    if (isFormulaParseError(f)) throw new Error(f.error);
    const plain = await addDocument(h, 'antes.ods', bytes);
    const spill = await addDocument(h, 'matriz.ods', bytes, [
      { type: 'cell.set', sheet: 's0', row: 'b0', col: 'b3', value: { f }, replaces: [] }
    ]);
    await render(h, { id: plain, sheet: 'Datos', range: 'A1:D5' });
    await render(h, { id: spill, sheet: 'Datos', range: 'A1:D5' });
    // D1 enseña su «1» y D2 y D3, que no tienen nada en el modelo, el «2» y el «3».
    const [before, after] = h.svgs.map(glyphsIn);
    expect(after! - before!).toBe(3);
  });

  it('sin motor las fórmulas salen vacías, y con showFormulas sale su texto', async () => {
    const h = await harness();
    const id = await addDocument(h, 'cuentas.ods', buildOds());
    await render(h, { id, sheet: 'Datos', range: 'A1:C5' });
    // Un motor que no devuelve nada: B1 (=SUM) se queda sin su «6».
    const empty: FormulaEngineWithValues = {
      ...inProcessEngine({ loads: 0, disposed: 0 }),
      readValues: async () => []
    };
    await render(h, { id, sheet: 'Datos', range: 'A1:C5' }, { engine: () => empty });
    const shown = await render(h, { id, sheet: 'Datos', range: 'A1:C5', showFormulas: true });
    expect(shown.meta.formulas).toBe('shown');
    const [calculated, blank, formulas] = h.svgs.map(glyphsIn);
    expect(calculated! - blank!).toBe(1);
    // `=SUM(A1:A3)` son 11 glifos en lugar del «6».
    expect(formulas! - blank!).toBe(11);
  });

  it('rango excesivo da document_too_complex sin leer el documento', async () => {
    const h = await harness();
    const id = await addDocument(h, 'grande.ods', buildOds(bigContent(250, 70)));
    for (const range of ['A1:BI1', 'A1:A201', 'A:A', '1:1']) {
      expect(await refusal(h, { id, sheet: 'Datos', range }), range).toBe('document_too_complex');
    }
    // Ni una reserva: se rechaza antes de abrir nada.
    expect(h.gate.asked).toEqual([]);
    expect(h.engineLog.loads).toBe(0);
  });

  it('las filas inmovilizadas que se pintan delante cuentan en el tope', async () => {
    const h = await harness();
    const id = await addDocument(h, 'panel.ods', buildOds(bigContent(250, 4)), [
      { type: 'sheet.freeze', sheet: 's0', rows: 10, cols: 0 }
    ]);
    expect(await refusal(h, { id, sheet: 'Datos', range: 'A20:A210' })).toBe('document_too_complex');
    expect(h.gate.pending).toBe(0);
    const { meta } = await render(h, { id, sheet: 'Datos', range: 'A20:A209' });
    expect(meta.range).toBe('A20:A209');
  });

  /**
   * El único test de trabajo pesado del fichero, y no por frío: pinta el rango máximo (60 x 200
   * celdas con texto y números) en un PNG de 2 Mpx. Medido el 22 nov 2026 en este Mac con una carga
   * media de 9 en 15 núcleos, ya caliente: entre 1,4 y 1,5 s en total, de los que el PNG de un SVG
   * de 4,1 MB se lleva de 0,84 a 1,1 s, la lista de dibujo de 0,19 a 0,33, el SVG 0,2, el motor de
   * 0,12 a 0,22 y el libro 0,13. Los 5 s por defecto son poco más de tres veces eso, y con la
   * máquina llena (carga de 46) vencieron. El plazo es una guarda contra un cuelgue, no una medida:
   * 30 s, unas veinte veces lo medido. Cuánto tarda es cosa de una pasada de rendimiento aparte.
   */
  const MAX_RANGE_TIMEOUT_MS = 30_000;
  it('el rango máximo sale como PNG de 2 Mpx como mucho aunque se pida el ancho máximo', async () => {
    const h = await harness();
    const id = await addDocument(h, 'grande.ods', buildOds(bigContent(250, 70)));
    const { meta, png } = await render(h, { id, sheet: 'Datos', range: 'A1:BH200', width: 1568 });
    const { width, height } = pngSize(png);
    expect(width * height).toBeLessThanOrEqual(RENDER_SHEET_MAX_PIXELS);
    expect(Math.max(width, height)).toBeLessThanOrEqual(1568);
    expect(meta).toMatchObject({ width, height, range: 'A1:BH200' });
    expect(h.gate.pending).toBe(0);
  }, MAX_RANGE_TIMEOUT_MS);

  it('id oculto da not_found, igual que uno inexistente, uno de la papelera o el de una nota', async () => {
    const h = await harness();
    const visible = await addDocument(h, 'cuentas.ods', buildOds());
    const hidden = await addFile(h, h.folders.privada, 'secreto.ods', buildOds());
    const trashed = await addFile(h, h.folders.hojas, 'viejo.ods', buildOds());
    const noteId = await h.port.writeExclusive(async (store) => (await store.noteCreate(h.folders.hojas)).id);
    await h.port.writeExclusive(async (store) => store.fileTrash(trashed));
    await refreshContext(h);

    for (const id of [hidden, trashed, noteId, 'no-existe']) {
      expect(await refusal(h, { id, sheet: 'Datos', range: 'A1:C5' }), id).toBe('not_found');
    }
    // Nada leído ni apartado para ninguno de ellos; el visible sí pinta.
    expect(h.gate.asked).toEqual([]);
    expect((await render(h, { id: visible, sheet: 'Datos', range: 'A1' })).meta.range).toBe('A1');
  });

  it('un .ods sin cabecera de documento se pinta desde sus bytes', async () => {
    const h = await harness();
    const id = await addFile(h, h.folders.hojas, 'recien.ods', buildOds());
    const { meta } = await render(h, { id, sheet: 'datos', range: 'A1:C5' });
    expect(meta).toMatchObject({ sheet: 'Datos', formulas: 'calculated' });
    // Lee sin escribir: sigue sin cabecera.
    expect((await h.port.documentSource().port.docRead(id)).head).toBeNull();
  });

  it('rango o hoja mal dados: invalid_input; un fichero que no es .ods: document_invalid', async () => {
    const h = await harness();
    const id = await addDocument(h, 'cuentas.ods', buildOds());
    expect(await refusal(h, { id, sheet: 'Datos', range: 'Datos!A1' })).toBe('invalid_input');
    expect(await refusal(h, { id, sheet: 'No existe', range: 'A1' })).toBe('invalid_input');
    expect(await refusal(h, { id, sheet: 'Datos', range: 'A1', width: 200 })).toBe('invalid_input');
    const text = await addFile(h, h.folders.hojas, 'nota.ods', new TextEncoder().encode('no soy un zip'));
    expect(await refusal(h, { id: text, sheet: 'Datos', range: 'A1' })).toBe('document_invalid');
    expect(h.gate.pending).toBe(0);
  });

  it('con la cola de hojas ocupada la lectura espera su hueco: ni reserva ni motor hasta soltarlo (H-95b)', async () => {
    const h = await harness();
    const id = await addDocument(h, 'cuentas.ods', buildOds());
    const release = await sheetJobSlot();
    const pending = render(h, { id, sheet: 'Datos', range: 'A1:C5' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.gate.asked).toEqual([]);
    expect(h.engineLog.loads).toBe(0);
    release();
    await pending;
    expect(h.gate.asked[0]).toBe(SHEET_JOB_RESERVE_BYTES);
    expect(h.gate.pending).toBe(0);
  });

  it('un .ods de más de 4 MiB da file_too_large con el tope de hojas, sin reservar (H-95b)', async () => {
    const h = await harness();
    const entries: Zippable = {};
    for (const [path, data] of Object.entries(unzipSync(buildOds()))) entries[path] = [data, { level: path === 'mimetype' ? 0 : 9 }];
    entries['Pictures/relleno.png'] = [randomBytes(SHEET_DOCUMENT_MAX_BYTES), { level: 0 }];
    const bytes = zipSync(entries);
    const id = await addFile(h, h.folders.hojas, 'grande.ods', bytes);
    const error = await runTracked(h.ctx, { id, sheet: 'Datos', range: 'A1' }, h.wiring()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe('file_too_large');
    expect((error as ToolError).extra).toEqual({ byteLength: bytes.length, maxBytes: SHEET_DOCUMENT_MAX_BYTES });
    expect(h.gate.asked).toEqual([]);
  });

  it('una imagen que pasa del tope de hojas da document_too_complex y suelta lo que aparta (H-TOPES-MCP)', async () => {
    const h = await harness();
    // La misma hoja con la imagen pequeña se pinta: lo que corta es el tamaño de la imagen.
    const small = await addFile(h, h.folders.hojas, 'logo.ods', bookWithImage(new Uint8Array(64 * 1024).fill(7)));
    expect((await render(h, { id: small, sheet: 'Datos', range: 'A1:C5' })).meta.sheet).toBe('Datos');
    // 5 MiB de texto hexadecimal: deflate lo deja en la mitad, así que el `.ods` no llega a los
    // 4 MiB y la razón queda lejos de 200; solo lo para `maxEntryBytes` (4 MiB) en las imágenes.
    // Sin topes, `createEditorData` la leía con los de la app (128 MiB por entrada) y pintaba.
    const image = new TextEncoder().encode(randomBytes(5 * MIB / 2).toString('hex'));
    expect(image.length).toBeGreaterThan(SHEET_ODS_READ_LIMITS.maxEntryBytes);
    const bytes = bookWithImage(image, 9);
    expect(bytes.length).toBeLessThan(SHEET_DOCUMENT_MAX_BYTES);
    const big = await addFile(h, h.folders.hojas, 'foto.ods', bytes);
    expect(await refusal(h, { id: big, sheet: 'Datos', range: 'A1:C5' })).toBe('document_too_complex');
    expect(h.gate.pending).toBe(0);
  });

  it('sin hueco en la compuerta: document_busy, sin motor ni pintado', async () => {
    const h = await harness(true);
    const id = await addDocument(h, 'cuentas.ods', buildOds());
    expect(await refusal(h, { id, sheet: 'Datos', range: 'A1:C5' })).toBe('document_busy');
    expect(h.engineLog.loads).toBe(0);
    expect(h.svgs).toEqual([]);
  });

  it('la lectura con plazo vencido da document_too_complex y cierra el motor', async () => {
    const h = await harness();
    const id = await addDocument(h, 'cuentas.ods', buildOds());
    const log = { loads: 0, disposed: 0 };
    // Un motor que no termina de cargar hasta que lo cortan.
    const stuck: FormulaEngineWithValues = {
      ...inProcessEngine(log),
      load: (_book, _opts, signal) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cortado')), { once: true }))
    };
    expect(await refusal(h, { id, sheet: 'Datos', range: 'A1:C5' }, { engine: () => stuck, readTimeoutMs: 50 })).toBe(
      'document_too_complex'
    );
    expect(log.disposed).toBe(1);
    expect(h.gate.pending).toBe(0);
    expect(h.svgs).toEqual([]);
  });
});
