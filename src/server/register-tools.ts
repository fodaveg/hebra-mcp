/**
 * Registro de las 7 herramientas de lectura de L1 (SPEC.md §5, §10). Común a todas:
 * - `privacy_config_unresolved` primero (§6.3, R5): ninguna corre con una carpeta
 *   configurada que no existe.
 * - Log cerrado de cada llamada (§6.4): nunca la entrada, solo si salió bien y un
 *   recuento cuando aplica, o el código si falló.
 * `hebra_create_note` y `hebra_append_to_note` (L3b) se registran con el mismo `runTool`:
 * pasan igual por `privacy_config_unresolved` primero y por el log cerrado de cada
 * llamada.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logToolError, logToolOk } from '../log/logger';
import { resolveToolContext, type ServerContext, type ToolContext } from './context';
import { ToolError, toErrorResult, toOkResult } from './errors';
import {
  appendToNoteInputShape,
  createNoteInputShape,
  linksInputShape,
  listNotesInputShape,
  readNoteInputShape,
  searchInputShape
} from './schemas';
import { runAppendToNote } from './tools/append-to-note';
import { runCreateNote } from './tools/create-note';
import { runLinks } from './tools/links';
import { runListFolders } from './tools/list-folders';
import { runListNotes } from './tools/list-notes';
import { runListTags } from './tools/list-tags';
import { runReadNote } from './tools/read-note';
import { runSearch } from './tools/search';
import { runStatus } from './tools/status';

/** Recuento de resultados a loguear (§6.4): solo un número, nunca su contenido. */
function countOf(result: unknown): number | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  for (const key of ['results', 'notes', 'tags', 'folders'] as const) {
    const value = record[key];
    if (Array.isArray(value)) return value.length;
  }
  if (Array.isArray(record.outgoing) || Array.isArray(record.backlinks)) {
    const outgoing = Array.isArray(record.outgoing) ? record.outgoing.length : 0;
    const backlinks = Array.isArray(record.backlinks) ? record.backlinks.length : 0;
    return outgoing + backlinks;
  }
  return undefined;
}

/**
 * Reconstruye el `ToolContext` (filtro de privados incluido) DEL ALMACÉN, en esta
 * llamada: nunca el de una llamada anterior. Es lo que evita la fuga de §1 (una nota
 * que el sync movió a una carpeta privada, o le añadió una etiqueta privada, mientras
 * el proceso vive) y el fallo simétrico (una nota nueva del sync, invisible hasta
 * reiniciar).
 */
async function runTool(
  ctx: ServerContext,
  name: string,
  run: (toolCtx: ToolContext) => Promise<unknown>
): Promise<ReturnType<typeof toOkResult>> {
  const toolCtx = await resolveToolContext(ctx);
  if (toolCtx.privacy.unresolved) {
    logToolError(name, 'privacy_config_unresolved');
    return toErrorResult(new ToolError('privacy_config_unresolved'));
  }
  try {
    const result = await run(toolCtx);
    logToolOk(name, countOf(result));
    return toOkResult(result);
  } catch (error) {
    const toolError = error instanceof ToolError ? error : new ToolError('invalid_input');
    logToolError(name, toolError.code);
    return toErrorResult(toolError);
  }
}

export function registerTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'hebra_search',
    {
      title: 'Buscar notas',
      description: 'Busca en la biblioteca de Hebra por texto (FTS5), con filtro opcional de carpeta o etiqueta.',
      inputSchema: searchInputShape
    },
    async (input) => runTool(ctx, 'hebra_search', (toolCtx) => runSearch(toolCtx, input))
  );

  server.registerTool(
    'hebra_list_notes',
    {
      title: 'Listar notas',
      description: 'Lista notas de la biblioteca, opcionalmente por carpeta o etiqueta, más recientes primero.',
      inputSchema: listNotesInputShape
    },
    async (input) => runTool(ctx, 'hebra_list_notes', (toolCtx) => runListNotes(toolCtx, input))
  );

  server.registerTool(
    'hebra_read_note',
    {
      title: 'Leer una nota',
      description: 'Lee una nota completa por id o por título exacto.',
      inputSchema: readNoteInputShape
    },
    async (input) => runTool(ctx, 'hebra_read_note', (toolCtx) => runReadNote(toolCtx, input))
  );

  server.registerTool(
    'hebra_list_tags',
    {
      title: 'Listar etiquetas',
      description: 'Lista las etiquetas de la biblioteca (anidadas como a/b) con su recuento de notas.'
    },
    async () => runTool(ctx, 'hebra_list_tags', (toolCtx) => runListTags(toolCtx))
  );

  server.registerTool(
    'hebra_list_folders',
    {
      title: 'Listar carpetas',
      description: 'Lista las carpetas de la biblioteca con su recuento de notas.'
    },
    async () => runTool(ctx, 'hebra_list_folders', (toolCtx) => runListFolders(toolCtx))
  );

  server.registerTool(
    'hebra_links',
    {
      title: 'Enlaces de una nota',
      description: 'Enlaces salientes y entrantes (backlinks) de una nota, por id.',
      inputSchema: linksInputShape
    },
    async (input) => runTool(ctx, 'hebra_links', (toolCtx) => runLinks(toolCtx, input))
  );

  server.registerTool(
    'hebra_status',
    {
      title: 'Estado del vínculo',
      description: 'Estado del vínculo con Hebra y del sync. Sin contenido de notas.'
    },
    async () => runTool(ctx, 'hebra_status', (toolCtx) => runStatus(toolCtx))
  );

  server.registerTool(
    'hebra_create_note',
    {
      title: 'Crear una nota',
      description:
        'Crea una nota nueva en la biblioteca de Hebra (el primer H1 del cuerpo es el título), en una carpeta existente o en la raíz.',
      inputSchema: createNoteInputShape
    },
    async (input) => runTool(ctx, 'hebra_create_note', (toolCtx) => runCreateNote(toolCtx, input))
  );

  server.registerTool(
    'hebra_append_to_note',
    {
      title: 'Añadir texto a una nota',
      description:
        'Añade texto al final de una nota existente. Una edición concurrente produce una copia de conflicto visible, sin perder texto.',
      inputSchema: appendToNoteInputShape
    },
    async (input) =>
      runTool(ctx, 'hebra_append_to_note', (toolCtx) => runAppendToNote(toolCtx, input))
  );
}
