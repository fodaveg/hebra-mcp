/**
 * Solo para `tsc` (HS-5, 12 nov 2026), como `test/unpdf-shim.d.ts`. `space-history-client.ts`
 * de Hebra (el historial compartido de los espacios) importa `recordDiagnostic` del registro de
 * diagnóstico de la app (`lib/diagnostics/index.ts`), que lee `import.meta.env` de Vite y carga
 * el sumidero de Tauri con un `import()` DINÁMICO de `@tauri-apps/api/core`. hebra-mcp nunca
 * llega a ninguno de los dos: le pasa al cliente su propio `diagnostic` (al log), y en `dist/`
 * ese módulo lo sustituye `src/shims/hebra-diagnostics.ts` (`scripts/build.mjs`), así que
 * `check:bundle` sigue sin ver Tauri ni el DOM. Estas dos declaraciones solo evitan los `TS2339`
 * y `TS2307` del código de Hebra sin instalar Tauri. `invoke` e `InvokeArgs` llevan la forma
 * mínima que piden los tipos de `persistence/bridge-trace.ts`, al que `tsc` llega por el tipo
 * `SpaceSyncIdentity` (`space-identity.ts`), que el cliente solo importa como tipo.
 */
declare module '@tauri-apps/api/core' {
  export type InvokeArgs = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array;
  export function invoke<T>(cmd: string, args?: InvokeArgs, options?: unknown): Promise<T>;
}

interface ImportMeta {
  readonly env: Record<string, unknown> & { readonly MODE?: string };
}
