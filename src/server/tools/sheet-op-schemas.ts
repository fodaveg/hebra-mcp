/**
 * Esquemas de los comandos de hojas que manda un LLM (H-79, S-02 del estudio MCP de documentos):
 * los `SheetCommand` por dirección A1 de `vendor/hebra/src/lib/sheets/contracts/commands.ts`, que
 * `compileBatch` (H-30) convierte en `SheetOp`. Los usan `hebra_create_sheet` (`./create-sheet.ts`)
 * y `hebra_edit_sheet` (H-80); `hebra_read_sheet` (H-78) y `hebra_render_sheet` (H-81) toman de
 * aquí la forma de un rango A1 (`a1RangeSchema`).
 *
 * Misma capacidad que la interfaz, comprobada por tipos (sección 4 del estudio):
 * - `SHEET_COMMAND_SCHEMAS` es una tabla con un esquema por cada `SheetCommand['type']`. Un comando
 *   nuevo en el contrato sin su esquema, o un esquema que no produce ese comando, no compila.
 * - `SHEET_OP_COVERAGE` dice, para cada `SheetOp['type']` que puede producir la rejilla, qué
 *   comando del LLM lo produce o por qué no hay ninguno (una exclusión escrita). Un `SheetOp`
 *   nuevo sin su línea tampoco compila.
 *
 * Validar no es compilar: aquí solo se mira la FORMA (tipos, direcciones bien escritas, claves de
 * formato conocidas, topes del lote) y que nada pida red. Lo que depende del libro (que la hoja
 * exista, que el rango quepa, que `expect` siga valiendo) lo decide `compileBatch` sobre el modelo.
 *
 * Sin red (D28, protección 6): ninguna fórmula de un valor ni el cuerpo de una regla puede usar
 * una función de red (`WEBSERVICE`, `IMAGE`, `RTD`, `DDE`), y los esquemas son estrictos, así que
 * una imagen por URL (en `assets`, en un comando inventado o en una clave de formato) no pasa. Todo
 * eso es `batch_invalid`, sin escribir nada.
 *
 * Los errores no repiten la entrada: cada fallo lleva el índice del comando, la ruta del campo y
 * un motivo fijo (`BatchIssue`), hasta `BATCH_INVALID_ISSUES_MAX`.
 *
 * Bloques opcionales de hojas (H-171, segunda entrega del editor): imágenes flotantes (IMG,
 * `ImageCommand`), tablas estructuradas (TAB, `TableCommand`), gráficos (CHT, `ChartCommand`),
 * matrices dinámicas (ARR, `SpillCommand`) y tablas dinámicas (PIV, `PivotCommand`). Sus comandos
 * NO son `SheetCommand` (`compileBatch` no los conoce): cada bloque tiene su tabla de esquemas con
 * la misma regla de tipos (falta uno, o
 * produce otra cosa, y no compila), sus líneas en `SHEET_OP_COVERAGE` y su entrada en
 * `SHEET_OPT_BLOCKS`. Solo `hebra_edit_sheet` los admite (`parseSheetEditCommands`); los compila
 * `./sheet-opt.ts` con las funciones del propio bloque (`vendor/hebra/src/lib/sheets/opt/`).
 * Un bloque está ACTIVADO cuando el registro de operaciones de la app (`OP_TABLE`, H-170) ya
 * aplica todas sus operaciones; si no, sus comandos responden `op_unsupported` y la descripción
 * de la herramienta no los anuncia. Lo que aporta un bloque nuevo está en el apartado «Bloques
 * opcionales».
 */
import { z } from 'zod';
import {
  MAX_IMAGE_ALT_CHARS,
  MAX_IMAGE_ID_CHARS,
  MAX_IMAGE_OFFSET_PX,
  MAX_IMAGE_SIDE_PX,
  IMAGE_OP_TYPES,
  type ImageOpType
} from '../../../vendor/hebra/src/lib/sheets/opt/img/ops';
import { IMAGE_COMMAND_TYPES, type ImageCommand } from '../../../vendor/hebra/src/lib/sheets/opt/img/llm';
import { MAX_TABLE_NAME, TABLE_OP_TYPES, TOTAL_FNS, type TableOpType } from '../../../vendor/hebra/src/lib/sheets/opt/tab/model';
import type { TableCommand } from '../../../vendor/hebra/src/lib/sheets/opt/tab/llm';
import { CHART_KINDS, CHART_OP_TYPES, type ChartOpType } from '../../../vendor/hebra/src/lib/sheets/opt/cht/model';
import type { ChartCommand } from '../../../vendor/hebra/src/lib/sheets/opt/cht/llm-write';
import type { SpillCommand } from '../../../vendor/hebra/src/lib/sheets/opt/arr/llm';
import {
  PIVOT_DATE_PARTS,
  PIVOT_FUNCTIONS,
  type PivotDatePart,
  type PivotFunction,
  type PivotOp
} from '../../../vendor/hebra/src/lib/sheets/opt/piv/model';
import { PIVOT_OP_COVERAGE, type PivotCommand } from '../../../vendor/hebra/src/lib/sheets/opt/piv/llm-write';
import type { PivotSheetOp } from '../../../vendor/hebra/src/lib/sheets/opt/piv/concur';
import { MAX_AXIS_PX, OP_TABLE, type SheetCommand, type SheetOpType } from '../../sheets';

/** La operación de rejilla de PIV (registro de PIV 1.1): una sola, que envuelve un `PivotOp`. */
export const PIVOT_SHEET_OP_TYPES = ['pivot.edit'] as const satisfies readonly PivotSheetOp['type'][];
import {
  ASSETS_MAX_BYTES,
  BATCH_INVALID_ISSUES_MAX,
  EDIT_OPS_MAX,
  EDIT_OPS_MAX_BYTES,
  EDIT_OPS_MIN
} from '../../store/document-limits';
import type { BatchIssue, DocumentAsset, DocumentError } from '../../store/document-types';

// --- Piezas comunes ---------------------------------------------------------------------------

/** Una celda A1 (`B7`, `$C$2`): hasta la columna XFD y la fila 1.048.576 los mide `compileBatch`. */
const A1_CELL = '\\$?[A-Za-z]{1,3}\\$?\\d{1,7}';
const A1_CELL_RE = new RegExp(`^${A1_CELL}$`);
/** Un rango A1: una celda, dos esquinas, columnas enteras (`A:C`) o filas enteras (`2:5`). */
const A1_RANGE_RE = new RegExp(
  `^(?:${A1_CELL}(?::${A1_CELL})?|\\$?[A-Za-z]{1,3}:\\$?[A-Za-z]{1,3}|\\$?\\d{1,7}:\\$?\\d{1,7})$`
);

/** Largo máximo del texto de una celda (el de Excel y LibreOffice). */
export const SHEET_CELL_TEXT_MAX = 32_767;
/** Largo máximo de lo que nombra una hoja en un comando: su nombre (31) o un `$alias`. */
const SHEET_REF_MAX = 64;
/** Largo máximo de un valor de formato (un código de número, un borde en JSON, un enlace). */
const FORMAT_VALUE_MAX = 4096;
/** Largo máximo del cuerpo de una regla, ya en JSON. */
const RULE_BODY_MAX = 64 * 1024;

/** Celda A1 de inicio (`start` de `setCells`). */
export const a1CellSchema = z.string().regex(A1_CELL_RE, 'celda A1 no válida');
/** Rango A1 (`range`, claves de `expect`). Lo usan también `hebra_read_sheet` y `hebra_render_sheet`. */
export const a1RangeSchema = z.string().regex(A1_RANGE_RE, 'rango A1 no válido');
/** Una hoja por su nombre o, dentro del lote, por el `as` de quien la creó (`"$ventas"`). */
export const sheetRefSchema = z.string().min(1).max(SHEET_REF_MAX);
/** El nombre que se da en `as`; los comandos siguientes lo citan como `"$nombre"`. */
const aliasSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'alias no válido').max(64);
const axisSchema = z.enum(['row', 'col']);
const ruleKindSchema = z.enum(['name', 'filter', 'validation', 'conditional', 'comment']);

