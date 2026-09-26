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
  constructor(
    readonly code: ToolErrorCode,
    readonly extra?: Record<string, unknown>
  ) {
    super(code);
    this.name = 'ToolError';
  }
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
