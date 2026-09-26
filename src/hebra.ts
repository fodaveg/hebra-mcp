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
