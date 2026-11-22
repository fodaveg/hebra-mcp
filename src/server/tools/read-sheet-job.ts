/**
 * El cálculo de `hebra_read_sheet` (H-78, plan de hojas 3.5; estudio MCP de documentos, apartado
 * 4): lo que corre DENTRO del hilo de documentos (`dist/document-worker.mjs`, cargador `read`).
 * La herramienta (`./read-sheet.ts`) comprueba la privacidad, junta los bytes del almacén y manda
 * aquí solo datos: la base, los segmentos y los pendientes del `Y.Doc` y la petición ya validada.
 * Aquí no hay puerto, ni filtro de privados, ni red: si algo de esto se colara, el hilo podría
 * leer lo que la herramienta no comprobó.
 *
 * Qué hace:
 * 1. Abre el documento con la lectura común de hojas (`openSheetRead` de `./sheet-read.ts`, la misma
 *    de `hebra_render_sheet`), sobre el estado que mandó la herramienta (`pinnedSource`): el `Y.Doc`
 *    con los segmentos y pendientes, proyectado con el adaptador real, y las revisiones de
 *    `openDocumentRead`, con la fórmula de la sesión de escritura. Así `revision` y
 *    `layoutRevision` son las que `hebra_edit_sheet` compara con `expectedRevision` y
 *    `expectedLayout` (decisión 18). Un documento sin cabecera se lee con un `Y.Doc` vacío
 *    (`headless: 'empty'`), sin andamio: la misma lectura da la misma revisión y no se escribe nada.
 * 2. Sin hoja ni rango: el resumen del libro, sin celdas.
 * 3. Con hoja o rango: una página de filas enteras del rango, con hasta `maxCells` celdas. Los
 *    valores de las fórmulas los calcula el motor (`createNodeFormulaEngine`, H-09) en su propio
 *    hilo, con la región y la zona del libro. Si el libro no tiene región admitida o el motor falla,
 *    esas celdas van a `null` con `calculated: false`: nunca un valor inventado.
 *
 * Matrices que se derraman (H-SPILL): una fórmula como `=SEQUENCE(3)` en N1 rellena N2 y N3, que
 * en el modelo no tienen nada. Sus valores solo los sabe el motor, como en la rejilla de la app
 * (que pinta lo que da `controller.read`). Una celda sin contenido propio con valor en el motor es
 * una celda derramada: sale con su valor, la página la marca en `spilled` y cuenta en el rango
 * usado y en los errores del resumen. El contrato del motor no dice de qué ancla viene cada celda
 * (eso lo sabe IronCalc por dentro, `getCellArrayStructure`), así que la marca no nombra la fórmula
 * de origen: deducirla de los valores sería adivinar cuando dos matrices se tocan.
 *
 * Todo lo que sale de una celda (valor, fórmula, comentario, nombre de hoja) es un dato del
 * documento y va solo en campos de datos. Un error sale como código cerrado (`DocumentError`), sin
 * texto del documento.
 */
import type * as Y from 'yjs';
import type { DocHeadRecord } from '../../../vendor/hebra/src/lib/documents/contract';
import { readSafeZip } from '../../../vendor/hebra/src/lib/portability/zip-read';
import { columnIndex, columnLetters, MAX_COLS, MAX_ROWS } from '../../../vendor/hebra/src/lib/sheets/formula/canon';
import { inventoryOds } from '../../../vendor/hebra/src/lib/sheets/ods/inventory';
import { readOdsStylesFromBytes, type OdsStyleBook, type ResolvedCellStyle } from '../../../vendor/hebra/src/lib/sheets/ods/read-styles';
import { zipLimits } from '../../../vendor/hebra/src/lib/sheets/ods/read-workbook';
import { CELL_STYLES_MAP, readCellStyle } from '../../../vendor/hebra/src/lib/sheets/ops/apply-cell';
import {
  createFormulaLocale,
  createNodeFormulaEngine,
  createSheetEngineProjection,
  formulaText,
  type BookEngineSettings,
  type CellValue,
  type FormulaEngineWithValues,
  type GridRange,
  type SheetBase,
  type SheetModel,
  type SheetModelSheet
} from '../../sheets';
import type { DocumentError } from '../../store/document-types';
import { SHEET_ODS_INVENTORY_LIMITS, SHEET_ODS_READ_LIMITS } from '../../store/sheet-limits';
import { ToolError } from '../errors';
import type { ReadSheetInclude } from './read-sheet';
import { isFormula, openSheetRead, pinnedSource, scopeOf, sheetOf, type OpenedSheet } from './sheet-read';

