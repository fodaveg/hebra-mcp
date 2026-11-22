/**
 * `annotations` MCP de las herramientas (SPEC.md §5, «Anotaciones MCP»). Viven aparte para que
 * las compartan `./register-tools.ts` y la tabla de las herramientas de documentos
 * (`./tools/document-tool-table.ts`, H-177) sin importarse la una a la otra.
 *
 * Ninguna herramienta toca el mundo exterior (`openWorldHint: false`). Destructivas, solo las que
 * sobrescriben un fichero: `hebra_replace_file_text` (D15) y `hebra_edit_sheet` (D28).
 * `test/tool-annotations.test.ts` compara cada herramienta con una tabla escrita a mano.
 */

export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export const WRITE_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

/** Escritura destructiva pero repetible: `hebra_replace_file_text` (D15) y `hebra_edit_sheet` (D28). */
export const WRITE_DESTRUCTIVE_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false
} as const;

export const WRITE_NON_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
} as const;
