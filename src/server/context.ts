import type { HebraLibraryPort } from '../store/types';
import { PrivacyFilter } from '../privacy/filter';
import type { PrivacyConfig } from '../privacy/config';
import type { StatusSource } from '../status/status-source';

/**
 * Lo que vive todo el proceso: el almacén, la CONFIGURACIÓN de privados (no el filtro ya
 * construido) y la fuente de estado. El filtro NO se guarda aquí a propósito: el sync
 * cambia el almacén mientras el proceso vive (`SyncRunner`, `src/sync/`), así que un
 * `PrivacyFilter` cacheado se queda obsoleto y puede enseñar, o esconder, una nota que
 * ya no es así (hallazgo del coordinador, 26 sep 2026 — antes de esto, `main.ts`
 * construía el filtro UNA vez al arrancar).
 */
export interface ServerContext {
  port: HebraLibraryPort;
  privacyConfig: PrivacyConfig;
  status: StatusSource;
}

/** Todo lo que una herramienta necesita PARA ESTA llamada: el almacén, un filtro de
 *  privados recién calculado del almacén (§6.3) y la fuente de estado (§5,
 *  `hebra_status`). `register-tools.ts` construye uno por llamada con
 *  `resolveToolContext`; ninguna herramienta guarda esto entre llamadas. */
export interface ToolContext {
  port: HebraLibraryPort;
  privacy: PrivacyFilter;
  status: StatusSource;
}

/** `PrivacyFilter.build` es dos consultas al almacén (`foldersList()` +
 *  `notesVisibilityIndex()`, ambas O(1) ronda): barato de sobra para pagarlo en cada
 *  llamada de herramienta en vez de cachearlo. */
export async function resolveToolContext(ctx: ServerContext): Promise<ToolContext> {
  const privacy = await PrivacyFilter.build(ctx.port, ctx.privacyConfig);
  return { port: ctx.port, privacy, status: ctx.status };
}