/** Lo que admite una celda: vacío, sí o no, un número finito o un texto (una fórmula empieza por `=`). */
const cellInputSchema = z.union([
  z.null(),
  z.boolean(),
  z.number().refine(Number.isFinite, 'número no finito'),
  z.string().max(SHEET_CELL_TEXT_MAX)
]);

/**
 * Lo que el LLM leyó en cada destino, por dirección: un valor para una celda, `null` para un rango
 * vacío o una lista de filas con las medidas del rango. `compileBatch` lo compara con el libro.
 */
export const expectSchema = z.record(
  a1RangeSchema,
  z.union([cellInputSchema, z.array(z.array(cellInputSchema))])
);

const flagSchema = z.enum(['true', 'false']).nullable();
const formatValueSchema = z.string().max(FORMAT_VALUE_MAX);

/**
 * Claves de formato de una celda: las que el adaptador de hojas sabe escribir en el `.ods`
 * (`stylePatchOf` de `sheet-adapter.ts` y el enlace de `ops/cell-link.ts`). Cada valor es texto, o
 * `null` para quitarlo. Una clave que no está aquí (un fondo con imagen, por ejemplo) no se admite.
 */
export const sheetFormatSchema = z.strictObject({
  bold: flagSchema.optional(),
  italic: flagSchema.optional(),
  underline: flagSchema.optional(),
  strike: flagSchema.optional(),
  wrap: flagSchema.optional(),
  /** `#rrggbb`. */
  fill: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color #rrggbb').nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color #rrggbb').nullable().optional(),
  halign: z.enum(['left', 'center', 'right', 'justify']).nullable().optional(),
  valign: z.enum(['top', 'middle', 'bottom']).nullable().optional(),
  /** Nombre de un estilo de datos que ya exista en el fichero. */
  numberFormat: formatValueSchema.nullable().optional(),
  /** Código de formato de Excel (`#,##0.00 €`). */
  numberFormatCode: formatValueSchema.nullable().optional(),
  fontFamily: formatValueSchema.optional(),
  /** Puntos, como texto (`"11"`). */
  fontSize: z.string().regex(/^\d{1,3}(?:\.\d{1,2})?$/, 'tamaño en puntos').optional(),
  /** Un borde en JSON (`{"style":"solid","width":1,"color":"#000000"}`), o `null` para quitarlo. */
  'border.top': formatValueSchema.nullable().optional(),
  'border.right': formatValueSchema.nullable().optional(),
  'border.bottom': formatValueSchema.nullable().optional(),
  'border.left': formatValueSchema.nullable().optional(),
  /** Enlace de la celda en JSON (`{"href":"https://…"}`): un hipervínculo, nunca contenido que se baje. */
  link: formatValueSchema.nullable().optional()
});

// --- Un esquema por comando --------------------------------------------------------------------

type CommandType = SheetCommand['type'];

/**
 * La variante de una unión de comandos `C` con ese `type`. Las variantes que comparten forma (un
 * `type` que es una unión, como `'merge' | 'unmerge'`) se separan: `Extract` no las daría.
 */
export type CommandVariant<C, T extends string> = C extends { type: infer U }
  ? T extends U
    ? Omit<C, 'type'> & { type: T }
    : never
  : never;

/** El comando del contrato con ese `type` (las variantes que comparten forma se separan). */
export type SheetCommandOf<T extends CommandType> = CommandVariant<SheetCommand, T>;

/** Un esquema por cada comando de la unión `C`: falta uno, o produce otra cosa, y no compila. */
export type CommandSchemaTable<C extends { type: string }> = {
  readonly [T in C['type']]: z.ZodType<CommandVariant<C, T>>;
};

/** Un esquema por comando: falta uno, o produce otra cosa, y no compila. */
export type SheetCommandSchemaTable = CommandSchemaTable<SheetCommand>;

const axisCommand = <T extends 'insertAxis' | 'deleteAxis' | 'hideAxis' | 'showAxis'>(type: T) =>
  z.strictObject({
    type: z.literal(type),
    sheet: sheetRefSchema,
    axis: axisSchema,
    /** Desde 1: la fila 1 o la columna A. */
    at: z.number().int().min(1),
    count: z.number().int().min(1),
    expect: expectSchema.optional()
  });

const sheetCommand = <T extends 'deleteSheet' | 'renameSheet'>(type: T) =>
  z.strictObject({
    type: z.literal(type),
    sheet: sheetRefSchema,
    name: z.string().min(1).max(SHEET_REF_MAX).optional(),
    as: aliasSchema.optional()
  });

const mergeCommand = <T extends 'merge' | 'unmerge'>(type: T) =>
  z.strictObject({
    type: z.literal(type),
    sheet: sheetRefSchema,
    range: a1RangeSchema,
    expect: expectSchema.optional()
  });

const ruleCommand = <T extends 'putRule' | 'deleteRule'>(type: T) =>
  z.strictObject({
    type: z.literal(type),
    kind: ruleKindSchema,
    id: z.string().min(1).max(256).optional(),
    body: z.unknown().optional(),
    as: aliasSchema.optional()
  });

export const SHEET_COMMAND_SCHEMAS = {
  setCells: z.strictObject({
    type: z.literal('setCells'),
    sheet: sheetRefSchema,
    start: a1CellSchema,
    rows: z.array(z.array(cellInputSchema)).min(1),
    expect: expectSchema.optional(),
    as: aliasSchema.optional()
  }),
  setFormat: z.strictObject({
    type: z.literal('setFormat'),
    sheet: sheetRefSchema,
    range: a1RangeSchema,
    format: sheetFormatSchema,
    expect: expectSchema.optional()
  }),
  insertAxis: axisCommand('insertAxis'),
  deleteAxis: axisCommand('deleteAxis'),
  hideAxis: axisCommand('hideAxis'),
  showAxis: axisCommand('showAxis'),
  setAxisSize: z.strictObject({
    type: z.literal('setAxisSize'),
    sheet: sheetRefSchema,
    axis: axisSchema,
    /** Desde 1: la fila 1 o la columna A. */
    at: z.number().int().min(1),
    count: z.number().int().min(1),
    /**
     * Ancho o alto en píxeles CSS (o en puntos con `unit: 'pt'`), mayor que 0; `null` quita la
     * medida propia. El tope en puntos (7.500) lo mira `compileBatch` tras convertir.
     */
    size: z.number().positive().max(MAX_AXIS_PX).nullable(),
    unit: z.enum(['px', 'pt']).optional(),
    expect: expectSchema.optional()
  }),
  addSheet: z.strictObject({
    type: z.literal('addSheet'),
    sheet: sheetRefSchema,
    name: z.string().min(1).max(SHEET_REF_MAX).optional(),
    as: aliasSchema.optional(),
    /** `true` crea la hoja ya oculta (H-OCULTAR-HOJA). */
    hidden: z.boolean().optional()
  }),
  /** Oculta o muestra una hoja; nunca la última visible (lo decide `compileBatch`). */
  setSheetHidden: z.strictObject({
    type: z.literal('setSheetHidden'),
    sheet: sheetRefSchema,
    hidden: z.boolean()
  }),
  deleteSheet: sheetCommand('deleteSheet'),
  renameSheet: sheetCommand('renameSheet'),
  moveSheet: z.strictObject({
    type: z.literal('moveSheet'),
    sheet: sheetRefSchema,
    /** Posición final, desde 0, entre las hojas vivas. */
    to: z.number().int().min(0)
  }),
  freeze: z.strictObject({
    type: z.literal('freeze'),
    sheet: sheetRefSchema,
    rows: z.number().int().min(0),
    cols: z.number().int().min(0)
  }),
  merge: mergeCommand('merge'),
  unmerge: mergeCommand('unmerge'),
  putRule: ruleCommand('putRule'),
  deleteRule: ruleCommand('deleteRule')
} as const satisfies SheetCommandSchemaTable;

