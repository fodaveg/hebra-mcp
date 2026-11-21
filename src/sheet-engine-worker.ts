/**
 * Hilo del motor de fórmulas de hojas (IronCalc, H-09 de Hebra), empaquetado como
 * `dist/sheet-engine-worker.mjs` (hito H-173).
 *
 * `createNodeFormulaEngine` (`./sheets/index.ts`) arranca un `worker_threads` con el módulo que
 * recibe en `workerUrl`, y ese módulo debe ser SOLO el del motor: si apuntara al servidor
 * empaquetado, el hilo arrancaría el servidor entero. Por eso el motor tiene su propia entrada,
 * autónoma como `office-worker.mjs` y `document-worker.mjs`. Quien cree el motor desde `dist/` pasa
 * `new URL('./sheet-engine-worker.mjs', import.meta.url)`.
 *
 * Importar este fichero en el hilo principal no hace nada: `engine-node.ts` solo atiende cuando
 * corre en un hilo con su marca en `workerData`. El wasm lo resuelve `@ironcalc/wasm` desde
 * `node_modules`, que por eso está en `dependencies`.
 */
export { runNodeEngineWorker } from '../vendor/hebra/src/lib/sheets/engine/engine-node';
