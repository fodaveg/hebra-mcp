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
  'hebra_read_attachment'
].sort();

/** Lo que el MCP nunca expone aunque tenga papelera: purgar y vaciar la papelera. */
export const FORBIDDEN_TRASH_TOOLS: readonly string[] = [
  'hebra_purge_note',
  'hebra_empty_trash'
];

/** Las tres de gestión de carpetas que quedaron fuera del MCP (opción A de David, 28 sep
 *  2026: sus errores revelaban carpetas privadas). Ningún transporte las lista. */
export const REMOVED_FOLDER_TOOLS: readonly string[] = [
  'hebra_create_folder',
  'hebra_rename_folder',
  'hebra_move_folder'
];