/** Todos los tipos de comando, en el orden de la tabla. */
export const SHEET_COMMAND_TYPES = Object.keys(SHEET_COMMAND_SCHEMAS) as CommandType[];

/** Un comando cualquiera, por su `type`. */
export const sheetCommandSchema = z.discriminatedUnion('type', [
  SHEET_COMMAND_SCHEMAS.setCells,
  SHEET_COMMAND_SCHEMAS.setFormat,
  SHEET_COMMAND_SCHEMAS.insertAxis,
  SHEET_COMMAND_SCHEMAS.deleteAxis,
  SHEET_COMMAND_SCHEMAS.hideAxis,
  SHEET_COMMAND_SCHEMAS.showAxis,
  SHEET_COMMAND_SCHEMAS.setAxisSize,
  SHEET_COMMAND_SCHEMAS.addSheet,
  SHEET_COMMAND_SCHEMAS.setSheetHidden,
  SHEET_COMMAND_SCHEMAS.deleteSheet,
  SHEET_COMMAND_SCHEMAS.renameSheet,
  SHEET_COMMAND_SCHEMAS.moveSheet,
  SHEET_COMMAND_SCHEMAS.freeze,
  SHEET_COMMAND_SCHEMAS.merge,
  SHEET_COMMAND_SCHEMAS.unmerge,
  SHEET_COMMAND_SCHEMAS.putRule,
  SHEET_COMMAND_SCHEMAS.deleteRule
]);

// --- Bloques opcionales ---------------------------------------------------------------------------
//
// Un bloque opcional aporta, en este orden (el patrón que siguió PIV, el último en entrar):
// 1. Su tabla de esquemas, `satisfies CommandSchemaTable<SuComando>`: un comando del bloque sin
//    esquema, o un esquema que produce otra forma, no compila.
// 2. Su cobertura de operaciones, `satisfies OptOpCoverageTable<SuOp['type']>`, que entra en
//    `SHEET_OP_COVERAGE`: una operación del bloque sin su comando (o su exclusión escrita) no
//    compila, tampoco cuando la app (H-170) la meta en `SheetOp`.
// 3. Su tipo de comando en `OptCommand`, sus operaciones en `OptOpType` y su entrada en
//    `SHEET_OPT_BLOCKS` (comandos y operaciones en tiempo de ejecución).
// 4. Su compilación en `./sheet-opt.ts`, con la función del bloque (nunca un camino propio).

/** Un comando de imagen nombra la imagen por el id que da `hebra_read_sheet`. */
const imageRefSchema = z.string().min(1).max(MAX_IMAGE_ID_CHARS);
/** El `ref` de un asset del lote (`sheetAssetSchema`). */
const assetRefSchema = z.string().min(1).max(64);
const imageSideSchema = z.number().positive().max(MAX_IMAGE_SIDE_PX);
const imageOffsetSchema = z.number().min(-MAX_IMAGE_OFFSET_PX).max(MAX_IMAGE_OFFSET_PX);
const imageAltSchema = z.string().max(MAX_IMAGE_ALT_CHARS);
const byImage = <T extends 'deleteImage'>(type: T) =>
  z.strictObject({ type: z.literal(type), sheet: sheetRefSchema, image: imageRefSchema });

/** IMG (H-104): imágenes flotantes, en píxeles de la hoja (96 por pulgada). */
export const IMAGE_COMMAND_SCHEMAS = {
  insertImage: z.strictObject({
    type: z.literal('insertImage'),
    sheet: sheetRefSchema,
    /** Celda de la esquina superior izquierda. */
    at: a1CellSchema,
    asset: assetRefSchema,
    width: imageSideSchema.optional(),
    height: imageSideSchema.optional(),
    dx: imageOffsetSchema.optional(),
    dy: imageOffsetSchema.optional(),
    alt: imageAltSchema.optional(),
    as: aliasSchema.optional()
  }),
  moveImage: z.strictObject({
    type: z.literal('moveImage'),
    sheet: sheetRefSchema,
    image: imageRefSchema,
    at: a1CellSchema,
    dx: imageOffsetSchema.optional(),
    dy: imageOffsetSchema.optional()
  }),
  resizeImage: z.strictObject({
    type: z.literal('resizeImage'),
    sheet: sheetRefSchema,
    image: imageRefSchema,
    width: imageSideSchema,
    height: imageSideSchema
  }),
  setImageAlt: z.strictObject({
    type: z.literal('setImageAlt'),
    sheet: sheetRefSchema,
    image: imageRefSchema,
    alt: imageAltSchema
  }),
  reorderImage: z.strictObject({
    type: z.literal('reorderImage'),
    sheet: sheetRefSchema,
    image: imageRefSchema,
    order: z.enum(['front', 'back', 'forward', 'backward'])
  }),
  replaceImage: z.strictObject({
    type: z.literal('replaceImage'),
    sheet: sheetRefSchema,
    image: imageRefSchema,
    asset: assetRefSchema
  }),
  deleteImage: byImage('deleteImage')
} as const satisfies CommandSchemaTable<ImageCommand>;

/** Nombre de una tabla o de una columna de tabla, como lo escribe la persona. */
const tableRefSchema = z.string().min(1).max(MAX_TABLE_NAME);
const tableStyleSchema = z.string().regex(/^TableStyle(?:Light|Medium|Dark)\d{1,2}$/, 'estilo de tabla no válido');
const tableTotalFnSchema = z.enum(TOTAL_FNS as readonly [(typeof TOTAL_FNS)[number], ...(typeof TOTAL_FNS)[number][]]);
const finiteNumber = z.number().refine(Number.isFinite, 'número no finito');
const tableFilterTestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    op: z.enum(['contains', 'notContains', 'begins', 'ends', 'equals', 'notEquals']),
    text: z.string().max(SHEET_CELL_TEXT_MAX)
  }),
  z.strictObject({
    kind: z.literal('number'),
    op: z.enum(['=', '<>', '>', '>=', '<', '<=', 'between']),
    value: finiteNumber,
    value2: finiteNumber.optional()
  }),
  z.strictObject({
    kind: z.literal('values'),
    values: z.array(z.union([z.string().max(SHEET_CELL_TEXT_MAX), finiteNumber, z.boolean()])).max(10_000)
  }),
  z.strictObject({ kind: z.literal('blank') }),
  z.strictObject({ kind: z.literal('nonBlank') })
]);
const tableBandsSchema = z.strictObject({
  rows: z.boolean().optional(),
  cols: z.boolean().optional(),
  firstCol: z.boolean().optional(),
  lastCol: z.boolean().optional()
});
const byTable = <T extends 'convertTableToRange' | 'deleteTable' | 'clearTableFilter'>(type: T) =>
  z.strictObject({ type: z.literal(type), table: tableRefSchema });