/** La petición ya validada por la herramienta. */
export interface ReadSheetJobRequest {
  /** Nombre o id de la hoja. Sin él y sin `range`, el resumen. */
  sheet?: string;
  /** `A1` o `A1:D20`. Sin él, el rango usado de la hoja. */
  range?: string;
  include: readonly ReadSheetInclude[];
  maxCells: number;
  /**
   * Fila del rango por la que empieza la página (base 0), del cursor. Más allá del rango da una
   * página vacía: la herramienta decide si el cursor era ajeno o si cambió la disposición.
   */
  offset: number;
}

/** Lo que la herramienta manda al hilo. Solo datos clonables. */
export interface ReadSheetJobInput {
  format: 'ods';
  fileId: string;
  /** La cabecera del documento, o `null` si aún no tiene (nunca se abrió como documento). */
  head: DocHeadRecord | null;
  /** Bytes del último punto de control, o de la base; sin cabecera, los del fichero. */
  base: Uint8Array;
  /** SHA-256 de `base`: el punto de control de la cabecera, o el del fichero si no tiene. */
  baseSha256: string;
  segments: readonly Uint8Array[];
  pending: readonly Uint8Array[];
  request: ReadSheetJobRequest;
}

/** Una hoja del resumen. */
export interface SheetSummary {
  sheetId: string;
  name: string;
  /**
   * Oculta en el fichero (`table:display="false"`): sigue en el libro con sus celdas y sus
   * fórmulas, y se lee igual, pero el editor no enseña su pestaña.
   */
  hidden: boolean;
  /** `A1:D20`, o `null` si la hoja está vacía. */
  usedRange: string | null;
  formulaCount: number;
  /** Celdas con error: guardado en el fichero o calculado por el motor. */
  errorCount: number;
  /** Clases de contenido que el editor conserva sin entenderlas (inventario de H-16). */
  preserved: string[];
}

export interface WorkbookSummary {
  sheets: SheetSummary[];
  namedRanges: string[];
  /** `false` si alguna fórmula no se pudo calcular: su error no cuenta en `errorCount`. */
  calculated: boolean;
}

/** Valor de una celda tal como sale: un error va como `{ error }` con su código. */
export type ReadCellValue = null | boolean | number | string | { error: string };

/** Una fila de la página, con lo que se pidió de ella. */
export interface PageRow {
  /** Número de fila del libro (base 1). */
  row: number;
  values: ReadCellValue[];
  formulas?: Record<string, string>;
  comments?: Record<string, string>;
  formats?: { range: string; styleId: string }[];
  /**
   * Tramos de columnas (base 0, extremos incluidos) de la fila que rellena una matriz que se
   * derrama: sin contenido propio, con el valor que calcula el motor. Solo con `values` y si hay.
   */
  spilled?: { from: number; to: number }[];
}

export interface SheetPage {
  sheetId: string;
  sheet: string;
  /** El rango pedido entero (o el usado de la hoja). */
  address: string;
  /** Primera columna del rango (base 0) y ancho. */
  col: number;
  width: number;
  /** Filas del rango pedido, en total, y la primera de esta página (base 0 dentro del rango). */
  totalRows: number;
  offset: number;
  rows: PageRow[];
  /** Propiedades de cada `styleId` usado en `formats`. */
  styles?: Record<string, Record<string, unknown>>;
  /**
   * `false` si el motor no pudo calcular lo que la página necesita: el valor de sus fórmulas y el
   * de lo que derrama una matriz van a `null`.
   */
  calculated: boolean;
}

