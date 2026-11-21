/**
 * Logs cerrados a stderr (SPEC.md §6.4): un JSON por línea, con `event`, códigos y
 * recuentos. NUNCA títulos, cuerpos, consultas ni argumentos de herramienta: por eso
 * `logToolCall`/`logToolError` no reciben nada del `input` de la llamada, solo el
 * nombre de la herramienta, si salió bien y, si no, un código cerrado.
 */
import type { CheckpointOutcome } from '../store/document-checkpoint';
import type { DocumentErrorCode } from '../store/document-types';
import type { JdRejectionCode } from '../store/errors';

export type ToolErrorCode =
  // Hojas y presentaciones (D28, 21 nov 2026; `DOCUMENT_ERROR_CODES` de `src/store/document-types.ts`).
  | DocumentErrorCode
  | 'client_outdated'
  | 'space_not_ready'
  | 'space_access_denied'
  // El relé de Lumbre no atiende ahora (429): no es una denegación; lleva `retryAfterSeconds`.
  | 'space_unavailable'
  | 'space_not_supported'
  // El directorio del agente no está disponible (D22, `src/spaces/directory.ts`).
  | 'organizations_unavailable'
  // El historial del espacio en el relé no dio la versión pedida (D26): restaurar sin
  // `source: "local"`, o leer con `source: "server"`. Lleva `sourceReason`; no se escribió nada.
  | 'history_unavailable'
  | 'not_found'
  | 'ambiguous_title'
  | 'privacy_config_unresolved'
  | 'invalid_input'
  | 'busy_other_instance'
  // Adjunto en un apartado (11 oct 2026): el escritor es de una versión anterior que no
  // conoce la op; se rechaza antes de escribir.
  | 'writer_outdated'
  // Edición y organización (D2 ampliada, 28 sep 2026; `src/store/errors.ts`).
  | 'revision_conflict'
  | 'no_match'
  | 'ambiguous_match'
  | 'overlapping_edits'
  | 'note_locked'
  | 'operation_id_reused'
  // Adjuntos (30 sep 2026, `src/server/tools/attachments.ts`; añadir, D9 del 3 oct 2026).
  | 'attachment_too_large'
  | 'attachment_type_not_allowed'
  | 'attachment_unavailable'
  // Carpetas (D9, 3 oct 2026; `src/store/folders.ts`).
  | 'folder_unavailable'
  | 'folder_name_taken'
  // Apartados (D11, 9 oct 2026; `src/store/sections.ts`).
  | 'heading_not_found'
  | 'ambiguous_heading'
  // `hebra_grep` (D13, 10 oct 2026): una expresión regular que no termina ni una nota
  // dentro del tope de tiempo.
  | 'pattern_too_slow'
  // `hebra_replace_in_notes` (D14, 10 oct 2026; `src/store/replace-batch.ts`).
  | 'plan_not_found'
  | 'plan_expired'
  | 'plan_already_applied'
  // Leer y reemplazar ficheros sueltos (D15, 10 oct 2026; `src/store/file-writes.ts`).
  | 'file_changed'
  | 'file_too_large'
  | 'file_type_not_allowed'
  | 'file_unavailable'
  // `hebra_import_office` (C-37b): sin memoria para convertir a tiempo; no se escribió nada y se
  // puede reintentar con el mismo `operationId`.
  | 'capacity_wait_timeout'
  // `hebra_import_office` (C-25): `.doc`, `.xls`, `.ppt` o cualquier extensión que no es
  // `.xlsx`, `.pptx` o `.docx`; se rechaza antes de tocar el almacén.
  | 'unsupported_format'
  // Crear, renombrar, mover y duplicar ficheros sueltos (D17, 12 oct 2026;
  // `src/store/file-verbs.ts`).
  | 'file_exists'
  | 'file_name_unavailable'
  // Renombrar con más notas que arreglar de las que juzga la puerta final (D23).
  | 'too_many_linked_notes'
  // Mover a un ID (D19): el destino no se puede usar así (privacidad); un solo código.
  | 'destination_unavailable'
  // Un ID nuevo del JDex (D18, 19 oct 2026; `src/store/jd-new-id.ts`): los del motor JD.
  | JdRejectionCode;

interface ToolCallOkEvent {
  event: 'tool.call';
  tool: string;
  ok: true;
  /** Recuento de resultados devueltos, cuando aplica (nunca su contenido). */
  count?: number;
}

interface ToolCallErrorEvent {
  event: 'tool.call';
  tool: string;
  ok: false;
  code: ToolErrorCode;
}

export type LogEvent = ToolCallOkEvent | ToolCallErrorEvent | { event: string; [key: string]: unknown };

function write(entry: LogEvent): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export function logToolOk(tool: string, count?: number): void {
  write(count === undefined ? { event: 'tool.call', tool, ok: true } : { event: 'tool.call', tool, ok: true, count });
}

export function logToolError(tool: string, code: ToolErrorCode): void {
  write({ event: 'tool.call', tool, ok: false, code });
}

export function logEvent(entry: LogEvent): void {
  write(entry);
}

/**
 * Lo que un documento (`.ods`, `.odp`) deja en el log (D28, protección 13). La lista es
 * cerrada: acción, formato, resultado, un código y recuentos. Nunca ids, nombres, hashes,
 * operaciones ni valores de celda.
 */
export type DocumentLogEntry =
  | {
      event: 'document.write';
      action: 'edit' | 'undo' | 'create';
      format: 'ods' | 'odp';
      outcome: 'saved' | 'already' | 'validated' | 'error';
      code?: DocumentLogCode;
      /** Operaciones del lote. */
      ops?: number;
      replayed?: true;
    }
  | { event: 'document.read'; outcome: 'ok' | 'error'; code?: DocumentLogCode }
  | { event: 'document.copy'; outcome: 'ok' | 'error'; code?: DocumentLogCode }
  | { event: 'document.checkpoint'; status: CheckpointOutcome['status']; removed: number; kept: number };

/** Los códigos que puede llevar un evento de documento; cualquier otro sale como `internal`. */
export type DocumentLogCode = DocumentErrorCode | 'file_type_not_allowed' | 'file_name_unavailable' | 'invalid_input' | 'internal';

const DOCUMENT_LOG_CODES: ReadonlySet<string> = new Set<DocumentLogCode>([
  'precondition_failed',
  'generation_changed',
  'batch_invalid',
  'op_unsupported',
  'document_invalid',
  'document_too_complex',
  'document_busy',
  'too_large',
  'op_invalid',
  'file_too_large',
  'file_unavailable',
  'file_exists',
  'operation_id_reused',
  'writer_outdated',
  'not_found',
  'space_access_denied',
  'doc_head_invalid',
  'file_type_not_allowed',
  'file_name_unavailable',
  'invalid_input',
  'internal'
]);

/** El código de log de un fallo: el suyo si está en la lista cerrada; si no, `internal`. */
export function documentLogCode(error: unknown): DocumentLogCode {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && DOCUMENT_LOG_CODES.has(code) ? (code as DocumentLogCode) : 'internal';
}

export function logDocumentEvent(entry: DocumentLogEntry): void {
  write(entry);
}
