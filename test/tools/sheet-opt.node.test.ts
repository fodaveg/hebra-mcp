/**
 * El cableado de los bloques opcionales de hojas en el MCP (H-171, `src/server/tools/sheet-opt.ts`)
 * contra libros reales: lo que el fichero base trae (tablas, gráficos, imágenes), su descripción
 * para `hebra_read_sheet` y la compilación de los comandos de cada bloque con la función del
 * propio bloque. Aplicar sus operaciones es de la app (`OP_TABLE`, H-170): aquí se compila contra
 * un libro y se mira lo que sale.
 *
 * Pruebas negativas hechas a mano al escribirlo (se rompe, el test cae, se restaura):
 * - `chartDataOf` dando el valor de caché de una fórmula como si estuviera calculado (`yield
 *   { value: 0 }` en vez de `{ f }`): cae «un dato sin recalcular».
 * - `compileImageRun` respondiendo `batch_invalid` a un asset oculto: cae «oculto y ausente».
 * - `resolveLotAsset` leyendo el `fileId` en vez del SHA juzgado (`sha(index)` ignorado): cae su
 *   test.
 * - `liveImages` sin quitar los marcos de objeto (`objectFrames`): cae «la imagen de reemplazo de
 *   un gráfico» (sale como imagen y `deleteImage` compila contra el marco del gráfico).
 * - PIV, `occupiedIn` que nunca ve nada ocupado: cae «una salida que pisa algo ocupado».
 * - PIV, `rangeValuesOf` dando los valores escritos de una hoja con fórmulas sin motor: cae «un
 *   origen con fórmulas sin motor».
 * - PIV, sin `withRealSheets` (la hoja tal como la escribe el LLM): caen «pivotCreate crea» y
 *   «una salida que pisa algo ocupado» (hoja que no existe).
 * - PIV, sin el rechazo de una cabecera vacía o repetida (`readHeaders`): cae «una salida que pisa
 *   algo ocupado».
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { segmentsOf } from '../../src/server/tools/edit-sheet';
import {
  baseObjectsOf,
  compileChartRun,
  compileImageRun,
  compilePivotRun,
  compileTableAt,
  describeTable,
  liveImages,
  livePivots,
  liveTables,
  objectCountsOf,
  pivotViewsOf,
  pivotWarningsOf,
  resolveLotAsset,
  sheetObjectsOf,
  type OptCompileState
} from '../../src/server/tools/sheet-opt';
import { compileBatch, createSheetAdapter, prepareSheetBase, type SheetModel, type SheetOp } from '../../src/sheets';
import { applyPivotSheetOp, type PivotSheetOp } from '../../vendor/hebra/src/lib/sheets/opt/piv/concur';
import { pivotOds } from '../fixtures/pivot-ods';
import { SHEET_ODS_INVENTORY_LIMITS, SHEET_ODS_READ_LIMITS } from '../../src/store/sheet-limits';
import { odsWithChart } from '../../vendor/hebra/src/lib/sheets/opt/cht/test-ods';
import { buildImageBook, PNG_A } from '../../vendor/hebra/src/lib/sheets/opt/img/img.fixture';
import { tableOds } from '../fixtures/table-ods';

const live = new AbortController().signal;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Un libro abierto como lo abre la lectura común: base, adaptador, `Y.Doc` vacío y modelo. */
async function open(bytes: Uint8Array) {
  const sheetBase = await prepareSheetBase(bytes, SHEET_ODS_READ_LIMITS);
  const adapter = createSheetAdapter(sheetBase, { limits: SHEET_ODS_INVENTORY_LIMITS });
  const doc = new Y.Doc();
  const model = await adapter.project(bytes, doc, live);
  return { bytes, sheetBase, adapter, doc, model };
}

type Opened = Awaited<ReturnType<typeof open>>;

const stateOf = (book: Opened, model: SheetModel = book.model): OptCompileState => ({
  model,
  doc: book.doc,
  bytes: book.bytes,
  sheetBase: book.sheetBase,
  seed: 'semilla',
  engine: async () => null
});