/** TAB (H-118): tablas estructuradas, por nombre de tabla y de columna. */
export const TABLE_COMMAND_SCHEMAS = {
  createTable: z.strictObject({
    type: z.literal('createTable'),
    sheet: sheetRefSchema,
    range: a1RangeSchema,
    name: tableRefSchema.optional(),
    header: z.boolean().optional(),
    totals: z.boolean().optional(),
    style: tableStyleSchema.nullable().optional()
  }),
  convertTableToRange: byTable('convertTableToRange'),
  deleteTable: byTable('deleteTable'),
  resizeTable: z.strictObject({ type: z.literal('resizeTable'), table: tableRefSchema, range: a1RangeSchema }),
  renameTable: z.strictObject({ type: z.literal('renameTable'), table: tableRefSchema, name: tableRefSchema }),
  setTableTotals: z.strictObject({ type: z.literal('setTableTotals'), table: tableRefSchema, show: z.boolean() }),
  setTableTotal: z.strictObject({
    type: z.literal('setTableTotal'),
    table: tableRefSchema,
    column: tableRefSchema,
    fn: tableTotalFnSchema
  }),
  setTableStyle: z
    .strictObject({
      type: z.literal('setTableStyle'),
      table: tableRefSchema,
      style: tableStyleSchema.nullable().optional(),
      bands: tableBandsSchema.optional()
    })
    .refine((c) => c.style !== undefined || c.bands !== undefined, 'falta el estilo o las bandas'),
  filterTable: z.strictObject({
    type: z.literal('filterTable'),
    table: tableRefSchema,
    column: tableRefSchema,
    tests: z.array(tableFilterTestSchema).max(2),
    join: z.enum(['and', 'or']).optional()
  }),
  clearTableFilter: byTable('clearTableFilter'),
  sortTable: z.strictObject({
    type: z.literal('sortTable'),
    table: tableRefSchema,
    column: tableRefSchema,
    order: z.enum(['asc', 'desc'])
  })
} as const satisfies CommandSchemaTable<TableCommand>;

const chartKindSchema = z.enum(CHART_KINDS as readonly [(typeof CHART_KINDS)[number], ...(typeof CHART_KINDS)[number][]]);
/** Un gráfico o una serie: el id de `hebra_read_sheet` o, dentro del lote, `"$alias"`. */
const chartRefSchema = z.string().min(1).max(256);
/** Uno o varios rangos A1 separados por espacios (`B2:B5`, `Hoja1!B2:B5`, `'Mi hoja'!B2`). */
const chartRangesSchema = z.string().min(1).max(1024);
const chartPointSchema = z.strictObject({ x: finiteNumber, y: finiteNumber });
const chartSizeSchema = z.strictObject({
  w: z.number().positive().max(20_000),
  h: z.number().positive().max(20_000)
});
const chartTextSchema = z.string().max(1024).nullable();
const chartColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'color #rrggbb en minúsculas').nullable();
const chartAxisSchema = z.strictObject({
  title: chartTextSchema.optional(),
  visible: z.boolean().optional(),
  grid: z.boolean().optional(),
  min: finiteNumber.nullable().optional(),
  max: finiteNumber.nullable().optional()
});

/** CHT (H-132): gráficos, por id (de `hebra_read_sheet`) y rangos A1. */
export const CHART_COMMAND_SCHEMAS = {
  createChart: z.strictObject({
    type: z.literal('createChart'),
    sheet: sheetRefSchema,
    range: chartRangesSchema,
    kind: chartKindSchema.optional(),
    seriesIn: z.enum(['cols', 'rows']).optional(),
    firstRowLabels: z.boolean().optional(),
    firstColLabels: z.boolean().optional(),
    title: chartTextSchema.optional(),
    position: chartPointSchema.optional(),
    size: chartSizeSchema.optional(),
    as: aliasSchema.optional()
  }),
  deleteChart: z.strictObject({ type: z.literal('deleteChart'), chart: chartRefSchema }),
  setChart: z.strictObject({
    type: z.literal('setChart'),
    chart: chartRefSchema,
    kind: chartKindSchema.optional(),
    horizontal: z.boolean().optional(),
    stacking: z.enum(['none', 'stacked', 'percent']).optional(),
    title: chartTextSchema.optional(),
    subtitle: chartTextSchema.optional(),
    legend: z.enum(['none', 'top', 'bottom', 'start', 'end']).optional(),
    categories: chartRangesSchema.nullable().optional(),
    axes: z.strictObject({ x: chartAxisSchema.optional(), y: chartAxisSchema.optional() }).optional(),
    position: chartPointSchema.optional(),
    size: chartSizeSchema.optional()
  }),
  addSeries: z.strictObject({
    type: z.literal('addSeries'),
    chart: chartRefSchema,
    after: chartRefSchema.nullable().optional(),
    name: chartRangesSchema.nullable().optional(),
    values: chartRangesSchema,
    x: chartRangesSchema.nullable().optional(),
    color: chartColorSchema.optional(),
    kind: chartKindSchema.nullable().optional(),
    as: aliasSchema.optional()
  }),
  removeSeries: z.strictObject({ type: z.literal('removeSeries'), chart: chartRefSchema, series: chartRefSchema }),
  moveSeries: z.strictObject({
    type: z.literal('moveSeries'),
    chart: chartRefSchema,
    series: chartRefSchema,
    after: chartRefSchema.nullable()
  }),
  setSeries: z.strictObject({
    type: z.literal('setSeries'),
    chart: chartRefSchema,
    series: chartRefSchema,
    name: chartRangesSchema.nullable().optional(),
    values: chartRangesSchema.optional(),
    x: chartRangesSchema.nullable().optional(),
    color: chartColorSchema.optional(),
    kind: chartKindSchema.nullable().optional()
  })
} as const satisfies CommandSchemaTable<ChartCommand>;

/**
 * ARR (H-143): matrices dinámicas. Una fórmula de matriz es un `setCells` más (con `A1#` para
 * citar lo que derrama otra); el único comando propio vacía lo que impide un desborde. Se expande
 * a `setCells` de `null` antes de `compileBatch` (`expandClearSpillBlockers`), así que no tiene
 * operaciones propias.
 */
export const SPILL_COMMAND_SCHEMAS = {
  clearSpillBlockers: z.strictObject({
    type: z.literal('clearSpillBlockers'),
    sheet: sheetRefSchema,
    /** Ancla de la fórmula con `#SPILL!`. */
    cell: a1CellSchema
  })
} as const satisfies CommandSchemaTable<SpillCommand>;

/** Una tabla dinámica (su id o su nombre) o un campo (su cabecera, su id o su nombre visible). */
const pivotRefSchema = z.string().min(1).max(256);
const pivotFunctionSchema = z.enum(PIVOT_FUNCTIONS as readonly [PivotFunction, ...PivotFunction[]]);
const pivotDatePartSchema = z.enum(PIVOT_DATE_PARTS as readonly [PivotDatePart, ...PivotDatePart[]]);
/** Un elemento de un campo (lo que sale en una celda del origen), como texto. */
const pivotItemSchema = z.string().max(SHEET_CELL_TEXT_MAX);
const pivotCellRefSchema = z.strictObject({ sheet: sheetRefSchema, at: a1CellSchema });
const pivotRangeRefSchema = z.strictObject({ sheet: sheetRefSchema, range: a1RangeSchema });
const pivotIsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha AAAA-MM-DD');
const pivotLimitSchema = finiteNumber.nullable().optional();

/**
 * PIV (H-166): tablas dinámicas, los comandos de `piv/llm-write.ts` (`PivotCommand`). Los campos se
 * citan por la cabecera de su columna; una copia, por su id o su nombre visible; el campo de
 * valores es `"$valores"`. Esquemas de `impl/opcionales/registro-piv.md` 5.4, con las listas de
 * funciones y de partes de fecha leídas del modelo.
 */
