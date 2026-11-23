/**
 * Esquemas de los comandos de hojas (H-79, `src/server/tools/sheet-op-schemas.ts`).
 *
 * Paridad por tipos: "una operación sin esquema rompe la compilación". Los `@ts-expect-error` de
 * abajo solo compilan si quitar una entrada de la tabla es un error de tipos; si la tabla dejara de
 * exigir todas, `npm run typecheck` fallaría aquí. Rotura vista al hacer el paquete: quitar
 * `moveSheet` de `SHEET_COMMAND_SCHEMAS` o `axis.size` de `SHEET_OP_COVERAGE` en la fuente da rojo
 * en `npm run typecheck`, y cambiar el esquema de `freeze` para que produzca otra forma, también.
 *
 * Bloques opcionales (H-171): lo mismo para las tablas de esquemas de cada bloque, la de todos
 * (`OPT_COMMAND_SCHEMAS`) y las líneas de sus operaciones en `SHEET_OP_COVERAGE`. Rotura vista al
 * hacer el paquete: quitar `deleteImage` de `IMAGE_COMMAND_SCHEMAS`, `chart.series.move` de la
 * cobertura de gráficos o `clearSpillBlockers` de `SPILL_COMMAND_SCHEMAS` en la fuente da rojo en
 * `npm run typecheck`; cambiar `sortTable` para que su `order` admita `"random"`, también.
 */
import { describe, expect, it } from 'vitest';
import { OP_TABLE, type SheetCommand } from '../../src/sheets';
import {
  a1RangeSchema,
  CHART_COMMAND_SCHEMAS,
  IMAGE_COMMAND_SCHEMAS,
  inactiveOptCommand,
  isOptBlockActive,
  OPT_COMMAND_SCHEMAS,
  OPT_COMMAND_TYPES,
  parseSheetAssets,
  parseSheetCommands,
  parseSheetEditCommands,
  SHEET_COMMAND_SCHEMAS,
  SHEET_COMMAND_TYPES,
  SHEET_OP_COVERAGE,
  SHEET_OPS_DESCRIPTION,
  SHEET_OPT_BLOCKS,
  sheetCommandSchema,
  sheetEditOpsDescription,
  TABLE_COMMAND_SCHEMAS,
  type CommandSchemaTable,
  type CommandVariant,
  type OptCommand,
  type OptCommandSchemaTable,
  type OptCommandType,
  type OptOpCoverageTable,
  type SheetCommandSchemaTable,
  type SheetOpCoverageTable,
  type SheetOptBlockId
} from '../../src/server/tools/sheet-op-schemas';
import { SHEET_OP_TYPES } from '../../vendor/hebra/src/lib/sheets/contracts/ops';
import { IMAGE_OP_TYPES } from '../../vendor/hebra/src/lib/sheets/opt/img/ops';
import type { ImageCommand } from '../../vendor/hebra/src/lib/sheets/opt/img/llm';
import { TABLE_OP_TYPES, type TableOpType } from '../../vendor/hebra/src/lib/sheets/opt/tab/model';
import type { TableCommand } from '../../vendor/hebra/src/lib/sheets/opt/tab/llm';
import { CHART_OP_TYPES } from '../../vendor/hebra/src/lib/sheets/opt/cht/model';
import type { ChartCommand } from '../../vendor/hebra/src/lib/sheets/opt/cht/llm-write';
import type { SpillCommand } from '../../vendor/hebra/src/lib/sheets/opt/arr/llm';
import { EDIT_OPS_MAX, EDIT_OPS_MAX_BYTES } from '../../src/store/document-limits';

