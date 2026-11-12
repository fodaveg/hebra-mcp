/**
 * Lo que `dist/` pone en lugar del registro de diagnóstico de la app de Hebra
 * (`vendor/hebra/src/lib/diagnostics/index.ts`) cuando lo importa `space-history-client.ts`
 * (HS-5, 12 nov 2026). Ese registro elige su sumidero según el runtime (IndexedDB, Tauri) y
 * lee `localStorage` e `import.meta.env` de Vite: nada de eso existe en Node, y
 * `scripts/check-bundle.mjs` lo rechaza con razón. hebra-mcp no usa ese registro: le pasa al
 * cliente del historial su propio `diagnostic` (`src/server/tools/space-versions.ts`, al log),
 * así que `recordDiagnostic` no se llama nunca. Lo sustituye `scripts/build.mjs`, solo para ese
 * importador; los tests (Vitest) cargan el módulo real de Hebra.
 */
export function recordDiagnostic(_event: unknown): void {
  // A propósito vacío: ver la cabecera.
}
