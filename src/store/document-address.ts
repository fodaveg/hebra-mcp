/**
 * Regla de direcciones de las herramientas de edición de documentos (estudio MCP de
 * documentos, recomendación 4; decisión 18). Si alguien inserta una fila, `A2` pasa a ser
 * otra celda: un lote que direcciona por A1 o por índice necesita una garantía de que la
 * dirección sigue apuntando a lo leído. Los elementos con id estable no la necesitan.
 *
 * La garantía es una de estas dos (plan-base-documentos 2.3.4):
 * - `expectedRevision` del lote.
 * - `expect` en CADA operación con direcciones (su dirección o id como clave) Y `expectedLayout`
 *   del lote (la `layoutRevision` leída).
 *
 * `expect` solo no basta: si alguien inserta una fila y la celda desplazada también está vacía,
 * `expect: null` se cumple y el lote escribe en otra fila; `expectedLayout` cambia con los ejes y
 * lo nota. `expectedLayout` solo tampoco basta: no ve que otra persona escribió en el destino. Es la
 * regla de `compileBatch` (H-30), la misma que aplica `hebra_edit_sheet`;
 * `test/tools/edit-sheet.node.test.ts` compara las dos caso por caso.
 *
 * Sin `expectedRevision`, `batch_invalid` con la ruta de cada operación sin `expect` y, si todas lo
 * llevan pero falta `expectedLayout`, una sola incidencia con la ruta `expectedLayout`. Los
 * motivos son fijos y nunca repiten contenido del documento.
 */
import { BATCH_INVALID_ISSUES_MAX } from './document-limits';
import type { BatchIssue, DocumentError, EditIn } from './document-types';

/** Error de la regla: lleva el `batch_invalid` listo para serializar. */
export class DocumentAddressError extends Error {
  readonly error: DocumentError<'batch_invalid'>;
  constructor(issues: BatchIssue[]) {
    super('batch_invalid');
    this.name = 'DocumentAddressError';
    this.error = { code: 'batch_invalid', issues };
  }
}

/** Lo que la regla lee del lote: no necesita el resto de `EditIn`. */
export type AddressRuleInput<Op> = Pick<EditIn<Op>, 'expectedRevision' | 'expectedLayout'> & {
  ops?: readonly Op[];
};

const REASON = 'direccion por posicion sin garantia';
const EXPECTED = 'expect en la operacion o expectedRevision';
const LAYOUT_REASON = 'expect sin expectedLayout';
const LAYOUT_EXPECTED = 'expectedLayout con la layoutRevision leida, o expectedRevision';

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Comprueba la regla. `isAddressed` lo aporta cada herramienta y dice si una operación
 * direcciona por A1 o índice (true) o por id estable (false). Un lote que deshace
 * (`undoOperationId`, sin `ops`) no direcciona nada. Lanza `DocumentAddressError`.
 */
export function assertAddressRule<Op>(
  input: AddressRuleInput<Op>,
  isAddressed: (op: Op, index: number) => boolean
): void {
  const ops = input.ops;
  if (!ops) return;
  // La revisión del lote cubre todas las operaciones; si no, `expect` y `expectedLayout` (ver la cabecera).
  if (hasText(input.expectedRevision)) return;
  const issues: BatchIssue[] = [];
  let total = 0;
  let addressed = false;
  ops.forEach((op, index) => {
    if (!isAddressed(op, index)) return;
    addressed = true;
    const expect = (op as { expect?: Record<string, unknown> }).expect;
    if (expect && Object.keys(expect).length > 0) return;
    total += 1;
    if (issues.length < BATCH_INVALID_ISSUES_MAX) {
      issues.push({ opIndex: index, path: `ops[${index}].expect`, reason: REASON, expected: EXPECTED });
    }
  });
  if (total > 0) throw new DocumentAddressError(issues);
  if (addressed && !hasText(input.expectedLayout)) {
    throw new DocumentAddressError([{ opIndex: 0, path: 'expectedLayout', reason: LAYOUT_REASON, expected: LAYOUT_EXPECTED }]);
  }
}
