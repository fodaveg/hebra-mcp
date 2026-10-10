/**
 * Logs cerrados a stderr (SPEC.md §6.4): un JSON por línea, con `event`, códigos y
 * recuentos. NUNCA títulos, cuerpos, consultas ni argumentos de herramienta: por eso
 * `logToolCall`/`logToolError` no reciben nada del `input` de la llamada, solo el
 * nombre de la herramienta, si salió bien y, si no, un código cerrado.
 */

export type ToolErrorCode =
  | 'not_found'
  | 'ambiguous_title'
  | 'privacy_config_unresolved'
  | 'invalid_input'
  | 'busy_other_instance'
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
  | 'pattern_too_slow';

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