/** Un ejemplo válido de cada comando del contrato. */
const EXAMPLES: { [T in SheetCommand['type']]: SheetCommand & { type: T } } = {
  setCells: { type: 'setCells', sheet: 'Ventas', start: 'A2', rows: [['Enero', 1200, true, null, '=SUM(B1:B3)']], expect: { 'A2:E2': null } },
  setFormat: { type: 'setFormat', sheet: 'Ventas', range: 'B2:B3', format: { numberFormatCode: '#,##0.00 €', bold: 'true', fill: '#ffcc00', link: null }, expect: { B2: 1200 } },
  insertAxis: { type: 'insertAxis', sheet: 'Ventas', axis: 'row', at: 2, count: 3 },
  deleteAxis: { type: 'deleteAxis', sheet: 'Ventas', axis: 'col', at: 1, count: 1, expect: { 'A:A': null } },
  hideAxis: { type: 'hideAxis', sheet: 'Ventas', axis: 'col', at: 4, count: 2 },
  showAxis: { type: 'showAxis', sheet: 'Ventas', axis: 'row', at: 1, count: 1 },
  setAxisSize: { type: 'setAxisSize', sheet: 'Ventas', axis: 'col', at: 2, count: 3, size: 120, expect: { 'B:D': null } },
  addSheet: { type: 'addSheet', sheet: 'Resumen', as: 'resumen', hidden: true },
  setSheetHidden: { type: 'setSheetHidden', sheet: 'Resumen', hidden: false },
  deleteSheet: { type: 'deleteSheet', sheet: 'Viejo' },
  renameSheet: { type: 'renameSheet', sheet: '$resumen', name: 'Total' },
  moveSheet: { type: 'moveSheet', sheet: 'Total', to: 0 },
  freeze: { type: 'freeze', sheet: 'Ventas', rows: 1, cols: 0 },
  merge: { type: 'merge', sheet: 'Ventas', range: 'A1:C1', expect: { 'A1:C1': [['Título', null, null]] } },
  unmerge: { type: 'unmerge', sheet: 'Ventas', range: 'A1:C1', expect: { A1: 'Título' } },
  putRule: { type: 'putRule', kind: 'name', body: { name: 'tasa', formula: "'Ventas'!$B$1" }, as: 'tasa' },
  deleteRule: { type: 'deleteRule', kind: 'name', id: '$tasa' }
};

