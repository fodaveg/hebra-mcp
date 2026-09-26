/**
 * Punto de entrada del almacén para `scripts/build.mjs`: lo que un servidor MCP (L1+)
 * necesita para abrir la biblioteca y hablar con ella. `scripts/check-bundle.mjs` corre
 * sobre lo que esto arrastra. Nada de aquí exporta mutaciones fuera de D2
 * (`test/store/surface.node.test.ts`).
 */
export {
  openNodeLibraryPort,
  NodeLibraryPort,
  type OpenNodeLibraryOptions
} from './node-port';
export type { HebraLibraryPort } from './types';
export type { SyncStorePort } from './sync-port';
export {
  NoteWriter,
  APPEND_SEPARATOR,
  type AppendToNoteInput,
  type AppendToNoteResult,
  type CreateNoteInput,
  type CreateNoteResult,
  type NoteWriteTarget
} from './writes';
export { StoreError, isBusyOtherInstance, type StoreErrorCode } from './errors';
/** Derivados de Hebra (título, etiquetas, enlaces) tal cual los calculan sus apps: se
 *  reexporta para la prueba de humo de `scripts/check-bundle.mjs` (el bundle carga y
 *  deriva en Node sin DOM). Es una reexportación del submódulo, no una copia. */
export { deriveNote } from '../hebra';