export const PIVOT_COMMAND_SCHEMAS = {
  pivotCreate: z.strictObject({
    type: z.literal('pivotCreate'),
    name: z.string().min(1).max(256),
    source: pivotRangeRefSchema,
    output: pivotCellRefSchema,
    rows: z.array(pivotRefSchema).max(64).optional(),
    columns: z.array(pivotRefSchema).max(64).optional(),
    pages: z.array(z.strictObject({ field: pivotRefSchema, selected: pivotItemSchema.nullable().optional() })).max(64).optional(),
    values: z
      .array(z.strictObject({ field: pivotRefSchema, function: pivotFunctionSchema.optional(), label: z.string().min(1).max(256).optional() }))
      .max(64)
      .optional(),
    valuesIn: z.enum(['rows', 'columns']).optional()
  }),
  pivotDelete: z.strictObject({ type: z.literal('pivotDelete'), pivot: pivotRefSchema }),
  pivotSet: z.strictObject({
    type: z.literal('pivotSet'),
    pivot: pivotRefSchema,
    name: z.string().min(1).max(256).optional(),
    source: pivotRangeRefSchema.optional(),
    output: pivotCellRefSchema.optional(),
    grandTotals: z.strictObject({ rows: z.boolean().optional(), columns: z.boolean().optional() }).optional(),
    showFilterButton: z.boolean().optional()
  }),
  pivotPlace: z.strictObject({
    type: z.literal('pivotPlace'),
    pivot: pivotRefSchema,
    field: pivotRefSchema,
    area: z.enum(['row', 'column', 'page', 'data', 'hidden']),
    index: z.number().int().min(0).optional(),
    copy: z.boolean().optional()
  }),
  pivotRemoveField: z.strictObject({ type: z.literal('pivotRemoveField'), pivot: pivotRefSchema, field: pivotRefSchema }),
  pivotFieldSet: z.strictObject({
    type: z.literal('pivotFieldSet'),
    pivot: pivotRefSchema,
    field: pivotRefSchema,
    function: pivotFunctionSchema.optional(),
    subtotals: z.array(pivotFunctionSchema).max(PIVOT_FUNCTIONS.length).optional(),
    hidden: z.array(pivotItemSchema).max(10_000).optional(),
    selected: pivotItemSchema.nullable().optional(),
    sort: z
      .strictObject({ by: z.enum(['name', 'data', 'none', 'manual']), ascending: z.boolean().optional(), value: pivotRefSchema.optional() })
      .optional(),
    order: z.array(pivotItemSchema).max(10_000).optional(),
    label: z.string().min(1).max(256).nullable().optional(),
    showEmpty: z.boolean().optional()
  }),
  pivotGroup: z.strictObject({
    type: z.literal('pivotGroup'),
    pivot: pivotRefSchema,
    field: pivotRefSchema,
    group: z
      .discriminatedUnion('by', [
        z.strictObject({ by: z.literal('number'), start: pivotLimitSchema, end: pivotLimitSchema, step: finiteNumber.refine((n) => n > 0, 'paso mayor que 0') }),
        z.strictObject({
          by: z.literal('date'),
          parts: z.array(pivotDatePartSchema).min(1).max(PIVOT_DATE_PARTS.length),
          start: pivotIsoDateSchema.nullable().optional(),
          end: pivotIsoDateSchema.nullable().optional()
        })
      ])
      .nullable()
  }),
  pivotRefresh: z.strictObject({ type: z.literal('pivotRefresh'), pivot: pivotRefSchema })
} as const satisfies CommandSchemaTable<PivotCommand>;

/** Los comandos de los bloques opcionales. Un bloque nuevo añade aquí el suyo (paso 3). */
export type OptCommand = ImageCommand | TableCommand | ChartCommand | SpillCommand | PivotCommand;
export type OptCommandType = OptCommand['type'];
/** Lo que admite `hebra_edit_sheet`: los comandos de la base y los de los bloques. */
export type SheetEditCommand = SheetCommand | OptCommand;
export type SheetEditCommandType = SheetEditCommand['type'];

/**
 * Las operaciones de los bloques opcionales (paso 3). Hoy la app aún no las mete en `SheetOp`.
 * PIV entra en la rejilla como una sola, `pivot.edit` (registro de PIV 1.1), que envuelve un
 * `PivotOp`: su detalle por operación del modelo es `PIVOT_OP_COVERAGE`.
 */
export type OptOpType = ImageOpType | TableOpType | ChartOpType | PivotSheetOp['type'];

/** Un esquema por cada comando de los bloques: falta uno y no compila. */
export type OptCommandSchemaTable = CommandSchemaTable<OptCommand>;

export const OPT_COMMAND_SCHEMAS = {
  ...IMAGE_COMMAND_SCHEMAS,
  ...TABLE_COMMAND_SCHEMAS,
  ...CHART_COMMAND_SCHEMAS,
  ...SPILL_COMMAND_SCHEMAS,
  ...PIVOT_COMMAND_SCHEMAS
} as const satisfies OptCommandSchemaTable;

/** Todos los comandos de los bloques, en el orden de la tabla. */
export const OPT_COMMAND_TYPES = Object.keys(OPT_COMMAND_SCHEMAS) as OptCommandType[];

/** Un bloque opcional en tiempo de ejecución: sus comandos y las operaciones que producen. */
export interface SheetOptBlock {
  /** Nombre para personas, en las descripciones y en los errores. */
  label: string;
  commands: readonly OptCommandType[];
  /** Tipos de operación de la rejilla que produce. Vacío: se expande a comandos de la base. */
  ops: readonly string[];
}

/** Los bloques opcionales (paso 3). */
export const SHEET_OPT_BLOCKS = {
  img: { label: 'imágenes flotantes', commands: IMAGE_COMMAND_TYPES, ops: IMAGE_OP_TYPES },
  tab: { label: 'tablas', commands: Object.keys(TABLE_COMMAND_SCHEMAS) as TableCommand['type'][], ops: TABLE_OP_TYPES },
  cht: { label: 'gráficos', commands: Object.keys(CHART_COMMAND_SCHEMAS) as ChartCommand['type'][], ops: CHART_OP_TYPES },
  arr: { label: 'matrices dinámicas', commands: Object.keys(SPILL_COMMAND_SCHEMAS) as SpillCommand['type'][], ops: [] },
  piv: { label: 'tablas dinámicas', commands: Object.keys(PIVOT_COMMAND_SCHEMAS) as PivotCommand['type'][], ops: PIVOT_SHEET_OP_TYPES }
} as const satisfies Record<string, SheetOptBlock>;

export type SheetOptBlockId = keyof typeof SHEET_OPT_BLOCKS;

/** El bloque de un comando opcional, o `null` si es de la base o desconocido. */
export function optBlockOf(type: unknown): SheetOptBlockId | null {
  if (typeof type !== 'string') return null;
  for (const [id, block] of Object.entries(SHEET_OPT_BLOCKS) as [SheetOptBlockId, SheetOptBlock][]) {
    if (block.commands.includes(type as OptCommandType)) return id;
  }
  return null;
}

/**
 * Si la app ya aplica todas las operaciones del bloque (las tiene `OP_TABLE`, H-170). Un bloque
 * sin operaciones propias (ARR) lo está siempre. `registered` solo lo cambian los tests.
 */
export function isOptBlockActive(
  id: SheetOptBlockId,
  registered: (type: string) => boolean = (type) => Object.hasOwn(OP_TABLE, type)
): boolean {
  return SHEET_OPT_BLOCKS[id].ops.every(registered);
}

/** El primer comando de un bloque sin activar, con su bloque, o `null`. */
export function inactiveOptCommand(
  commands: readonly { type: string }[],
  registered?: (type: string) => boolean
): { opIndex: number; block: SheetOptBlockId } | null {
  for (const [opIndex, command] of commands.entries()) {
    const block = optBlockOf(command.type);
    if (block !== null && !isOptBlockActive(block, registered)) return { opIndex, block };
  }
  return null;
}

// --- Paridad con la interfaz ---------------------------------------------------------------------

/**
 * De dónde sale cada operación de la rejilla en el MCP: un comando (de la base o de un bloque), o
 * por qué no hay ninguno.
 */
export type SheetOpCoverage = { readonly command: SheetEditCommandType } | { readonly excluded: string };

/** La cobertura de las operaciones de un bloque (paso 2). */
export type OptOpCoverageTable<O extends OptOpType> = { readonly [T in O]: SheetOpCoverage };

