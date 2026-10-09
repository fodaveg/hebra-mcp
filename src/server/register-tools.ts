/**
 * Registro de las 27 herramientas del servidor (SPEC.md §5, §10): lectura, escritura,
 * organización, papelera, versiones, adjuntos, desde D9 (3 oct 2026), crear y renombrar
 * carpetas y añadir adjuntos, y desde D10 (9 oct 2026), listar los ficheros sueltos,
 * mandarlos a la papelera y sacarlos. Todas pasan por `runTool`:
 * - `privacy_config_unresolved` primero (§6.3, R5): ninguna corre con una carpeta
 *   configurada que no existe.
 * - Log cerrado de cada llamada (§6.4): nunca la entrada, solo si salió bien y un
 *   recuento cuando aplica, o el código si falló.
 * Ninguna purga ni vacía la papelera, mueve ni borra carpetas, ni cambia ni borra
 * adjuntos, ni purga, crea, renombra, mueve o reemplaza un fichero suelto, ni lee su
 * contenido. Cada una lleva sus `annotations` MCP.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logToolError, logToolOk } from '../log/logger';
import { resolveToolContext, type ServerContext, type ToolContext } from './context';
import { ToolContent, ToolError, toErrorResult, toOkResult } from './errors';
import {
  addAttachmentInputShape,
  appendToNoteInputShape,
  createFolderInputShape,
  createNoteInputShape,
  renameFolderInputShape,
  editNoteInputShape,
  linksInputShape,
  listAttachmentsInputShape,
  listFilesInputShape,
  listFoldersInputShape,
  listNotesInputShape,
  listTagsInputShape,
  listTrashInputShape,
  listVersionsInputShape,
  moveNoteInputShape,
  readAttachmentInputShape,
  readNoteInputShape,
  readVersionInputShape,
  restoreFileInputShape,
  restoreNoteInputShape,
  restoreVersionInputShape,
  searchInputShape,
  setArchivedInputShape,
  setFavoriteInputShape,
  trashFileInputShape,
  trashNoteInputShape
} from './schemas';
import { runAddAttachment } from './tools/add-attachment';
import { runAppendToNote } from './tools/append-to-note';
import { runCreateFolder, runRenameFolder } from './tools/folders';
import { runListAttachments, runReadAttachment } from './tools/attachments';
import { runCreateNote } from './tools/create-note';
import { runEditNote } from './tools/edit-note';
import { runListFiles, runRestoreFile, runTrashFile } from './tools/files';
import { runLinks } from './tools/links';
import { runListFolders } from './tools/list-folders';
import { runListNotes } from './tools/list-notes';
import { runListTags } from './tools/list-tags';
import { runListTrash } from './tools/list-trash';
import {
  runMoveNote,
  runRestoreNote,
  runSetArchived,
  runSetFavorite,
  runTrashNote
} from './tools/organize';
import { runReadNote } from './tools/read-note';
import { runSearch } from './tools/search';
import { runStatus } from './tools/status';
import { runListVersions, runReadVersion, runRestoreVersion } from './tools/versions';

/** `annotations` MCP: ninguna herramienta es destructiva ni toca el mundo exterior. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;
const WRITE_NON_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
} as const;

/** Recuento de resultados a loguear (§6.4): solo un número, nunca su contenido. */
function countOf(result: unknown): number | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  for (const key of [
    'results',
    'notes',
    'tags',
    'folders',
    'files',
    'versions',
    'attachments'
  ] as const) {
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
    return result instanceof ToolContent ? result.result : toOkResult(result);
  } catch (error) {
    const toolError = error instanceof ToolError ? error : new ToolError('invalid_input');
    logToolError(name, toolError.code);
    return toErrorResult(toolError);
  }
}