describe('paridad por tipos con la interfaz', () => {
  it('la tabla de comandos exige un esquema por cada SheetCommand', () => {
    const { moveSheet: _moveSheet, ...withoutOne } = SHEET_COMMAND_SCHEMAS;
    // @ts-expect-error falta el esquema de `moveSheet`: no debe compilar.
    const incomplete: SheetCommandSchemaTable = withoutOne;
    expect(Object.keys(incomplete)).not.toContain('moveSheet');
    // @ts-expect-error el esquema de `freeze` no produce un `freeze`: no debe compilar.
    const wrong: SheetCommandSchemaTable = { ...SHEET_COMMAND_SCHEMAS, freeze: SHEET_COMMAND_SCHEMAS.moveSheet };
    expect(wrong.freeze).toBe(SHEET_COMMAND_SCHEMAS.moveSheet);
    expect([...SHEET_COMMAND_TYPES].sort()).toEqual(Object.keys(EXAMPLES).sort());
  });

  it('cada SheetOp de la rejilla y de los bloques tiene su comando o una exclusión escrita', () => {
    const { 'axis.size': _size, ...withoutOne } = SHEET_OP_COVERAGE;
    // @ts-expect-error falta la línea de `axis.size`: no debe compilar.
    const incomplete: SheetOpCoverageTable = withoutOne;
    expect(Object.keys(incomplete)).not.toContain('axis.size');
    // Las de la rejilla y las de los bloques, sin repetir (cuando H-170 meta las de los bloques en
    // `SheetOp`, las dos listas se solapan y la unión sigue siendo la misma).
    const expected = new Set<string>([...SHEET_OP_TYPES, ...IMAGE_OP_TYPES, ...TABLE_OP_TYPES, ...CHART_OP_TYPES]);
    expect(Object.keys(SHEET_OP_COVERAGE).sort()).toEqual([...expected].sort());
    const commands: string[] = [...SHEET_COMMAND_TYPES, ...OPT_COMMAND_TYPES];
    for (const [type, coverage] of Object.entries(SHEET_OP_COVERAGE)) {
      if ('command' in coverage) expect(commands, type).toContain(coverage.command);
      else expect(coverage.excluded.length, type).toBeGreaterThan(20);
    }
  });

  it('una operación de un bloque sin su línea de cobertura no compila (H-171)', () => {
    const { 'image.set': _image, ...withoutImage } = SHEET_OP_COVERAGE;
    // @ts-expect-error falta la línea de `image.set`: no debe compilar.
    const noImage: SheetOpCoverageTable = withoutImage;
    const { 'chart.series.move': _move, ...withoutMove } = SHEET_OP_COVERAGE;
    // @ts-expect-error falta la línea de `chart.series.move`: no debe compilar.
    const noMove: SheetOpCoverageTable = withoutMove;
    // @ts-expect-error la cobertura de las tablas sin `table.restore`: no debe compilar.
    const tables: OptOpCoverageTable<TableOpType> = { 'table.put': { command: 'createTable' }, 'table.delete': { command: 'deleteTable' } };
    // @ts-expect-error un comando que no existe no cubre nada: no debe compilar.
    const invented: SheetOpCoverageTable = { ...SHEET_OP_COVERAGE, 'image.set': { command: 'pasteImage' } };
    expect([noImage, noMove, tables, invented].map((t) => Object.keys(t).length)).not.toContain(0);
  });

  it('cada comando de cada bloque tiene su esquema, y producirlo es lo que compila (H-171)', () => {
    const { deleteImage: _deleteImage, ...noDelete } = IMAGE_COMMAND_SCHEMAS;
    // @ts-expect-error falta el esquema de `deleteImage`: no debe compilar.
    const images: CommandSchemaTable<ImageCommand> = noDelete;
    const { sortTable: _sortTable, ...noSort } = TABLE_COMMAND_SCHEMAS;
    // @ts-expect-error falta el esquema de `sortTable`: no debe compilar.
    const tables: CommandSchemaTable<TableCommand> = noSort;
    const { setSeries: _setSeries, ...noSetSeries } = CHART_COMMAND_SCHEMAS;
    // @ts-expect-error falta el esquema de `setSeries`: no debe compilar.
    const charts: CommandSchemaTable<ChartCommand> = noSetSeries;
    // @ts-expect-error la tabla de matrices dinámicas vacía: falta `clearSpillBlockers`.
    const spills: CommandSchemaTable<SpillCommand> = {};
    const { insertImage: _insertImage, ...noInsert } = OPT_COMMAND_SCHEMAS;
    // @ts-expect-error la tabla de todos los bloques sin `insertImage`: no debe compilar.
    const all: OptCommandSchemaTable = noInsert;
    // @ts-expect-error el esquema de `deleteChart` no produce un `deleteChart`: no debe compilar.
    const wrong: CommandSchemaTable<ChartCommand> = { ...CHART_COMMAND_SCHEMAS, deleteChart: CHART_COMMAND_SCHEMAS.removeSeries };
    expect([images, tables, charts, spills, all, wrong].every((t) => typeof t === 'object')).toBe(true);
    expect([...OPT_COMMAND_TYPES].sort()).toEqual(Object.keys(OPT_EXAMPLES).sort());
    // La lista de comandos de cada bloque es la de su tabla de esquemas.
    const fromBlocks = Object.values(SHEET_OPT_BLOCKS).flatMap((block) => [...block.commands]);
    expect(fromBlocks.sort()).toEqual([...OPT_COMMAND_TYPES].sort());
  });
});

