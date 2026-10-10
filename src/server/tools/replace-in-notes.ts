/**
 * `hebra_replace_in_notes` (D14, decidido por David el 10 oct 2026; SPEC.md §5): sustituir
 * un texto o un patrón en un lote de notas, en dos pasos obligatorios, con vuelta atrás.
 * Una sola herramienta con `mode`:
 *
 * - `simulate`: `pattern` (literal o, con `regex`, expresión regular, con las reglas de
 *   `hebra_grep`), `replacement` y el ámbito (`folder`/`subfolders`, `tag`, `ids`). No
 *   escribe ninguna nota: guarda un plan y devuelve su `planId`, `expiresAt` y, por nota,
 *   id, título, coincidencias y las primeras líneas antes y después (paginado; con un
 *   corte, `continueAfter` sigue el ámbito en otra simulación, `after`).
 * - `preview`: la página siguiente de un plan (`planId`, `cursor`).
 * - `apply`: `planId` y un `operationId` nuevo. Aplica EXACTAMENTE lo simulado (el cuerpo
 *   resultante guardado, sin volver a ejecutar la expresión), nota a nota, con instantánea
 *   forzada antes de cada una. El informe, leído de lo guardado, dice qué entró, qué chocó
 *   (copia de conflicto) y qué no se tocó; repetir con el mismo `operationId` no duplica
 *   nada y sigue lo pendiente.
 * - `undo`: `planId`. Vuelve a la base las notas que el lote escribió y siguen como las
 *   dejó, y manda a la papelera sus copias de conflicto si siguen igual.
 *
 * Todo ocurre en el escritor (`../../store/replace-batch.ts`; un lector lo reenvía por
 * `writer.sock`) con la configuración de privados de ESTA instancia: ninguna nota oculta
 * entra en el plan, en los recuentos ni en el informe. Aquí solo se valida la entrada,
 * sin eco: un campo que no es del modo, o que falta, `invalid_input`.
 *
 * Logs (§6.4): `replace.batch` con el modo y números (notas, si terminó, estado de sync).
 * Nunca el patrón, el reemplazo, títulos ni ids.
 */
import { logEvent } from '../../log/logger';
import { compileGrepPattern } from '../../store/grep';
import { compileReplacement, REPLACE_MAX_NOTES } from '../../store/replace';
import {
  REPLACE_PAGE_DEFAULT,
  REPLACE_PAGE_MAX,
  type ReplaceRequest,
  type ReplaceScope
} from '../../store/replace-batch';
import type { ToolContext } from '../context';
import { ToolError } from '../errors';
import type { ReplaceOutcome } from '../write-context';
import { requireValidOperationId } from './guards';
import { mapWriteError } from './write-errors';

export interface ReplaceInNotesInput {
  mode: 'simulate' | 'preview' | 'apply' | 'undo';
  pattern?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  replacement?: string;
  folder?: string;
  subfolders?: boolean;
  tag?: string;
  ids?: string[];
  maxNotes?: number;
  after?: string;
  planId?: string;
  cursor?: string;
  limit?: number;
  operationId?: string;
}

/** Los campos que admite cada modo (además de `mode`). */
const FIELDS: Record<ReplaceInNotesInput['mode'], ReadonlySet<string>> = {
  simulate: new Set([
    'pattern',
    'regex',
    'caseSensitive',
    'replacement',
    'folder',
    'subfolders',
    'tag',
    'ids',
    'maxNotes',
    'after',
    'limit'
  ]),
  preview: new Set(['planId', 'cursor', 'limit']),
  apply: new Set(['planId', 'operationId']),
  undo: new Set(['planId'])
};

function requestOf(input: ReplaceInNotesInput, ctx: ToolContext): ReplaceRequest {
  const allowed = FIELDS[input.mode];
  if (!allowed) throw new ToolError('invalid_input');
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'mode' && value !== undefined && !allowed.has(key)) throw new ToolError('invalid_input');
  }
  const privacy = ctx.privacyConfig;
  const limit = input.limit ?? REPLACE_PAGE_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REPLACE_PAGE_MAX) throw new ToolError('invalid_input');
  const planId = (): string => {
    if (typeof input.planId !== 'string' || input.planId.length === 0) throw new ToolError('invalid_input');
    return input.planId;
  };
  switch (input.mode) {
    case 'simulate': {
      if (typeof input.pattern !== 'string' || typeof input.replacement !== 'string') {
        throw new ToolError('invalid_input');
      }
      const regex = input.regex === true;
      const caseSensitive = input.caseSensitive === true;
      // Lo mismo que comprueba el escritor, antes de reenviar nada.
      const pattern = compileGrepPattern(input.pattern, { regex, caseSensitive });
      if (!pattern || !compileReplacement(input.replacement, pattern)) throw new ToolError('invalid_input');
      const maxNotes = input.maxNotes ?? REPLACE_MAX_NOTES;
      if (!Number.isSafeInteger(maxNotes) || maxNotes < 1 || maxNotes > REPLACE_MAX_NOTES) {
        throw new ToolError('invalid_input');
      }
      const scope: ReplaceScope = {};
      if (input.folder !== undefined) scope.folder = input.folder;
      if (input.subfolders !== undefined) scope.subfolders = input.subfolders;
      if (input.tag !== undefined) scope.tag = input.tag;
      if (input.ids !== undefined) scope.ids = input.ids;
      const request: Extract<ReplaceRequest, { mode: 'simulate' }> = {
        mode: 'simulate',
        pattern: input.pattern,
        regex,
        caseSensitive,
        replacement: input.replacement,
        scope,
        maxNotes,
        limit,
        privacy
      };
      if (input.after !== undefined) request.after = input.after;
      return request;
    }
    case 'preview':
      if (typeof input.cursor !== 'string' || input.cursor.length === 0) throw new ToolError('invalid_input');
      return { mode: 'preview', planId: planId(), cursor: input.cursor, limit, privacy };
    case 'apply':
      if (typeof input.operationId !== 'string') throw new ToolError('invalid_input');
      requireValidOperationId(input.operationId);
      return { mode: 'apply', planId: planId(), operationId: input.operationId, privacy };
    case 'undo':
      return { mode: 'undo', planId: planId(), privacy };
  }
}

export async function runReplaceInNotes(
  ctx: ToolContext,
  input: ReplaceInNotesInput
): Promise<ReplaceOutcome> {
  if (!ctx.write?.replaceInNotes) throw new ToolError('invalid_input');
  const request = requestOf(input, ctx);
  let result: ReplaceOutcome;
  try {
    result = await ctx.write.replaceInNotes(request);
  } catch (error) {
    throw mapWriteError(error);
  }
  const event: Record<string, unknown> = { event: 'replace.batch', mode: result.mode, notes: result.notes.length };
  if (result.mode === 'apply') {
    event.complete = result.complete;
    event.replayed = result.replayed === true;
  }
  if ('sync' in result) event.sync = result.sync;
  logEvent(event as { event: string });
  return result;
}
