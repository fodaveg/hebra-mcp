/**
 * Registro de las 7 herramientas de lectura de L1 (SPEC.md §5, §10). Común a todas:
 * - `privacy_config_unresolved` primero (§6.3, R5): ninguna corre con una carpeta
 *   configurada que no existe.
 * - Log cerrado de cada llamada (§6.4): nunca la entrada, solo si salió bien y un
 *   recuento cuando aplica, o el código si falló.
 * `hebra_create_note` y `hebra_append_to_note` (L3b), y `hebra_edit_note` y las tres de
 * organización de notas (D2 ampliada, 28 sep 2026), se registran con el mismo
 * `runTool`: pasan igual por `privacy_config_unresolved` primero y por el log cerrado de
 * cada llamada. No hay herramientas de carpetas (opción A de David, 28 sep 2026: sus
 * errores revelaban carpetas privadas).
 * Las seis de papelera y versiones (ampliación de D2, 30 sep 2026) van igual, al final.
 * Ninguna purga ni vacía la papelera.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logToolError, logToolOk } from '../log/logger';
import { resolveToolContext, type ServerContext, type ToolContext } from './context';
import { ToolError, toErrorResult, toOkResult } from './errors';
import {
  appendToNoteInputShape,
  createNoteInputShape,
  editNoteInputShape,
  linksInputShape,
  listNotesInputShape,
  moveNoteInputShape,
  readNoteInputShape,
  searchInputShape,
  setArchivedInputShape,
  setFavoriteInputShape
} from './schemas';
import { runAppendToNote } from './tools/append-to-note';
import { runCreateNote } from './tools/create-note';
import { runEditNote } from './tools/edit-note';
import { runMoveNote, runSetArchived, runSetFavorite } from './tools/organize';
import { runLinks } from './tools/links';
import { runListFolders } from './tools/list-folders';
import { runListNotes } from './tools/list-notes';
import { runListTags } from './tools/list-tags';
import { runReadNote } from './tools/read-note';
import { runSearch } from './tools/search';
import { runStatus } from './tools/status';
import {
  listTrashInputShape,
  listVersionsInputShape,
  readVersionInputShape,
  restoreNoteInputShape,
  restoreVersionInputShape,
  trashNoteInputShape
} from './schemas';
import { runListTrash } from './tools/list-trash';
import { runRestoreNote, runTrashNote } from './tools/organize';
import { runListVersions, runReadVersion, runRestoreVersion } from './tools/versions';

/** Recuento de resultados a loguear (§6.4): solo un número, nunca su contenido. */
function countOf(result: unknown): number | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  for (const key of ['results', 'notes', 'tags', 'folders', 'versions'] as const) {
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
      description:
        'Lee una nota completa por id o por título exacto. Devuelve `revision`, la que pide hebra_edit_note para editarla.',
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

  server.registerTool(
    'hebra_edit_note',
    {
      title: 'Editar una nota',
      description:
        'Edita una nota por sustituciones puntuales {find, replace} sobre la versión leída con hebra_read_note (expectedRevision). Cada find tiene que aparecer exactamente una vez en ese cuerpo; si alguno falla, no se escribe nada. Renombrar una nota es editar su H1. Si la nota cambió desde la lectura, revision_conflict: vuelve a leerla. Reintentar con el mismo operationId no repite la edición.',
      inputSchema: editNoteInputShape
    },
    async (input) => runTool(ctx, 'hebra_edit_note', (toolCtx) => runEditNote(toolCtx, input))
  );

  server.registerTool(
    'hebra_move_note',
    {
      title: 'Mover una nota',
      description: 'Mueve una nota a otra carpeta, por ids ("root" es la raíz).',
      inputSchema: moveNoteInputShape
    },
    async (input) => runTool(ctx, 'hebra_move_note', (toolCtx) => runMoveNote(toolCtx, input))
  );

  server.registerTool(
    'hebra_set_favorite',
    {
      title: 'Marcar como favorita',
      description: 'Marca (true) o desmarca (false) una nota como favorita.',
      inputSchema: setFavoriteInputShape
    },
    async (input) =>
      runTool(ctx, 'hebra_set_favorite', (toolCtx) => runSetFavorite(toolCtx, input))
  );

  server.registerTool(
    'hebra_set_archived',
    {
      title: 'Archivar una nota',
      description: 'Archiva (true) o desarchiva (false) una nota. No la borra ni la manda a la papelera.',
      inputSchema: setArchivedInputShape
    },
    async (input) =>
      runTool(ctx, 'hebra_set_archived', (toolCtx) => runSetArchived(toolCtx, input))
  );

  server.registerTool(
    'hebra_trash_note',
    {
      title: 'Mandar una nota a la papelera',
      description:
        'Manda una nota a la papelera de Hebra. Se puede sacar con hebra_restore_note o desde Hebra: no la borra.',
      inputSchema: trashNoteInputShape
    },
    async (input) => runTool(ctx, 'hebra_trash_note', (toolCtx) => runTrashNote(toolCtx, input))
  );

  server.registerTool(
    'hebra_restore_note',
    {
      title: 'Sacar una nota de la papelera',
      description:
        'Saca una nota de la papelera, a su carpeta si sigue existiendo o, si no, a la raíz.',
      inputSchema: restoreNoteInputShape
    },
    async (input) =>
      runTool(ctx, 'hebra_restore_note', (toolCtx) => runRestoreNote(toolCtx, input))
  );

  server.registerTool(
    'hebra_list_trash',
    {
      title: 'Listar la papelera',
      description:
        'Lista las notas de la papelera, la última en entrar primero, con la carpeta a la que volverían al restaurarlas.',
      inputSchema: listTrashInputShape
    },
    async (input) => runTool(ctx, 'hebra_list_trash', (toolCtx) => runListTrash(toolCtx, input))
  );

  server.registerTool(
    'hebra_list_versions',
    {
      title: 'Versiones anteriores de una nota',
      description:
        'Lista las versiones anteriores guardadas de una nota (sin cuerpo), la más reciente primero. Son las de este dispositivo, de los últimos 7 días.',
      inputSchema: listVersionsInputShape
    },
    async (input) =>
      runTool(ctx, 'hebra_list_versions', (toolCtx) => runListVersions(toolCtx, input))
  );

  server.registerTool(
    'hebra_read_version',
    {
      title: 'Leer una versión anterior',
      description: 'Lee el cuerpo de una versión anterior de una nota (versionId de hebra_list_versions).',
      inputSchema: readVersionInputShape
    },
    async (input) =>
      runTool(ctx, 'hebra_read_version', (toolCtx) => runReadVersion(toolCtx, input))
  );

  server.registerTool(
    'hebra_restore_version',
    {
      title: 'Restaurar una versión anterior',
      description:
        'Deja el cuerpo de una versión anterior como una edición nueva de la nota, sobre la revisión leída con hebra_read_note (expectedRevision). Si la nota cambió desde la lectura, revision_conflict: vuelve a leerla. Lo que había queda como versión anterior. Reintentar con el mismo operationId no la repite.',
      inputSchema: restoreVersionInputShape
    },
    async (input) =>
      runTool(ctx, 'hebra_restore_version', (toolCtx) => runRestoreVersion(toolCtx, input))
  );
}
