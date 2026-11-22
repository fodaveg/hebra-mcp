/**
 * Regla de direcciones de las herramientas de edición de documentos (estudio MCP de
 * documentos, recomendación 4; decisión 18). Si alguien inserta una fila, `A2` pasa a ser
 * otra celda: un lote que direcciona por A1 o por índice necesita una garantía de que la
 * dirección sigue apuntando a lo leído. Los elementos con id estable no la necesitan.
 *
 * La garantía es una de estas dos:
 * - `expect` en la operación (su dirección o id como clave).
 * - `expectedRevision` del lote.
 *
 * `expectedLayout` (la `layoutRevision` leída; solo hojas) es un control añadido y NO es una
 * garantía: solo cambia con los ejes, así que no ve que otra persona escribió en el destino. Un
 * lote con direcciones que solo trae `expectedLayout` es `batch_invalid`. Es la regla del contrato
 * de hojas (`SheetBatch` del plan de hojas, sección 3.3, y `compileBatch` de H-30), la misma que
 * aplica `hebra_edit_sheet`; `test/tools/edit-sheet.node.test.ts` compara las dos caso por caso.
 *
 * Sin ninguna, `batch_invalid` con la ruta de cada operación sin garantía. Los motivos son
 * fijos y nunca repiten contenido del documento.
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
  // La garantía del lote cubre todas las operaciones; `expectedLayout` no lo es (ver la cabecera).
  if (hasText(input.expectedRevision)) return;
  const issues: BatchIssue[] = [];
  let total = 0;
  ops.forEach((op, index) => {
    if (!isAddressed(op, index)) return;
    const expect = (op as { expect?: Record<string, unknown> }).expect;
    if (expect && Object.keys(expect).length > 0) return;
    total += 1;
    if (issues.length < BATCH_INVALID_ISSUES_MAX) {
      issues.push({ opIndex: index, path: `ops[${index}].expect`, reason: REASON, expected: EXPECTED });
    }
  });
  if (total > 0) throw new DocumentAddressError(issues);
}