export function registerTools(server: McpServer, ctx: ServerContext, version = 'unknown'): void {
  server.registerTool(
    'hebra_search',
    {
      title: 'Buscar notas',
      description: 'Busca en la biblioteca de Hebra por texto (FTS5), con filtro opcional de carpeta o etiqueta. Paginada (`limit`, `cursor`, `nextCursor`); `fields` pide solo algunos campos.',
      inputSchema: searchInputShape,
      annotations: READ_ONLY
    },
    async (input) => runTool(ctx, 'hebra_search', (toolCtx) => runSearch(toolCtx, input))
  );

  server.registerTool(
    'hebra_list_notes',
    {
      title: 'Listar notas',
      description: 'Lista notas de la biblioteca, opcionalmente por carpeta o etiqueta, con las favoritas primero y después por `updatedAt` descendente. Paginada (`limit`, `cursor`, `nextCursor`); `fields` pide solo algunos campos.',
      inputSchema: listNotesInputShape,
      annotations: READ_ONLY
    },
    async (input) => runTool(ctx, 'hebra_list_notes', (toolCtx) => runListNotes(toolCtx, input))
  );

  server.registerTool(
    'hebra_read_note',
    {
      title: 'Leer una nota',
      description:
        'Lee una nota completa por id o por título exacto. Devuelve `revision`, la que pide hebra_edit_note para editarla.',
      inputSchema: readNoteInputShape,
      annotations: READ_ONLY
    },
    async (input) => runTool(ctx, 'hebra_read_note', (toolCtx) => runReadNote(toolCtx, input))
  );

  server.registerTool(
    'hebra_list_tags',
    {
      title: 'Listar etiquetas',
      description: 'Lista las etiquetas de la biblioteca (anidadas como a/b) con su recuento de notas. Paginada (`limit`, `cursor`, `nextCursor`).',
      inputSchema: listTagsInputShape,
      annotations: READ_ONLY
    },
    async (input) => runTool(ctx, 'hebra_list_tags', (toolCtx) => runListTags(toolCtx, input))
  );

  server.registerTool(
    'hebra_list_folders',
    {
      title: 'Listar carpetas',
      description: 'Lista las carpetas de la biblioteca con su recuento de notas. Paginada (`limit`, `cursor`, `nextCursor`).',
      inputSchema: listFoldersInputShape,
      annotations: READ_ONLY
    },
    async (input) =>
      runTool(ctx, 'hebra_list_folders', (toolCtx) => runListFolders(toolCtx, input))
  );

  server.registerTool(
    'hebra_links',
    {
      title: 'Enlaces de una nota',
      description: 'Enlaces salientes y entrantes (backlinks) de una nota, por id. Paginada (`limit`, `cursor`, `nextCursor`).',
      inputSchema: linksInputShape,
      annotations: READ_ONLY
    },
    async (input) => runTool(ctx, 'hebra_links', (toolCtx) => runLinks(toolCtx, input))
  );

  server.registerTool(
    'hebra_status',
    {
      title: 'Estado del vínculo',
      description:
        'Estado del vínculo con Hebra y del sync, y `capabilities` (versión, herramientas, límites, lo que no permite). Sin contenido de notas.',
      annotations: READ_ONLY
    },
    async () => runTool(ctx, 'hebra_status', (toolCtx) => runStatus(toolCtx, version))
  );

  server.registerTool(
    'hebra_create_note',
    {
      title: 'Crear una nota',
      description:
        'Crea una nota nueva en la biblioteca de Hebra (el título es el `title:` del frontmatter si lo hay y, si no, el primer H1 del cuerpo), en una carpeta existente o en la raíz.',
      inputSchema: createNoteInputShape,
      annotations: WRITE_NON_IDEMPOTENT
    },
    async (input) => runTool(ctx, 'hebra_create_note', (toolCtx) => runCreateNote(toolCtx, input))
  );

  server.registerTool(
    'hebra_append_to_note',
    {
      title: 'Añadir texto a una nota',
      description:
        'Añade texto al final de una nota existente. Una edición concurrente produce una copia de conflicto visible, sin perder texto.',
      inputSchema: appendToNoteInputShape,
      annotations: WRITE_NON_IDEMPOTENT
    },
    async (input) =>
      runTool(ctx, 'hebra_append_to_note', (toolCtx) => runAppendToNote(toolCtx, input))
  );

  server.registerTool(
    'hebra_edit_note',
    {
      title: 'Editar una nota',
      description:
        'Edita una nota por sustituciones puntuales {find, replace} sobre la versión leída con hebra_read_note (expectedRevision). Cada find tiene que aparecer exactamente una vez en ese cuerpo; si alguno falla, no se escribe nada. Renombrar una nota es editar su `title:` del frontmatter si lo tiene; si no, su H1. Si la nota cambió desde la lectura, revision_conflict: vuelve a leerla. Marcar una tarea (`- [ ]` → `- [x]`) la baja al final de su lista y desmarcarla la sube tras la última pendiente, como en Hebra, pero solo si la edición cambia ÚNICAMENTE su casilla: si cambia también el texto de la línea, se trata como reescrita y se queda donde está. Para que se mueva, hazlo en dos ediciones: primero la casilla y luego el texto. Reintentar con el mismo operationId no repite la edición.',
      inputSchema: editNoteInputShape,
      annotations: WRITE_IDEMPOTENT
    },
    async (input) => runTool(ctx, 'hebra_edit_note', (toolCtx) => runEditNote(toolCtx, input))
  );

  server.registerTool(
    'hebra_move_note',
    {
      title: 'Mover una nota',
      description: 'Mueve una nota a otra carpeta, por ids ("root" es la raíz).',
      inputSchema: moveNoteInputShape,
      annotations: WRITE_IDEMPOTENT
    },
    async (input) => runTool(ctx, 'hebra_move_note', (toolCtx) => runMoveNote(toolCtx, input))
  );

  server.registerTool(
    'hebra_set_favorite',
    {
      title: 'Marcar como favorita',
      description: 'Marca (true) o desmarca (false) una nota como favorita.',
      inputSchema: setFavoriteInputShape,
      annotations: WRITE_IDEMPOTENT
    },
    async (input) =>
      runTool(ctx, 'hebra_set_favorite', (toolCtx) => runSetFavorite(toolCtx, input))
  );

  server.registerTool(
    'hebra_set_archived',
    {
      title: 'Archivar una nota',
      description: 'Archiva (true) o desarchiva (false) una nota. No la borra ni la manda a la papelera.',
      inputSchema: setArchivedInputShape,
      annotations: WRITE_IDEMPOTENT
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
      inputSchema: trashNoteInputShape,
      annotations: WRITE_IDEMPOTENT
    },
    async (input) => runTool(ctx, 'hebra_trash_note', (toolCtx) => runTrashNote(toolCtx, input))
  );

  server.registerTool(
    'hebra_restore_note',
    {
      title: 'Sacar una nota de la papelera',
      description:
        'Saca una nota de la papelera, a su carpeta si sigue existiendo o, si no, a la raíz.',
      inputSchema: restoreNoteInputShape,
      annotations: WRITE_IDEMPOTENT
    },
    async (input) =>
      runTool(ctx, 'hebra_restore_note', (toolCtx) => runRestoreNote(toolCtx, input))
  );

  server.registerTool(
    'hebra_list_trash',
    {
      title: 'Listar la papelera',
      description:
        'Lista las notas de la papelera, la última en entrar primero, con la carpeta a la que volverían al restaurarlas. Paginada (`limit`, `cursor`, `nextCursor`).',
      inputSchema: listTrashInputShape,
      annotations: READ_ONLY
    },
    async (input) => runTool(ctx, 'hebra_list_trash', (toolCtx) => runListTrash(toolCtx, input))
  );

  server.registerTool(
    'hebra_list_files',
    {
      title: 'Listar ficheros sueltos',
      description:
        'Lista los ficheros sueltos de la biblioteca (los que tienen carpeta propia y no son adjuntos de una nota: un .base, un PDF), por nombre. Con `trashed: true`, los de la papelera, el último en entrar primero, con la carpeta a la que volverían. Filtros opcionales: `folder` (con `subfolders`) y `name` (parte del nombre). No devuelve su contenido. Paginada (`limit`, `cursor`, `nextCursor`).',
      inputSchema: listFilesInputShape,
      annotations: READ_ONLY
    },
    async (input) => runTool(ctx, 'hebra_list_files', (toolCtx) => runListFiles(toolCtx, input))
  );

  server.registerTool(
    'hebra_trash_file',
    {
      title: 'Mandar un fichero suelto a la papelera',
      description:
        'Manda un fichero suelto (id de hebra_list_files) a la papelera de Hebra. Se puede sacar con hebra_restore_file o desde Hebra: no lo borra.',
      inputSchema: trashFileInputShape,
      annotations: WRITE_IDEMPOTENT
    },
    async (input) => runTool(ctx, 'hebra_trash_file', (toolCtx) => runTrashFile(toolCtx, input))
  );

  server.registerTool(
    'hebra_restore_file',
    {
      title: 'Sacar un fichero suelto de la papelera',
      description:
        'Saca un fichero suelto de la papelera, a su carpeta si sigue existiendo o, si no, a la raíz.',
      inputSchema: restoreFileInputShape,
      annotations: WRITE_IDEMPOTENT
    },
    async (input) =>
      runTool(ctx, 'hebra_restore_file', (toolCtx) => runRestoreFile(toolCtx, input))
  );

  server.registerTool(
    'hebra_list_versions',
    {
      title: 'Versiones anteriores de una nota',
      description:
        'Lista las versiones anteriores guardadas de una nota (sin cuerpo), la más reciente primero. Son las de este dispositivo: las 5 más recientes de cada nota se conservan siempre y las demás caducan a los 7 días. Paginada (`limit`, `cursor`, `nextCursor`); 50 por página por defecto.',
      inputSchema: listVersionsInputShape,
      annotations: READ_ONLY
    },
    async (input) =>
      runTool(ctx, 'hebra_list_versions', (toolCtx) => runListVersions(toolCtx, input))
  );

  server.registerTool(
    'hebra_read_version',
    {
      title: 'Leer una versión anterior',
      description: 'Lee el cuerpo de una versión anterior de una nota (versionId de hebra_list_versions).',
      inputSchema: readVersionInputShape,
      annotations: READ_ONLY
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
      inputSchema: restoreVersionInputShape,
      annotations: WRITE_IDEMPOTENT
    },
    async (input) =>
      runTool(ctx, 'hebra_restore_version', (toolCtx) => runRestoreVersion(toolCtx, input))
  );

  server.registerTool(
    'hebra_list_attachments',
    {
      title: 'Adjuntos de una nota',
      description:
        'Lista los adjuntos de una nota (imágenes, PDF, ficheros): attachmentId, name, mimeType y byteLength (null si no se sabe sin bajarlo). Paginada (`limit`, `cursor`, `nextCursor`). Solo lectura.',
      inputSchema: listAttachmentsInputShape,
      annotations: READ_ONLY
    },
    async (input) =>
      runTool(ctx, 'hebra_list_attachments', (toolCtx) => runListAttachments(toolCtx, input))
  );

  server.registerTool(
    'hebra_read_attachment',
    {
      title: 'Leer un adjunto',
      description:
        'Devuelve un adjunto de una nota: imagen como imagen, texto como texto, PDF como recurso embebido. Hasta 5 MiB y solo PNG, JPEG, GIF, WebP, PDF, texto plano, Markdown, CSV y JSON (si no, attachment_too_large o attachment_type_not_allowed). Un adjunto de texto se devuelve por tramos de hasta 100 000 caracteres (`offset`, `maxChars`; la respuesta trae `truncated` y `nextOffset`). Solo lectura.',
      inputSchema: readAttachmentInputShape,
      annotations: READ_ONLY
    },
    async (input) =>
      runTool(ctx, 'hebra_read_attachment', (toolCtx) => runReadAttachment(toolCtx, input))
  );

  server.registerTool(
    'hebra_create_folder',
    {
      title: 'Crear una carpeta',
      description:
        'Crea una carpeta dentro de otra que ya existe (`parent`, su ruta, o `parentId`; sin ninguno, la raíz). Si ya hay una con ese nombre ahí, la devuelve con `created: false`. folder_unavailable: ese nombre no se puede usar ahí. No mueve ni borra carpetas.',
      inputSchema: createFolderInputShape,
      annotations: WRITE_IDEMPOTENT
    },
    async (input) =>
      runTool(ctx, 'hebra_create_folder', (toolCtx) => runCreateFolder(toolCtx, input))
  );

  server.registerTool(
    'hebra_rename_folder',
    {
      title: 'Renombrar una carpeta',
      description:
        'Renombra una carpeta por id (de hebra_list_folders). folder_name_taken: ya hay una hermana con ese nombre; folder_unavailable: no se puede renombrar así. El nombre que ya tiene responde `renamed: false`. No mueve ni borra carpetas.',
      inputSchema: renameFolderInputShape,
      annotations: WRITE_IDEMPOTENT
    },
    async (input) =>
      runTool(ctx, 'hebra_rename_folder', (toolCtx) => runRenameFolder(toolCtx, input))
  );

  server.registerTool(
    'hebra_add_attachment',
    {
      title: 'Añadir un adjunto a una nota',
      description:
        'Añade un fichero (base64) al final de una nota como `![[sha256:…|nombre]]`, igual que adjunta Hebra, y lo sube con el sync. Hasta 5 MiB y solo PNG, JPEG, GIF, WebP, PDF, texto plano, Markdown, CSV y JSON (si no, attachment_too_large o attachment_type_not_allowed). Si la nota termina dentro de un bloque de código (```) sin cerrar, lo cierra antes de añadir la referencia, para que cuente como adjunto. Una edición concurrente produce una copia de conflicto visible. Reintentar con el mismo operationId no lo añade dos veces (durante 24 h). No cambia ni borra adjuntos.',
      inputSchema: addAttachmentInputShape,
      annotations: WRITE_IDEMPOTENT
    },
    async (input) =>
      runTool(ctx, 'hebra_add_attachment', (toolCtx) => runAddAttachment(toolCtx, input))
  );
}
