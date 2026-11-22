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
 */
import { z } from 'zod';
import { MAX_AXIS_PX, type SheetCommand, type SheetOpType } from '../../sheets';
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

/** El comando del contrato con ese `type` (las variantes que comparten forma se separan). */
export type SheetCommandOf<T extends CommandType> = SheetCommand extends infer C
  ? C extends { type: infer U }
    ? T extends U
      ? Omit<C, 'type'> & { type: T }
      : never
    : never
  : never;

/** Un esquema por comando: falta uno, o produce otra cosa, y no compila. */
export type SheetCommandSchemaTable = { readonly [T in CommandType]: z.ZodType<SheetCommandOf<T>> };

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

// --- Paridad con la interfaz ---------------------------------------------------------------------

/** De dónde sale cada operación de la rejilla en el MCP: un comando, o por qué no hay ninguno. */
export type SheetOpCoverage = { readonly command: CommandType } | { readonly excluded: string };

/** Una línea por `SheetOp['type']`: falta una y no compila. */
export type SheetOpCoverageTable = { readonly [T in SheetOpType]: SheetOpCoverage };

export const SHEET_OP_COVERAGE = {
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

/** El primer fallo de forma de un comando, con la ruta de zod sin el valor. */
function shapeIssue(opIndex: number, raw: unknown): BatchIssue | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return issue(opIndex, `ops.${opIndex}`, 'el comando debe ser un objeto');
  }
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== 'string' || !(SHEET_COMMAND_TYPES as string[]).includes(type)) {
    return issue(opIndex, `ops.${opIndex}.type`, 'comando desconocido', SHEET_COMMAND_TYPES.join(', '));
  }
  const parsed = SHEET_COMMAND_SCHEMAS[type as CommandType].safeParse(raw);
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
  const invalid = (issues: BatchIssue[]): SheetCommandsParse => ({
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
  const ops: SheetCommand[] = [];
  for (const [index, raw] of rawOps.entries()) {
    const shape = shapeIssue(index, raw);
    if (shape) {
      issues.push(shape);
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
