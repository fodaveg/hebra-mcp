/**
 * Punto de entrada del almacén para `scripts/build.mjs` (L0): lo que un servidor MCP
 * (L1+) necesita para abrir la biblioteca y hablar con ella. `scripts/check-bundle.mjs`
 * corre sobre lo que esto arrastra.
 */
export { openNodeLibraryPort, NodeLibraryPort, type OpenNodeLibraryOptions } from './node-port';
export type { HebraLibraryPort } from './types';