/**
 * Una línea por `SheetOp['type']` y por cada operación de los bloques: falta una y no compila.
 * Va por la unión de las dos para que compile hoy (los bloques aún no están en `SheetOp`) y
 * después de que H-170 los registre (entonces la unión es `SheetOpType`).
 */
export type SheetOpCoverageTable = { readonly [T in SheetOpType | OptOpType]: SheetOpCoverage };

/** IMG: todo comando de imagen escribe `image.set` (H-99). */
const IMAGE_OP_COVERAGE = {
  // También `moveImage`, `resizeImage`, `setImageAlt`, `reorderImage`, `replaceImage` y `deleteImage`.
  'image.set': { command: 'insertImage' },
  'image.unset': { excluded: 'Solo la genera una inversa de image.set (H-99): se pide con undoOperationId.' }
} as const satisfies OptOpCoverageTable<ImageOpType>;

/** TAB: `TABLE_UI_PARITY` de `tab/llm.ts` da la paridad de cada acción de la interfaz. */
const TABLE_OP_COVERAGE = {
  // También `resizeTable`, `renameTable`, `setTableTotals`, `setTableTotal`, `setTableStyle`,
  // `filterTable`, `clearTableFilter` y `sortTable`.
  'table.put': { command: 'createTable' },
  // También `convertTableToRange`.
  'table.delete': { command: 'deleteTable' },
  'table.restore': { excluded: 'Solo la genera la inversa de borrar una tabla del fichero: se pide con undoOperationId.' }
} as const satisfies OptOpCoverageTable<TableOpType>;

/** CHT: `CHART_OP_COVERAGE` de `cht/llm-write.ts` da además el campo de cada propiedad. */
const CHART_OP_COVERAGE = {
  'chart.create': { command: 'createChart' },
  'chart.delete': { command: 'deleteChart' },
  'chart.set': { command: 'setChart' },
  'chart.series.add': { command: 'addSeries' },
  'chart.series.remove': { command: 'removeSeries' },
  'chart.series.move': { command: 'moveSeries' },
  'chart.series.set': { command: 'setSeries' }
} as const satisfies OptOpCoverageTable<ChartOpType>;

/**
 * PIV: todo comando de tabla dinámica escribe `pivot.edit`. Qué comando da cada `PivotOp` lo dice
 * `PIVOT_OP_COVERAGE` de `piv/llm-write.ts`, que no compila si falta una; y aquí cada comando que
 * nombra tiene que tener su esquema (`PIVOT_OP_COVERAGE_HAS_SCHEMAS`).
 */
const PIVOT_COVERAGE = {
  // También `pivotDelete`, `pivotSet`, `pivotPlace`, `pivotRemoveField`, `pivotFieldSet` y `pivotGroup`.
  'pivot.edit': { command: 'pivotCreate' }
} as const satisfies OptOpCoverageTable<PivotSheetOp['type']>;

/** Cada comando de `PIVOT_OP_COVERAGE` tiene su esquema: uno sin él no compila. */
export const PIVOT_OP_COVERAGE_HAS_SCHEMAS: { readonly [T in PivotOp['type']]: readonly (keyof typeof PIVOT_COMMAND_SCHEMAS)[] } = PIVOT_OP_COVERAGE;

export const SHEET_OP_COVERAGE = {
  ...IMAGE_OP_COVERAGE,
  ...TABLE_OP_COVERAGE,
  ...CHART_OP_COVERAGE,
  ...PIVOT_COVERAGE,
  'cell.set': { command: 'setCells' },
  'cell.unset': { excluded: 'Solo la genera una inversa al deshacer (H-25b): se pide con undoOperationId.' },
  'cell.style': { command: 'setFormat' },
  'axis.insert': { command: 'insertAxis' },
  'axis.delete': { command: 'deleteAxis' },
  'axis.restore': { excluded: 'Solo la genera una inversa al deshacer un borrado de filas o columnas.' },
  'axis.hide': { command: 'hideAxis' },
  'axis.show': { command: 'showAxis' },
  // `setAxisSize` compila siempre a un `axis.sizeRun` (también para una sola fila o columna); los
  // dos ponen una medida propia, así que la rejilla y el MCP llegan a lo mismo en el `.ods`.
  'axis.size': { command: 'setAxisSize' },
  'axis.sizeRun': { command: 'setAxisSize' },
  'axis.hideRun': { command: 'hideAxis' },
  'axis.runs': { excluded: 'Solo la genera una inversa de axis.sizeRun o axis.hideRun.' },
  'sheet.add': { command: 'addSheet' },
  'sheet.delete': { command: 'deleteSheet' },
  'sheet.rename': { command: 'renameSheet' },
  'sheet.move': { command: 'moveSheet' },
  'sheet.hide': { command: 'setSheetHidden' },
  'sheet.freeze': { command: 'freeze' },
  'range.merge': { command: 'merge' },
  'range.unmerge': { command: 'unmerge' },
  'range.restore': { excluded: 'Solo la genera una inversa de combinar o descombinar (H-178).' },
  'rule.put': { command: 'putRule' },
  'rule.delete': { command: 'deleteRule' }
} as const satisfies SheetOpCoverageTable;

// --- Imágenes del lote ---------------------------------------------------------------------------

/**
 * Una imagen del lote (sección 4 del estudio): un fichero de la biblioteca, un adjunto de una nota
 * o los bytes en base64 con su tipo. Nunca una URL: el esquema es estricto y no hay otra forma.
 */
export const sheetAssetSchema = z.union([
  z.strictObject({ ref: z.string().min(1).max(64), fileId: z.string().min(1).max(256) }),
  z.strictObject({
    ref: z.string().min(1).max(64),
    noteId: z.string().min(1).max(256),
    attachmentId: z.string().min(1).max(256)
  }),
  z.strictObject({
    ref: z.string().min(1).max(64),
    dataBase64: z.string().min(1),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  })
]);

// --- Validar un lote -----------------------------------------------------------------------------

/** Funciones que harían red al calcular o al abrir el fichero (la regla de `compileBatch`, más `DDE`). */
const NETWORK_FUNCTION = /\b(?:WEBSERVICE|IMAGE|RTD|DDE)\s*\(/i;

/** Resultado de validar: los comandos ya tipados, o el error del lote sin escribir nada. */
export type SheetCommandsParse =
  | { ok: true; ops: SheetCommand[]; assets: DocumentAsset[] }
  | { ok: false; error: DocumentError<'batch_invalid' | 'too_large'> };

const issue = (opIndex: number, path: string, reason: string, expected?: string): BatchIssue => ({
  opIndex,
  path,
  reason,
  ...(expected !== undefined ? { expected } : {})
});

/** Los textos de un valor JSON cualquiera (el cuerpo de una regla), claves incluidas. */
function stringsOf(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 32) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out, depth + 1);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      stringsOf(item, out, depth + 1);
    }
  }
  return out;
}

/** Dónde pide red un comando ya con su forma: la ruta del campo, o `null`. */
function networkPathOf(command: SheetCommand): string | null {
  if (command.type === 'setCells') {
    for (const [r, row] of command.rows.entries()) {
      for (const [c, value] of row.entries()) {
        if (typeof value === 'string' && value.startsWith('=') && NETWORK_FUNCTION.test(value)) {
          return `rows.${r}.${c}`;
        }
      }
    }
    return null;
  }
  if (command.type === 'putRule' && command.kind !== 'comment') {
    // Nombres, filtros, validaciones y formatos condicionales llevan fórmulas en su cuerpo.
    if (stringsOf(command.body).some((text) => NETWORK_FUNCTION.test(text))) return 'body';
  }
  return null;
}

