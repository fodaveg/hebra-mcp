/**
 * `hebra_render_sheet` (H-81, S-04 del estudio MCP de documentos; D28 de SPEC.md): un rango de una
 * hoja de un `.ods` como PNG, pintado en Node sin DOM con las mismas piezas que la rejilla de la
 * app. Está implementada y SIN REGISTRAR (decisión 17): la da de alta H-177, junto con las otras
 * tres herramientas de hojas, en `document-tool-table.ts`.
 *
 * Entrada: `{ id, sheet, range, width?, showFormulas? }`. `range` es `A1`, `A1:D20`, `A:C` o
 * `1:5`; hasta `RENDER_SHEET_MAX_COLUMNS` columnas por `RENDER_SHEET_MAX_ROWS` filas, contando las
 * filas y columnas inmovilizadas que se pintan delante del rango. `width` va de 320 a 1.568 px
 * (960 por defecto). Salida: el bloque de texto de `documentOk` (`untrustedContent: true`) con
 * `{ id, name, revision, byteLength, sheet, range, renderer, width, height }`, y el PNG detrás como
 * bloque `image`.
 *
 * El camino, en este orden:
 *  1. El rango, sin abrir nada: mal escrito, `invalid_input`; más grande que el tope,
 *     `document_too_complex`. No depende del documento, así que no dice nada de él.
 *  2. Privacidad (D28, protección 1): `visibleDocumentOf` sobre el filtro de ficheros de esta
 *     llamada. Oculto, inexistente, lápida, papelera o id de nota dan el mismo `not_found`, antes
 *     de leer un solo byte. La puerta final (`../privacy-gate.ts`) lo vuelve a juzgar con el sello
 *     de la fila (`usageOf`), igual que `hebra_read_file`.
 *  3. Fase de lectura, con su reserva en el `CapacityGate` de la cuenta (`documentReserveBytes`,
 *     la de leer un documento) y el plazo de `DOCUMENT_READ_TIMEOUT_MS`: el estado de ahora
 *     (`openDocumentRead`, que no escribe ni crea punto de control), los datos de pintado de la
 *     rejilla (`createEditorData`), los valores de las fórmulas (el motor de la app, en su hilo) y
 *     la lista de dibujo con su SVG (`layoutDrawList`, `drawToSvg`). Al acabar se cierra todo y se
 *     suelta la reserva: lo único que sigue vivo es el SVG.
 *  4. Pintado: `renderSvgToPng` (B-LR20), que aparta su propia reserva en la misma compuerta, con
 *     su hilo, su plazo y su cola de uno. El ancho se reduce si hace falta para que el PNG no pase
 *     de `RENDER_SHEET_MAX_PIXELS` (2 Mpx, la superficie que fijó el estudio de fidelidad).
 *
 * Un `.ods` sin cabecera de documento (nunca abierto en el editor) se pinta desde sus bytes, con el
 * andamio del adaptador (`scaffold`) como único estado: es lo que vería quien lo abriera ahora.
 *
 * Errores, todos con código cerrado y sin texto del documento: `invalid_input`, `not_found`,
 * `file_too_large`, `file_unavailable` (faltan los bytes), `document_invalid` (no es un `.ods`
 * legible, o la cabecera es de otro formato), `document_too_complex` (rango, plazo, SVG o
 * superficie) y `document_busy` (sin hueco en la compuerta o en la cola del render).
 *
 * Puntos de unión (los cablea H-177): `RenderSheetWiring` lleva la fuente de documentos del
 * contexto (`NodeLibraryPort.documentSource()`), la compuerta de la cuenta y, en producción,
 * `bundledSheetRenderAssets()` (fuentes y motor junto a `dist/cli.mjs`). El esquema de entrada
 * (`renderSheetInputShape`) va aquí y no en `sheet-op-schemas.ts` (H-79), que es de las
 * operaciones de un lote.
 *
 * Sin pintar todavía, porque la lista de dibujo (H-76) no los emite: imágenes flotantes, gráficos,
 * formato condicional y bordes de matriz.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as Y from 'yjs';
import { ContextUnavailableError, type AdmissionTicket, type CapacityGate } from '../../accounts/capacity';
import { FileFilter } from '../../privacy/file-filter';
import { RenderError, RENDER_SVG_MAX_BYTES, renderSvgToPng, type RenderSvgResult } from '../../render/render';
import {
  createEditorData,
  createFontTextMeasurer,
  createFormulaLocale,
  createNodeFormulaEngine,
  createSheetAdapter,
  drawToSvg,
  engineBookOf,
  formulaText,
  layoutDrawList,
  loadFontSet,
  OdsReadError,
  prepareSheetBase,
  readBookLocale,
  readBookSettings,
  snapshotEngine,
  type Axis,
  type CanonFormula,
  type CellValue,
  type ComputedValue,
  type FontSet,
  type FormulaEngineWithValues,
  type FormulaScope,
  type GridAxis,
  type GridRange,
  type SheetModel,
  type SheetModelSheet
} from '../../sheets';
import { documentReserveBytes } from '../../store/document-jobs';
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_QUEUE_WAIT_MS,
  DOCUMENT_READ_TIMEOUT_MS,
  RENDER_SHEET_MAX_COLUMNS,
  RENDER_SHEET_MAX_ROWS,
  RENDER_WIDTH_DEFAULT_PX,
  RENDER_WIDTH_MAX_PX,
  RENDER_WIDTH_MIN_PX
} from '../../store/document-limits';
import { visibleDocumentOf } from '../../store/document-privacy';
import { openDocumentRead, type DocumentReadSource } from '../../store/document-read';
import type { DocumentPort } from '../../store/document-channel';
import { newDocumentHead } from '../../../vendor/hebra/src/lib/documents/sync/lifecycle';
import { documentOk } from '../document-response';
import { usageOf, type ToolContext } from '../context';
import { ToolContent, ToolError } from '../errors';

/** Superficie máxima del PNG: 2 Mpx, unos 7,63 MiB de lienzo RGBA (estudio de fidelidad, R3). */
export const RENDER_SHEET_MAX_PIXELS = 2_000_000;

