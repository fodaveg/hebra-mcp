/**
 * Bloques opcionales de hojas en el MCP (H-171): imágenes flotantes (IMG), tablas estructuradas
 * (TAB), gráficos (CHT), matrices dinámicas (ARR) y tablas dinámicas (PIV). Aquí solo se cablea:
 * cada pieza es la función del propio bloque en `vendor/hebra/src/lib/sheets/opt/<bloque>/`, la
 * misma que usa la interfaz. Los esquemas de los comandos están en `./sheet-op-schemas.ts`.
 *
 * Dos usos:
 * - Leer (`hebra_read_sheet`, `./read-sheet-job.ts`): las tablas, las imágenes, los gráficos (con
 *   sus datos y su fiabilidad, `describeCharts`), los desbordes de una hoja (`describeSpills`) y
 *   las tablas dinámicas (`describePivotsForLlm`, con los avisos de `unreliableRanges`).
 * - Compilar (`hebra_edit_sheet`, `./edit-sheet.ts`): los comandos de cada bloque a sus
 *   operaciones, contra el libro de ese momento del lote (`compileImageCommands`,
 *   `compileTableCommand`, `compileChartCommands`, `expandClearSpillBlockers`,
 *   `compilePivotCommands` con `refreshPivot` para pintar las salidas).
 *
 * Lo que el fichero base trae (tablas de `table:database-range` y gráficos de `Object N/`) se lee
 * una vez por base (`baseObjectsOf`), con los topes de lectura de hojas, como lo hará el adaptador
 * de la app (registros de TAB y CHT, H-170). Lo que el documento cambió encima sale de sus mapas
 * (`readTables`, `readCharts`, `readImageOverlay`).
 *
 * Imágenes del lote: un `ref` de `insertImage` o `replaceImage` es una de `assets`. La privacidad
 * la deciden la herramienta (con el filtro de la llamada) y las fases 1 y 3 del escritor
 * (`guardAsset`): un asset oculto da `not_found`, igual que uno que no existe. Aquí solo se buscan
 * los bytes (`resolveLotAsset`), y lo que no está tampoco se distingue: `missing`.
 */
import { createHash } from 'node:crypto';
import type * as Y from 'yjs';
import type { RowId, SheetId } from '../../../vendor/hebra/src/lib/sheets/contracts/model';
import type { ValueReader } from '../../../vendor/hebra/src/lib/sheets/grid/sort-filter';
import { columnLetters } from '../../../vendor/hebra/src/lib/sheets/formula/canon';
import { readOdsParts } from '../../../vendor/hebra/src/lib/sheets/ods/package-read';
import { decodeXml } from '../../../vendor/hebra/src/lib/office-import/xml/decode';
import type { OdsReadLimits } from '../../../vendor/hebra/src/lib/sheets/contracts/limits';
import { compileImageCommands, type ImageAssetLookup, type ImageCommand } from '../../../vendor/hebra/src/lib/sheets/opt/img/llm';
import { readImageOverlay, resolveImageStates, type ImageState } from '../../../vendor/hebra/src/lib/sheets/opt/img/ops';
import type { PreparedImage } from '../../../vendor/hebra/src/lib/sheets/opt/img/insert';
import { compileTableCommand, type TableCommand } from '../../../vendor/hebra/src/lib/sheets/opt/tab/llm';
import {
  isTableInvalid,
  readTables,
  resolveTables,
  tableColumns,
  type ResolvedTable,
  type TabOp,
  type TableRecord
} from '../../../vendor/hebra/src/lib/sheets/opt/tab/model';
import { readTablesFromOds } from '../../../vendor/hebra/src/lib/sheets/opt/tab/persist';
import { readChartFrames } from '../../../vendor/hebra/src/lib/sheets/opt/cht/frame';
import { childNamed, findAll, parseTree } from '../../../vendor/hebra/src/lib/sheets/opt/cht/xml-tree';
import { readChartModel } from '../../../vendor/hebra/src/lib/sheets/opt/cht/read-model';
import { gridFromModel, rangeFromRef, type ChartGrid, type ChartModel, type ChartOp } from '../../../vendor/hebra/src/lib/sheets/opt/cht/model';
import { readCharts } from '../../../vendor/hebra/src/lib/sheets/opt/cht/concur';
import { ChartCommandError, compileChartCommands, type ChartCommand } from '../../../vendor/hebra/src/lib/sheets/opt/cht/llm-write';
import { describeCharts, type LlmChart, type LlmChartData } from '../../../vendor/hebra/src/lib/sheets/opt/cht/llm-read';
import type { ChartCell } from '../../../vendor/hebra/src/lib/sheets/charts/read-chart';
import type { ChartRange } from '../../../vendor/hebra/src/lib/sheets/charts/refs';
import { hasSpillSource, projectSpills } from '../../../vendor/hebra/src/lib/sheets/opt/arr/engine';
import { describeSpills, type SpillDescription } from '../../../vendor/hebra/src/lib/sheets/opt/arr/llm';
import type { ImageOp } from '../../../vendor/hebra/src/lib/sheets/opt/img/ops';
import type { GridRange } from '../../../vendor/hebra/src/lib/sheets/contracts/model';
import { parseA1 } from '../../../vendor/hebra/src/lib/sheets/grid/validation';
import { createCellVersionIndex } from '../../../vendor/hebra/src/lib/sheets/ops/cell-versions';
import { readPivotTablesXml } from '../../../vendor/hebra/src/lib/sheets/opt/piv/read';
import { readPivotBook, type PivotSheetOp } from '../../../vendor/hebra/src/lib/sheets/opt/piv/concur';
import { compilePivotCommands, type PivotCommand } from '../../../vendor/hebra/src/lib/sheets/opt/piv/llm-write';
import { describePivotsForLlm, unreliableRanges, a1Range, type PivotLlmView } from '../../../vendor/hebra/src/lib/sheets/opt/piv/llm-read';
import { refreshPivot } from '../../../vendor/hebra/src/lib/sheets/opt/piv/refresh';
import type { PivotBook, PivotTable } from '../../../vendor/hebra/src/lib/sheets/opt/piv/model';
import type { PivotCell, PivotSourceData } from '../../../vendor/hebra/src/lib/sheets/opt/piv/cache';
import { readHeaders } from '../../../vendor/hebra/src/lib/sheets-ui/opt/piv/piv-ui';
import {
  createEditorData,
  type CellValue,
  type EngineCell,
  type FormulaEngine,
  type SheetBase,
  type SheetModel,
  type SheetModelSheet,
  type SheetOp
} from '../../sheets';
import type { DocumentAsset, DocumentError } from '../../store/document-types';
import { SHEET_ODS_READ_LIMITS } from '../../store/sheet-limits';

