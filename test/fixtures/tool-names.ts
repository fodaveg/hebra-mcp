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
  'hebra_read_note',
  'hebra_search',
  'hebra_status'
].sort();
