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
  | 'invalid_input';

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
