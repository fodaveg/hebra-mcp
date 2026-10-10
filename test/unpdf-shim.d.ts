/**
 * Solo para `tsc`. Desde el submódulo en `59b5d403`, `node-testing.ts` de Hebra (lo usan
 * los tests: `test/hebra-testing.ts`) importa `local-port.ts`, que arrastra
 * `pdf-text-extract.ts`, y este importa `unpdf` de forma DINÁMICA, dentro de
 * `extractPdfText`. hebra-mcp no saca texto de PDF ni instala `unpdf`: el import nunca se
 * ejecuta aquí (ni en los tests ni en `dist/`, que no incluye `node-testing.ts`). Este
 * módulo ambiente solo evita el `TS2307` sin añadir una dependencia que no se usa.
 */
declare module 'unpdf';
