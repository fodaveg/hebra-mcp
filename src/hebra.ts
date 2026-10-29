/**
 * Punto de entrada estable de Hebra para Node (`vendor/hebra/src/lib/library/node.ts`,
 * lote L6 de Hebra, petición P1; SPEC.md §4.2, §10 L6). Desde L6c (`bb0f3d13`), TODO lo
 * que el runtime de hebra-mcp usa entra por aquí, con una ruta relativa y sin el alias
 * `$lib`: motor de sync, `SqliteLibraryEngine`/`SqliteConn`, transporte HTTP, relé de
 * blobs, vínculo de dispositivos, derivados, PKCE, código de recuperación, los TIPOS de
 * las bóvedas y de `types.ts`, `folder-tree`, `canonicalTag`, `cleanSearchPage`,
 * `SCHEMA_SQL` y el tipo `BlobBytesStore`. Ningún fichero de `src/` importa ya del alias
 * `$lib` (`scripts/check-no-hebra-code.mjs` y el `grep` de cierre de este lote lo
 * comprueban).
 *
 * Lo que sigue sin exportar aquí, a propósito (SPEC.md §4.1): las implementaciones de
 * las bóvedas sobre IndexedDB/Keychain de Tauri (solo sus interfaces), `MemoryBlobStore`
 * (vive en `vendor/hebra/src/lib/library/node-testing.ts`, solo para tests) y el
 * worker/OPFS de `web-port.ts`.
 */
export * from '../vendor/hebra/src/lib/library/node';
// El MCP combina la búsqueda de cuerpo de Hebra con su índice de subcadenas sin
// consultar las ramas de dibujos y nombres de ficheros incrustados (privacidad M6).
export {
  flushSubstringPending,
  sqliteResultCode,
  SUBSTRING_INDEX_READY_SQL,
  substringResidualSql,
  substringSnippet
} from '../vendor/hebra/src/lib/library/substring-search';
// Si el cuerpo indexado de una fila es su `search_body` (TRA-18: el cuerpo sin los
// comentarios de Obsidian): la condición del prefiltro de `hebra_grep` que mira el cuerpo
// en bruto de las notas con comentarios (`src/store/grep-sql.ts`).
export { searchBodyInUseSql } from '../vendor/hebra/src/lib/library/search-body';
export { SEARCH_MARK_START, SEARCH_MARK_END } from '../vendor/hebra/src/lib/library/types';
export type { NoteMutationGuard, FolderMutationGuard } from '../vendor/hebra/src/lib/library/types';
// El error del relé de Blob V2 (lo lanza `HttpBlobRelayV2`, ya empaquetado): `SyncRunner`
// reconoce con él un 429 al bajar un adjunto y espera antes de reintentar.
export { BlobRelayV2Error } from '../vendor/hebra/src/lib/vault/blob-v2/memory-transport';

// H-L7: protocolo compartido de concesiones de dispositivo, sin copiar criptografía.
export { openAgentSpaceGrant, agentDeviceKeyId, parseAgentSpaceGrant } from '../vendor/hebra/src/lib/spaces/agent-space-grant';