/** El cuerpo de una regla, como lo guardará `compileBatch`, cabe en el tope. */
function ruleBodyTooLarge(command: SheetCommand): boolean {
  if (command.type !== 'putRule' || command.body === undefined) return false;
  const text = typeof command.body === 'string' ? command.body : JSON.stringify(command.body);
  return text === undefined || Buffer.byteLength(text, 'utf8') > RULE_BODY_MAX;
}

/** Qué comandos admite un lote: los de la base (`hebra_create_sheet`) o también los de los bloques. */
type CommandSet = { types: readonly string[]; schemas: Readonly<Record<string, z.ZodType>> };

const BASE_COMMANDS: CommandSet = { types: SHEET_COMMAND_TYPES, schemas: SHEET_COMMAND_SCHEMAS };
const EDIT_COMMANDS: CommandSet = {
  types: [...SHEET_COMMAND_TYPES, ...OPT_COMMAND_TYPES],
  schemas: { ...SHEET_COMMAND_SCHEMAS, ...OPT_COMMAND_SCHEMAS }
};

/** El primer fallo de forma de un comando, con la ruta de zod sin el valor. */
function shapeIssue(opIndex: number, raw: unknown, set: CommandSet): BatchIssue | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return issue(opIndex, `ops.${opIndex}`, 'el comando debe ser un objeto');
  }
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== 'string' || !set.types.includes(type)) {
    return issue(opIndex, `ops.${opIndex}.type`, 'comando desconocido', set.types.join(', '));
  }
  const parsed = set.schemas[type]!.safeParse(raw);
  if (parsed.success) return null;
  const first = parsed.error.issues[0];
  const path = ['ops', opIndex, ...(first?.path ?? [])].map(String).join('.');
  // El mensaje de zod no repite el valor, pero sí puede nombrar una clave inventada: la ruta basta.
  const reason = first?.code === 'unrecognized_keys' ? 'campo no admitido' : (first?.message ?? 'forma no válida');
  return issue(opIndex, path, reason);
}

/**
 * Valida un lote de comandos de hojas y, si los hay, sus imágenes. Entre 1 y 200 comandos y hasta
 * 512 KiB en JSON (si no, `too_large`, como `runDocumentOps`), cada uno con la forma de su esquema
 * y sin funciones de red. Devuelve hasta 20 fallos a la vez; no mira el libro.
 */
export function parseSheetCommands(rawOps: unknown, rawAssets?: unknown): SheetCommandsParse {
  return parseCommands(rawOps, rawAssets, BASE_COMMANDS) as SheetCommandsParse;
}

/** Lo que da `parseSheetEditCommands`: comandos de la base y de los bloques. */
export type SheetEditCommandsParse =
  | { ok: true; ops: SheetEditCommand[]; assets: DocumentAsset[] }
  | { ok: false; error: DocumentError<'batch_invalid' | 'too_large'> };

/**
 * Lo mismo que `parseSheetCommands` admitiendo además los comandos de los bloques opcionales
 * (`OPT_COMMAND_SCHEMAS`). Es la entrada de `hebra_edit_sheet`. Que el bloque esté activado no se
 * mira aquí (`inactiveOptCommand`): esto es solo la forma.
 */
export function parseSheetEditCommands(rawOps: unknown, rawAssets?: unknown): SheetEditCommandsParse {
  return parseCommands(rawOps, rawAssets, EDIT_COMMANDS);
}

function parseCommands(rawOps: unknown, rawAssets: unknown, set: CommandSet): SheetEditCommandsParse {
  const invalid = (issues: BatchIssue[]): SheetEditCommandsParse => ({
    ok: false,
    error: { code: 'batch_invalid', issues: issues.slice(0, BATCH_INVALID_ISSUES_MAX) }
  });
  if (!Array.isArray(rawOps) || rawOps.length < EDIT_OPS_MIN) {
    return invalid([issue(0, 'ops', 'sin comandos', `de ${EDIT_OPS_MIN} a ${EDIT_OPS_MAX} comandos`)]);
  }
  if (rawOps.length > EDIT_OPS_MAX) {
    return invalid([issue(0, 'ops', 'demasiados comandos', `como mucho ${EDIT_OPS_MAX}`)]);
  }
  const json = JSON.stringify(rawOps);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > EDIT_OPS_MAX_BYTES) {
    const detail = { maxBytes: EDIT_OPS_MAX_BYTES };
    return { ok: false, error: { code: 'too_large', ...detail } };
  }
  const issues: BatchIssue[] = [];
  const ops: SheetEditCommand[] = [];
  for (const [index, raw] of rawOps.entries()) {
    const shape = shapeIssue(index, raw, set);
    if (shape) {
      issues.push(shape);
      continue;
    }
    if (optBlockOf((raw as { type: unknown }).type) !== null) {
      // Ningún comando de los bloques lleva fórmulas ni cuerpos de regla.
      ops.push(raw as OptCommand);
      continue;
    }
    const command = raw as SheetCommand;
    const network = networkPathOf(command);
    if (network !== null) {
      issues.push(issue(index, `ops.${index}.${network}`, 'usa una función de red, que no se admite'));
      continue;
    }
    if (ruleBodyTooLarge(command)) {
      issues.push(issue(index, `ops.${index}.body`, 'cuerpo de regla demasiado grande', `hasta ${RULE_BODY_MAX} bytes`));
      continue;
    }
    ops.push(command);
  }

  const assets = parseAssetsInto(rawAssets, issues);
  if (issues.length > 0) return invalid(issues);
  return { ok: true, ops, assets };
}

/** Valida las imágenes del lote y deja sus fallos en `issues`. Sin `rawAssets`, ninguna. */
function parseAssetsInto(rawAssets: unknown, issues: BatchIssue[]): DocumentAsset[] {
  const assets: DocumentAsset[] = [];
  if (rawAssets === undefined) return assets;
  if (!Array.isArray(rawAssets)) {
    issues.push(issue(0, 'assets', 'debe ser una lista'));
    return assets;
  }
  let base64 = 0;
  for (const [index, raw] of rawAssets.entries()) {
    const parsed = sheetAssetSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push(issue(0, `assets.${index}`, 'imagen no admitida: fileId, noteId y attachmentId, o dataBase64 y mimeType'));
      continue;
    }
    if ('dataBase64' in parsed.data) base64 += parsed.data.dataBase64.length;
    assets.push(parsed.data as DocumentAsset);
  }
  // Tope de la suma en base64 (sección 4 del estudio): se mira antes de decodificar nada.
  if (base64 > Math.ceil(ASSETS_MAX_BYTES / 3) * 4) {
    issues.push(issue(0, 'assets', 'imágenes demasiado grandes', `hasta ${ASSETS_MAX_BYTES} bytes en total`));
  }
  return assets;
}

/** Solo las imágenes, para quien no manda comandos (`hebra_create_sheet` sin `ops`). */
export function parseSheetAssets(
  rawAssets: unknown
): { ok: true; assets: DocumentAsset[] } | { ok: false; error: DocumentError<'batch_invalid'> } {
  const issues: BatchIssue[] = [];
  const assets = parseAssetsInto(rawAssets, issues);
  if (issues.length > 0) {
    return { ok: false, error: { code: 'batch_invalid', issues: issues.slice(0, BATCH_INVALID_ISSUES_MAX) } };
  }
  return { ok: true, assets };
}

/**
 * Descripción de `ops` para el registro (H-177): el registro usa un esquema laxo (una lista de
 * objetos) y `parseSheetCommands` da los fallos como `batch_invalid`, sin el eco del error de
 * validación del SDK.
 */