/** Lo que el fichero base trae de los bloques, con los ids de la proyección de la base (`b<n>`). */
export interface BaseObjects {
  tables: readonly TableRecord[];
  /** Gráficos del fichero que se saben dibujar, por id (`base-object-1`). */
  charts: ReadonlyMap<string, ChartModel>;
  /**
   * Por hoja, la posición (base 0, entre todos los `draw:frame` de la hoja, como `frame` de las
   * imágenes del editor) de los marcos que son un objeto incrustado. Un gráfico de LibreOffice
   * lleva en su marco la imagen de reemplazo (`ObjectReplacements/Object N`), y los datos del
   * editor la dan como una imagen más: no lo es, y un `deleteImage` sobre ella tocaría el marco del
   * gráfico al guardar.
   */
  objectFrames: ReadonlyMap<SheetId, ReadonlySet<number>>;
  /** Tablas dinámicas del fichero (`table:data-pilot-tables`), la base de `readPivotBook`. */
  pivots: PivotBook;
}

/** Las posiciones de los marcos de objeto incrustado de cada hoja (ver `BaseObjects.objectFrames`). */
function readObjectFrames(text: string, base: SheetModel): Map<SheetId, Set<number>> {
  const out = new Map<SheetId, Set<number>>();
  const tables = parseTree(text).children.flatMap((node) => findAll(node, 'table:table')).filter((t) => t.parent?.name === 'office:spreadsheet');
  tables.forEach((table, index) => {
    const sheet = base.sheets[index];
    if (!sheet) return;
    const frames = new Set<number>();
    findAll(table, 'draw:frame').forEach((frame, ordinal) => {
      if (childNamed(frame, 'draw:object') || childNamed(frame, 'draw:object-ole')) frames.add(ordinal);
    });
    if (frames.size > 0) out.set(sheet.id, frames);
  });
  return out;
}

const OBJECT_CONTENT = /^Object \d+\/content\.xml$/;
const baseObjectsCache = new WeakMap<Uint8Array, Promise<BaseObjects>>();

async function readBaseObjects(sheetBase: SheetBase, limits: Readonly<OdsReadLimits>): Promise<BaseObjects> {
  const entries = await readOdsParts(sheetBase.bytes, limits, (path) => path === 'content.xml' || OBJECT_CONTENT.test(path));
  const content = entries.find((entry) => entry.path === 'content.xml');
  if (!content) return { tables: [], charts: new Map(), objectFrames: new Map(), pivots: { tables: {} } };
  const text = decodeXml(content.bytes);
  const base = sheetBase.model;
  const tables = text.includes('<table:database-range')
    ? readTablesFromOds(content.bytes, base.sheets, (sheet, row) => sheetBase.hidden.kindAt(sheet, 'row', row) === 'filter')
    : [];
  const charts = new Map<string, ChartModel>();
  const objectFrames = text.includes('<draw:object') ? readObjectFrames(text, base) : new Map<SheetId, Set<number>>();
  if (text.includes('<draw:object')) {
    const grid = gridFromModel(base);
    for (const frame of readChartFrames(text)) {
      const object = entries.find((entry) => entry.path === `${frame.object}/content.xml`);
      const sheet = grid.sheetId(frame.sheet);
      if (!object || sheet === null) continue;
      const cell = frame.cell ? { row: `b${frame.cell.row}`, col: `b${frame.cell.col}` } : null;
      const { model } = readChartModel(
        decodeXml(object.bytes),
        { object: frame.object, sheet, position: { cell, x: frame.x, y: frame.y }, size: { w: frame.w, h: frame.h } },
        grid
      );
      // Un tipo que no se dibuja no tiene modelo: se conserva en el fichero y no se edita.
      if (model) charts.set(model.id, model);
    }
  }
  // Una tabla dinámica que no se lee no está en el libro: el escritor la devuelve tal cual (PIV 3.1).
  const pivots = text.includes('<table:data-pilot-table') ? readPivotTablesXml(text).book : { tables: {} };
  return { tables, charts, objectFrames, pivots };
}

/**
 * Tablas y gráficos del fichero base, leídos una vez por bytes (con los topes de lectura de hojas,
 * `SHEET_ODS_READ_LIMITS`). Un fallo de lectura no queda guardado.
 */
export function baseObjectsOf(sheetBase: SheetBase, limits: Readonly<OdsReadLimits> = SHEET_ODS_READ_LIMITS): Promise<BaseObjects> {
  let hit = baseObjectsCache.get(sheetBase.bytes);
  if (!hit) {
    hit = readBaseObjects(sheetBase, limits);
    baseObjectsCache.set(sheetBase.bytes, hit);
    hit.catch(() => baseObjectsCache.delete(sheetBase.bytes));
  }
  return hit;
}

/** Los ejes vivos de cada hoja del modelo, para resolver ids a posiciones. */
const axesOf = (model: SheetModel) => (sheet: SheetId) => {
  const found = model.sheets.find((s) => s.id === sheet);
  return found ? { rows: found.rows, cols: found.cols } : null;
};

/** Las tablas visibles ahora: las del fichero con lo que el documento cambió, y las creadas. */
export function liveTables(doc: Y.Doc, base: BaseObjects, model: SheetModel): ResolvedTable[] {
  return resolveTables(readTables(doc, base.tables), axesOf(model)).tables;
}

/** Los gráficos vigentes: los del fichero con los cambios del documento, y los creados. */
export function liveCharts(doc: Y.Doc, base: BaseObjects): ChartModel[] {
  return readCharts(doc, base.charts);
}

/**
 * Las imágenes de cada hoja, en orden de apilado, con lo propio del documento encima: las del
 * fichero salen de los datos del editor (`createEditorData`, el mismo que pinta la rejilla). Sin
 * la imagen de reemplazo de un objeto incrustado (`BaseObjects.objectFrames`): no se lista ni la
 * puede citar un comando de imagen.
 */
