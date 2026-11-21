/**
 * H-173: el núcleo de hojas de Hebra entra en el MCP por `src/sheets/index.ts`, con las piezas
 * reales de `vendor/hebra/src/lib/sheets/` y no con dobles. Aquí se recorre lo que harán las
 * herramientas de hojas (H-78 a H-81) desde las fuentes: leer un `.ods`, compilar un lote por
 * direcciones con su guarda, comprobar la disposición y escribir un `.ods` nuevo que se vuelve a
 * leer.
 *
 * Lo que no se puede probar desde las fuentes, porque necesita el JS empaquetado, lo prueba
 * `scripts/check-bundle.mjs` sobre `dist/`: que el núcleo carga sin globales del DOM, que sus
 * dependencias están en `dependencies` y que el motor de fórmulas calcula en su hilo
 * (`dist/sheet-engine-worker.mjs`).
 */
import { describe, expect, it } from 'vitest';
import {
  checkExpectedLayout,
  compileBatch,
  createSheetAdapter,
  layoutRevision,
  prepareSheetBase,
  writeNewOds,
  type SheetCommand
} from '../../src/sheets';
import { buildOds } from '../../vendor/hebra/src/lib/sheets/adapter/sheet-adapter.fixture';

const SET_B1: SheetCommand = { type: 'setCells', sheet: 'Datos', start: 'B1', rows: [[42]] };
/** Las hojas del `.ods` de prueba de Hebra (`buildOds`). */
const FIXTURE_SHEETS = ['Datos', 'Resumen'];

describe('núcleo de hojas por src/sheets', () => {
  it('lee el .ods y da un adaptador de documento de hojas', async () => {
    const base = await prepareSheetBase(buildOds());
    expect(base.model.sheets.map((sheet) => sheet.name)).toEqual(FIXTURE_SHEETS);
    const adapter = createSheetAdapter(base);
    expect(typeof adapter.applyOp).toBe('function');
    expect(typeof adapter.exportFile).toBe('function');
  });

  it('un lote por direcciones sin guarda da batch_invalid y con expectedRevision compila', async () => {
    const { model } = await prepareSheetBase(buildOds());

    const unguarded = compileBatch(model, { ops: [SET_B1] });
    expect(unguarded).toMatchObject({ error: 'batch_invalid' });

    const guarded = compileBatch(model, { ops: [SET_B1], expectedRevision: 'r1' });
    expect('error' in guarded).toBe(false);
    if ('error' in guarded) return;
    expect(guarded.ops.map((op) => op.type)).toEqual(['cell.set']);
  });

  it('la disposición leída es la esperada y una de otro libro no', async () => {
    const { model } = await prepareSheetBase(buildOds());
    expect(checkExpectedLayout(model, layoutRevision(model))).toEqual({ ok: true });

    // El mismo libro sin su segunda hoja: otra disposición, y el lote no debe aplicarse.
    const other = await prepareSheetBase(writeNewOds({ ...model, sheets: model.sheets.slice(0, 1) }));
    expect(checkExpectedLayout(model, layoutRevision(other.model))).toMatchObject({ error: 'precondition_failed' });
  });

  it('escribe un .ods nuevo con el modelo y se vuelve a leer igual', async () => {
    const { model } = await prepareSheetBase(buildOds());
    const bytes = writeNewOds(model);
    expect(writeNewOds(model)).toEqual(bytes);
    const reread = await prepareSheetBase(bytes);
    expect(reread.model.sheets.map((sheet) => sheet.name)).toEqual(FIXTURE_SHEETS);
  });
});