export const SHEET_OPS_DESCRIPTION =
  'Comandos por dirección A1, de 1 a 200, en orden. Cada uno lleva `type`: ' +
  '`setCells` {sheet, start:"A1", rows:[[valor,…],…]} (un texto que empieza por "=" es una fórmula, en inglés y con coma: "=SUM(A1:A3)"); ' +
  '`setFormat` {sheet, range:"A1:B3", format:{bold,italic,underline,strike,wrap:"true"|"false", fill,color:"#rrggbb", halign, valign, numberFormatCode, fontFamily, fontSize, "border.top"…, link}}; ' +
  '`insertAxis`, `deleteAxis`, `hideAxis`, `showAxis` {sheet, axis:"row"|"col", at (desde 1), count}; ' +
  '`setAxisSize` {sheet, axis, at, count, size (px, o pt con unit:"pt"; null quita la medida), unit?}; ' +
  '`addSheet` {sheet:nombre, as?, hidden?:true crea la hoja oculta}, `setSheetHidden` {sheet, hidden:true|false} (nunca la última hoja visible), `deleteSheet` {sheet}, `renameSheet` {sheet, name}, `moveSheet` {sheet, to (desde 0)}, `freeze` {sheet, rows, cols}; ' +
  '`merge`, `unmerge` {sheet, range}; `putRule`, `deleteRule` {kind:"name"|"filter"|"validation"|"conditional"|"comment", id?, body?, as?}. ' +
  'Una hoja creada en el lote se cita como "$alias". Ninguna fórmula puede usar WEBSERVICE, IMAGE, RTD ni DDE.';

/** El campo `ops` del registro: laxo a propósito (ver `SHEET_OPS_DESCRIPTION`). */
export const sheetOpsField = z
  .array(z.record(z.string(), z.unknown()))
  .describe(SHEET_OPS_DESCRIPTION);

/** El campo `assets` del registro, laxo como `ops`: lo valida `parseSheetCommands`. */
export const sheetAssetsField = z
  .array(z.record(z.string(), z.unknown()))
  .optional()
  .describe('Imágenes del lote: {ref, fileId}, {ref, noteId, attachmentId} o {ref, dataBase64, mimeType} (PNG, JPEG, GIF o WebP; 5 MiB en total). Nunca una URL.');

/** Cómo se describe cada bloque opcional en `ops` de `hebra_edit_sheet` (paso 3 de un bloque). */
export const SHEET_OPT_DESCRIPTIONS: { readonly [B in SheetOptBlockId]: string } = {
  img:
    'Imágenes flotantes (ids en hebra_read_sheet con include "objects"): `insertImage` {sheet, at:"B3", asset (el ref de assets), width?, height?, dx?, dy? (px), alt?, as?}, ' +
    '`moveImage` {sheet, image, at, dx?, dy?}, `resizeImage` {sheet, image, width, height}, `setImageAlt` {sheet, image, alt}, ' +
    '`reorderImage` {sheet, image, order:"front"|"back"|"forward"|"backward"}, `replaceImage` {sheet, image, asset}, `deleteImage` {sheet, image}. ',
  tab:
    'Tablas, por nombre de tabla y de columna: `createTable` {sheet, range, name?, header?, totals?, style?:"TableStyleMedium2"}, ' +
    '`convertTableToRange` {table}, `deleteTable` {table} (vacía sus celdas), `resizeTable` {table, range}, `renameTable` {table, name}, ' +
    '`setTableTotals` {table, show}, `setTableTotal` {table, column, fn:"sum"|"average"|"count"|"countNums"|"max"|"min"|"stdDev"|"var"|"none"}, ' +
    '`setTableStyle` {table, style?, bands?:{rows,cols,firstCol,lastCol}}, `filterTable` {table, column, tests:[{kind:"text"|"number"|"values"|"blank"|"nonBlank",…}], join?}, ' +
    '`clearTableFilter` {table}, `sortTable` {table, column, order:"asc"|"desc"}. ',
  cht:
    'Gráficos (ids en hebra_read_sheet con include "objects"): `createChart` {sheet, range, kind?:"bar"|"line"|"area"|"pie"|"doughnut"|"scatter", seriesIn?, firstRowLabels?, firstColLabels?, title?, position?:{x,y}, size?:{w,h}, as?}, ' +
    '`deleteChart` {chart}, `setChart` {chart, kind?, horizontal?, stacking?, title?, subtitle?, legend?, categories?, axes?:{x,y}, position?, size?}, ' +
    '`addSeries` {chart, values, name?, x?, color?:"#rrggbb", kind?, after?, as?}, `removeSeries` {chart, series}, `moveSeries` {chart, series, after}, `setSeries` {chart, series, name?, values?, x?, color?, kind?}. ',
  arr:
    '`clearSpillBlockers` {sheet, cell:"A1"} vacía las celdas que impiden que la fórmula de esa celda se desborde (#SPILL!). Una fórmula de matriz (SEQUENCE, FILTER, SORT, UNIQUE…) se desborda a las celdas vecinas; otra fórmula puede citar el rango entero como "A1#". ',
  piv:
    'Tablas dinámicas (ids en hebra_read_sheet con include "objects"): los campos se citan por la cabecera de su columna, una copia por su id o su nombre visible, y el campo de valores es "$valores". ' +
    '`pivotCreate` {name, source:{sheet, range:"A1:D50"}, output:{sheet, at:"F2"}, rows?, columns?, pages?:[{field, selected?}], values?:[{field, function?:"sum"|"count"|"average"|…, label?}], valuesIn?:"rows"|"columns"}, ' +
    '`pivotDelete` {pivot}, `pivotSet` {pivot, name?, source?, output?, grandTotals?:{rows?, columns?}, showFilterButton?}, `pivotPlace` {pivot, field, area:"row"|"column"|"page"|"data"|"hidden", index?, copy?}, ' +
    '`pivotRemoveField` {pivot, field}, `pivotFieldSet` {pivot, field, function?, subtotals?, hidden?, selected?, sort?:{by:"name"|"data"|"none"|"manual", ascending?, value?}, order?, label?, showEmpty?}, ' +
    '`pivotGroup` {pivot, field, group:{by:"number", start?, end?, step} | {by:"date", parts:["years"|"quarters"|"months"|…], start?, end?} | null}, `pivotRefresh` {pivot}. ' +
    'Crear, cambiar el origen o pivotRefresh recalcula la salida; los demás cambios no (termina el lote con pivotRefresh). Si una celda ocupada lo impide, el lote falla con las celdas que estorban. '
};

/** Los bloques activados ahora, en el orden de `SHEET_OPT_BLOCKS`. */
export function activeOptBlocks(registered?: (type: string) => boolean): SheetOptBlockId[] {
  return (Object.keys(SHEET_OPT_BLOCKS) as SheetOptBlockId[]).filter((id) => isOptBlockActive(id, registered));
}

/**
 * Descripción de `ops` de `hebra_edit_sheet`: la de la base y la de cada bloque ACTIVADO. Los
 * comandos de un bloque sin activar no se anuncian (responden `op_unsupported`).
 */
export function sheetEditOpsDescription(registered?: (type: string) => boolean): string {
  const blocks = activeOptBlocks(registered).map((id) => SHEET_OPT_DESCRIPTIONS[id]);
  return blocks.length === 0 ? SHEET_OPS_DESCRIPTION : `${SHEET_OPS_DESCRIPTION} ${blocks.join('')}`.trim();
}

/** El campo `ops` de `hebra_edit_sheet`, laxo como `sheetOpsField`: lo valida `parseSheetEditCommands`. */
export const sheetEditOpsField = z.array(z.record(z.string(), z.unknown())).describe(sheetEditOpsDescription());

/** El campo `assets` de `hebra_edit_sheet`: las imágenes que citan `insertImage` y `replaceImage`. */
export const sheetEditAssetsField = z
  .array(z.record(z.string(), z.unknown()))
  .optional()
  .describe(
    'Imágenes que citan insertImage y replaceImage por su ref: {ref, fileId}, {ref, noteId, attachmentId} o {ref, dataBase64, mimeType} (PNG, JPEG, GIF o WebP; 5 MiB en total). Nunca una URL. Una que no se ve da not_found.'
  );