/** Un ejemplo válido de cada comando de los bloques opcionales (falta uno y no compila). */
const OPT_EXAMPLES: { [T in OptCommandType]: CommandVariant<OptCommand, T> } = {
  insertImage: { type: 'insertImage', sheet: 'Ventas', at: 'B3', asset: 'logo', width: 120, height: 80, dx: 4, dy: -2, alt: 'Logo', as: 'logo' },
  moveImage: { type: 'moveImage', sheet: 'Ventas', image: 'Ventas:img0', at: 'D7', dx: 0 },
  resizeImage: { type: 'resizeImage', sheet: 'Ventas', image: 'Ventas:img0', width: 240, height: 160 },
  setImageAlt: { type: 'setImageAlt', sheet: 'Ventas', image: 'Ventas:img0', alt: 'Gráfico de ventas' },
  reorderImage: { type: 'reorderImage', sheet: 'Ventas', image: 'Ventas:img0', order: 'front' },
  replaceImage: { type: 'replaceImage', sheet: 'Ventas', image: 'Ventas:img0', asset: 'logo' },
  deleteImage: { type: 'deleteImage', sheet: 'Ventas', image: 'Ventas:img0' },
  createTable: { type: 'createTable', sheet: 'Ventas', range: 'A1:C10', name: 'Ventas2026', header: true, totals: false, style: 'TableStyleMedium2' },
  convertTableToRange: { type: 'convertTableToRange', table: 'Ventas2026' },
  deleteTable: { type: 'deleteTable', table: 'Ventas2026' },
  resizeTable: { type: 'resizeTable', table: 'Ventas2026', range: 'A1:C12' },
  renameTable: { type: 'renameTable', table: 'Ventas2026', name: 'Ventas' },
  setTableTotals: { type: 'setTableTotals', table: 'Ventas', show: true },
  setTableTotal: { type: 'setTableTotal', table: 'Ventas', column: 'Importe', fn: 'sum' },
  setTableStyle: { type: 'setTableStyle', table: 'Ventas', style: null, bands: { rows: true, firstCol: false } },
  filterTable: { type: 'filterTable', table: 'Ventas', column: 'Importe', tests: [{ kind: 'number', op: '>', value: 100 }], join: 'and' },
  clearTableFilter: { type: 'clearTableFilter', table: 'Ventas' },
  sortTable: { type: 'sortTable', table: 'Ventas', column: 'Importe', order: 'desc' },
  createChart: { type: 'createChart', sheet: 'Ventas', range: 'A1:B5', kind: 'bar', seriesIn: 'cols', title: 'Ventas', position: { x: 10, y: 20 }, size: { w: 400, h: 300 }, as: 'grafico' },
  deleteChart: { type: 'deleteChart', chart: 'base-object-1' },
  setChart: { type: 'setChart', chart: '$grafico', kind: 'line', legend: 'bottom', categories: 'Ventas!A2:A5', axes: { y: { min: 0, max: null, grid: true } } },
  addSeries: { type: 'addSeries', chart: 'base-object-1', values: 'C2:C5', name: 'C1', color: '#1f77b4', after: null, as: 'coste' },
  removeSeries: { type: 'removeSeries', chart: 'base-object-1', series: 's1' },
  moveSeries: { type: 'moveSeries', chart: 'base-object-1', series: 's1', after: null },
  setSeries: { type: 'setSeries', chart: 'base-object-1', series: 's1', kind: null, color: null },
  clearSpillBlockers: { type: 'clearSpillBlockers', sheet: 'Ventas', cell: 'A1' }
};

