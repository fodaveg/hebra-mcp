/**
 * `sqlite-engine.ts` de Hebra importa el esquema como texto con el sufijo `?raw` de
 * Vite (`import SCHEMA_SQL from './schema.sql?raw'`). `tsc` no conoce ese especificador;
 * esta declaración solo le dice el tipo. En tiempo de build, `scripts/build.mjs`
 * resuelve el import de verdad con un plugin de esbuild (§4.2 de SPEC.md); en tests,
 * Vite lo resuelve de forma nativa.
 */
declare module '*.sql?raw' {
  const contents: string;
  export default contents;
}
