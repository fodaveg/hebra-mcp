import type { HebraLibraryPort } from '../store/types';
import { PrivacyFilter } from '../privacy/filter';
import type { PrivacyConfig } from '../privacy/config';
import type { StatusSource } from '../status/status-source';
import type { WriteContext } from './write-context';

/**
 * Lo que vive todo el proceso: el almacén, la CONFIGURACIÓN de privados (no el filtro ya
 * construido), la fuente de estado y, si el proceso puede escribir (L3b), el
 * `WriteContext`. El filtro NO se guarda aquí a propósito: el sync cambia el almacén
 * mientras el proceso vive (`SyncRunner`, `src/sync/`), así que un `PrivacyFilter`
 * cacheado se queda obsoleto y puede enseñar, o esconder, una nota que ya no es así
 * (hallazgo del coordinador, 26 sep 2026 — antes de esto, `main.ts` construía el filtro
 * UNA vez al arrancar).
 *
 * `write` es opcional para no romper los tests de L1 que construyen un `ServerContext`
 * sin él (solo lectura): `hebra_create_note`/`hebra_append_to_note` son las únicas
 * herramientas que lo necesitan.
 */
export interface ServerContext {
  port: HebraLibraryPort;
  privacyConfig: PrivacyConfig;
  status: StatusSource;
  write?: WriteContext;
}

/** Todo lo que una herramienta necesita PARA ESTA llamada: el almacén, un filtro de
 *  privados recién calculado del almacén (§6.3), la fuente de estado (§5,
 *  `hebra_status`) y, si aplica, el `WriteContext` (L3b). `register-tools.ts` construye
 *  uno por llamada con `resolveToolContext`; ninguna herramienta guarda esto entre
 *  llamadas. */
export interface ToolContext {
  port: HebraLibraryPort;
  privacy: PrivacyFilter;
  status: StatusSource;
  write?: WriteContext;
}

/** `PrivacyFilter.build` es dos consultas al almacén (`foldersList()` +
 *  `notesVisibilityIndex()`, ambas O(1) ronda): barato de sobra para pagarlo en cada
 *  llamada de herramienta en vez de cachearlo. */
export async function resolveToolContext(ctx: ServerContext): Promise<ToolContext> {
  const privacy = await PrivacyFilter.build(ctx.port, ctx.privacyConfig);
  return { port: ctx.port, privacy, status: ctx.status, write: ctx.write };
}