describe('comandos de los bloques opcionales (H-171)', () => {
  it.each(Object.entries(OPT_EXAMPLES))('%s válido pasa por su esquema y por parseSheetEditCommands', (type, example) => {
    expect(OPT_COMMAND_SCHEMAS[type as OptCommandType].safeParse(example).success).toBe(true);
    expect(parseSheetEditCommands([example])).toEqual({ ok: true, ops: [example], assets: [] });
  });

  it('hebra_create_sheet (parseSheetCommands) no los admite: comando desconocido', () => {
    for (const example of Object.values(OPT_EXAMPLES)) {
      expect(parseSheetCommands([example])).toMatchObject({ ok: false, error: { code: 'batch_invalid', issues: [{ path: 'ops.0.type' }] } });
    }
  });

  it('un lote mezcla comandos de la base y de los bloques, en orden', () => {
    const ops = [EXAMPLES.setCells, OPT_EXAMPLES.createTable, OPT_EXAMPLES.clearSpillBlockers];
    const parsed = parseSheetEditCommands(ops);
    expect(parsed.ok && parsed.ops.map((op) => op.type)).toEqual(['setCells', 'createTable', 'clearSpillBlockers']);
  });

  const bad: Array<[string, unknown, string]> = [
    ['imagen por URL en un campo inventado', { type: 'insertImage', sheet: 'A', at: 'B2', asset: 'a', url: 'https://ejemplo.com/a.png' }, 'ops.0'],
    ['imagen de ancho 0', { type: 'resizeImage', sheet: 'A', image: 'i', width: 0, height: 10 }, 'ops.0.width'],
    ['imagen de más de 20.000 px', { type: 'insertImage', sheet: 'A', at: 'B2', asset: 'a', height: 20_001 }, 'ops.0.height'],
    ['orden de apilado inventado', { type: 'reorderImage', sheet: 'A', image: 'i', order: 'top' }, 'ops.0.order'],
    ['celda de ancla que es un rango', { type: 'moveImage', sheet: 'A', image: 'i', at: 'A1:B2' }, 'ops.0.at'],
    ['estilo de tabla que no es de la galería', { type: 'createTable', sheet: 'A', range: 'A1:B3', style: 'Rojo' }, 'ops.0.style'],
    ['función de totales inventada', { type: 'setTableTotal', table: 'T', column: 'C', fn: 'median' }, 'ops.0.fn'],
    ['estilo de tabla sin estilo ni bandas', { type: 'setTableStyle', table: 'T' }, 'ops.0'],
    ['más de dos condiciones de filtro', { type: 'filterTable', table: 'T', column: 'C', tests: [{ kind: 'blank' }, { kind: 'blank' }, { kind: 'blank' }] }, 'ops.0.tests'],
    ['condición de filtro inventada', { type: 'filterTable', table: 'T', column: 'C', tests: [{ kind: 'regex', text: '.*' }] }, 'ops.0.tests.0.kind'],
    ['tipo de gráfico inventado', { type: 'createChart', sheet: 'A', range: 'A1:B3', kind: 'radar' }, 'ops.0.kind'],
    ['color de serie en mayúsculas', { type: 'addSeries', chart: 'g', values: 'B2:B5', color: '#FF0000' }, 'ops.0.color'],
    ['eje con un campo inventado', { type: 'setChart', chart: 'g', axes: { z: {} } }, 'ops.0.axes'],
    ['moveSeries sin after', { type: 'moveSeries', chart: 'g', series: 's' }, 'ops.0.after'],
    ['clearSpillBlockers con un rango', { type: 'clearSpillBlockers', sheet: 'A', cell: 'A1:A3' }, 'ops.0.cell']
  ];
  it.each(bad)('%s es batch_invalid con la ruta del campo', (_label, op, path) => {
    const parsed = parseSheetEditCommands([op]);
    expect(parsed).toMatchObject({ ok: false, error: { code: 'batch_invalid', issues: [{ opIndex: 0, path }] } });
    expect(JSON.stringify(parsed)).not.toContain('ejemplo.com');
  });
});

