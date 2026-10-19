/**
 * Errores con código cerrado propios de hebra-mcp (no de Hebra). El `message` es el
 * código, igual que `LibraryError` de Hebra (`library/library-error`), para que
 * la capa de herramientas lo traduzca sin mirar texto libre.
 */

import type { SectionRef } from './sections';

/**
 * Por qué una escritura de la edición o la organización (D2 ampliada, 28 sep 2026) se
 * rechazó SIN escribir nada. Viajan tal cual por `writer.sock` (`src/ipc/`) y la capa de
 * herramientas los devuelve con el mismo nombre (`src/server/tools/write-errors.ts`):
 * - `not_found`: la nota o carpeta no existe, está en la papelera, está oculta por el
 *   filtro de privados, o la escritura la dejaría oculta (decisión 4 de David: mismo
 *   error que un destino inexistente, para no revelar qué es privado).
 * - `revision_conflict`: el cuerpo cambió desde la lectura que trae el agente.
 * - `no_match`/`ambiguous_match`/`overlapping_edits`: un `find` no aparece, aparece más
 *   de una vez, o se solapa con el de otra sustitución (`editIndex` dice cuál).
 * - `note_locked`: nota bloqueada (Paridad Bear L de Hebra, §17): su cuerpo no se edita.
 * - `operation_id_reused`: el mismo `operationId` con otra petición.
 * - `privacy_config_unresolved`: el filtro no se puede aplicar (SPEC.md §6.3, R5).
 * - `invalid_input`: la entrada no vale (revisión ilegible, cuerpo bloqueado…).
 * Carpetas (D9, 3 oct 2026; antes, opción A: fuera del MCP porque `folder_name_taken`
 * revelaba hermanas privadas):
 * - `folder_unavailable`: la ruta resultante es privada o queda debajo de una privada, la
 *   carpeta tiene una privada debajo, o el nombre choca con algo que no es visible. Uno
 *   solo para todo, decidido desde la configuración (`./folders.ts`).
 * - `folder_name_taken`: choca con una hermana VISIBLE (solo al renombrar).
 * Adjuntos añadidos (D9), revalidados en el escritor aunque la herramienta ya los mirara:
 * - `attachment_too_large`: más de 5 MiB.
 * - `attachment_type_not_allowed`: fuera de los tipos que se pueden leer.
 * Apartados (D11, 9 oct 2026), al añadir a un apartado (`src/store/sections.ts`):
 * - `heading_not_found`: ningún apartado con ese título (o esa aparición).
 * - `ambiguous_heading`: varios con ese título y sin `headingOccurrence`; el error lleva
 *   los candidatos (`candidates`).
 * Sustitución en lote (`hebra_replace_in_notes`, D14, 10 oct 2026; `./replace-batch.ts`):
 * - `plan_not_found`: el plan no existe, es de otra biblioteca o se calculó con otra
 *   configuración de privados (las tres igual).
 * - `plan_expired`: pasó la hora para aplicarlo, o los 7 días para deshacerlo.
 * - `plan_already_applied`: el plan ya se aplicó (o se está aplicando) con otro
 *   `operationId`.
 * Ficheros sueltos (`hebra_read_file` y `hebra_replace_file_text`, D15, 10 oct 2026;
 * `./file-writes.ts`):
 * - `file_changed`: el contenido del fichero ya no es el del `expectedSha256` (alguien lo
 *   cambió desde la lectura); no se escribe nada.
 * - `file_too_large`: el fichero o el texto nuevo pasan del tope.
 * - `file_type_not_allowed`: el fichero no es de texto (al reemplazar) o no es de un tipo
 *   que se pueda leer.
 * - `file_unavailable`: sus bytes no están en este dispositivo y no se pudieron bajar.
 * Crear, renombrar, mover y duplicar ficheros sueltos (D17, 12 oct 2026; `./file-verbs.ts`):
 * - `file_exists`: en la carpeta de destino ya hay un fichero suelto VIVO y VISIBLE con ese
 *   nombre (sin distinguir mayúsculas); lleva su id (`existingId`). Un homónimo oculto nunca
 *   lo produce.
 * - `file_name_unavailable`: el fichero que se crearía quedaría oculto (lo enlaza una nota
 *   oculta, o hay una nota bloqueada oculta y el nombre se puede incrustar). Uno solo, sin
 *   detalles.
 */
export type WriteRejectionCode =
  | 'not_found'
  | 'revision_conflict'
  | 'no_match'
  | 'ambiguous_match'
  | 'overlapping_edits'
  | 'note_locked'
  | 'operation_id_reused'
  | 'privacy_config_unresolved'
  | 'invalid_input'
  | 'folder_unavailable'
  | 'folder_name_taken'
  | 'attachment_too_large'
  | 'attachment_type_not_allowed'
  | 'heading_not_found'
  | 'ambiguous_heading'
  | 'plan_not_found'
  | 'plan_expired'
  | 'plan_already_applied'
  | 'file_changed'
  | 'file_too_large'
  | 'file_type_not_allowed'
  | 'file_unavailable'
  | 'file_exists'
  | 'file_name_unavailable'
  | JdRejectionCode;

