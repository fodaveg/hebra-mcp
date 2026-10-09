/**
 * Sustituciones puntuales de `hebra_edit_note` (D2 ampliada, decisión de David del 28
 * sep 2026: «edición por sustituciones puntuales, no reescritura del cuerpo entero»).
 *
 * Reglas:
 * - Cada `find` se busca en el cuerpo LEÍDO (el de la revisión), no en el resultado de
 *   las sustituciones anteriores: el agente describe cambios sobre un texto que vio, y una
 *   sustitución no puede casar con lo que otra acaba de insertar.
 * - Cada `find` tiene que aparecer exactamente UNA vez, contando también apariciones
 *   solapadas consigo mismas (`aa` en `aaa` son dos): así «una vez» no depende de por
 *   dónde empiece a buscar.
 * - Dos sustituciones no pueden tocar el mismo tramo del cuerpo.
 * Si cualquiera falla, no se aplica ninguna: el llamante no escribe nada.
 */

export interface TextEdit {
  find: string;
  replace: string;
}

/** Dónde quedó el `replace` de la sustitución `editIndex` en el cuerpo resultante
 *  (`start` incluido, `end` excluido), en el orden de `edits`. Lo usa la prueba de lo
 *  guardado de `hebra_edit_note` (D11). */
export interface PlacedEdit {
  editIndex: number;
  start: number;
  end: number;
}

export type ApplyEditsResult =
  | { ok: true; body: string; placed: PlacedEdit[] }
  | { ok: false; code: 'no_match' | 'ambiguous_match' | 'overlapping_edits'; editIndex: number };

/** Máximo de sustituciones por llamada (lo comprueban la herramienta y el socket). */
export const EDITS_MAX_COUNT = 50;
/** Suma de las longitudes de todos los `find` y `replace` (unidades UTF-16): igual que el
 *  cuerpo máximo de `hebra_create_note`, para que el peor escape JSON quepa en los mismos
 *  límites del socket (`MAX_MESSAGE_BYTES`) y de HTTP (SPEC.md §12.1). */
export const EDITS_TOTAL_MAX_LENGTH = 100_000;

/** Posición de la ÚNICA aparición de `find`, o cuántas hay si no es una. */
function locate(body: string, find: string): { index: number } | { count: 0 | 2 } {
  const first = body.indexOf(find);
  if (first === -1) return { count: 0 };
  // `first + 1`, no `first + find.length`: una aparición solapada también cuenta.
  if (body.indexOf(find, first + 1) !== -1) return { count: 2 };
  return { index: first };
}

export function applyEdits(body: string, edits: readonly TextEdit[]): ApplyEditsResult {
  const spans: Array<{ start: number; end: number; replace: string; editIndex: number }> = [];
  for (const [editIndex, edit] of edits.entries()) {
    if (edit.find.length === 0) return { ok: false, code: 'no_match', editIndex };
    const found = locate(body, edit.find);
    if ('count' in found) {
      return { ok: false, code: found.count === 0 ? 'no_match' : 'ambiguous_match', editIndex };
    }
    spans.push({
      start: found.index,
      end: found.index + edit.find.length,
      replace: edit.replace,
      editIndex
    });
  }
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (current.start < previous.end) {
      return {
        ok: false,
        code: 'overlapping_edits',
        editIndex: Math.max(previous.editIndex, current.editIndex)
      };
    }
  }
  let result = '';
  let cursor = 0;
  const placed: PlacedEdit[] = [];
  for (const span of ordered) {
    result += body.slice(cursor, span.start);
    placed.push({ editIndex: span.editIndex, start: result.length, end: result.length + span.replace.length });
    result += span.replace;
    cursor = span.end;
  }
  placed.sort((a, b) => a.editIndex - b.editIndex);
  return { ok: true, body: result + body.slice(cursor), placed };
}

/** Los últimos `WRITE_PROOF_TAIL_CHARS` caracteres de `text`, sin empezar a mitad de un par
 *  suplente (si el primer código es un suplente bajo, se quita). */
export function proofTail(text: string): string {
  const tail = text.slice(-WRITE_PROOF_TAIL_CHARS);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/** Prueba de una sustitución guardada (D11): el tamaño de su `replace` y sus últimos
 *  `WRITE_PROOF_TAIL_CHARS` caracteres leídos del cuerpo guardado; o `moved: true` si el
 *  reordenado de tareas la desplazó y ya no se puede ubicar. */
export interface AppliedEdit {
  chars: number;
  tail?: string;
  moved?: true;
}

/** Caracteres finales que devuelve la prueba de lo guardado (SPEC.md §5, D11):
 *  `appended.tail` y `applied[].tail`. Se expone en `capabilities.limits.writeProofTailChars`. */
export const WRITE_PROOF_TAIL_CHARS = 200;

/**
 * La prueba de cada sustitución sobre el cuerpo GUARDADO (`savedBody`). `placed` y
 * `appliedBody` son los de `applyEdits` (antes del reordenado de tareas). Si el cuerpo
 * guardado es el aplicado, o su prefijo hasta la sustitución no cambió, el `replace`
 * está donde `applyEdits` lo puso y de ahí sale el `tail`. Si el reordenado movió líneas,
 * se lee de la única aparición del `replace` en el cuerpo guardado; si no hay una sola,
 * `moved: true`. Un `replace` vacío es `{chars: 0, tail: ""}`.
 */
export function editProof(
  edits: readonly TextEdit[],
  placed: readonly PlacedEdit[],
  appliedBody: string,
  savedBody: string
): AppliedEdit[] {
  const tailOf = proofTail;
  return edits.map((edit, index) => {
    const chars = edit.replace.length;
    if (chars === 0) return { chars: 0, tail: '' };
    const position = placed.find((entry) => entry.editIndex === index)!;
    const inPlace =
      savedBody.slice(position.start, position.end) === edit.replace &&
      (savedBody === appliedBody ||
        savedBody.startsWith(appliedBody.slice(0, position.start)));
    if (inPlace) return { chars, tail: tailOf(savedBody.slice(position.start, position.end)) };
    const first = savedBody.indexOf(edit.replace);
    if (first !== -1 && savedBody.indexOf(edit.replace, first + 1) === -1) {
      return { chars, tail: tailOf(savedBody.slice(first, first + chars)) };
    }
    return { chars, moved: true as const };
  });
}

/** `true` si `edits` respeta los límites de tamaño de arriba. */
export function editsWithinLimits(edits: readonly TextEdit[]): boolean {
  if (edits.length === 0 || edits.length > EDITS_MAX_COUNT) return false;
  let total = 0;
  for (const edit of edits) {
    if (edit.find.length === 0) return false;
    total += edit.find.length + edit.replace.length;
    if (total > EDITS_TOTAL_MAX_LENGTH) return false;
  }
  return true;
}
