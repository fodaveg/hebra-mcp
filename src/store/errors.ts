/**
 * Errores con código cerrado propios de hebra-mcp (no de Hebra). El `message` es el
 * código, igual que `LibraryError` de Hebra (`library/library-error`), para que
 * la capa de herramientas lo traduzca sin mirar texto libre.
 */

/** Códigos que una escritura del almacén de hebra-mcp puede devolver además de los de
 *  Hebra (`note_not_found`, `folder_not_found`…). */
export type StoreErrorCode = 'busy_other_instance';

export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super(code);
    this.name = 'StoreError';
  }
}

/**
 * Esta instancia no es el escritor único (SPEC.md §8): la SQLite está abierta en solo
 * lectura porque otro proceso de hebra-mcp tiene el bloqueo, y cualquier escritura se
 * rechaza ANTES de llegar al motor.
 */
export function busyOtherInstance(): StoreError {
  return new StoreError('busy_other_instance');
}

export function isBusyOtherInstance(error: unknown): boolean {
  return error instanceof StoreError && error.code === 'busy_other_instance';
}