export type ReadSheetJobResult =
  | {
      ok: true;
      revision: string;
      layoutRevision: string;
      workbook?: WorkbookSummary;
      page?: SheetPage;
    }
  | { ok: false; error: DocumentError }
  /** La entrada no casa con el libro: una hoja que no existe o un rango fuera de ella. */
  | { ok: false; invalid: 'sheet' | 'range' };

export interface ReadSheetJobOptions {
  /**
   * Módulo del hilo del motor. Por defecto el empaquetado junto a este (`dist/document-worker.mjs`
   * y `dist/sheet-engine-worker.mjs` están en la misma carpeta). Los tests pasan el suyo.
   */
  engineWorkerUrl?: URL;
  signal?: AbortSignal;
}

/** Hilo del motor junto al empaquetado (`dist/sheet-engine-worker.mjs`, H-173). */
const ENGINE_WORKER_URL = new URL('./sheet-engine-worker.mjs', import.meta.url);

const A1_CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

type Rect = { r1: number; c1: number; r2: number; c2: number };

/** `A1` o `A1:D20` a posiciones base 0, o `null`. Los límites de la hoja se miran aparte. */
export function parseA1Range(text: string): Rect | null {
  const parts = text.trim().split(':');
  if (parts.length > 2) return null;
  const cells = parts.map((part) => {
    const m = A1_CELL.exec(part);
    if (!m) return null;
    const c = columnIndex(m[1]);
    const r = Number(m[2]) - 1;
    return c === null || r < 0 ? null : { r, c };
  });
  const [a, b = a] = cells;
  if (!a || !b) return null;
  return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
}

/** Dirección A1 de una celda en posiciones base 0. */
export const cellA1 = (row: number, col: number): string => `${columnLetters(col)}${row + 1}`;
const rectA1 = (r: Rect): string =>
  r.r1 === r.r2 && r.c1 === r.c2 ? cellA1(r.r1, r.c1) : `${cellA1(r.r1, r.c1)}:${cellA1(r.r2, r.c2)}`;

const isStoredError = (value: CellValue): value is { err: string } =>
  typeof value === 'object' && value !== null && 'err' in value;
const isEmpty = (value: CellValue | undefined): boolean => value === undefined || value === null || value === '';

/** Posición (fila y columna, base 0) de una clave `${RowId}:${ColId}` del modelo. */
function positionOf(sheet: SheetModelSheet, key: string): { row: number; col: number } | null {
  const colon = key.indexOf(':');
  if (colon < 0) return null;
  const row = sheet.rows.indexOf(key.slice(0, colon));
  const col = sheet.cols.indexOf(key.slice(colon + 1));
  return row === null || col === null ? null : { row, col };
}

/** Rango usado: el rectángulo de las celdas con contenido, o `null`. */
function usedRect(sheet: SheetModelSheet): Rect | null {
  let rect: Rect | null = null;
  for (const [key, value] of sheet.cells) {
    if (isEmpty(value)) continue;
    const at = positionOf(sheet, key);
    if (!at) continue;
    if (!rect) rect = { r1: at.row, c1: at.col, r2: at.row, c2: at.col };
    else {
      rect.r1 = Math.min(rect.r1, at.row);
      rect.c1 = Math.min(rect.c1, at.col);
      rect.r2 = Math.max(rect.r2, at.row);
      rect.c2 = Math.max(rect.c2, at.col);
    }
  }
  return rect;
}

/** El menor rectángulo que contiene los dos (cualquiera puede faltar). */
function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a || !b) return a ?? b;
  return { r1: Math.min(a.r1, b.r1), c1: Math.min(a.c1, b.c1), r2: Math.max(a.r2, b.r2), c2: Math.max(a.c2, b.c2) };
}

/** La hoja entera para el motor: `read` recorre solo las celdas con valor, no el rango. */
const WHOLE_SHEET: GridRange = { from: { row: 0, col: 0 }, to: { row: MAX_ROWS - 1, col: MAX_COLS - 1 } };

/** Posiciones (`fila:columna`, base 0) con contenido propio en el modelo. */
function ownPositions(sheet: SheetModelSheet): Set<string> {
  const out = new Set<string>();
  for (const [key, value] of sheet.cells) {
    if (isEmpty(value)) continue;
    const at = positionOf(sheet, key);
    if (at) out.add(`${at.row}:${at.col}`);
  }
  return out;
}