export async function liveImages(doc: Y.Doc, bytes: Uint8Array, model: SheetModel, base: BaseObjects): Promise<Map<SheetId, ImageState[]>> {
  const data = await createEditorData({ doc, base: bytes, limits: SHEET_ODS_READ_LIMITS });
  try {
    const out = new Map<SheetId, ImageState[]>();
    for (const sheet of model.sheets) {
      const objects = base.objectFrames.get(sheet.id);
      const images = resolveImageStates({
        fileImages: data.images(sheet.id),
        overlay: readImageOverlay(doc, sheet.id),
        rows: sheet.rows,
        cols: sheet.cols
      });
      out.set(sheet.id, objects ? images.filter((image) => image.frame === undefined || !objects.has(image.frame)) : images);
    }
    return out;
  } finally {
    data.dispose();
  }
}

/** `A1` de una posición base 0. */
const cellA1 = (row: number, col: number): string => `${columnLetters(col)}${row + 1}`;

/** El valor de una celda del motor como valor de celda (un error, `{ err }`). */
export function engineValueOf(cell: EngineCell): CellValue {
  if (cell.kind === 'empty') return null;
  if (cell.kind === 'error') return { err: cell.shown };
  return cell.value ?? cell.shown;
}

const isFormula = (value: CellValue | undefined): boolean => typeof value === 'object' && value !== null && 'f' in value;

// --- Lectura --------------------------------------------------------------------------------------

/** Una tabla para el LLM: por nombre, con su rango y sus columnas. */
export interface TableDescription {
  name: string;
  /** `A1:D10`, cabecera y totales incluidos. */
  range: string;
  header: boolean;
  totals: boolean;
  columns: string[];
  style: string | null;
  /** Columnas con condición de filtro, por nombre. */
  filteredColumns: string[];
  sortedBy: { column: string; order: 'asc' | 'desc' } | null;
}

/** Una imagen para el LLM: su id (el que citan los comandos), su celda y su tamaño en px. */
export interface ImageDescription {
  id: string;
  cell: string;
  dx: number;
  dy: number;
  width: number;
  height: number;
  alt: string;
}

/** Lo que `hebra_read_sheet` da de los bloques de una hoja (`include: ["objects"]`). */
export interface SheetObjects {
  tables: TableDescription[];
  images: ImageDescription[];
  /** Con sus datos de ahora; `reliable: false` (con el motivo) si no están recalculados. */
  charts: LlmChart[];
  /** Desbordes de las fórmulas de matriz, si el motor los sabe decir. */
  spills?: SpillDescription[];
  /** Tablas dinámicas que pintan en la hoja, con su fiabilidad (`describePivotsForLlm`). */
  pivots: PivotLlmView[];
}

/** Puntos por serie y por categorías en la lectura: la respuesta entera no pasa de 30.000 caracteres. */
export const READ_CHART_POINTS_MAX = 100;

export function describeTable(table: ResolvedTable, sheet: SheetModelSheet): TableDescription {
  const columns = tableColumns(table, sheet);
  const nameOf = (col: string) => columns.find((c) => c.id === col)?.name ?? col;
  const { from, to } = table.range;
  return {
    name: table.body.name,
    range: `${cellA1(from.row, from.col)}:${cellA1(to.row, to.col)}`,
    header: table.body.header,
    totals: table.body.totals,
    columns: columns.map((c) => c.name),
    style: table.body.bands?.style ?? null,
    filteredColumns: (table.body.filter?.columns ?? []).map((c) => nameOf(c.col)),
    sortedBy: table.body.sort ? { column: nameOf(table.body.sort.col), order: table.body.sort.order } : null
  };
}

export function describeImage(image: ImageState): ImageDescription {
  return {
    id: image.id,
    cell: cellA1(image.anchor.row, image.anchor.col),
    dx: image.anchor.dx,
    dy: image.anchor.dy,
    width: image.w,
    height: image.h,
    alt: image.alt
  };
}

/**
 * Fuente de datos de los gráficos sobre el libro proyectado: las celdas propias del modelo y, para
 * las fórmulas y lo que derraman, los valores del motor ya leídos (`computed`, por hoja y
 * `fila:columna`). Una fórmula sin valor del motor sale como `{ f }`: `describeCharts` la marca
 * como no recalculada y la serie como no fiable. Nunca un valor inventado.
 */
export function chartDataOf(model: SheetModel, computed: ReadonlyMap<SheetId, ReadonlyMap<string, CellValue>> | null): LlmChartData {
  const byName = new Map(model.sheets.map((s) => [s.name.toLowerCase(), s]));
  return {
    hasSheet: (name) => byName.has(name.toLowerCase()),
    *cells(name: string, range: ChartRange): Iterable<ChartCell> {
      const sheet = byName.get(name.toLowerCase());
      if (!sheet) return;
      const values = computed?.get(sheet.id);
      const own = new Set<string>();
      for (const [key, value] of sheet.cells) {
        const colon = key.indexOf(':');
        const row = sheet.rows.indexOf(key.slice(0, colon));
        const col = sheet.cols.indexOf(key.slice(colon + 1));
        if (row === null || col === null) continue;
        if (row < range.startRow || row > range.endRow || col < range.startCol || col > range.endCol) continue;
        own.add(`${row}:${col}`);
        if (isFormula(value)) {
          const shown = values?.get(`${row}:${col}`);
          yield { row, col, value: shown === undefined ? value : shown };
        } else yield { row, col, value };
      }
      // Lo que derrama una matriz: sin contenido propio, con valor en el motor.
      for (const [at, value] of values ?? []) {
        if (own.has(at) || value === null) continue;
        const [row, col] = at.split(':').map(Number) as [number, number];
        if (row < range.startRow || row > range.endRow || col < range.startCol || col > range.endCol) continue;
        yield { row, col, value };
      }
    },
    // Un valor del motor está recalculado; lo que no lo tiene ya sale como `{ f }`.
    isStale: () => false
  };
}

/**
 * Los valores del motor de los rangos que citan los gráficos, por hoja y `fila:columna`, o `null`
 * sin motor o si falla. Solo se leen las hojas con alguna fórmula.
 */