describe('tablas del fichero y comandos de tabla (TAB)', () => {
  it('lee la tabla del fichero y la describe por nombre, rango y columnas', async () => {
    const book = await open(tableOds());
    const base = await baseObjectsOf(book.sheetBase);
    expect(base.tables.map((t) => t.body.name)).toEqual(['Ventas2026']);
    const [table] = liveTables(book.doc, base, book.model);
    expect(describeTable(table!, book.model.sheets[0]!)).toEqual({
      name: 'Ventas2026',
      range: 'A1:B4',
      header: true,
      totals: false,
      columns: ['Mes', 'Importe'],
      style: null,
      filteredColumns: [],
      sortedBy: null
    });
  });

  it('createTable compila a table.put; una que pisa otra tabla es batch_invalid en su comando', async () => {
    const book = await open(tableOds());
    const ok = await compileTableAt({ index: 2, command: { type: 'createTable', sheet: 'Ventas', range: 'D1:E3', name: 'Otra' } }, stateOf(book));
    expect(ok.ok && ok.ops.some((op) => op.type === 'table.put')).toBe(true);
    const overlap = await compileTableAt({ index: 5, command: { type: 'createTable', sheet: 'Ventas', range: 'A2:B3' } }, stateOf(book));
    expect(overlap).toMatchObject({ ok: false, error: { code: 'batch_invalid', issues: [{ opIndex: 5, path: 'ops.5' }] } });
    const unknown = await compileTableAt({ index: 0, command: { type: 'renameTable', table: 'NoEsta', name: 'X' } }, stateOf(book));
    expect(unknown).toMatchObject({ ok: false, error: { code: 'batch_invalid' } });
  });

  it('sortTable por una columna de la tabla compila con el plan de la interfaz', async () => {
    const book = await open(tableOds());
    const out = await compileTableAt({ index: 0, command: { type: 'sortTable', table: 'ventas2026', column: 'importe', order: 'desc' } }, stateOf(book));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.ops.map((op) => op.type)).toContain('table.put');
  });
});

describe('gráficos del fichero y comandos de gráfico (CHT)', () => {
  it('describe el gráfico del fichero con sus datos, fiables si son valores escritos', async () => {
    const book = await open(odsWithChart());
    const base = await baseObjectsOf(book.sheetBase);
    expect([...base.charts.keys()]).toEqual(['base-object-1']);
    const objects = await sheetObjectsOf({ ...book, sheet: book.model.sheets[0]!, engine: null });
    const [chart] = objects.charts;
    expect(chart).toMatchObject({ id: 'base-object-1', kind: 'bar', reliable: true, categories: ['Ene', 'Feb', 'Mar', 'Abr'] });
    expect(chart!.series.map((s) => [s.name, s.values, s.reliable])).toEqual([
      ['Norte', [1, 4, 7, 2], true],
      ['Sur', [2, 5, 8, 3], true],
      ['Este', [3, 6, 9, 4], true]
    ]);
    // La otra hoja no tiene gráficos.
    expect((await sheetObjectsOf({ ...book, sheet: book.model.sheets[1]!, engine: null })).charts).toEqual([]);
  });

  it('un dato sin recalcular (una fórmula sin motor) marca la serie y el gráfico como no fiables', async () => {
    const book = await open(odsWithChart());
    const compiled = compileBatch(
      book.model,
      { ops: [{ type: 'setCells', sheet: 'Hoja1', start: 'B2', rows: [['=1+3']] }], expectedRevision: 'x' },
      { newId: () => 'id-b2' }
    );
    if ('error' in compiled) throw new Error(compiled.reason);
    book.adapter.scaffold(book.bytes, book.doc);
    for (const op of compiled.ops) book.adapter.applyOp(book.doc, op, { newId: () => 'n' });
    const model = await book.adapter.project(book.bytes, book.doc, live);
    const [chart] = (await sheetObjectsOf({ ...book, model, sheet: model.sheets[0]!, engine: null })).charts;
    expect(chart!.reliable).toBe(false);
    expect(chart!.series[0]).toMatchObject({ name: 'Norte', reliable: false, reasons: ['hay fórmulas sin calcular'], staleCells: ['Hoja1!B2'] });
    // Las otras series siguen siendo fiables: el aviso es de la que tiene el dato.
    expect(chart!.series.slice(1).map((s) => s.reliable)).toEqual([true, true]);
  });

  it('createChart con as da su id en createdIds; un gráfico que no existe es batch_invalid con su campo', async () => {
    const book = await open(odsWithChart());
    const base = await baseObjectsOf(book.sheetBase);
    const ok = compileChartRun(
      [
        { index: 1, command: { type: 'createChart', sheet: 'Hoja1', range: 'A1:C5', kind: 'line', as: 'nuevo' } },
        { index: 2, command: { type: 'setChart', chart: '$nuevo', title: 'Ventas' } }
      ],
      stateOf(book),
      base
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.ops.map((op) => op.type)).toEqual(['chart.create', 'chart.set']);
    const created = ok.ops[0] as { type: 'chart.create'; chart: { id: string } };
    expect(ok.createdIds).toEqual({ nuevo: created.chart.id });
    const bad = compileChartRun([{ index: 3, command: { type: 'deleteChart', chart: 'base-object-9' } }], stateOf(book), base);
    expect(bad).toMatchObject({ ok: false, error: { code: 'batch_invalid', issues: [{ opIndex: 3, path: 'ops.3.chart' }] } });
  });
});

