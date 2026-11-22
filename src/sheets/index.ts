/**
 * Núcleo de hojas de cálculo de Hebra para Node (hito H-173, plan de hojas): lo que las
 * herramientas de hojas del MCP (`hebra_read_sheet`, `hebra_create_sheet`, `hebra_edit_sheet` y
 * `hebra_render_sheet`, H-78 a H-81) usan de `vendor/hebra/src/lib/sheets/`. Todo entra por aquí,
 * con una ruta relativa al submódulo y sin el alias `$lib`, como `../hebra.ts` para el motor de la
 * biblioteca. Es la misma copia que corre en la app: el MCP no reimplementa nada de hojas (D5).
 *
 * Es también un punto de entrada del empaquetado (`dist/sheets/index.js`), así que
 * `scripts/check-bundle.mjs` comprueba sobre el JS ya empaquetado que este núcleo carga en Node sin
 * globales del DOM y que todo paquete que importa (`@ironcalc/wasm`, `harfbuzzjs`, `linebreak`,
 * `fflate`, `yjs`) está en `dependencies` (R27).
 *
 * Qué hay, por paquete de Hebra:
 * - Contratos (H-03): el modelo, las operaciones, los comandos por dirección A1 del LLM, la lista de
 *   dibujo, el motor y los topes de lectura.
 * - Adaptador `DocFormatAdapter` de `.ods` y tabla de operaciones (H-31).
 * - Comandos A1 compilados a `SheetOp` con `expect` y `expectedRevision` (H-30).
 * - `layoutRevision` y `expectedLayout` (H-176).
 * - Escritor de `.ods` nuevos (H-23).
 * - Proyección del `Y.Doc` al motor (H-29) y el motor de fórmulas en un hilo de Node (H-09). El
 *   hilo del motor es otra entrada del empaquetado (`dist/sheet-engine-worker.mjs`,
 *   `../sheet-engine-worker.ts`): quien cree el motor pasa su URL como `workerUrl`.
 * - Lista de dibujo y su paso a SVG para el render común (H-76, H-77).
 * - Para `hebra_render_sheet` (H-81): fuentes empaquetadas, datos de pintado de la rejilla
 *   (`createEditorData`) y el texto de una fórmula (abajo, con su motivo).
 *
 * Fuera, a propósito: la rejilla, el controlador del editor y el resto de `sheets-ui/` (Svelte y
 * DOM) salvo `editor-data.ts`, el hilo del motor para navegador (`engine.worker.ts`,
 * `engine-client.ts`) y los dobles de los tests (`contracts/doubles.ts`).
 */
export * from '../../vendor/hebra/src/lib/sheets/contracts/model';
export * from '../../vendor/hebra/src/lib/sheets/contracts/ops';
export * from '../../vendor/hebra/src/lib/sheets/contracts/commands';
export * from '../../vendor/hebra/src/lib/sheets/contracts/draw';
export * from '../../vendor/hebra/src/lib/sheets/contracts/engine';
export * from '../../vendor/hebra/src/lib/sheets/contracts/limits';

export * from '../../vendor/hebra/src/lib/sheets/adapter/sheet-adapter';
export * from '../../vendor/hebra/src/lib/sheets/ops/op-table';
export * from '../../vendor/hebra/src/lib/sheets/ops/commands';
export * from '../../vendor/hebra/src/lib/sheets/ops/layout-revision';
export * from '../../vendor/hebra/src/lib/sheets/ods/write-new';
export * from '../../vendor/hebra/src/lib/sheets/ops/project-engine';
export {
  createNodeFormulaEngine,
  type NodeEngineOptions
} from '../../vendor/hebra/src/lib/sheets/engine/engine-node';
export {
  EngineError,
  ENGINE_APPLY_MS,
  ENGINE_LOAD_MS,
  type EngineErrorCode,
  type EngineValue,
  type EngineValueCell,
  type FormulaEngineWithValues
} from '../../vendor/hebra/src/lib/sheets/engine/ironcalc-engine';
export * from '../../vendor/hebra/src/lib/sheets/render/draw-list';
export * from '../../vendor/hebra/src/lib/sheets/render/draw-to-svg';

// Lo que añade `hebra_render_sheet` (H-81): el error del lector de `.ods`, las fuentes empaquetadas
// (`loadFontSet`, B-LR11), el texto canónico de una fórmula para `showFormulas` y los datos con los
// que la rejilla de la app pinta una hoja (`createEditorData`, H-51c): medidas, ocultas y estilo de
// cada celda, del fichero y del `Y.Doc`. `editor-data.ts` vive en `sheets-ui/` pero no usa Svelte
// ni el DOM (lo dice su cabecera y lo comprueba `check:bundle`); es la única pieza de esa carpeta
// que entra, para que el PNG del MCP salga con los mismos datos que la rejilla.
export { OdsReadError } from '../../vendor/hebra/src/lib/sheets/ods/read-workbook';
export { readBookLocale } from '../../vendor/hebra/src/lib/sheets/ods/book-locale';
export type { Axis } from '../../vendor/hebra/src/lib/sheets/grid/axes';
export {
  loadFontSet,
  FontIntegrityError,
  type FontSet
} from '../../vendor/hebra/src/lib/documents/text/fonts';
export { createFormulaLocale } from '../../vendor/hebra/src/lib/sheets/formula/locale';
export type { FormulaScope } from '../../vendor/hebra/src/lib/sheets/formula/canon';
export {
  createEditorData,
  type EditorData,
  type EffectiveCellStyle
} from '../../vendor/hebra/src/lib/sheets-ui/editor-data';
export type { GridAxis } from '../../vendor/hebra/src/lib/sheets-ui/paint-grid';
