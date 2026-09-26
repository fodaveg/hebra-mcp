/**
 * Registro de las 7 herramientas de lectura de L1 (SPEC.md §5, §10). Común a todas:
 * - `privacy_config_unresolved` primero (§6.3, R5): ninguna corre con una carpeta
 *   configurada que no existe.
 * - Log cerrado de cada llamada (§6.4): nunca la entrada, solo si salió bien y un
 *   recuento cuando aplica, o el código si falló.
 * `hebra_create_note` y `hebra_append_to_note` NO se registran aquí (van en L3b).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logToolError, logToolOk } from '../log/logger';
import type { ServerContext } from './context';
import { ToolError, toErrorResult, toOkResult } from './errors';
import {
  linksInputShape,
  listNotesInputShape,
  readNoteInputShape,
  searchInputShape
} from './schemas';
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

async function runTool(
  ctx: ServerContext,
  name: string,
  run: () => Promise<unknown>
): Promise<ReturnType<typeof toOkResult>> {
  if (ctx.privacy.unresolved) {
    logToolError(name, 'privacy_config_unresolved');
    return toErrorResult(new ToolError('privacy_config_unresolved'));
  }
  try {
    const result = await run();
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
    async (input) => runTool(ctx, 'hebra_search', () => runSearch(ctx, input))
  );

  server.registerTool(
    'hebra_list_notes',
    {
      title: 'Listar notas',
      description: 'Lista notas de la biblioteca, opcionalmente por carpeta o etiqueta, más recientes primero.',
      inputSchema: listNotesInputShape
    },
    async (input) => runTool(ctx, 'hebra_list_notes', () => runListNotes(ctx, input))
  );

  server.registerTool(
    'hebra_read_note',
    {
      title: 'Leer una nota',
      description: 'Lee una nota completa por id o por título exacto.',
      inputSchema: readNoteInputShape
    },
    async (input) => runTool(ctx, 'hebra_read_note', () => runReadNote(ctx, input))
  );

  server.registerTool(
    'hebra_list_tags',
    {
      title: 'Listar etiquetas',
      description: 'Lista las etiquetas de la biblioteca (anidadas como a/b) con su recuento de notas.'
    },
    async () => runTool(ctx, 'hebra_list_tags', () => runListTags(ctx))
  );

  server.registerTool(
    'hebra_list_folders',
    {
      title: 'Listar carpetas',
      description: 'Lista las carpetas de la biblioteca con su recuento de notas.'
    },
    async () => runTool(ctx, 'hebra_list_folders', () => runListFolders(ctx))
  );

  server.registerTool(
    'hebra_links',
    {
      title: 'Enlaces de una nota',
      description: 'Enlaces salientes y entrantes (backlinks) de una nota, por id.',
      inputSchema: linksInputShape
    },
    async (input) => runTool(ctx, 'hebra_links', () => runLinks(ctx, input))
  );

  server.registerTool(
    'hebra_status',
    {
      title: 'Estado del vínculo',
      description: 'Estado del vínculo con Hebra y del sync. Sin contenido de notas.'
    },
    async () => runTool(ctx, 'hebra_status', () => runStatus(ctx))
  );
}