describe('bloques activados (H-171)', () => {
  const none = () => false;
  const all = () => true;

  it('un bloque está activado cuando el registro de la app aplica todas sus operaciones', () => {
    expect(isOptBlockActive('img', none)).toBe(false);
    expect(isOptBlockActive('img', all)).toBe(true);
    expect(isOptBlockActive('tab', (type) => type !== 'table.restore')).toBe(false);
    // ARR no tiene operaciones propias: lo está siempre.
    expect(isOptBlockActive('arr', none)).toBe(true);
    // Con el registro real, lo que diga `OP_TABLE` de la app.
    for (const id of Object.keys(SHEET_OPT_BLOCKS) as SheetOptBlockId[]) {
      expect(isOptBlockActive(id), id).toBe(SHEET_OPT_BLOCKS[id].ops.every((type) => Object.hasOwn(OP_TABLE, type)));
    }
  });

  it('el primer comando de un bloque sin activar se señala con su índice', () => {
    const ops = [EXAMPLES.setCells, OPT_EXAMPLES.clearSpillBlockers, OPT_EXAMPLES.createChart, OPT_EXAMPLES.insertImage];
    expect(inactiveOptCommand(ops, none)).toEqual({ opIndex: 2, block: 'cht' });
    expect(inactiveOptCommand(ops, all)).toBeNull();
    expect(inactiveOptCommand([EXAMPLES.setCells, OPT_EXAMPLES.clearSpillBlockers], none)).toBeNull();
  });

  it('la descripción de ops solo anuncia los bloques activados', () => {
    const allOn = sheetEditOpsDescription(all);
    const allOff = sheetEditOpsDescription(none);
    for (const type of OPT_COMMAND_TYPES) expect(allOn, type).toContain(`\`${type}\``);
    expect(allOff).toContain('`clearSpillBlockers`');
    for (const type of OPT_COMMAND_TYPES.filter((t) => t !== 'clearSpillBlockers')) expect(allOff, type).not.toContain(`\`${type}\``);
    expect(allOff.startsWith(SHEET_OPS_DESCRIPTION)).toBe(true);
  });
});