export async function chartValues(
  charts: readonly ChartModel[],
  grid: ChartGrid,
  model: SheetModel,
  engine: FormulaEngine | null
): Promise<Map<SheetId, Map<string, CellValue>> | null> {
  if (!engine) return null;
  const out = new Map<SheetId, Map<string, CellValue>>();
  try {
    for (const chart of charts) {
      const refs = [chart.props.categories, ...chart.series.flatMap((s) => [s.props.name ? [s.props.name] : [], s.props.values, s.props.domains])].flat();
      for (const ref of refs) {
        const range = rangeFromRef(ref, grid);
        if (!range || range.sheet === null) continue;
        const index = model.sheets.findIndex((s) => s.name === range.sheet);
        const sheet = model.sheets[index];
        if (!sheet || ![...sheet.cells.values()].some(isFormula)) continue;
        const values = out.get(sheet.id) ?? new Map<string, CellValue>();
        out.set(sheet.id, values);
        const lastRow = Math.min(range.endRow, sheet.rows.length() - 1);
        const lastCol = Math.min(range.endCol, sheet.cols.length() - 1);
        if (lastRow < range.startRow || lastCol < range.startCol) continue;
        const cells = await engine.read(index, {
          from: { row: range.startRow, col: range.startCol },
          to: { row: lastRow, col: lastCol }
        });
        for (const cell of cells) values.set(`${cell.row}:${cell.col}`, engineValueOf(cell));
      }
    }
  } catch {
    return null;
  }
  return out;
}

/**
 * Los objetos de los bloques de una hoja para `hebra_read_sheet`. `engine` es el motor ya cargado
 * con `model` (o `null`): da los valores de los gráficos y los desbordes. Sin él, los gráficos con
 * fórmulas salen como no fiables y no hay `spills`.
 */
export async function sheetObjectsOf(input: {
  doc: Y.Doc;
  bytes: Uint8Array;
  sheetBase: SheetBase;
  model: SheetModel;
  sheet: SheetModelSheet;
  engine: FormulaEngine | null;
}): Promise<SheetObjects> {
  const { doc, model, sheet, engine } = input;
  const base = await baseObjectsOf(input.sheetBase);
  const tables = liveTables(doc, base, model)
    .filter((table) => table.body.sheet === sheet.id)
    .map((table) => describeTable(table, sheet));
  const images = ((await liveImages(doc, input.bytes, model, base)).get(sheet.id) ?? []).map(describeImage);
  const charts = liveCharts(doc, base).filter((chart) => chart.sheet === sheet.id);
  const grid = gridFromModel(model);
  const computed = await chartValues(charts, grid, model, engine);
  const out: SheetObjects = {
    tables,
    images,
    charts: describeCharts(charts, grid, chartDataOf(model, computed), { maxPoints: READ_CHART_POINTS_MAX }),
    pivots: await pivotViewsOf(livePivots(doc, base), model, async () => engine, (table) => sameSheet(table.target.sheet, sheet.name))
  };
  if (engine && hasSpillSource(engine)) {
    try {
      const spills = describeSpills(projectSpills(await engine.readSpills(model.sheets.indexOf(sheet))));
      if (spills.length > 0) out.spills = spills;
    } catch {
      // Sin desbordes: el motor no los supo decir. Nunca uno inventado.
    }
  }
  return out;
}

/** Cuántos objetos de cada bloque tiene cada hoja, para el resumen del libro (sin datos). */
export interface SheetObjectCounts {
  tables: string[];
  images: number;
  charts: number;
  /** Nombres de las tablas dinámicas que pintan en la hoja. */
  pivots: string[];
}

export async function objectCountsOf(doc: Y.Doc, bytes: Uint8Array, sheetBase: SheetBase, model: SheetModel): Promise<Map<SheetId, SheetObjectCounts>> {
  const base = await baseObjectsOf(sheetBase);
  const out = new Map<SheetId, SheetObjectCounts>(model.sheets.map((s) => [s.id, { tables: [], images: 0, charts: 0, pivots: [] }]));
  for (const table of liveTables(doc, base, model)) out.get(table.body.sheet)?.tables.push(table.body.name);
  for (const pivot of Object.values(livePivots(doc, base).tables).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const sheet = sheetNamed(model, pivot.target.sheet);
    if (sheet) out.get(sheet.id)?.pivots.push(pivot.name);
  }
  for (const chart of liveCharts(doc, base)) {
    const counts = out.get(chart.sheet);
    if (counts) counts.charts += 1;
  }
  for (const [sheet, images] of await liveImages(doc, bytes, model, base)) {
    const counts = out.get(sheet);
    if (counts) counts.images = images.length;
  }
  return out;
}

// --- Compilar ------------------------------------------------------------------------------------

/** Una operación que produce un comando de un bloque (se aplica con el adaptador de hojas). */
export type OptOp = ImageOp | TabOp | ChartOp | PivotSheetOp;

/**
 * Lo que compila un tramo de un bloque: sus operaciones y, en PIV, las escrituras de celdas que
 * pinta la salida de una tabla dinámica al actualizarla (registro de PIV 4.2 y 5.3).
 */
export type OptCompiledOp = OptOp | Extract<SheetOp, { type: 'cell.set' }>;

/** El libro en un punto del lote, contra el que se compila un tramo de comandos de un bloque. */
export interface OptCompileState {
  model: SheetModel;
  doc: Y.Doc;
  /** Bytes del `.ods` con que se abrió el documento (`OpenedSheet.base`). */
  bytes: Uint8Array;
  sheetBase: SheetBase;
  /** Semilla determinista de los ids nuevos de este tramo. */
  seed: string;
  /** Motor cargado con `model`, o `null` (región no admitida o fallo). Solo se pide si hace falta. */
  engine(): Promise<FormulaEngine | null>;
}

/** Un comando de un bloque con su índice en el lote. */
export type Indexed<C> = { command: C; index: number };

export type OptCompileResult =
  | { ok: true; ops: OptCompiledOp[]; createdIds: Record<string, string>; images: PreparedImage[] }
  | { ok: false; error: DocumentError };

const batchInvalid = (opIndex: number, reason: string): DocumentError => ({
  code: 'batch_invalid',
  issues: [{ opIndex, path: `ops.${opIndex}`, reason }]
});