/**
 * Un ID nuevo del JDex (`hebra_jd_new_id`, D18, 19 oct 2026; `./jd-new-id.ts`): los códigos
 * del motor JD de jdex-manager (`JdLibraryErrorCode`), con el mismo nombre y sin su mensaje,
 * que podría nombrar una carpeta o un número. Ninguno dice qué está oculto ni qué número
 * está ocupado: `category_has_hidden` es UNO para todo lo que la categoría no enseña. Los del
 * motor de mover (`id_not_found` y siguientes) están para que la lista sea la del motor
 * entera (`./jd-new-id.ts` lo comprueba al compilar); ninguna herramienta los da todavía.
 */
export type JdRejectionCode =
  | 'jdex_not_found'
  | 'templates_not_found'
  | 'category_not_found'
  | 'category_folder_not_found'
  | 'category_has_hidden'
  | 'category_full'
  | 'id_taken'
  | 'invalid_pattern'
  | 'invalid_title'
  | 'plan_stale'
  | 'id_not_found'
  | 'source_not_found'
  | 'invalid_name'
  | 'invalid_subfolder'
  | 'destination_taken'
  | 'destination_inside_source'
  | 'already_in_destination'
  | 'folder_has_hidden';

export const WRITE_REJECTION_CODES: ReadonlySet<WriteRejectionCode> = new Set<WriteRejectionCode>([
  'not_found',
  'revision_conflict',
  'no_match',
  'ambiguous_match',
  'overlapping_edits',
  'note_locked',
  'operation_id_reused',
  'privacy_config_unresolved',
  'invalid_input',
  'folder_unavailable',
  'folder_name_taken',
  'attachment_too_large',
  'attachment_type_not_allowed',
  'heading_not_found',
  'ambiguous_heading',
  'plan_not_found',
  'plan_expired',
  'plan_already_applied',
  'file_changed',
  'file_too_large',
  'file_type_not_allowed',
  'file_unavailable',
  'file_exists',
  'file_name_unavailable',
  'jdex_not_found',
  'templates_not_found',
  'category_not_found',
  'category_folder_not_found',
  'category_has_hidden',
  'category_full',
  'id_taken',
  'invalid_pattern',
  'invalid_title',
  'plan_stale',
  'id_not_found',
  'source_not_found',
  'invalid_name',
  'invalid_subfolder',
  'destination_taken',
  'destination_inside_source',
  'already_in_destination',
  'folder_has_hidden'
]);

/** Códigos que una escritura del almacén de hebra-mcp puede devolver además de los de
 *  Hebra (`note_not_found`, `folder_not_found`…). */
export type StoreErrorCode = 'busy_other_instance' | WriteRejectionCode;

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    /** Índice de la sustitución que falló (`no_match`, `ambiguous_match`,
     *  `overlapping_edits`): un número, nunca el texto buscado. */
    readonly editIndex?: number,
    /** Candidatos de `ambiguous_heading` (D11): títulos y posiciones de los apartados,
     *  ya acotados; nunca texto de la nota. */
    readonly candidates?: readonly SectionRef[],
    /** De `operation_id_reused`: lo que nombra el registro que lo decidió (una nota, un
     *  fichero o un plan). No sale nunca en la respuesta: lo juzga la puerta final del lector
     *  (R3-2 de la 3.ª revisión de Codex). */
    readonly operationTarget?: string,
    /** De `file_exists` (D17): el id del fichero VISIBLE que ya tiene ese nombre en la
     *  carpeta de destino. Sale en la respuesta, y lo juzga antes la puerta final. */
    readonly existingId?: string
  ) {
    super(code);
    this.name = 'StoreError';
  }
}

/** `operation_id_reused` sin haber escrito nada, con lo que nombra el registro. */
export function operationReused(target: string): StoreError {
  return new StoreError('operation_id_reused', undefined, undefined, target);
}

/** `file_exists` (D17) sin haber escrito nada, con el id del fichero visible que choca. */
export function existingFileRejected(existingId: string): StoreError {
  return new StoreError('file_exists', undefined, undefined, undefined, existingId);
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

export function isWriteRejectionCode(code: unknown): code is WriteRejectionCode {
  return typeof code === 'string' && WRITE_REJECTION_CODES.has(code as WriteRejectionCode);
}

/** Rechazo de una escritura de edición u organización, sin haber escrito nada. */
export function writeRejected(code: WriteRejectionCode, editIndex?: number): StoreError {
  return new StoreError(code, editIndex);
}

/** `heading_not_found` o `ambiguous_heading` (D11) sin haber escrito nada. */
export function headingRejected(
  code: 'heading_not_found' | 'ambiguous_heading',
  candidates?: readonly SectionRef[]
): StoreError {
  return new StoreError(code, undefined, candidates);
}
