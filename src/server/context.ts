import type { HebraLibraryPort } from '../store/types';
import type { PrivacyFilter } from '../privacy/filter';
import type { PrivacyConfig } from '../privacy/config';
import { privacyWithMemory } from '../privacy/folder-memory';
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
  /** La configuración de privados; con `privacyConfigSource`, la del arranque. */
  privacyConfig: PrivacyConfig;
  /** `serve` (M5 del audit de privacidad, 11 oct 2026): `config.json` releído cuando
   *  cambia, en cada llamada (`src/privacy/config-source.ts`). Sin él (tests, ficheros de
   *  trabajo), `privacyConfig` tal cual. */
  privacyConfigSource?: { current(): Promise<PrivacyConfig> };
  status: StatusSource;
  write?: WriteContext;
}

/** Todo lo que una herramienta necesita PARA ESTA llamada: el almacén, un filtro de
 *  privados recién calculado del almacén (§6.3), la fuente de estado (§5,
 *  `hebra_status`) y, si aplica, el `WriteContext` (L3b). `register-tools.ts` construye
 *  uno por llamada con `resolveToolContext`; ninguna herramienta guarda esto entre
 *  llamadas.
 *
 *  `privacyConfig` (la configuración, no el filtro) viaja con las escrituras de la
 *  edición y la organización: el escritor la vuelve a aplicar DENTRO del turno en que
 *  escribe (D2 ampliada), también cuando se la reenvía un lector. */
export interface ToolContext {
  port: HebraLibraryPort;
  privacy: PrivacyFilter;
  privacyConfig: PrivacyConfig;
  status: StatusSource;
  write?: WriteContext;
}

/** `PrivacyFilter.build` es dos consultas al almacén (`foldersList()` +
 *  `notesVisibilityIndex()`, ambas O(1) ronda): barato de sobra para pagarlo en cada
 *  llamada de herramienta en vez de cachearlo. Antes, la configuración vigente (M5: un
 *  `stat` de `config.json`; si no se puede aplicar, `PrivacyConfigUnreadable`) y la memoria
 *  de las carpetas privadas (A3, `privacyWithMemory`: una lectura más, y una escritura solo
 *  cuando una ruta resuelve a una carpeta nueva). La `privacyConfig` que sale lleva esa
 *  memoria (`knownPrivateFolderIds`), y con ella viaja a las escrituras. */
export async function resolveToolContext(ctx: ServerContext): Promise<ToolContext> {
  const current = ctx.privacyConfigSource ? await ctx.privacyConfigSource.current() : ctx.privacyConfig;
  const { config, filter } = await privacyWithMemory(ctx.port, current);
  return {
    port: ctx.port,
    privacy: filter,
    privacyConfig: config,
    status: ctx.status,
    write: ctx.write
  };
}