/** Id determinista: la semilla del tramo, el bloque y un contador (sin `#`, `/` ni `@`). */
export function optIds(seed: string, kind: string): (n: number) => string {
  return (n) => createHash('sha256').update(`hebra.edit-sheet.opt/v1\u0000${seed}\u0000${kind}\u0000${n}`).digest('hex').slice(0, 32);
}

/**
 * Un asset del lote por su `ref`. Los bytes en base64, tal cual; los de un fichero o un adjunto,
 * por el SHA-256 que juzgó la fase 1 del escritor en su turno (`sha(index)`, de `guardAsset`):
 * aquí no se lee ninguna fila del almacén (D2). Sin SHA o sin bytes, `missing`.
 */
export async function resolveLotAsset(
  assets: readonly DocumentAsset[],
  ref: string,
  source: { sha(index: number): string | null; blob(sha256: string): Promise<Uint8Array | null> }
): Promise<ImageAssetLookup> {
  const index = assets.findIndex((a) => a.ref === ref);
  const asset = assets[index];
  if (!asset) return { status: 'missing' };
  if ('dataBase64' in asset) return { status: 'ok', bytes: new Uint8Array(Buffer.from(asset.dataBase64, 'base64')) };
  const sha = source.sha(index);
  const bytes = sha ? await source.blob(sha.toLowerCase()) : null;
  return bytes ? { status: 'ok', bytes } : { status: 'missing' };
}

/**
 * Un tramo de comandos de imagen, todos contra el estado leído al empezar el tramo (la regla de
 * `compileImageCommands`). Una hoja, una imagen o un asset que no se ve o no existe es `not_found`
 * con el comando; lo demás, `batch_invalid`.
 */
export async function compileImageRun(
  run: readonly Indexed<ImageCommand>[],
  state: OptCompileState,
  resolveAsset: (ref: string) => Promise<ImageAssetLookup>
): Promise<OptCompileResult> {
  const images = await liveImages(state.doc, state.bytes, state.model, await baseObjectsOf(state.sheetBase));
  const ids = optIds(state.seed, 'img');
  const out = await compileImageCommands(
    run.map((item) => item.command),
    {
      sheets: state.model.sheets.map((s) => ({ id: s.id, name: s.name, rows: s.rows, cols: s.cols, images: images.get(s.id) ?? [] })),
      resolveAsset,
      newImageId: ids
    }
  );
  if (!out.ok) {
    const opIndex = run[out.opIndex]?.index ?? run[0]!.index;
    return { ok: false, error: out.error === 'not_found' ? { code: 'not_found', opIndex } : batchInvalid(opIndex, out.reason) };
  }
  return { ok: true, ops: out.ops, createdIds: out.created, images: out.assets };
}

/** Nombres definidos del libro (las reglas `name`), para que una tabla no choque con uno. */
function definedNames(model: SheetModel): string[] {
  const names: string[] = [];
  for (const sheet of model.sheets) {
    for (const rule of sheet.rules) {
      if (rule.kind !== 'name') continue;
      try {
        const body = JSON.parse(rule.body) as { name?: unknown } | null;
        if (body && typeof body.name === 'string' && body.name !== '') names.push(body.name);
      } catch {
        // Un cuerpo ilegible no nombra nada.
      }
    }
  }
  return names;
}

/** Filas de una hoja ocultas ahora, sin las que ocultó el filtro de una tabla. */
function hiddenRowsOf(sheet: SheetModelSheet, tables: readonly ResolvedTable[]): (row: RowId) => boolean {
  const byFilter = new Set(tables.filter((t) => t.body.sheet === sheet.id).flatMap((t) => t.body.filter?.hiddenRows ?? []));
  const spans = sheet.hiddenRows ?? [];
  return (row) => {
    if (byFilter.has(row)) return false;
    const at = sheet.rows.indexOf(row);
    return at !== null && spans.some((span) => at >= span.from && at <= span.to);
  };
}

/** Comandos de tabla que leen valores calculados (filtrar u ordenar columnas con fórmulas). */
const READS_VALUES = new Set<TableCommand['type']>(['filterTable', 'clearTableFilter', 'sortTable']);

/**
 * UN comando de tabla, contra las tablas de ese momento del lote: los comandos de tabla se
 * compilan y aplican uno a uno (las tablas cambian entre ellos, registro de TAB 7.1). Un
 * `table_invalid` es `batch_invalid` con el comando.
 */
export async function compileTableAt(item: Indexed<TableCommand>, state: OptCompileState): Promise<OptCompileResult> {
  const base = await baseObjectsOf(state.sheetBase);
  const tables = liveTables(state.doc, base, state.model);
  const ids = optIds(state.seed, 'tab');
  let n = 0;
  // Valores del motor de la hoja de la tabla, solo si el comando los lee y la hoja tiene fórmulas.
  let values: { sheet: SheetId; at: Map<string, CellValue> } | null = null;
  if (READS_VALUES.has(item.command.type) && 'table' in item.command) {
    const name = item.command.table.toLowerCase();
    const table = tables.find((t) => t.body.name.toLowerCase() === name);
    const index = table ? state.model.sheets.findIndex((s) => s.id === table.body.sheet) : -1;
    const sheet = state.model.sheets[index];
    if (table && sheet && [...sheet.cells.values()].some(isFormula)) {
      const engine = await state.engine();
      if (engine) {
        try {
          const cells = await engine.read(index, table.range);
          values = { sheet: sheet.id, at: new Map(cells.map((cell) => [`${cell.row}:${cell.col}`, engineValueOf(cell)])) };
        } catch {
          values = null;
        }
      }
    }
  }
  const valueAt = (sheetId: SheetId): ValueReader | undefined => {
    const sheet = state.model.sheets.find((s) => s.id === sheetId);
    if (!sheet || !values || values.sheet !== sheetId) return undefined;
    const known = values.at;
    return (row, col) => {
      const computed = known.get(`${row}:${col}`);
      if (computed !== undefined) return computed;
      if (row >= sheet.rows.length() || col >= sheet.cols.length()) return null;
      return sheet.cells.get(`${sheet.rows.idAt(row)}:${sheet.cols.idAt(col)}`) ?? null;
    };
  };
  const out = compileTableCommand(item.command, {
    sheets: state.model.sheets,
    tables,
    definedNames: definedNames(state.model),
    newTableId: () => ids(n++),
    valueAt,
    isHidden: (sheetId) => {
      const sheet = state.model.sheets.find((s) => s.id === sheetId);
      return sheet ? hiddenRowsOf(sheet, tables) : undefined;
    }
  });
  if (isTableInvalid(out)) return { ok: false, error: batchInvalid(item.index, out.reason) };
  return { ok: true, ops: out, createdIds: {}, images: [] };
}