describe('imágenes del fichero y comandos de imagen (IMG)', () => {
  it('lista las imágenes de cada hoja con el id que citan los comandos', async () => {
    const book = await open(buildImageBook());
    const images = await liveImages(book.doc, book.bytes, book.model, await baseObjectsOf(book.sheetBase));
    const datos = book.model.sheets.find((s) => s.name === 'Datos')!;
    const ids = (images.get(datos.id) ?? []).map((image) => image.id);
    expect(ids.length).toBeGreaterThan(0);
    const objects = await sheetObjectsOf({ ...book, sheet: datos, engine: null });
    expect(objects.images.map((image) => image.id)).toEqual(ids);
    expect(objects.images.some((image) => image.cell === 'C1' && image.alt === 'Foto')).toBe(true);
  });

  it('moveImage e insertImage compilan a image.set; la imagen del lote sale con su SHA para guardarla', async () => {
    const book = await open(buildImageBook());
    const datos = book.model.sheets.find((s) => s.name === 'Datos')!;
    const [first] = (await liveImages(book.doc, book.bytes, book.model, await baseObjectsOf(book.sheetBase))).get(datos.id)!;
    const out = await compileImageRun(
      [
        { index: 0, command: { type: 'moveImage', sheet: 'Datos', image: first!.id, at: 'D5' } },
        { index: 1, command: { type: 'insertImage', sheet: 'Datos', at: 'B7', asset: 'logo', alt: 'Logo', as: 'logo' } }
      ],
      stateOf(book),
      async (ref) => (ref === 'logo' ? { status: 'ok', bytes: PNG_A } : { status: 'missing' })
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ops.map((op) => op.type)).toEqual(['image.set', 'image.set']);
    expect(out.images.map((image) => image.sha)).toEqual([sha(PNG_A)]);
    expect(Object.keys(out.createdIds)).toEqual(['logo']);
  });

  it('la imagen de reemplazo de un gráfico no es una imagen: ni se lista ni la cita un comando', async () => {
    const book = await open(odsWithChart());
    const base = await baseObjectsOf(book.sheetBase);
    const hoja1 = book.model.sheets[0]!;
    expect([...(base.objectFrames.get(hoja1.id) ?? [])]).toEqual([0]);
    expect((await liveImages(book.doc, book.bytes, book.model, base)).get(hoja1.id)).toEqual([]);
    // El id que le daría el editor (`<hoja>:img0`) no lo encuentra un comando de imagen.
    const out = await compileImageRun([{ index: 0, command: { type: 'deleteImage', sheet: 'Hoja1', image: `${hoja1.id}:img0` } }], stateOf(book), async () => ({ status: 'missing' }));
    expect(out).toEqual({ ok: false, error: { code: 'not_found', opIndex: 0 } });
  });

  it('oculto y ausente responden igual: not_found con el comando, sin decir cuál', async () => {
    const book = await open(buildImageBook());
    const insert = (index: number) => ({ index, command: { type: 'insertImage' as const, sheet: 'Datos', at: 'B7', asset: 'logo' } });
    const hidden = await compileImageRun([insert(4)], stateOf(book), async () => ({ status: 'hidden' }));
    const missing = await compileImageRun([insert(4)], stateOf(book), async () => ({ status: 'missing' }));
    expect(hidden).toEqual({ ok: false, error: { code: 'not_found', opIndex: 4 } });
    expect(missing).toEqual(hidden);
    const noImage = await compileImageRun([{ index: 2, command: { type: 'deleteImage', sheet: 'Datos', image: 'no-existe' } }], stateOf(book), async () => ({ status: 'missing' }));
    expect(noImage).toEqual({ ok: false, error: { code: 'not_found', opIndex: 2 } });
  });

  it('resolveLotAsset: base64 tal cual; fichero o adjunto, por el SHA juzgado en la fase 1', async () => {
    const png = Buffer.from(PNG_A).toString('base64');
    const assets = [
      { ref: 'a', dataBase64: png, mimeType: 'image/png' as const },
      { ref: 'b', fileId: 'f1' },
      { ref: 'c', noteId: 'n1', attachmentId: 'ABC' }
    ];
    const blobs = new Map([[sha(PNG_A), PNG_A]]);
    const source = { sha: (index: number) => [null, sha(PNG_A), null][index] ?? null, blob: async (s: string) => blobs.get(s) ?? null };
    expect(await resolveLotAsset(assets, 'a', source)).toEqual({ status: 'ok', bytes: PNG_A });
    expect(await resolveLotAsset(assets, 'b', source)).toEqual({ status: 'ok', bytes: PNG_A });
    // El adjunto sin SHA juzgado (la fase 1 no lo dio) no se lee: `missing`.
    expect(await resolveLotAsset(assets, 'c', source)).toEqual({ status: 'missing' });
    expect(await resolveLotAsset(assets, 'z', source)).toEqual({ status: 'missing' });
  });
});