describe('forma de cada comando', () => {
  it.each(Object.entries(EXAMPLES))('%s válido pasa por su esquema y por la unión', (type, example) => {
    expect(SHEET_COMMAND_SCHEMAS[type as SheetCommand['type']].safeParse(example).success).toBe(true);
    expect(sheetCommandSchema.parse(example)).toEqual(example);
  });

  it('el lote de ejemplo de todos los comandos es válido y vuelve tipado', () => {
    const parsed = parseSheetCommands(Object.values(EXAMPLES));
    expect(parsed).toMatchObject({ ok: true, assets: [] });
    if (parsed.ok) expect(parsed.ops.map((op) => op.type)).toEqual(Object.keys(EXAMPLES));
  });

  const bad: Array<[string, unknown, string]> = [
    ['comando desconocido', { type: 'insertImage', sheet: 'A' }, 'ops.0.type'],
    ['sin type', { sheet: 'A' }, 'ops.0.type'],
    ['no es un objeto', 'setCells', 'ops.0'],
    ['campo inventado', { type: 'freeze', sheet: 'A', rows: 1, cols: 0, url: 'x' }, 'ops.0'],
    ['dirección mal escrita', { type: 'setCells', sheet: 'A', start: 'A0B', rows: [[1]] }, 'ops.0.start'],
    ['rango mal escrito', { type: 'merge', sheet: 'A', range: 'A1:', expect: {} }, 'ops.0.range'],
    ['clave de expect que no es un rango', { type: 'merge', sheet: 'A', range: 'A1:B1', expect: { Ventas: null } }, 'ops.0.expect.Ventas'],
    ['número no finito', { type: 'setCells', sheet: 'A', start: 'A1', rows: [[Number.POSITIVE_INFINITY]] }, 'ops.0.rows.0.0'],
    ['un objeto en una celda', { type: 'setCells', sheet: 'A', start: 'A1', rows: [[{ err: '#REF!' }]] }, 'ops.0.rows.0.0'],
    ['clave de formato desconocida', { type: 'setFormat', sheet: 'A', range: 'A1', format: { backgroundImage: 'x' } }, 'ops.0.format'],
    ['color sin forma #rrggbb', { type: 'setFormat', sheet: 'A', range: 'A1', format: { fill: 'red' } }, 'ops.0.format.fill'],
    ['eje que no es row ni col', { type: 'insertAxis', sheet: 'A', axis: 'fila', at: 1, count: 1 }, 'ops.0.axis'],
    ['at desde 0', { type: 'insertAxis', sheet: 'A', axis: 'row', at: 0, count: 1 }, 'ops.0.at'],
    ['medida 0', { type: 'setAxisSize', sheet: 'A', axis: 'col', at: 1, count: 1, size: 0 }, 'ops.0.size'],
    ['medida por encima de 10.000 px', { type: 'setAxisSize', sheet: 'A', axis: 'row', at: 1, count: 1, size: 10_001 }, 'ops.0.size'],
    ['medida sin size', { type: 'setAxisSize', sheet: 'A', axis: 'row', at: 1, count: 1 }, 'ops.0.size'],
    ['unidad que no es px ni pt', { type: 'setAxisSize', sheet: 'A', axis: 'col', at: 1, count: 1, size: 2, unit: 'cm' }, 'ops.0.unit'],
    ['tipo de regla desconocido', { type: 'putRule', kind: 'macro', body: 'x' }, 'ops.0.kind'],
    ['alias con espacios', { type: 'addSheet', sheet: 'A', as: 'mi hoja' }, 'ops.0.as'],
    ['hidden de addSheet que no es booleano', { type: 'addSheet', sheet: 'A', hidden: 'true' }, 'ops.0.hidden'],
    ['setSheetHidden sin hidden', { type: 'setSheetHidden', sheet: 'A' }, 'ops.0.hidden'],
    ['hidden de setSheetHidden que no es booleano', { type: 'setSheetHidden', sheet: 'A', hidden: 1 }, 'ops.0.hidden'],
    ['setSheetHidden con un campo de más', { type: 'setSheetHidden', sheet: 'A', hidden: true, name: 'B' }, 'ops.0']
  ];
  it.each(bad)('%s es batch_invalid con la ruta del campo y sin el valor', (_label, op, path) => {
    const parsed = parseSheetCommands([op]);
    expect(parsed).toMatchObject({ ok: false, error: { code: 'batch_invalid', issues: [{ opIndex: 0, path }] } });
    if (!parsed.ok) expect(JSON.stringify(parsed.error)).not.toContain('backgroundImage');
  });

  it('cuenta cada comando por su índice y para en 20 fallos', () => {
    const ops = [EXAMPLES.freeze, { type: 'freeze' }, EXAMPLES.addSheet, ...Array.from({ length: 30 }, () => ({ type: 'x' }))];
    const parsed = parseSheetCommands(ops);
    if (parsed.ok) throw new Error('debía fallar');
    expect(parsed.error.code).toBe('batch_invalid');
    if (parsed.error.code !== 'batch_invalid') return;
    expect(parsed.error.issues).toHaveLength(20);
    expect(parsed.error.issues[0]!.opIndex).toBe(1);
    expect(parsed.error.issues[1]!.opIndex).toBe(3);
  });
});

describe('topes del lote', () => {
  it('de 1 a 200 comandos; más de 512 KiB es too_large', () => {
    expect(parseSheetCommands([])).toMatchObject({ ok: false, error: { code: 'batch_invalid', issues: [{ path: 'ops' }] } });
    expect(parseSheetCommands('ops')).toMatchObject({ ok: false, error: { code: 'batch_invalid' } });
    expect(parseSheetCommands(Array.from({ length: EDIT_OPS_MAX }, () => EXAMPLES.freeze)).ok).toBe(true);
    expect(parseSheetCommands(Array.from({ length: EDIT_OPS_MAX + 1 }, () => EXAMPLES.freeze))).toMatchObject({
      ok: false,
      error: { code: 'batch_invalid', issues: [{ path: 'ops' }] }
    });
    const big = { type: 'setCells', sheet: 'A', start: 'A1', rows: Array.from({ length: 40 }, () => ['x'.repeat(16_000)]) };
    expect(parseSheetCommands([big])).toEqual({ ok: false, error: { code: 'too_large', maxBytes: EDIT_OPS_MAX_BYTES } });
  });
});