/** Largo máximo de `range` y de `sheet` en la entrada. */
const RANGE_MAX_CHARS = 32;
const SHEET_MAX_CHARS = 200;

export const renderSheetInputShape = {
  id: z.string().max(200).describe('Id del .ods, de hebra_list_files (vivo, no de la papelera).'),
  sheet: z
    .string()
    .min(1)
    .max(SHEET_MAX_CHARS)
    .describe('Nombre de la hoja (o su sheetId de hebra_read_sheet).'),
  range: z
    .string()
    .min(1)
    .max(RANGE_MAX_CHARS)
    .describe(
      `Rango en A1, sin hoja: A1:D20. Hasta ${RENDER_SHEET_MAX_COLUMNS} columnas por ${RENDER_SHEET_MAX_ROWS} filas.`
    ),
  width: z
    .number()
    .int()
    .min(RENDER_WIDTH_MIN_PX)
    .max(RENDER_WIDTH_MAX_PX)
    .optional()
    .describe(`Ancho del PNG en píxeles, de ${RENDER_WIDTH_MIN_PX} a ${RENDER_WIDTH_MAX_PX}. Por defecto ${RENDER_WIDTH_DEFAULT_PX}.`),
  showFormulas: z
    .boolean()
    .optional()
    .describe('true: las celdas con fórmula enseñan la fórmula (en inglés) en vez del valor.')
};

export type RenderSheetInput = {
  id: string;
  sheet: string;
  range: string;
  width?: number;
  showFormulas?: boolean;
};

/** Lo que la herramienta necesita de fuera. Los tests lo dan con dobles; producción, H-177. */
export interface RenderSheetWiring {
  /** La fuente de documentos del contexto de la llamada (`NodeLibraryPort.documentSource()`). */
  documents: DocumentReadSource;
  /** La compuerta de capacidad de la cuenta y la cuenta, para su turno. */
  capacity: { gate: Pick<CapacityGate, 'admit'>; key: string };
  /** Las fuentes empaquetadas, ya comprobadas (`loadDocumentFonts`). */
  fonts(): Promise<FontSet>;
  /** Un motor de fórmulas nuevo para esta llamada; lo cierra la herramienta. */
  engine(): FormulaEngineWithValues;
  /** El pintado de SVG a PNG; por defecto `renderSvgToPng`. */
  render?: typeof renderSvgToPng;
  /** Plazo de la fase de lectura; por defecto `DOCUMENT_READ_TIMEOUT_MS`. Los tests lo acortan. */
  readTimeoutMs?: number;
  /** Cancela la llamada (el cliente se fue). */
  signal?: AbortSignal;
}