/** Motivos de `ChartCommandError` en castellano (el código va detrás, para quien lo busque). */
const CHART_REASONS: Readonly<Record<string, string>> = {
  unknown_command: 'comando de gráfico desconocido',
  unknown_chart: 'no existe ese gráfico',
  unknown_series: 'no existe esa serie',
  unknown_sheet: 'no existe la hoja',
  bad_range: 'rango A1 no válido',
  bad_value: 'valor no válido',
  no_data: 'el rango no tiene datos',
  duplicate_alias: 'alias repetido',
  invalid: 'comando no válido'
};

/**
 * Un tramo de comandos de gráfico, en orden y todo o nada (`compileChartCommands`). Un `$alias`
 * vale dentro del tramo. Un fallo es `batch_invalid` con el comando y el campo.
 */
export function compileChartRun(run: readonly Indexed<ChartCommand>[], state: OptCompileState, base: BaseObjects): OptCompileResult {
  const ids = optIds(state.seed, 'cht');
  let n = 0;
  const created: Record<string, string> = {};
  let ops: ChartOp[];
  try {
    ops = compileChartCommands(
      run.map((item) => item.command),
      { grid: gridFromModel(state.model), charts: liveCharts(state.doc, base), newId: () => ids(n++), data: chartDataOf(state.model, null) }
    );
  } catch (error) {
    if (!(error instanceof ChartCommandError)) throw error;
    const opIndex = run[error.index]?.index ?? run[0]!.index;
    return {
      ok: false,
      error: {
        code: 'batch_invalid',
        issues: [{ opIndex, path: `ops.${opIndex}.${error.path}`, reason: `${CHART_REASONS[error.reason] ?? 'comando no válido'} (${error.reason})` }]
      }
    };
  }
  // Los ids de lo creado con `as`, como `createdIds` de los demás comandos.
  for (const [k, item] of run.entries()) {
    const as = 'as' in item.command ? item.command.as : undefined;
    if (as === undefined) continue;
    const op = ops.filter((o) => o.type === 'chart.create' || o.type === 'chart.series.add')[countCreating(run, k)];
    if (op?.type === 'chart.create') created[as] = op.chart.id;
    else if (op?.type === 'chart.series.add') created[as] = op.series.id;
  }
  return { ok: true, ops, createdIds: created, images: [] };
}

/** Cuántos comandos que crean (gráfico o serie) hay antes del `k` del tramo. */
function countCreating(run: readonly Indexed<ChartCommand>[], k: number): number {
  return run.slice(0, k).filter((item) => item.command.type === 'createChart' || item.command.type === 'addSeries').length;
}

// --- Tablas dinámicas (PIV) ----------------------------------------------------------------------
//
// Una tabla dinámica nombra sus hojas por nombre (`target.sheet`, `source.sheet`), no por id: así
// la guarda el fichero y así la escribe el modelo de PIV. Aquí se comparan sin distinguir
// mayúsculas, como el resto de comandos, y un comando lleva siempre el nombre real de la hoja.

/** Celdas que puede tener el origen de una tabla dinámica que se lee para calcularla. */
export const PIVOT_SOURCE_CELLS_MAX = 1_000_000;

/** Las tablas dinámicas vigentes: las del fichero con los cambios del documento, y las creadas. */
export function livePivots(doc: Y.Doc, base: BaseObjects): PivotBook {
  return readPivotBook(doc, base.pivots);
}

const sameSheet = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** La hoja del modelo con ese nombre (sin distinguir mayúsculas), o `null`. */
export function sheetNamed(model: SheetModel, name: string): SheetModelSheet | null {
  return model.sheets.find((s) => sameSheet(s.name, name)) ?? null;
}

/** El valor de una celda como lo cuenta una tabla dinámica: una fórmula sin valor del motor, vacía. */
function pivotCellOf(value: CellValue | undefined): PivotCell {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return 'err' in value ? { err: value.err } : null;
  return value;
}

/**
 * Los valores de un rectángulo de una hoja como los ve la rejilla: los escritos y, para las
 * fórmulas y lo que derraman, los del motor. Lo que queda fuera de la hoja no tiene filas. `null`
 * si la hoja tiene fórmulas y no hay motor, o si falla: un origen con valores inventados daría una
 * salida falsa y una huella de fiable.
 */
export async function rangeValuesOf(
  model: SheetModel,
  sheet: SheetModelSheet,
  range: GridRange,
  engine: () => Promise<FormulaEngine | null>
): Promise<PivotCell[][] | null> {
  const lastRow = Math.min(range.to.row, sheet.rows.length() - 1);
  const lastCol = Math.min(range.to.col, sheet.cols.length() - 1);
  if (lastRow < range.from.row || lastCol < range.from.col) return [];
  const height = lastRow - range.from.row + 1;
  const width = lastCol - range.from.col + 1;
  const out: PivotCell[][] = Array.from({ length: height }, () => new Array<PivotCell>(width).fill(null));
  let formulas = false;
  for (const [key, value] of sheet.cells) {
    if (isFormula(value)) formulas = true;
    const colon = key.indexOf(':');
    const row = sheet.rows.indexOf(key.slice(0, colon));
    const col = sheet.cols.indexOf(key.slice(colon + 1));
    if (row === null || col === null || row < range.from.row || row > lastRow || col < range.from.col || col > lastCol) continue;
    out[row - range.from.row]![col - range.from.col] = pivotCellOf(value);
  }
  if (!formulas) return out;
  const loaded = await engine();
  if (!loaded) return null;
  try {
    const cells = await loaded.read(model.sheets.indexOf(sheet), { from: range.from, to: { row: lastRow, col: lastCol } });
    for (const cell of cells) out[cell.row - range.from.row]![cell.col - range.from.col] = pivotCellOf(engineValueOf(cell));
  } catch {
    return null;
  }
  return out;
}