/**
 * ¿Hay alguna fórmula que pueda derramar hasta (`row`, `col`)? Una matriz se derrama hacia abajo
 * y a la derecha de su ancla, así que solo cuentan las de arriba a la izquierda.
 */
function formulaUpLeftOf(sheet: SheetModelSheet, row: number, col: number): boolean {
  for (const [key, value] of sheet.cells) {
    if (!isFormula(value)) continue;
    const at = positionOf(sheet, key);
    if (at && at.row <= row && at.col <= col) return true;
  }
  return false;
}

/** Un comentario del panel (H-50): JSON con `row`, `col` y `text`. Otro cuerpo no es un comentario. */
function commentOf(body: string): { row: string; col: string; text: string } | null {
  try {
    const data = JSON.parse(body) as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || data.deleted === true) return null;
    if (typeof data.row !== 'string' || typeof data.col !== 'string' || typeof data.text !== 'string') return null;
    return { row: data.row, col: data.col, text: data.text };
  } catch {
    return null;
  }
}

/** Nombre de una regla `name`, o `null` si su cuerpo no lo trae. */
function nameOf(body: string): string | null {
  try {
    const data = JSON.parse(body) as Record<string, unknown> | null;
    return data && typeof data.name === 'string' && data.name !== '' ? data.name : null;
  } catch {
    return null;
  }
}

/** El motor cargado con el libro proyectado, o `null` si el libro no tiene región admitida o falla. */
async function loadEngine(
  model: SheetModel,
  settings: BookEngineSettings | null,
  options: ReadSheetJobOptions
): Promise<FormulaEngineWithValues | null> {
  if (!settings) return null;
  const engine = createNodeFormulaEngine({ workerUrl: options.engineWorkerUrl ?? ENGINE_WORKER_URL });
  try {
    const book = createSheetEngineProjection(settings).book(model);
    await engine.load(book, settings, options.signal ?? new AbortController().signal);
    return engine;
  } catch {
    engine.dispose();
    return null;
  }
}

/** Lo que el resumen de una hoja con fórmulas necesita del motor. */
interface EngineSheetFacts {
  /** Errores calculados: en celdas con fórmula y en celdas derramadas. */
  errors: number;
  /** Rectángulo de las celdas derramadas, o `null` si no hay. */
  spilled: Rect | null;
}

function summaryOf(
  model: SheetModel,
  findings: readonly { cls: string; sheet?: string }[],
  engineFacts: ReadonlyMap<string, EngineSheetFacts> | null
): WorkbookSummary {
  const names = new Set<string>();
  let calculated = true;
  const sheets = model.sheets.map((sheet): SheetSummary => {
    let formulaCount = 0;
    let errorCount = 0;
    for (const value of sheet.cells.values()) {
      if (isFormula(value)) formulaCount += 1;
      else if (isStoredError(value)) errorCount += 1;
    }
    for (const rule of sheet.rules) {
      if (rule.kind !== 'name') continue;
      const name = nameOf(rule.body);
      if (name) names.add(name);
    }
    let spilled: Rect | null = null;
    if (formulaCount > 0) {
      const facts = engineFacts?.get(sheet.id);
      if (facts === undefined) calculated = false;
      else {
        errorCount += facts.errors;
        spilled = facts.spilled;
      }
    }
    // Lo que derrama una matriz también es parte del rango usado: la rejilla lo enseña.
    const used = unionRect(usedRect(sheet), spilled);
    const preserved = new Set<string>();
    for (const finding of findings) {
      if (finding.sheet === undefined || finding.sheet === sheet.name) preserved.add(finding.cls);
    }
    return {
      sheetId: sheet.id,
      name: sheet.name,
      hidden: sheet.hidden === true,
      usedRange: used ? rectA1(used) : null,
      formulaCount,
      errorCount,
      preserved: [...preserved]
    };
  });
  return { sheets, namedRanges: [...names].sort(), calculated };
}

/**
 * Celdas derramadas de una hoja: las que el motor rellena sin que el modelo tenga nada en ellas.
 * `own` son las posiciones con contenido propio (`ownPositions`).
 */