describe('tramos del lote (hebra_edit_sheet)', () => {
  it('la base con clearSpillBlockers va junta; las tablas de una en una; imágenes y gráficos seguidos', () => {
    const set = { type: 'setCells' as const, sheet: 'A', start: 'A1', rows: [[1]] };
    const segments = segmentsOf([
      set,
      { type: 'clearSpillBlockers', sheet: 'A', cell: 'A1' },
      { type: 'createTable', sheet: 'A', range: 'A1:B2' },
      { type: 'setTableTotals', table: 'T', show: true },
      { type: 'deleteImage', sheet: 'A', image: 'i' },
      { type: 'moveImage', sheet: 'A', image: 'j', at: 'B2' },
      { type: 'deleteChart', chart: 'g' },
      set
    ]);
    expect(segments.map((s) => [s.kind, s.items.map((item) => item.index)])).toEqual([
      ['base', [0, 1]],
      ['tab', [2]],
      ['tab', [3]],
      ['img', [4, 5]],
      ['cht', [6]],
      ['base', [7]]
    ]);
    // Los de tabla dinámica seguidos, juntos: `compilePivotCommands` los encadena.
    const pivots = segmentsOf([
      { type: 'pivotCreate', name: 'T', source: { sheet: 'A', range: 'A1:B3' }, output: { sheet: 'A', at: 'D1' } },
      { type: 'pivotRefresh', pivot: 'T' },
      set
    ]);
    expect(pivots.map((s) => [s.kind, s.items.map((item) => item.index)])).toEqual([
      ['piv', [0, 1]],
      ['base', [2]]
    ]);
  });
});

/** Las celdas que escribe un tramo, por dirección A1, como las vería la hoja `Datos`. */
function writesOf(ops: readonly { type: string }[], sheet: SheetModel['sheets'][number]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const op of ops) {
    if (op.type !== 'cell.set') continue;
    const { row, col, value } = op as unknown as { row: string; col: string; value: unknown };
    out[`${String.fromCharCode(65 + sheet.cols.indexOf(col)!)}${sheet.rows.indexOf(row)! + 1}`] = value;
  }
  return out;
}

