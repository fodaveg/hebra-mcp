/**
 * Errores de herramienta (SPEC.md §5, §6.4): código cerrado, sin eco de la entrada.
 * `toErrorResult` es lo único que construye un `CallToolResult` de error, para que
 * ningún tool loguee ni devuelva más que el código y los datos que SPEC permite
 * (candidatos de `ambiguous_title`, que son ids/títulos/carpetas ya filtrados de
 * privados, nunca la entrada de la persona).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolErrorCode } from '../log/logger';

export class ToolError extends Error {
  /** Solo para la puerta final (`./privacy-gate.ts`), nunca en la salida: lo que nombra el
   *  registro de un `operationId` que decidió `operation_id_reused` (R3-2 de la 3.ª revisión de
   *  Codex). */
  operationTarget?: string;

  constructor(
    readonly code: ToolErrorCode,
    readonly extra?: Record<string, unknown>
  ) {
    super(code);
    this.name = 'ToolError';
  }
}

/**
 * `invalid_input` por tamaño: qué campo, su límite y cuánto llegó, para que quien llama sepa
 * cuánto recortar (tarea de Lumbre 48e8e6f6, 27 nov 2026; antes salía el código a secas). Son
 * números, nunca el valor: sin eco de la entrada. `unit`: `chars` cuenta unidades UTF-16
 * (`string.length`: un emoji o un carácter fuera del plano básico cuenta 2), `items` elementos y
 * `bytes` bytes.
 */
export function tooLarge(
  field: string,
  limit: number,
  received: number,
  unit: 'chars' | 'items' | 'bytes' = 'chars'
): ToolError {
  return new ToolError('invalid_input', { field, limit, received, unit });
}

export function toErrorResult(error: ToolError): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: error.code, ...error.extra }) }],
    isError: true
  };
}

export function toOkResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * Una salida que no es un JSON en texto sino contenido MCP ya montado (`hebra_read_attachment`:
 * `image`, `text` o `resource` embebido). `register-tools.ts` la devuelve tal cual, sin
 * pasarla por `toOkResult`.
 */
export class ToolContent {
  constructor(readonly result: CallToolResult) {}
}