async function spilledCells(
  engine: FormulaEngineWithValues,
  index: number,
  own: ReadonlySet<string>
): Promise<{ row: number; col: number }[]> {
  const out: { row: number; col: number }[] = [];
  for (const cell of await engine.read(index, WHOLE_SHEET)) {
    if (cell.kind === 'empty' || own.has(`${cell.row}:${cell.col}`)) continue;
    out.push({ row: cell.row, col: cell.col });
  }
  return out;
}

/** Rectángulo de unas posiciones, o `null` si no hay ninguna. */
function rectOf(cells: readonly { row: number; col: number }[]): Rect | null {
  let rect: Rect | null = null;
  for (const { row, col } of cells) rect = unionRect(rect, { r1: row, c1: col, r2: row, c2: col });
  return rect;
}

/** Errores calculados y celdas derramadas de cada hoja con fórmulas, o `null` sin motor. */
async function engineSheetFacts(
  model: SheetModel,
  engine: FormulaEngineWithValues | null
): Promise<Map<string, EngineSheetFacts> | null> {
  if (!engine) return null;
  const out = new Map<string, EngineSheetFacts>();
  try {
    for (const [index, sheet] of model.sheets.entries()) {
      const formulas = new Set<string>();
      for (const [key, value] of sheet.cells) {
        if (!isFormula(value)) continue;
        const at = positionOf(sheet, key);
        if (at && at.row < MAX_ROWS && at.col < MAX_COLS) formulas.add(`${at.row}:${at.col}`);
      }
      if (formulas.size === 0) continue;
      const own = ownPositions(sheet);
      const cells = await engine.read(index, WHOLE_SHEET);
      let errors = 0;
      const spilled: { row: number; col: number }[] = [];
      for (const cell of cells) {
        const at = `${cell.row}:${cell.col}`;
        if (cell.kind === 'empty') continue;
        const isSpilled = !own.has(at);
        if (isSpilled) spilled.push(cell);
        if (cell.kind === 'error' && (isSpilled || formulas.has(at))) errors += 1;
      }
      out.set(sheet.id, { errors, spilled: rectOf(spilled) });
    }
  } catch {
    return null;
  }
  return out;
}

/** Hoja pedida por id o por nombre (sin distinguir mayúsculas). */
function findSheet(model: SheetModel, wanted: string | undefined): SheetModelSheet | null {
  return wanted === undefined ? (model.sheets[0] ?? null) : sheetOf(model, wanted);
}

const BOOLEAN_STYLES = new Set(['bold', 'italic', 'underline', 'strike', 'wrap']);

/** Lo que un estilo resuelto tiene distinto del estilo por defecto. */
function styleProps(style: ResolvedCellStyle, base: ResolvedCellStyle): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['fill', 'color', 'bold', 'italic', 'underline', 'strike', 'fontFamily', 'fontSize', 'halign', 'valign', 'wrap'] as const) {
    if (style[key] !== base[key]) out[key] = style[key];
  }
  const borders: Record<string, unknown> = {};
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    if (style.borders[side] && JSON.stringify(style.borders[side]) !== JSON.stringify(base.borders[side])) {
      borders[side] = style.borders[side];
    }
  }
  if (Object.keys(borders).length > 0) out.borders = borders;
  if (style.numberFormat && style.numberFormat.name !== base.numberFormat?.name) {
    out.numberFormat = { kind: style.numberFormat.kind, name: style.numberFormat.name };
  }
  return out;
}

/** Valor de una propiedad de estilo del `Y.Doc` (siempre texto) con su tipo. */
function patchValue(prop: string, value: string): unknown {
  if (BOOLEAN_STYLES.has(prop) && (value === 'true' || value === 'false')) return value === 'true';
  if (prop === 'fontSize' && Number.isFinite(Number(value))) return Number(value);
  return value;
}

const BASE_AXIS_ID = /^b(\d+)$/;

