/**
 * Traduce los errores de una escritura del almacén (SPEC.md §5, L3b) al vocabulario
 * cerrado de herramienta (`ToolError`, `../errors.ts`):
 * - `StoreError` de `busy_other_instance` (`isBusyOtherInstance`, SPEC.md §8: escritor
 *   único) → `ToolError('busy_other_instance')`.
 * - `LibraryError` de Hebra con `note_not_found` o `folder_not_found` → `not_found`,
 *   igual que una nota o carpeta oculta por privacidad (SPEC.md §6.3: «igual que una
 *   inexistente»).
 * El resto (cualquier otro código o excepción) lo trata el catch-all de
 * `../register-tools.ts` (`invalid_input`): aquí solo se traducen los dos casos que D2
 * espera de una escritura.
 */
import { LibraryError } from '$lib/library/library-error';
import { isBusyOtherInstance } from '../../store/errors';
import { ToolError } from '../errors';

const NOT_FOUND_LIBRARY_CODES = new Set(['note_not_found', 'folder_not_found']);

export function mapWriteError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  if (isBusyOtherInstance(error)) return new ToolError('busy_other_instance');
  if (error instanceof LibraryError && NOT_FOUND_LIBRARY_CODES.has(error.code)) {
    return new ToolError('not_found');
  }
  return new ToolError('invalid_input');
}