// ---------- rango ----------

/** Rango pedido, base 0 y con los dos extremos incluidos. */
export type RenderRange = GridRange;

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;
const COLS = /^\$?([A-Za-z]{1,3})$/;
const ROWS = /^\$?(\d{1,7})$/;
/** Lo que mide una hoja (IronCalc y xlsx): 1.048.576 filas por 16.384 columnas. */
const SHEET_ROWS = 1_048_576;
const SHEET_COLS = 16_384;

function columnOf(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function lettersOf(index: number): string {
  let out = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

/**
 * `A1`, `A1:D20`, `A:C` o `1:5` a posiciones base 0, con las esquinas en cualquier orden. `null` si
 * no es un rango o se sale de la hoja. No acota el tamaño: eso lo hace `renderRangeTooLarge`.
 */
export function parseRenderRange(text: string): RenderRange | null {
  const parts = text.trim().split(':');
  if (parts.length > 2 || parts.some((p) => p === '')) return null;
  type End = { row: number | null; col: number | null };
  const end = (part: string): End | null => {
    const cell = CELL.exec(part);
    if (cell) return { row: Number(cell[2]) - 1, col: columnOf(cell[1]) };
    const col = COLS.exec(part);
    if (col) return { row: null, col: columnOf(col[1]) };
    const row = ROWS.exec(part);
    return row ? { row: Number(row[1]) - 1, col: null } : null;
  };
  const a = end(parts[0]);
  const b = parts.length === 2 ? end(parts[1]) : a;
  if (!a || !b) return null;
  // Las dos esquinas, del mismo tipo: celda con celda, columna con columna, fila con fila.
  if ((a.row === null) !== (b.row === null) || (a.col === null) !== (b.col === null)) return null;
  if (parts.length === 1 && (a.row === null || a.col === null)) return null;
  const r1 = a.row ?? 0;
  const r2 = b.row ?? SHEET_ROWS - 1;
  const c1 = a.col ?? 0;
  const c2 = b.col ?? SHEET_COLS - 1;
  const from = { row: Math.min(r1, r2), col: Math.min(c1, c2) };
  const to = { row: Math.max(r1, r2), col: Math.max(c1, c2) };
  if (from.row < 0 || from.col < 0 || to.row >= SHEET_ROWS || to.col >= SHEET_COLS) return null;
  return { from, to };
}

/** `A1:D20` de un rango, para la respuesta. */
export function formatRenderRange(range: RenderRange): string {
  const a = `${lettersOf(range.from.col)}${range.from.row + 1}`;
  const b = `${lettersOf(range.to.col)}${range.to.row + 1}`;
  return a === b ? a : `${a}:${b}`;
}

/**
 * ¿Se pasa del tope? Cuentan también las filas y columnas inmovilizadas que la lista de dibujo pinta
 * delante cuando el rango empieza después de ellas (`layoutAxis`).
 */
export function renderRangeTooLarge(range: RenderRange, frozen: { rows: number; cols: number } = { rows: 0, cols: 0 }): boolean {
  const extra = (start: number, count: number) => (count > 0 && start >= count ? count : 0);
  const rows = range.to.row - range.from.row + 1 + extra(range.from.row, frozen.rows);
  const cols = range.to.col - range.from.col + 1 + extra(range.from.col, frozen.cols);
  return rows > RENDER_SHEET_MAX_ROWS || cols > RENDER_SHEET_MAX_COLUMNS;
}

/**
 * Ancho que se le pide a `renderSvgToPng` para que el PNG no pase de 2 Mpx. Ese servicio ya acota
 * el lado largo a 1.568; aquí solo se baja el ancho cuando las dos medidas son grandes. Nunca baja
 * de 320 (su mínimo): por debajo de ese ancho manda el lado largo y la superficie queda muy lejos
 * del tope.
 */
export function fitRenderWidth(width: number, canvas: { width: number; height: number }): number {
  const fit = Math.floor(Math.sqrt(RENDER_SHEET_MAX_PIXELS * (canvas.width / canvas.height)));
  return Math.max(RENDER_WIDTH_MIN_PX, Math.min(width, fit));
}

// ---------- fuentes y motor en producción ----------

const fontSets = new Map<string, Promise<FontSet>>();

/**
 * Las fuentes de documentos de `dir`, comprobadas contra su manifiesto (`loadFontSet`) y guardadas
 * para todo el proceso: son las mismas en cada llamada. Un fallo no se guarda.
 */
export function loadDocumentFonts(dir: URL): Promise<FontSet> {
  const key = dir.href;
  let hit = fontSets.get(key);
  if (!hit) {
    hit = loadFontSet((file) => readFile(fileURLToPath(new URL(file, dir))));
    fontSets.set(key, hit);
    hit.catch(() => fontSets.delete(key));
  }
  return hit;
}

/**
 * Fuentes y motor tal como quedan junto al binario (`dist/cli.mjs`): `dist/fonts/documents/`
 * (B-LR11) y `dist/sheet-engine-worker.mjs` (H-173). Solo vale desde `dist/`: desde las fuentes, la
 * URL de este módulo no tiene esos ficheros al lado, y los tests pasan los suyos.
 */
export function bundledSheetRenderAssets(): Pick<RenderSheetWiring, 'fonts' | 'engine'> {
  const fontsDir = new URL('./fonts/documents/', import.meta.url);
  const workerUrl = new URL('./sheet-engine-worker.mjs', import.meta.url);
  return {
    fonts: () => loadDocumentFonts(fontsDir),
    engine: () => createNodeFormulaEngine({ workerUrl })
  };
}

// ---------- lectura ----------

/** Cuánto aparta la fase de lectura en la compuerta: lo de leer un documento de ese tamaño. */
export function renderSheetReadReserveBytes(documentBytes: number): number {
  return documentReserveBytes(documentBytes);
}

function sheetOf(model: SheetModel, wanted: string): SheetModelSheet | null {
  const exact = model.sheets.find((s) => s.name === wanted);
  if (exact) return exact;
  const lower = wanted.toLowerCase();
  return model.sheets.find((s) => s.name.toLowerCase() === lower) ?? model.sheets.find((s) => s.id === wanted) ?? null;
}

/** El ámbito de una fórmula para escribir su texto, con los nombres visibles de las hojas. */
function scopeOf(model: SheetModel, sheet: string): FormulaScope {
  return {
    sheet,
    axes: (id) => {
      const s = model.sheets.find((x) => x.id === id);
      return s ? { rows: s.rows, cols: s.cols } : null;
    },
    sheetIdByName: (name) => model.sheets.find((x) => x.name.toLowerCase() === name.toLowerCase())?.id ?? null,
    sheetNameById: (id) => model.sheets.find((x) => x.id === id)?.name ?? null
  };
}

/**
 * `layoutDrawList` pide el `Axis` de H-33, una clase con campos privados, y solo usa `count`,
 * `offsetOf` y `visibleSize`, que el eje de la rejilla (`GridAxis`, sin memoria por fila) tiene
 * igual. Construir un `Axis` de 1.048.576 filas costaría unos 8 MiB por eje; este paso evita esa
 * copia. Pendiente en Hebra: que `DrawListInput.axes` pida solo esos tres miembros.
 */
function asDrawAxis(axis: GridAxis): Axis {
  const view = { count: axis.count, offsetOf: axis.offsetOf, visibleSize: axis.visibleSize };
  return view as unknown as Axis;
}

const isFormula = (value: CellValue | undefined): value is { f: CanonFormula } =>
  typeof value === 'object' && value !== null && 'f' in value;

/** Columnas que se leen del motor a cada lado del rango: las que puede recorrer un desborde. */
const SPILL_COLUMNS = 256;

/**
 * Los valores de las fórmulas del rango, y de las columnas vecinas cuyo texto puede desbordar
 * hacia dentro, calculados por el motor de la app con los ajustes del libro. Sin motor que admita
 * la lengua del libro, `null`: esas celdas salen vacías y la respuesta lo dice.
 */
async function formulaValues(
  model: SheetModel,
  sheetIndex: number,
  range: RenderRange,
  base: Uint8Array,
  engine: () => FormulaEngineWithValues,
  signal: AbortSignal
): Promise<Map<string, ComputedValue> | null> {
  const settings = await readBookSettings(base);
  if (!settings) return null;
  const book = engineBookOf(snapshotEngine(model, settings));
  const motor = engine();
  try {
    await motor.load(book, { locale: book.locale, timezone: book.timezone }, signal);
    const wide: GridRange = {
      from: { row: range.from.row, col: Math.max(0, range.from.col - SPILL_COLUMNS) },
      to: { row: range.to.row, col: Math.min(SHEET_COLS - 1, range.to.col + SPILL_COLUMNS) }
    };
    const out = new Map<string, ComputedValue>();
    for (const cell of await motor.readValues(sheetIndex, wide)) out.set(`${cell.row}:${cell.col}`, cell.value);
    return out;
  } finally {
    motor.dispose();
  }
}

/** Lo que sale de la fase de lectura: el SVG y lo que lleva la respuesta. */
type ReadPhase = {
  svg: Uint8Array;
  canvas: { width: number; height: number };
  name: string;
  revision: string;
  byteLength: number;
  sheetName: string;
  range: RenderRange;
  missingGlyphs: number;
  formulas: 'calculated' | 'shown' | 'not_calculated';
};

/** Una `DocumentReadSource` que sirve unos bytes y un estado ya leídos, sin volver al almacén. */
function pinnedSource(
  stored: Awaited<ReturnType<DocumentPort['docRead']>>,
  sha256: string,
  bytes: Uint8Array
): DocumentReadSource {
  const port = {
    docRead: async () => stored,
    blobRead: async (wanted: string) => (wanted === sha256 ? bytes : null)
  };
  // `openDocumentRead` solo llama a `docRead` y `blobRead` (los demás métodos son de escritura).
  return { port: port as unknown as DocumentPort };
}

async function blobOf(source: DocumentReadSource, sha256: string): Promise<Uint8Array | null> {
  const local = await source.port.blobRead(sha256).catch(() => null);
  return local ?? (await source.readBlob?.(sha256).catch(() => null)) ?? null;
}

async function readPhase(
  file: { id: string; name: string; sha256: string; byteLength: number | null },
  input: RenderSheetInput,
  range: RenderRange,
  wiring: RenderSheetWiring,
  signal: AbortSignal
): Promise<ReadPhase> {
  const source = wiring.documents;
  const stored = await source.port.docRead(file.id);
  const head = stored.head ?? newDocumentHead('ods', 'file', file.sha256);
  if (head.format !== 'ods') throw new ToolError('document_invalid');
  const baseSha = head.checkpointSha256 ?? head.baseSha256;
  const base = await blobOf(source, baseSha);
  if (!base) throw new ToolError('file_unavailable');
  if (base.byteLength > DOCUMENT_MAX_BYTES) {
    throw new ToolError('file_too_large', { byteLength: base.byteLength, maxBytes: DOCUMENT_MAX_BYTES });
  }
  signal.throwIfAborted();

  let sheetBase;
  try {
    sheetBase = await prepareSheetBase(base);
  } catch (error) {
    if (error instanceof OdsReadError) {
      throw new ToolError(error.code === 'too_large' ? 'document_too_complex' : 'document_invalid');
    }
    throw error;
  }
  const adapter = createSheetAdapter(sheetBase);

  // Sin cabecera, el estado es el andamio del fichero: lo que escribe quien lo abre por primera vez.
  let state = stored;
  if (!stored.head) {
    const scaffold = new Y.Doc();
    try {
      adapter.scaffold(base, scaffold);
      state = { head, segments: [Y.encodeStateAsUpdateV2(scaffold)], pending: [], pendingSeqs: [] };
    } finally {
      scaffold.destroy();
    }
  }
  const read = await openDocumentRead(pinnedSource(state, baseSha, base), file.id, adapter, signal);
  let data: Awaited<ReturnType<typeof createEditorData>> | null = null;
  try {
    const model = read.model;
    const sheet = sheetOf(model, input.sheet);
    if (!sheet) throw new ToolError('invalid_input');
    if (renderRangeTooLarge(range, { rows: sheet.frozenRows, cols: sheet.frozenCols })) {
      throw new ToolError('document_too_complex');
    }
    if (range.from.row >= sheet.rows.length() || range.from.col >= sheet.cols.length()) {
      throw new ToolError('invalid_input');
    }
    data = await createEditorData({ doc: read.doc, base });
    signal.throwIfAborted();
    const view = data.forSheet(sheet.id);
    const sheetIndex = model.sheets.indexOf(sheet);

    let computed: ((row: number, col: number) => ComputedValue | undefined) | undefined;
    let formulas: ReadPhase['formulas'];
    if (input.showFormulas) {
      const locale = createFormulaLocale();
      const scope = scopeOf(model, sheet.id);
      computed = (row, col) => {
        const value = sheet.cells.get(`${sheet.rows.idAt(row)}:${sheet.cols.idAt(col)}`);
        return isFormula(value) ? `=${formulaText(value.f, scope, locale)}` : undefined;
      };
      formulas = 'shown';
    } else {
      const values = await formulaValues(model, sheetIndex, range, base, wiring.engine, signal);
      computed = values ? (row, col) => values.get(`${row}:${col}`) : undefined;
      formulas = values ? 'calculated' : 'not_calculated';
    }
    signal.throwIfAborted();

    const fonts = await wiring.fonts();
    const layout = await layoutDrawList({
      sheet,
      axes: { rows: asDrawAxis(view.rowsAxis()), cols: asDrawAxis(view.colsAxis()) },
      range,
      styleAt: view.styleAt,
      computed,
      // La etiqueta de idioma del libro, como la rejilla (`bookLocale` de `OdsEditorHost`).
      locale: (await readBookLocale(base)) ?? undefined,
      measurer: createFontTextMeasurer(fonts),
      maxCells: RENDER_SHEET_MAX_ROWS * RENDER_SHEET_MAX_COLUMNS
    });
    // Todo oculto, o el rango cae entero fuera de lo que mide la hoja: no hay nada que pintar.
    if (layout.width <= 0 || layout.height <= 0) throw new ToolError('invalid_input');
    signal.throwIfAborted();
    const drawn = await drawToSvg({ ops: layout.ops, width: layout.width, height: layout.height, fonts });
    const svg = new TextEncoder().encode(drawn.svg);
    if (svg.byteLength > RENDER_SVG_MAX_BYTES) throw new ToolError('document_too_complex');
    return {
      svg,
      canvas: { width: layout.width, height: layout.height },
      name: file.name,
      revision: read.revision,
      byteLength: file.byteLength ?? base.byteLength,
      sheetName: sheet.name,
      range,
      missingGlyphs: drawn.missingGlyphs,
      formulas
    };
  } finally {
    data?.dispose();
    await read.close();
  }
}

/** Aparta la reserva de la fase de lectura. Sin hueco a tiempo, `document_busy`. */
async function admitRead(wiring: RenderSheetWiring, bytes: number, signal: AbortSignal): Promise<AdmissionTicket> {
  try {
    return await wiring.capacity.gate.admit(signal, renderSheetReadReserveBytes(bytes), wiring.capacity.key);
  } catch (error) {
    if (error instanceof ContextUnavailableError) {
      throw new ToolError('document_busy', { retryAfterSeconds: Math.max(1, Math.ceil(DOCUMENT_QUEUE_WAIT_MS / 1000)) });
    }
    throw error;
  }
}

function renderFailure(error: RenderError): ToolError {
  return error.code === 'document_busy'
    ? new ToolError('document_busy', { retryAfterSeconds: Math.max(1, Math.ceil(DOCUMENT_QUEUE_WAIT_MS / 1000)) })
    : new ToolError(error.code);
}

/** `hebra_render_sheet`: un rango de una hoja como PNG (ver la cabecera). */
export async function runRenderSheet(
  ctx: ToolContext,
  input: RenderSheetInput,
  wiring: RenderSheetWiring
): Promise<ToolContent> {
  const width = input.width ?? RENDER_WIDTH_DEFAULT_PX;
  if (!Number.isInteger(width) || width < RENDER_WIDTH_MIN_PX || width > RENDER_WIDTH_MAX_PX) {
    throw new ToolError('invalid_input');
  }
  if (typeof input.range !== 'string' || input.range.length > RANGE_MAX_CHARS) throw new ToolError('invalid_input');
  if (typeof input.sheet !== 'string' || input.sheet === '' || input.sheet.length > SHEET_MAX_CHARS) {
    throw new ToolError('invalid_input');
  }
  const range = parseRenderRange(input.range);
  if (!range) throw new ToolError('invalid_input');
  if (renderRangeTooLarge(range)) throw new ToolError('document_too_complex');

  const filter = await FileFilter.build(ctx.port, ctx.privacy, ctx.privacyConfig);
  let doc: { id: string; sha256: string; name: string };
  try {
    doc = visibleDocumentOf(filter, input.id);
  } catch {
    throw new ToolError('not_found');
  }
  const content = filter.contentOf(input.id)!;
  const used = usageOf(ctx);
  used.file(input.id, filter.sealOf(input.id));
  used.folder(content.file.folderId, ctx.privacy.folderPath(content.file.folderId));
  const knownLength = content.file.byteLength;
  if (knownLength !== null && knownLength > DOCUMENT_MAX_BYTES) {
    throw new ToolError('file_too_large', { byteLength: knownLength, maxBytes: DOCUMENT_MAX_BYTES });
  }

  // Fase de lectura, con su plazo y su reserva.
  const outer = wiring.signal ?? new AbortController().signal;
  const deadline = new AbortController();
  const onOuter = () => deadline.abort(outer.reason);
  outer.addEventListener('abort', onOuter, { once: true });
  const timer = setTimeout(() => deadline.abort(new ToolError('document_too_complex')), wiring.readTimeoutMs ?? DOCUMENT_READ_TIMEOUT_MS);
  let read: ReadPhase;
  try {
    outer.throwIfAborted();
    const ticket = await admitRead(wiring, knownLength ?? DOCUMENT_MAX_BYTES, deadline.signal);
    try {
      read = await readPhase(
        { id: doc.id, name: doc.name, sha256: doc.sha256, byteLength: knownLength },
        input,
        range,
        wiring,
        deadline.signal
      );
    } finally {
      ticket.done();
    }
  } catch (error) {
    // El plazo vence como un aborto con su propio motivo; el motor lo da como `EngineError`.
    if (deadline.signal.aborted && !outer.aborted) throw new ToolError('document_too_complex');
    throw error;
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', onOuter);
  }

  // Pintado, con la reserva y el plazo del servicio común.
  let png: RenderSvgResult;
  try {
    png = await (wiring.render ?? renderSvgToPng)({
      svg: read.svg,
      images: [],
      widthPx: fitRenderWidth(width, read.canvas),
      signal: outer,
      gate: wiring.capacity.gate,
      key: wiring.capacity.key
    });
  } catch (error) {
    if (error instanceof RenderError) throw renderFailure(error);
    throw error;
  }
  if (png.width * png.height > RENDER_SHEET_MAX_PIXELS) throw new ToolError('document_too_complex');

  const payload: Record<string, unknown> = {
    sheet: read.sheetName,
    range: formatRenderRange(read.range),
    renderer: png.renderer,
    width: png.width,
    height: png.height,
    formulas: read.formulas
  };
  if (read.missingGlyphs > 0) payload.missingGlyphs = read.missingGlyphs;
  const head: CallToolResult = documentOk(
    { id: input.id, name: read.name, revision: read.revision, byteLength: read.byteLength },
    payload
  );
  if (head.isError) throw new ToolError('too_large');
  return new ToolContent({
    content: [...head.content, { type: 'image', data: Buffer.from(png.png).toString('base64'), mimeType: 'image/png' }]
  });
}