/** Construye la página de filas pedida. */
async function pageOf(
  doc: Y.Doc,
  base: SheetBase,
  sheetBytes: Uint8Array,
  model: SheetModel,
  sheet: SheetModelSheet,
  rect: Rect,
  request: ReadSheetJobRequest,
  engineOf: () => Promise<FormulaEngineWithValues | null>
): Promise<SheetPage> {
  const width = rect.c2 - rect.c1 + 1;
  const totalRows = rect.r2 - rect.r1 + 1;
  const perPage = Math.max(1, Math.floor(request.maxCells / width));
  const first = rect.r1 + request.offset;
  const last = Math.min(rect.r2, first + perPage - 1);
  const include = new Set(request.include);
  const index = model.sheets.indexOf(sheet);

  // Lo que hay en la página, por posición.
  const grid = new Map<string, { value: CellValue; rowId: string; colId: string }>();
  for (const [key, value] of sheet.cells) {
    const at = positionOf(sheet, key);
    if (!at || at.row < first || at.row > last || at.col < rect.c1 || at.col > rect.c2) continue;
    const colon = key.indexOf(':');
    grid.set(`${at.row}:${at.col}`, { value, rowId: key.slice(0, colon), colId: key.slice(colon + 1) });
  }

  // Valores calculados: solo si se piden y hay alguna fórmula que llegue a la página, en ella o
  // arriba a la izquierda (una matriz que se derrama desde fuera también la rellena).
  let calculated = true;
  let computed: Map<string, ReadCellValue> | null = null;
  if (include.has('values') && formulaUpLeftOf(sheet, last, rect.c2)) {
    const engine = await engineOf();
    if (engine) {
      try {
        const range: GridRange = {
          from: { row: first, col: rect.c1 },
          to: { row: Math.min(last, MAX_ROWS - 1), col: Math.min(rect.c2, MAX_COLS - 1) }
        };
        computed = new Map();
        for (const cell of await engine.readValues(index, range)) {
          const v = cell.value;
          computed.set(`${cell.row}:${cell.col}`, v !== null && typeof v === 'object' ? { error: v.err } : v);
        }
      } catch {
        computed = null;
      }
    }
    if (!computed) calculated = false;
  }

  const formulas = createFormulaLocale();
  const scope = scopeOf(model, sheet.id);

  // Comentarios de la página, por posición.
  const comments = new Map<string, string>();
  if (include.has('comments')) {
    for (const rule of sheet.rules) {
      if (rule.kind !== 'comment') continue;
      const note = commentOf(rule.body);
      if (!note) continue;
      const row = sheet.rows.indexOf(note.row);
      const col = sheet.cols.indexOf(note.col);
      if (row === null || col === null || row < first || row > last || col < rect.c1 || col > rect.c2) continue;
      comments.set(`${row}:${col}`, note.text);
    }
  }

  // Formato: el estilo del fichero por su posición de base, con lo que el `Y.Doc` le cambió encima.
  let styleBook: OdsStyleBook | null = null;
  let defaultStyle: ResolvedCellStyle | null = null;
  const styleIds = new Map<string, string>();
  const styles: Record<string, Record<string, unknown>> = {};
  const patched = new Set<string>();
  if (include.has('formats')) {
    try {
      styleBook = await readOdsStylesFromBytes(sheetBytes, { limits: SHEET_ODS_READ_LIMITS });
      defaultStyle = styleBook.resolveNamed(null);
    } catch {
      styleBook = null;
    }
    // Las celdas de la página con alguna propiedad en el `Y.Doc`: un solo recorrido del mapa.
    const prefix = `${sheet.id}/`;
    doc.getMap(CELL_STYLES_MAP).forEach((_value, key) => {
      if (!key.startsWith(prefix)) return;
      const at = key.indexOf('@');
      if (at > prefix.length) patched.add(key.slice(prefix.length, at));
    });
  }
  const baseSheet = base.model.sheets.findIndex((s) => s.id === sheet.id);

  const styleIdOf = (row: number, col: number): string | null => {
    const rowId = sheet.rows.idAt(row);
    const colId = sheet.cols.idAt(col);
    let props: Record<string, unknown> = {};
    const r = BASE_AXIS_ID.exec(rowId);
    const c = BASE_AXIS_ID.exec(colId);
    if (styleBook && defaultStyle && baseSheet >= 0 && baseSheet < styleBook.sheetCount && r && c) {
      props = styleProps(styleBook.styleAt(baseSheet, Number(r[1]), Number(c[1])), defaultStyle);
    }
    if (patched.has(`${rowId}:${colId}`)) {
      for (const [prop, value] of Object.entries(readCellStyle(doc, sheet.id, rowId, colId))) {
        props[prop] = patchValue(prop, value);
      }
    }
    if (Object.keys(props).length === 0) return null;
    const signature = JSON.stringify(props, Object.keys(props).sort());
    let id = styleIds.get(signature);
    if (!id) {
      id = `st${styleIds.size + 1}`;
      styleIds.set(signature, id);
      styles[id] = props;
    }
    return id;
  };

  const rows: PageRow[] = [];
  for (let row = first; row <= last; row++) {
    const out: PageRow = { row: row + 1, values: [] };
    const rowFormulas: Record<string, string> = {};
    const rowComments: Record<string, string> = {};
    const rowFormats: { range: string; styleId: string }[] = [];
    const rowSpilled: { from: number; to: number }[] = [];
    // Tramo de celdas seguidas de la fila con el mismo estilo.
    const open: { run: { from: number; to: number; styleId: string } | null } = { run: null };
    const closeRun = () => {
      const run = open.run;
      if (!run) return;
      const range = run.from === run.to ? cellA1(row, run.from) : `${cellA1(row, run.from)}:${cellA1(row, run.to)}`;
      rowFormats.push({ range, styleId: run.styleId });
      open.run = null;
    };
    for (let col = rect.c1; col <= rect.c2; col++) {
      const at = `${row}:${col}`;
      const cell = grid.get(at);
      const value = cell?.value ?? null;
      let shown: ReadCellValue = null;
      if (isFormula(value)) {
        shown = computed?.get(at) ?? null;
        if (include.has('formulas')) rowFormulas[cellA1(row, col)] = `=${formulaText(value.f, scope, formulas)}`;
      } else if (isStoredError(value)) {
        shown = { error: value.err };
      } else if (isEmpty(value) && (computed?.get(at) ?? null) !== null) {
        // Sin contenido propio y con valor en el motor: la rellena una matriz que se derrama.
        shown = computed!.get(at)!;
        const run = rowSpilled[rowSpilled.length - 1];
        if (run && run.to === col - 1) run.to = col;
        else rowSpilled.push({ from: col, to: col });
      } else {
        shown = value;
      }
      if (include.has('values')) out.values.push(shown);
      const comment = comments.get(at);
      if (comment !== undefined) rowComments[cellA1(row, col)] = comment;
      if (include.has('formats')) {
        const styleId = styleIdOf(row, col);
        const current = open.run;
        if (current && styleId === current.styleId && current.to === col - 1) current.to = col;
        else {
          closeRun();
          if (styleId) open.run = { from: col, to: col, styleId };
        }
      }
    }
    closeRun();
    if (include.has('formulas')) out.formulas = rowFormulas;
    if (include.has('comments')) out.comments = rowComments;
    if (include.has('formats')) out.formats = rowFormats;
    if (rowSpilled.length > 0) out.spilled = rowSpilled;
    rows.push(out);
  }

  const page: SheetPage = {
    sheetId: sheet.id,
    sheet: sheet.name,
    address: rectA1(rect),
    col: rect.c1,
    width,
    totalRows,
    offset: request.offset,
    rows,
    calculated
  };
  if (include.has('formats')) page.styles = styles;
  return page;
}