describe('sin red ni imágenes remotas', () => {
  const network: Array<[string, unknown, string]> = [
    ['WEBSERVICE en una celda', { type: 'setCells', sheet: 'A', start: 'A1', rows: [['=webservice("https://x")']] }, 'ops.0.rows.0.0'],
    ['IMAGE en una celda', { type: 'setCells', sheet: 'A', start: 'A1', rows: [[1, '=IMAGE ("https://x/a.png")']] }, 'ops.0.rows.0.1'],
    ['RTD en una celda', { type: 'setCells', sheet: 'A', start: 'A1', rows: [['=RTD("srv";;"x")']] }, 'ops.0.rows.0.0'],
    ['DDE en una celda', { type: 'setCells', sheet: 'A', start: 'A1', rows: [['=DDE("soffice";"x";"A1")']] }, 'ops.0.rows.0.0'],
    ['WEBSERVICE en un nombre', { type: 'putRule', kind: 'name', body: { name: 'n', formula: 'WEBSERVICE("https://x")' } }, 'ops.0.body'],
    ['IMAGE en una validación en texto', { type: 'putRule', kind: 'validation', body: '{"formula":"IMAGE(\\"https://x\\")"}' }, 'ops.0.body']
  ];
  it.each(network)('%s es batch_invalid', (_label, op, path) => {
    expect(parseSheetCommands([op])).toMatchObject({ ok: false, error: { code: 'batch_invalid', issues: [{ path }] } });
  });

  it('el texto de una celda o de un comentario que nombra la función no es una fórmula', () => {
    expect(parseSheetCommands([{ type: 'setCells', sheet: 'A', start: 'A1', rows: [['Usa WEBSERVICE( para…']] }]).ok).toBe(true);
    expect(parseSheetCommands([{ type: 'putRule', kind: 'comment', body: { text: 'IMAGE(' } }]).ok).toBe(true);
  });

  it('una imagen solo entra por fichero, adjunto o base64: una URL no', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    expect(parseSheetAssets([{ ref: 'a', fileId: 'f1' }, { ref: 'b', noteId: 'n', attachmentId: 'x' }, { ref: 'c', dataBase64: png, mimeType: 'image/png' }]).ok).toBe(true);
    for (const asset of [
      { ref: 'a', url: 'https://ejemplo.com/a.png' },
      { ref: 'a', fileId: 'f1', href: 'https://ejemplo.com/a.png' },
      { ref: 'a', dataBase64: png, mimeType: 'image/svg+xml' }
    ]) {
      const parsed = parseSheetAssets([asset]);
      expect(parsed).toMatchObject({ ok: false, error: { code: 'batch_invalid', issues: [{ path: 'assets.0' }] } });
      expect(JSON.stringify(parsed)).not.toContain('ejemplo.com');
    }
  });
});

describe('rango A1 para lectura y render', () => {
  it.each(['A1', 'b7', '$C$2', 'A1:D20', 'A:C', '2:5', 'XFD1048576'])('%s es un rango', (range) => {
    expect(a1RangeSchema.safeParse(range).success).toBe(true);
  });
  it.each(['', 'A', '1', 'A1:', 'Hoja!A1', 'A1:B2:C3', 'ABCD1'])('%s no lo es', (range) => {
    expect(a1RangeSchema.safeParse(range).success).toBe(false);
  });
});
