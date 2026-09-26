/**
 * `import.meta.env` de Vite, SOLO para `tsc` (L6b, 26 sep 2026).
 *
 * `node.ts` de Hebra reexporta `device-link.ts` y `device-link-transport.ts`, que importan
 * como `import type` `vault/blob-v2/identity-vault.ts` y `lumbre/credential-vault.ts`.
 * esbuild borra esos imports, pero `tsc` comprueba los ficheros enteros y desde ellos
 * llega a código de Hebra que hebra-mcp nunca ejecuta:
 * - `@tauri-apps/api`, `yjs` y `fflate`: van como `devDependencies` fijadas a la versión
 *   de Hebra, solo por sus tipos. `scripts/check-bundle.mjs` sigue comprobando que nada
 *   de `@tauri-apps` llega a `dist/`.
 * - `import.meta.env` (`diagnostics/index.ts`): lo declara esta interfaz. No se usa
 *   `vite/client` porque declara también `*?raw` y otros módulos de Vite, y dejaría pasar
 *   en `tsc` un import que esbuild ya no sabe resolver.
 *
 * Todo esto se quitará cuando las interfaces de las bóvedas vivan en módulos de tipos sin
 * esos imports (petición a Hebra, informe de L6b).
 */
interface ImportMetaEnv {
  readonly MODE: string;
  readonly [key: string]: unknown;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
