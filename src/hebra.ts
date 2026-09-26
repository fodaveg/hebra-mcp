/**
 * Punto de entrada estable de Hebra para Node (`vendor/hebra/src/lib/library/node.ts`,
 * lote L6 de Hebra, petición P1; SPEC.md §4.2, §10 L6). Todo lo que el runtime de
 * hebra-mcp usa y `node.ts` exporta entra por aquí, con una ruta relativa y sin el alias
 * `$lib`: motor de sync, `SqliteLibraryEngine`/`SqliteConn`, transporte HTTP, relé de
 * blobs, vínculo de dispositivos, derivados y los TIPOS de las bóvedas.
 *
 * Lo que `node.ts` no exporta (tipos de `types.ts`, `folder-tree`, `canonicalTag`,
 * `search-snippet`, `blob-store`, `schema-sql`…) sigue entrando por `$lib/…` en cada
 * fichero que lo usa; la lista está en el informe de L6b como petición a Hebra.
 */
export * from '../vendor/hebra/src/lib/library/node';