/** Un fallo del lector de `.ods` a su código cerrado. */
function readFailure(error: unknown): ReadSheetJobResult {
  // `openSheetRead` ya da el código cerrado; los campos de `file_too_large` no hacen falta aquí,
  // porque la herramienta mira el tamaño antes de mandar el trabajo.
  if (error instanceof ToolError && (error.code === 'document_too_complex' || error.code === 'file_unavailable')) {
    return { ok: false, error: { code: error.code } };
  }
  if (error instanceof ToolError && error.code === 'file_too_large') return { ok: false, error: { code: 'document_too_complex' } };
  return { ok: false, error: { code: 'document_invalid' } };
}

/**
 * Lee el documento y prepara la respuesta. No lanza: todo fallo sale como `{ ok: false }` con un
 * código cerrado, porque el hilo solo puede devolver datos.
 */
export async function runReadSheetJob(
  input: ReadSheetJobInput,
  options: ReadSheetJobOptions = {}
): Promise<ReadSheetJobResult> {
  if (input.format !== 'ods') return { ok: false, error: { code: 'op_unsupported' } };
  const signal = options.signal ?? new AbortController().signal;
  let opened: OpenedSheet;
  try {
    // El estado ya leído por la herramienta, sin volver al almacén (aquí no hay ninguno).
    const stored = { head: input.head, segments: [...input.segments], pending: [...input.pending], pendingSeqs: [] };
    const source = pinnedSource(stored, input.baseSha256, input.base);
    opened = await openSheetRead(source, { id: input.fileId, sha256: input.baseSha256 }, signal, 'empty');
  } catch (error) {
    return readFailure(error);
  }
  try {
    {
      const { sheetBase: base, read } = opened;
      const { model, revision, layoutRevision, doc } = read;
      const { request } = input;
      if (request.sheet === undefined && request.range === undefined) {
        const hasFormulas = model.sheets.some((s) => [...s.cells.values()].some(isFormula));
        const engine = hasFormulas ? await loadEngine(model, base.engineSettings, options) : null;
        let facts: Map<string, EngineSheetFacts> | null;
        try {
          facts = await engineSheetFacts(model, engine);
        } finally {
          engine?.dispose();
        }
        let findings: { cls: string; sheet?: string }[] = [];
        try {
          // Todas las entradas, con los topes de hojas: con `DEFAULT_ZIP_LIMITS` un `.ods` de 4 MiB
          // podía inflarse hasta 512 MiB aquí (H-95b).
          findings = inventoryOds(await readSafeZip(input.base, zipLimits(SHEET_ODS_INVENTORY_LIMITS))).findings;
        } catch {
          findings = [];
        }
        return { ok: true, revision, layoutRevision, workbook: summaryOf(model, findings, facts) };
      }

      const sheet = findSheet(model, request.sheet);
      if (!sheet) return { ok: false, invalid: 'sheet' };
      // Un solo motor por lectura, cargado la primera vez que haga falta.
      const slot: { loading: Promise<FormulaEngineWithValues | null> | null } = { loading: null };
      const engineOf = () => (slot.loading ??= loadEngine(model, base.engineSettings, options));
      try {
        let rect: Rect | null;
        if (request.range === undefined) {
          // El rango usado, con lo que derraman las matrices: es lo que enseña la rejilla.
          let spilled: Rect | null = null;
          if ([...sheet.cells.values()].some(isFormula)) {
            const engine = await engineOf();
            try {
              if (engine) spilled = rectOf(await spilledCells(engine, model.sheets.indexOf(sheet), ownPositions(sheet)));
            } catch {
              spilled = null;
            }
          }
          rect = unionRect(usedRect(sheet), spilled) ?? { r1: 0, c1: 0, r2: 0, c2: 0 };
        } else rect = parseA1Range(request.range);
        if (!rect) return { ok: false, invalid: 'range' };
        const rows = Math.min(MAX_ROWS, sheet.rows.length());
        const cols = Math.min(MAX_COLS, sheet.cols.length());
        if (rect.r2 >= Math.max(rows, 1) || rect.c2 >= Math.max(cols, 1)) return { ok: false, invalid: 'range' };
        if (rect.c2 - rect.c1 + 1 > request.maxCells) return { ok: false, error: { code: 'document_too_complex' } };
        const page = await pageOf(doc, base, opened.base, model, sheet, rect, request, engineOf);
        return { ok: true, revision, layoutRevision, page };
      } finally {
        (await slot.loading)?.dispose();
      }
    }
  } finally {
    await opened.close();
  }
}

/** Entrada del cargador `read` de `../../document-worker.ts`. */
export function run(input: unknown): Promise<ReadSheetJobResult> {
  return runReadSheetJob(input as ReadSheetJobInput);
}