/** El origen de una tabla para calcularla o juzgar su fiabilidad, o `null` si no se puede leer. */
export async function pivotSourceOf(
  model: SheetModel,
  table: PivotTable,
  engine: () => Promise<FormulaEngine | null>
): Promise<PivotSourceData | null> {
  if (table.source.kind !== 'range') return null;
  const sheet = sheetNamed(model, table.source.sheet);
  const { from, to } = table.source.range;
  if (!sheet || (to.row - from.row + 1) * (to.col - from.col + 1) > PIVOT_SOURCE_CELLS_MAX) return null;
  const rows = await rangeValuesOf(model, sheet, table.source.range, engine);
  return rows ? { rows } : null;
}

/**
 * Las tablas dinámicas para el LLM (`describePivotsForLlm`), las que cumplan `keep`. El origen solo
 * se lee de las que tienen la huella de un cálculo de Hebra: sin ella son `from_file` sin mirarlo.
 */
export async function pivotViewsOf(
  book: PivotBook,
  model: SheetModel,
  engine: () => Promise<FormulaEngine | null>,
  keep: (table: PivotTable) => boolean = () => true
): Promise<PivotLlmView[]> {
  const kept: PivotBook = { tables: Object.fromEntries(Object.entries(book.tables).filter(([, t]) => keep(t))) };
  const sources: Record<string, PivotSourceData | null> = {};
  for (const table of Object.values(kept.tables)) {
    sources[table.id] = table.computed ? await pivotSourceOf(model, table, engine) : null;
  }
  return describePivotsForLlm(kept, sources);
}

/** Un rango de salida de una tabla dinámica cuyos valores no son fiables, para avisar en la lectura. */
export interface PivotWarning {
  /** `A1:D9`, sin la hoja (es la de la página). */
  range: string;
  grid: GridRange;
  trust: string;
  note: string;
}

/** Los avisos de las salidas no fiables de la hoja (`unreliableRanges`). */
export async function pivotWarningsOf(
  book: PivotBook,
  model: SheetModel,
  sheet: SheetModelSheet,
  engine: () => Promise<FormulaEngine | null>
): Promise<PivotWarning[]> {
  const keep = (table: PivotTable) => sameSheet(table.target.sheet, sheet.name);
  if (!Object.values(book.tables).some(keep)) return [];
  const views = await pivotViewsOf(book, model, engine, keep);
  return unreliableRanges(book, views).map((w) => ({
    range: a1Range(sheet.name, w.range).replace(/^.*!/u, ''),
    grid: w.range,
    trust: w.trust,
    note: w.note
  }));
}

/** El comando con el nombre real de sus hojas, o el campo con una hoja que no existe. */
function withRealSheets(command: PivotCommand, model: SheetModel): PivotCommand | { path: string; reason: string } {
  const fix = <T extends { sheet: string }>(ref: T | undefined, path: string): T | undefined | { path: string; reason: string } => {
    if (!ref) return ref;
    const sheet = sheetNamed(model, ref.sheet);
    return sheet ? { ...ref, sheet: sheet.name } : { path, reason: `no existe la hoja "${ref.sheet}"` };
  };
  if (command.type !== 'pivotCreate' && command.type !== 'pivotSet') return command;
  const source = fix(command.source, 'source.sheet');
  if (source && 'reason' in source) return source;
  const output = fix(command.output, 'output.sheet');
  if (output && 'reason' in output) return output;
  return { ...command, ...(source ? { source } : {}), ...(output ? { output } : {}) } as PivotCommand;
}

const headerKey = (sheet: string, range: GridRange): string =>
  `${sheet.toLowerCase()}\u0000${range.from.row}:${range.from.col}:${range.to.col}`;

/**
 * Las cabeceras (primera fila) de un origen, como las lee la interfaz (`readHeaders` de
 * `piv-ui.ts`): una vacía o repetida no sirve, con su motivo. `null` si no se lee.
 */
async function headersOf(
  model: SheetModel,
  sheetName: string,
  range: GridRange,
  engine: () => Promise<FormulaEngine | null>
): Promise<{ ok: true; headers: string[] } | { ok: false; reason: string } | null> {
  const sheet = sheetNamed(model, sheetName);
  if (!sheet) return null;
  const first = await rangeValuesOf(model, sheet, { from: range.from, to: { row: range.from.row, col: range.to.col } }, engine);
  if (!first) return null;
  const row = first[0] ?? [];
  return readHeaders(range, (_r, col) => {
    const value = row[col - range.from.col];
    return value === undefined || value === null || typeof value === 'object' ? null : value;
  });
}

/**
 * Qué celdas ocupa algo en la hoja de una salida: un valor o una fórmula, una combinada, la salida
 * de otra tabla dinámica, o lo que ya escribió el propio tramo. Lo que derrama una matriz no se ve
 * aquí (no tiene contenido propio): ese límite está escrito en el registro de PIV de H-171.
 */
function occupiedIn(
  sheet: SheetModelSheet,
  targets: ReadonlyMap<string, { sheet: string; range: GridRange }>,
  self: string,
  written: ReadonlyMap<string, { value: CellValue }>
): (row: number, col: number) => boolean {
  return (row, col) => {
    const own = written.get(`${sheet.id}:${row}:${col}`);
    if (own) return own.value !== null;
    if (row < sheet.rows.length() && col < sheet.cols.length()) {
      const value = sheet.cells.get(`${sheet.rows.idAt(row)}:${sheet.cols.idAt(col)}`);
      if (value !== undefined && value !== null) return true;
    }
    if (sheet.merges.some((m) => row >= m.row && row < m.row + m.rowSpan && col >= m.col && col < m.col + m.colSpan)) return true;
    for (const [id, target] of targets) {
      if (id === self || !sameSheet(target.sheet, sheet.name)) continue;
      const { from, to } = target.range;
      if (row >= from.row && row <= to.row && col >= from.col && col <= to.col) return true;
    }
    return false;
  };
}

/**
 * Un tramo de comandos de tabla dinámica, en orden y todo o nada (`compilePivotCommands`, las
 * mismas operaciones que la interfaz). Después, cada tabla que hay que actualizar (las creadas, las
 * de origen nuevo y las de `pivotRefresh`) se calcula aquí, en este hilo (`refreshPivot`), y su
 * salida se escribe como `cell.set`; las salidas de las borradas y lo que sobra de una salida que
 * encoge se vacían (registro de PIV 4.2 y 5.3). El formato de la salida no se arrastra (`fmt.ts` es
 * de la interfaz): una celda nueva sale sin formato propio.
 */