/** Aplica lo compilado como lo hará la app con H-170: `pivot.edit` por su bloque, lo demás por el adaptador. */
async function applyCompiled(book: Opened, ops: readonly { type: string }[], base: Awaited<ReturnType<typeof baseObjectsOf>>): Promise<SheetModel> {
  let n = 0;
  const ctx = { newId: () => `t${++n}` };
  book.doc.transact(() => {
    if (book.doc.getMap('sheetMeta').get('v') === undefined) book.adapter.scaffold(book.bytes, book.doc);
    for (const op of ops) {
      if (op.type === 'pivot.edit') applyPivotSheetOp(book.doc, op as PivotSheetOp, ctx, base.pivots);
      else book.adapter.applyOp(book.doc, op as SheetOp, ctx);
    }
  });
  return book.adapter.project(book.bytes, book.doc, live);
}

describe('tablas dinámicas (PIV)', () => {
  it('lee la del fichero: el resumen la nombra y objects la describe como no fiable, con aviso en su salida', async () => {
    const book = await open(pivotOds());
    const base = await baseObjectsOf(book.sheetBase);
    expect(Object.values(base.pivots.tables).map((t) => t.name)).toEqual(['Resumen']);
    const datos = book.model.sheets[0]!;
    expect((await objectCountsOf(book.doc, book.bytes, book.sheetBase, book.model)).get(datos.id)?.pivots).toEqual(['Resumen']);
    const [view] = (await sheetObjectsOf({ ...book, sheet: datos, engine: null })).pivots;
    expect(view).toMatchObject({
      name: 'Resumen',
      source: 'Datos!A1:C5',
      output: 'Datos!E1:F4',
      rows: [{ field: 'Región' }],
      values: [{ field: 'Importe', function: 'suma' }],
      trust: 'from_file',
      reliable: false
    });
    const warnings = await pivotWarningsOf(livePivots(book.doc, base), book.model, datos, async () => null);
    expect(warnings.map(({ range, trust }) => ({ range, trust }))).toEqual([{ range: 'E1:F4', trust: 'from_file' }]);
  });

  it('pivotRefresh recalcula la del fichero: escribe su salida con el origen de ahora y queda fiable', async () => {
    const book = await open(pivotOds());
    const base = await baseObjectsOf(book.sheetBase);
    const datos = book.model.sheets[0]!;
    const out = await compilePivotRun([{ index: 3, command: { type: 'pivotRefresh', pivot: 'Resumen' } }], stateOf(book), base);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Sur suma 225, no los 999 que guardó el fichero. La disposición es la de Calc (fila de filtro
    // arriba; con `grand-total="column"`, sin fila de totales), así que la salida se mueve con un
    // `pivot.set` y lo que sobra de la anterior se vacía.
    const writes = writesOf(out.ops, datos);
    expect(Object.values(writes)).toEqual(expect.arrayContaining(['Filtrar', 'Región', 'Norte', 150, 'Sur', 225]));
    expect(Object.values(writes)).not.toContain(999);
    expect(Object.values(writes)).not.toContain(1149);
    expect(out.ops.filter((op) => op.type === 'pivot.edit')).toHaveLength(1);
    const model = await applyCompiled(book, out.ops, base);
    const [view] = await pivotViewsOf(livePivots(book.doc, base), model, async () => null);
    expect(view).toMatchObject({ trust: 'recalculated', reliable: true });
    // Y si cambia el origen después, deja de serlo.
    const changed = compileBatch(model, { ops: [{ type: 'setCells', sheet: 'Datos', start: 'C2', rows: [[1]] }], expectedRevision: 'x' }, { newId: () => 'c2' });
    if ('error' in changed) throw new Error(changed.reason);
    const after = await applyCompiled(book, changed.ops, base);
    expect((await pivotViewsOf(livePivots(book.doc, base), after, async () => null))[0]).toMatchObject({ trust: 'stale', reliable: false });
  });

  it('pivotCreate crea, calcula y escribe la salida; los ids salen de la semilla del tramo', async () => {
    const book = await open(pivotOds());
    const base = await baseObjectsOf(book.sheetBase);
    const datos = book.model.sheets[0]!;
    const create = {
      type: 'pivotCreate' as const,
      name: 'PorMes',
      source: { sheet: 'datos', range: 'A1:C5' },
      output: { sheet: 'DATOS', at: 'H1' },
      rows: ['Mes'],
      values: [{ field: 'Importe', function: 'sum' as const }]
    };
    const out = await compilePivotRun([{ index: 0, command: create }], stateOf(book), base);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [first] = out.ops as PivotSheetOp[];
    expect(first).toMatchObject({ type: 'pivot.edit', edit: { type: 'pivot.create', table: { name: 'PorMes', target: { sheet: 'Datos' }, source: { sheet: 'Datos' } } } });
    const writes = writesOf(out.ops, datos);
    expect(Object.keys(writes).every((cell) => /^[HI]\d+$/.test(cell))).toBe(true);
    expect(Object.values(writes)).toEqual(expect.arrayContaining(['Ene', 'Feb', 300, 75, 375]));
    const again = await compilePivotRun([{ index: 0, command: create }], stateOf(book), base);
    expect(again).toEqual(out);
  });

  it('una salida que pisa algo ocupado, una hoja o una cabecera que no valen: batch_invalid en su comando, sin escribir', async () => {
    const book = await open(pivotOds());
    const base = await baseObjectsOf(book.sheetBase);
    const create = (output: string, source = 'A1:C5', sheet = 'Datos') => ({
      type: 'pivotCreate' as const,
      name: 'Otra',
      source: { sheet, range: source },
      output: { sheet: 'Datos', at: output },
      rows: ['Región']
    });
    // B2 tiene datos del origen: la salida no puede ir encima.
    const busy = await compilePivotRun([{ index: 2, command: create('B2') }], stateOf(book), base);
    expect(busy).toMatchObject({ ok: false, error: { code: 'batch_invalid', issues: [{ opIndex: 2, path: 'ops.2' }] } });
    // La salida de la otra tabla dinámica también está ocupada.
    const overPivot = await compilePivotRun([{ index: 0, command: create('E3') }], stateOf(book), base);
    expect(overPivot).toMatchObject({ ok: false, error: { code: 'batch_invalid' } });
    const noSheet = await compilePivotRun([{ index: 1, command: create('H1', 'A1:C5', 'NoEsta') }], stateOf(book), base);
    expect(noSheet).toMatchObject({ ok: false, error: { issues: [{ opIndex: 1, path: 'ops.1.source.sheet' }] } });
    // D no tiene cabecera: la interfaz tampoco la acepta.
    const noHeader = await compilePivotRun([{ index: 0, command: create('H1', 'A1:D5') }], stateOf(book), base);
    expect(noHeader).toMatchObject({ ok: false, error: { issues: [{ reason: expect.stringContaining('no tiene cabecera') }] } });
    const unknown = await compilePivotRun([{ index: 4, command: { type: 'pivotDelete', pivot: 'NoEsta' } }], stateOf(book), base);
    expect(unknown).toMatchObject({ ok: false, error: { issues: [{ opIndex: 4, reason: expect.stringContaining('(not_found)') }] } });
  });

  it('pivotDelete quita la tabla y vacía su salida', async () => {
    const book = await open(pivotOds());
    const base = await baseObjectsOf(book.sheetBase);
    const out = await compilePivotRun([{ index: 0, command: { type: 'pivotDelete', pivot: 'Resumen' } }], stateOf(book), base);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const writes = writesOf(out.ops, book.model.sheets[0]!);
    expect(Object.keys(writes).sort()).toEqual(['E1', 'E2', 'E3', 'E4', 'F1', 'F2', 'F3', 'F4']);
    expect(Object.values(writes).every((value) => value === null)).toBe(true);
  });

  it('un origen con fórmulas sin motor no se calcula con valores inventados', async () => {
    const book = await open(pivotOds());
    const base = await baseObjectsOf(book.sheetBase);
    const formula = compileBatch(book.model, { ops: [{ type: 'setCells', sheet: 'Datos', start: 'C2', rows: [['=40+60']] }], expectedRevision: 'x' }, { newId: () => 'f' });
    if ('error' in formula) throw new Error(formula.reason);
    const model = await applyCompiled(book, formula.ops, base);
    const out = await compilePivotRun([{ index: 0, command: { type: 'pivotRefresh', pivot: 'Resumen' } }], stateOf(book, model), base);
    expect(out).toMatchObject({ ok: false, error: { issues: [{ reason: expect.stringContaining('no se puede leer el origen') }] } });
  });
});
