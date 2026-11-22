/**
 * Esquemas de los comandos de hojas (H-79, `src/server/tools/sheet-op-schemas.ts`).
 *
 * Paridad por tipos: "una operación sin esquema rompe la compilación". Los `@ts-expect-error` de
 * abajo solo compilan si quitar una entrada de la tabla es un error de tipos; si la tabla dejara de
 * exigir todas, `npm run typecheck` fallaría aquí. Rotura vista al hacer el paquete: quitar
 * `moveSheet` de `SHEET_COMMAND_SCHEMAS` o `axis.size` de `SHEET_OP_COVERAGE` en la fuente da rojo
 * en `npm run typecheck`, y cambiar el esquema de `freeze` para que produzca otra forma, también.
 */
import { describe, expect, it } from 'vitest';
import type { SheetCommand } from '../../src/sheets';
import {
  a1RangeSchema,
  parseSheetAssets,
  parseSheetCommands,
  SHEET_COMMAND_SCHEMAS,
  SHEET_COMMAND_TYPES,
  SHEET_OP_COVERAGE,
  sheetCommandSchema,
  type SheetCommandSchemaTable,
  type SheetOpCoverageTable
} from '../../src/server/tools/sheet-op-schemas';
import { SHEET_OP_TYPES } from '../../vendor/hebra/src/lib/sheets/contracts/ops';
import { EDIT_OPS_MAX, EDIT_OPS_MAX_BYTES } from '../../src/store/document-limits';

/** Un ejemplo válido de cada comando del contrato. */
const EXAMPLES: { [T in SheetCommand['type']]: SheetCommand & { type: T } } = {
  setCells: { type: 'setCells', sheet: 'Ventas', start: 'A2', rows: [['Enero', 1200, true, null, '=SUM(B1:B3)']], expect: { 'A2:E2': null } },
  setFormat: { type: 'setFormat', sheet: 'Ventas', range: 'B2:B3', format: { numberFormatCode: '#,##0.00 €', bold: 'true', fill: '#ffcc00', link: null }, expect: { B2: 1200 } },
  insertAxis: { type: 'insertAxis', sheet: 'Ventas', axis: 'row', at: 2, count: 3 },
  deleteAxis: { type: 'deleteAxis', sheet: 'Ventas', axis: 'col', at: 1, count: 1, expect: { 'A:A': null } },
  hideAxis: { type: 'hideAxis', sheet: 'Ventas', axis: 'col', at: 4, count: 2 },
  showAxis: { type: 'showAxis', sheet: 'Ventas', axis: 'row', at: 1, count: 1 },
  addSheet: { type: 'addSheet', sheet: 'Resumen', as: 'resumen' },
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

  it('cada SheetOp de la rejilla tiene su comando o una exclusión escrita', () => {
    const { 'axis.size': _size, ...withoutOne } = SHEET_OP_COVERAGE;
    // @ts-expect-error falta la línea de `axis.size`: no debe compilar.
    const incomplete: SheetOpCoverageTable = withoutOne;
    expect(Object.keys(incomplete)).not.toContain('axis.size');
    expect(Object.keys(SHEET_OP_COVERAGE).sort()).toEqual([...SHEET_OP_TYPES].sort());
    for (const [type, coverage] of Object.entries(SHEET_OP_COVERAGE)) {
      if ('command' in coverage) expect(SHEET_COMMAND_TYPES, type).toContain(coverage.command);
      else expect(coverage.excluded.length, type).toBeGreaterThan(20);
    }
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
    ['tipo de regla desconocido', { type: 'putRule', kind: 'macro', body: 'x' }, 'ops.0.kind'],
    ['alias con espacios', { type: 'addSheet', sheet: 'A', as: 'mi hoja' }, 'ops.0.as']
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
