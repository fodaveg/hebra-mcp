import type { PrivacyConfig } from '../../src/privacy/config';

/**
 * Sin carpetas ni etiquetas privadas, EXPLÍCITO: `privacy` es obligatoria en las
 * entradas de escritura de `NoteWriter` (`src/store/writes.ts`), así que los tests que
 * escriben directamente en el almacén, sin filtro que probar, pasan esta.
 */
export const NO_PRIVATE: PrivacyConfig = { privateFolders: [], privateTags: [] };
