/**
 * B-N09 (R16): la regla de direcciones. Un lote con A1 o índices exige `expect`,
 * `expectedRevision` o `expectedLayout`; los ids estables no. R16 usa una hoja de juguete
 * que desplaza filas: sin garantía, A1 escribe en otra fila.
 */
import { describe, expect, it } from 'vitest';
import { assertAddressRule, DocumentAddressError } from '../../src/store/document-address';

type Op = { cell?: string; id?: string; value: string; expect?: Record<string, unknown> };
const byA1 = (op: Op) => op.cell !== undefined;

function failure(fn: () => void): DocumentAddressError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DocumentAddressError);
    return e as DocumentAddressError;
  }
  throw new Error('no lanzó');
}

describe('assertAddressRule', () => {
  it('A1 sin garantía da batch_invalid con la ruta de cada operación', () => {
    const err = failure(() =>
      assertAddressRule<Op>(
        { ops: [{ cell: 'A1', value: 'x' }, { id: 'r1', value: 'y' }, { cell: 'B2', value: 'z' }] },
        byA1
      )
    );
    expect(err.error.code).toBe('batch_invalid');
    expect(err.error.issues.map((i) => i.path)).toEqual(['ops[0].expect', 'ops[2].expect']);
  });

  it('los ids estables no necesitan guarda', () => {
    expect(() =>
      assertAddressRule<Op>({ ops: [{ id: 'r1', value: 'x' }, { id: 'r2', value: 'y' }] }, byA1)
    ).not.toThrow();
  });

  it('cada garantía basta: expect, expectedRevision o expectedLayout', () => {
    const ops: Op[] = [{ cell: 'A2', value: 'x', expect: { A2: '' } }];
    expect(() => assertAddressRule<Op>({ ops }, byA1)).not.toThrow();
    const bare: Op[] = [{ cell: 'A2', value: 'x' }];
    expect(() => assertAddressRule<Op>({ ops: bare, expectedRevision: 'r1' }, byA1)).not.toThrow();
    expect(() => assertAddressRule<Op>({ ops: bare, expectedLayout: 'l1' }, byA1)).not.toThrow();
  });

  it('un expect vacío o una garantía vacía no cuentan', () => {
    const ops: Op[] = [{ cell: 'A2', value: 'x', expect: {} }];
    failure(() => assertAddressRule<Op>({ ops, expectedRevision: '', expectedLayout: '' }, byA1));
  });

  it('deshacer no direcciona nada', () => {
    expect(() => assertAddressRule<Op>({}, byA1)).not.toThrow();
  });

  it('topa las incidencias y no repite el contenido', () => {
    const ops: Op[] = Array.from({ length: 30 }, (_, i) => ({ cell: `A${i + 1}`, value: 'SECRETO' }));
    const err = failure(() => assertAddressRule<Op>({ ops }, byA1));
    expect(err.error.issues).toHaveLength(20);
    expect(JSON.stringify(err.error)).not.toContain('SECRETO');
    expect(JSON.stringify(err.error)).not.toContain('A1"');
  });
});

/** Hoja de juguete: filas por posición, con revisión de disposición que sube al insertar. */
function sheet() {
  const rows = ['uno', 'dos', '', 'cuatro'];
  let layout = 1;
  return {
    rows,
    layoutRevision: () => `l${layout}`,
    insertRow(at: number) {
      rows.splice(at, 0, '');
      layout += 1;
    },
    write(row: number, value: string, expectedLayout?: string) {
      if (expectedLayout !== undefined && expectedLayout !== `l${layout}`) {
        throw new Error('precondition_failed');
      }
      rows[row] = value;
    }
  };
}

describe('R16: A1 escribe en otra fila', () => {
  it('con destino vacío, expectedLayout caducado da precondition_failed', () => {
    const s = sheet();
    const leido = s.layoutRevision();
    s.insertRow(0); // otra persona inserta; la fila 2 (vacía) pasa a ser la 3
    expect(() => s.write(3, 'nuevo', leido)).toThrow('precondition_failed');
    expect(s.rows).toEqual(['', 'uno', 'dos', '', 'cuatro']);
  });

  it('rotura: sin expectedLayout la escritura cae en otra fila, y la regla lo corta antes', () => {
    const s = sheet();
    s.insertRow(0);
    s.write(2, 'nuevo'); // quería la antigua fila 2 (vacía) y pisa "dos"
    expect(s.rows[2]).toBe('nuevo');
    expect(s.rows).not.toContain('dos');
    failure(() => assertAddressRule<Op>({ ops: [{ cell: 'A3', value: 'nuevo' }] }, byA1));
  });
});
