/**
 * Las herramientas que registra `src/server/register-tools.ts` (SPEC.md §5), ordenadas:
 * la lista que esperan `tools/list` por stdio (`test/e2e/stdio-server.test.ts`), por HTTP
 * (`test/http/serve-http.test.ts`) y tras OAuth (`test/http/oauth.test.ts`), y la que
 * tienen que cubrir las llamadas-cebo (`./bait-calls.ts`). Una sola lista para que una
 * herramienta nueva no se quede fuera de ninguno de los tres transportes.
 */
export const TOOL_NAMES: readonly string[] = [
  'hebra_append_to_note',
  'hebra_create_note',
  'hebra_edit_note',
  'hebra_links',
  'hebra_list_folders',
  'hebra_list_notes',
  'hebra_list_tags',
  'hebra_move_note',
  'hebra_read_note',
  'hebra_search',
  'hebra_set_archived',
  'hebra_set_favorite',
  'hebra_status',
  // Papelera y versiones (ampliación de D2, 30 sep 2026).
  'hebra_list_trash',
  'hebra_list_versions',
  'hebra_read_version',
  'hebra_restore_note',
  'hebra_restore_version',
  'hebra_trash_note',
  // Adjuntos en solo lectura (30 sep 2026).
  'hebra_list_attachments',
  'hebra_read_attachment',
  // Carpetas y adjuntos (D9, 3 oct 2026).
  'hebra_create_folder',
  'hebra_rename_folder',
  'hebra_add_attachment',
  // Ficheros sueltos (D10, 9 oct 2026).
  'hebra_list_files',
  'hebra_trash_file',
  'hebra_restore_file',
  // Notas por apartados (D11, 9 oct 2026).
  'hebra_note_outline',
  // Búsqueda línea a línea (D13, 10 oct 2026).
  'hebra_grep'
].sort();

/** Lo que el MCP nunca expone aunque tenga papelera: purgar y vaciar la papelera. */
export const FORBIDDEN_TRASH_TOOLS: readonly string[] = [
  'hebra_purge_note',
  'hebra_empty_trash'
];

/** Lo que sigue fuera del MCP tras D9 (3 oct 2026, que trajo crear y renombrar carpetas
 *  y añadir adjuntos): mover y borrar carpetas, y cambiar o borrar adjuntos. Ningún
 *  transporte las lista. */
export const REMOVED_FOLDER_TOOLS: readonly string[] = [
  'hebra_move_folder',
  'hebra_delete_folder',
  'hebra_trash_folder',
  'hebra_delete_attachment',
  'hebra_replace_attachment'
];

/** Lo que sigue fuera del MCP tras D10 (9 oct 2026, que trajo listar los ficheros sueltos
 *  y mandarlos a la papelera): purgarlos, vaciar su papelera, crearlos, renombrarlos,
 *  moverlos, reemplazarlos y leer su contenido. Ningún transporte las lista. */
export const FORBIDDEN_FILE_TOOLS: readonly string[] = [
  'hebra_purge_file',
  'hebra_delete_file',
  'hebra_empty_file_trash',
  'hebra_create_file',
  'hebra_rename_file',
  'hebra_move_file',
  'hebra_replace_file',
  'hebra_read_file'
];