export async function compilePivotRun(
  run: readonly Indexed<PivotCommand>[],
  state: OptCompileState,
  base: BaseObjects
): Promise<OptCompileResult> {
  const { model } = state;
  const commands: PivotCommand[] = [];
  for (const { command, index } of run) {
    const fixed = withRealSheets(command, model);
    if ('reason' in fixed) return { ok: false, error: { code: 'batch_invalid', issues: [{ opIndex: index, path: `ops.${index}.${fixed.path}`, reason: fixed.reason }] } };
    commands.push(fixed);
  }
  const book = livePivots(state.doc, base);

  // Las cabeceras de los orígenes, leídas antes (el compilador las pide sin esperar): las de los
  // comandos, con su motivo si no sirven, y las de las tablas que ya hay.
  const headers = new Map<string, string[]>();
  for (const [k, command] of commands.entries()) {
    const source = command.type === 'pivotCreate' || command.type === 'pivotSet' ? command.source : undefined;
    const range = source ? parseA1(source.range) : null;
    if (!source || !range) continue;
    const read = await headersOf(model, source.sheet, range, state.engine);
    if (read && !read.ok) return { ok: false, error: batchInvalid(run[k]!.index, read.reason) };
    if (read) headers.set(headerKey(source.sheet, range), read.headers);
  }
  for (const table of Object.values(book.tables)) {
    if (table.source.kind !== 'range') continue;
    const key = headerKey(table.source.sheet, table.source.range);
    if (headers.has(key)) continue;
    const read = await headersOf(model, table.source.sheet, table.source.range, state.engine);
    if (read?.ok) headers.set(key, read.headers);
  }
  const ids = optIds(state.seed, 'piv');
  let n = 0;
  const out = compilePivotCommands(book, commands, {
    headers: (sheet, range) => headers.get(headerKey(sheet, range)) ?? null,
    newPivotId: () => ids(n++)
  });
  if (!out.ok) return { ok: false, error: batchInvalid(run[out.index]?.index ?? run[0]!.index, `${out.reason} (${out.code})`) };
  const ops: OptCompiledOp[] = out.ops.map((edit): PivotSheetOp => ({ type: 'pivot.edit', edit }));

  /** Lo que el tramo escribe en celdas, por `hoja:fila:columna`: lo último gana. */
  const written = new Map<string, { sheet: SheetModelSheet; row: number; col: number; value: CellValue }>();
  const clearRect = (sheetName: string, range: GridRange) => {
    const sheet = sheetNamed(model, sheetName);
    if (!sheet) return;
    for (let row = range.from.row; row <= range.to.row; row++) {
      for (let col = range.from.col; col <= range.to.col; col++) written.set(`${sheet.id}:${row}:${col}`, { sheet, row, col, value: null });
    }
  };
  for (const placement of out.clear) clearRect(placement.sheet, placement.range);

  // Quién pidió cada actualización: su fallo va con ese comando.
  const blame = (id: string): number => {
    const table = out.book.tables[id];
    for (let k = commands.length - 1; k >= 0; k--) {
      const command = commands[k]!;
      const ref = command.type === 'pivotCreate' ? command.name : command.type === 'pivotRefresh' || command.type === 'pivotSet' ? command.pivot : null;
      if (ref !== null && table && (ref === table.id || ref === table.name)) return run[k]!.index;
    }
    return run[0]!.index;
  };
  const targets = new Map(Object.values(out.book.tables).map((t) => [t.id, { sheet: t.target.sheet, range: t.target.range }]));
  for (const id of out.refresh) {
    const table = out.book.tables[id];
    if (!table) continue;
    const opIndex = blame(id);
    const source = await pivotSourceOf(model, table, state.engine);
    if (!source) return { ok: false, error: batchInvalid(opIndex, `no se puede leer el origen de la tabla dinámica "${table.name}"`) };
    const sheet = sheetNamed(model, table.target.sheet);
    if (!sheet) return { ok: false, error: batchInvalid(opIndex, `no existe la hoja de la salida, "${table.target.sheet}"`) };
    const res = refreshPivot(table, source, { occupied: occupiedIn(sheet, targets, id, written), locale: 'es' });
    if (!res.ok) return { ok: false, error: batchInvalid(opIndex, `${res.reason} (${res.code})`) };
    for (const edit of res.ops) ops.push({ type: 'pivot.edit', edit });
    for (const placement of res.clear) clearRect(placement.sheet, placement.range);
    const { from } = res.output.range;
    res.output.cells.forEach((line, y) =>
      line.forEach((cell, x) => written.set(`${sheet.id}:${from.row + y}:${from.col + x}`, { sheet, row: from.row + y, col: from.col + x, value: cell.value }))
    );
    targets.set(id, { sheet: res.output.sheet, range: res.output.range });
  }

  // Las escrituras, solo donde cambian, con las versiones vivas de cada celda.
  const versions = createCellVersionIndex(state.doc);
  try {
    for (const { sheet, row, col, value } of written.values()) {
      const inside = row < sheet.rows.length() && col < sheet.cols.length();
      const now = inside ? sheet.cells.get(`${sheet.rows.idAt(row)}:${sheet.cols.idAt(col)}`) ?? null : null;
      if (JSON.stringify(now) === JSON.stringify(value)) continue;
      if (!inside) return { ok: false, error: batchInvalid(blameAt(run), `la salida de la tabla dinámica no cabe en la hoja "${sheet.name}" (${cellA1(row, col)})`) };
      const rowId = sheet.rows.idAt(row);
      const colId = sheet.cols.idAt(col);
      ops.push({ type: 'cell.set', sheet: sheet.id, row: rowId, col: colId, value, replaces: versions.replaces(sheet.id, rowId, colId) });
    }
  } finally {
    versions.dispose();
  }
  return { ok: true, ops, createdIds: {}, images: [] };
}

/** El comando de un tramo al que se atribuye un fallo sin dueño claro: el último. */
const blameAt = (run: readonly Indexed<PivotCommand>[]): number => run[run.length - 1]!.index;
