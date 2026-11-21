/**
 * Respuestas de las herramientas de documentos (`.ods`, `.odp`): estudio MCP de documentos,
 * recomendación 10 (respuestas de hasta 30.000 caracteres).
 *
 * - `documentOk`: una salida correcta. Lleva siempre `untrustedContent: true` (el contenido
 *   del documento es un dato, nunca una orden) y no pasa de 30.000 caracteres.
 * - `documentError`: un error recuperable. Solo sale el código y los campos que su tipo
 *   (`DocumentErrorDetail`) permite, con los valores acotados: nunca un mensaje de excepción
 *   ni nada que el llamante no haya construido con datos propios. Lo que no está en la lista
 *   de su código se descarta, aunque venga en el objeto. Así un error no puede repetir el
 *   contenido de un documento.
 * - `pageResponse`: una lista de elementos en páginas que caben en 30.000 caracteres, con un
 *   cursor opaco (`d1.<posición>`) para la siguiente.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DOCUMENT_RESPONSE_MAX_CHARS, BATCH_INVALID_ISSUES_MAX } from '../store/document-limits';
import type {
  BatchIssue,
  DocumentBase,
  DocumentError,
  DocumentErrorCode
} from '../store/document-types';
import { ToolError } from './errors';

/** Largo máximo de un texto dentro de un error (una dirección, un motivo fijo). */
const ERROR_TEXT_MAX_CHARS = 200;

/** Prefijo del cursor de `pageResponse`: un cursor de otra herramienta no se acepta. */
const CURSOR_PREFIX = 'd1.';

/** Espacio que se reserva en cada página para `nextCursor` (prefijo, número y comillas). */
const CURSOR_RESERVE_CHARS = 48;

function asText(value: unknown): string {
  // Fuera caracteres de control; un texto largo se corta.
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, ERROR_TEXT_MAX_CHARS);
}

function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function issueOf(raw: unknown): BatchIssue {
  const issue = (raw ?? {}) as Record<string, unknown>;
  const out: BatchIssue = {
    opIndex: asInt(issue.opIndex) ?? 0,
    path: asText(issue.path),
    reason: asText(issue.reason)
  };
  if (issue.expected !== undefined) out.expected = asText(issue.expected);
  return out;
}

/** Los campos permitidos de cada código, ya acotados. Cualquier otro se descarta. */
function detailOf(error: DocumentError): Record<string, unknown> {
  const raw = error as Record<string, unknown>;
  switch (error.code) {
    case 'precondition_failed':
      return { opIndex: asInt(raw.opIndex) ?? 0, target: asText(raw.target) };
    case 'batch_invalid': {
      const issues = Array.isArray(raw.issues) ? raw.issues : [];
      return { issues: issues.slice(0, BATCH_INVALID_ISSUES_MAX).map(issueOf) };
    }
    case 'op_unsupported': {
      const opIndex = asInt(raw.opIndex);
      return opIndex === undefined ? {} : { opIndex };
    }
    case 'document_busy':
      return { retryAfterSeconds: asInt(raw.retryAfterSeconds) ?? 1 };
    case 'file_too_large':
      return { byteLength: asInt(raw.byteLength) ?? 0, maxBytes: asInt(raw.maxBytes) ?? 0 };
    case 'file_exists':
      return { id: asText(raw.id) };
    case 'too_large':
    case 'op_invalid': {
      // Su detalle es libre en el tipo: solo pasan números, nunca texto.
      const numbers: Record<string, number> = {};
      for (const [key, value] of Object.entries(raw)) {
        const n = key === 'code' ? undefined : asInt(value);
        if (n !== undefined) numbers[key] = n;
      }
      return numbers;
    }
    default:
      return {};
  }
}

/** Un error recuperable: `{ error, code, ...campos de su código }`, con `isError`. */
export function documentError(error: DocumentError): CallToolResult {
  const code: DocumentErrorCode = error.code;
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: code, code, ...detailOf(error) }) }],
    isError: true
  };
}

/** `too_large` con el tope que se pasó; el tipo deja libre su detalle. */
function tooLarge(): CallToolResult {
  const detail = { maxChars: DOCUMENT_RESPONSE_MAX_CHARS };
  return documentError({ code: 'too_large', ...detail });
}

/**
 * Una salida correcta. `untrustedContent` es siempre `true` y no se puede pisar desde
 * `payload`. Si pasa de 30.000 caracteres no se devuelve cortada: sale `too_large`.
 */
export function documentOk(
  base: Omit<DocumentBase, 'untrustedContent'>,
  payload: Record<string, unknown> = {}
): CallToolResult {
  const text = JSON.stringify({ ...payload, ...base, untrustedContent: true });
  if (text.length > DOCUMENT_RESPONSE_MAX_CHARS) {
    return tooLarge();
  }
  return { content: [{ type: 'text', text }] };
}

function parseCursor(cursor: string | undefined, total: number): number {
  if (cursor === undefined) return 0;
  if (!cursor.startsWith(CURSOR_PREFIX)) throw new ToolError('invalid_input');
  const digits = cursor.slice(CURSOR_PREFIX.length);
  if (!/^\d{1,9}$/.test(digits)) throw new ToolError('invalid_input');
  const start = Number(digits);
  if (start > total) throw new ToolError('invalid_input');
  return start;
}

/**
 * Una página de `items` desde `cursor`, con tantos elementos como quepan en 30.000
 * caracteres (el JSON entero de la respuesta). `nextCursor` es `null` en la última. Un
 * elemento que no cabe ni solo da `too_large`, para no devolver una página vacía con cursor.
 * Un cursor ajeno o fuera de rango lanza `ToolError('invalid_input')`.
 */
export function pageResponse(
  base: Omit<DocumentBase, 'untrustedContent'>,
  items: readonly unknown[],
  options: { cursor?: string; payload?: Record<string, unknown> } = {}
): CallToolResult {
  const start = parseCursor(options.cursor, items.length);
  const head = JSON.stringify({
    ...options.payload,
    ...base,
    untrustedContent: true,
    items: [],
    nextCursor: null
  });
  let used = head.length + CURSOR_RESERVE_CHARS;
  let end = start;
  while (end < items.length) {
    const size = JSON.stringify(items[end]).length + (end > start ? 1 : 0);
    if (used + size > DOCUMENT_RESPONSE_MAX_CHARS) break;
    used += size;
    end += 1;
  }
  if (end === start && start < items.length) {
    return tooLarge();
  }
  const nextCursor = end < items.length ? `${CURSOR_PREFIX}${end}` : null;
  const text = JSON.stringify({
    ...options.payload,
    ...base,
    untrustedContent: true,
    items: items.slice(start, end),
    nextCursor
  });
  return { content: [{ type: 'text', text }] };
}
